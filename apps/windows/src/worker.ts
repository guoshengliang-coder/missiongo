import { hostname } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { API, serverOrigin } from "../../node/src/api.js";
import { loadConfig, saveConfig, readPrivate, directories, stateRoot, safeError } from "../../node/src/storage.js";
import { runHost, hostDirectory } from "../../node/src/host.js";
import { runNode, detectAgents, verifyRepo, version } from "../../node/src/runner.js";
import { validateLaunchPaths } from "../../node/src/environment.js";
import { object, type Kind, type RepoMapping, type HostState } from "../../node/src/types.js";
import { initializeNativeSecurity } from "./security.js";
import { acquireNodeLease } from "./lease.js";
import type { DesktopRequest, DesktopEvent } from "./contracts.js";
import { runBridge } from "./bridge.js";

initializeNativeSecurity();
if (process.platform !== "win32" && ["--worker", "_bridge"].includes(process.argv[2] ?? "")) process.env.MISSIONGO_NODE_HOME = join(stateRoot(), "windows-desktop");
const root = stateRoot();
const entry = fileURLToPath(import.meta.url);
let controller: AbortController | undefined;
let running: Promise<void> | undefined;
let login: AbortController | undefined;
let profileCache: { products: unknown[]; repos: unknown[] } = { products: [], repos: [] };
let profileAt = 0; let profilePending = false; let profileFailed = false;
const event = (value: DesktopEvent) => process.stdout.write(JSON.stringify({ event: value }) + "\n");
const api = () => {
  const config = loadConfig(root);
  if (!config.server || !config.token) throw new Error("请先登录此执行环境");
  return new API(config.server, config.token);
};
async function stop(): Promise<void> { controller?.abort(); await running; }
async function start(): Promise<void> {
  if (running) return;
  api();
  // WSL uses the Linux flock wrapper; a Windows native worker uses a named pipe.
  if (process.platform !== "win32") {
    const child = spawn("flock", ["--nonblock", "--no-fork", join(root, "node.lock"), process.execPath, entry, "_node"], { stdio: ["ignore", "pipe", "ignore"] });
    controller = new AbortController(); controller.signal.addEventListener("abort", () => child.kill("SIGTERM"), { once: true });
    const messages = createInterface({ input: child.stdout });
    messages.on("line", (line) => { if (line.length > 64_000) return; try { const value = JSON.parse(line); if (["status", "attention"].includes(value.event?.type)) event(value.event); } catch { /* Never expose raw runtime output. */ } });
    running = new Promise<void>((resolve) => {
      child.once("error", () => { event({ type: "status", text: "WSL 需要 Node.js 22.13+ 与 util-linux flock" }); resolve(); });
      child.once("exit", (code) => { if (code) event({ type: "status", text: "WSL 节点退出，或该配置已被另一节点占用" }); resolve(); });
    }).finally(() => { running = undefined; controller = undefined; });
    return;
  }
  const release = await acquireNodeLease(root);
  controller = new AbortController();
  running = runNode(root, entry, controller.signal, (text) => event({ type: "status", text }), observe(), { managedAllowed: true })
    .catch((error) => { event({ type: "status", text: safeError(error) }); })
    .finally(async () => { await release(); running = undefined; controller = undefined; });
}
function observe(): NonNullable<Parameters<typeof runNode>[4]> {
  const seenAttention = new Map<string, string>();
  return (session, snapshot) => {
    const last = [...snapshot.messages].reverse().find((message) => message.role !== "user");
    const key = `${session.id}:${last?.sourceId ?? ""}:${snapshot.approval?.id ?? ""}:${snapshot.waitingForInput === true}`;
    if ((last || snapshot.waitingForInput) && seenAttention.get(session.id) !== key) { seenAttention.set(session.id, key); event({ type: "attention" }); }
  };
}
async function profile() {
  const value = await api().call("GET", "/api/v1/node/me");
  return { products: value.products ?? [], repos: value.repos ?? [] };
}
function hasRecordedHosts(): boolean {
  return directories(join(root, "sessions")).some((key) => readPrivate<HostState>(join(hostDirectory(root, key), "state.json"))?.phase === "launched");
}

export async function handleDesktopRequest(request: DesktopRequest): Promise<unknown> {
  const config = loadConfig(root);
  switch (request.method) {
    case "snapshot": {
      let health = readPrivate<{ state?: string; checkedAt?: string }>(join(root, "status.json"));
      if (config.token && !profilePending && Date.now() - profileAt > 30_000) {
        profileAt = Date.now(); profilePending = true;
        void profile().then((value) => { if (loadConfig(root).token === config.token) { profileCache = value; profileFailed = false; } }).catch(() => { if (loadConfig(root).token === config.token) profileFailed = true; }).finally(() => { profilePending = false; });
      }
      if (profileFailed) health = { ...health, state: "连接不可用，请检查网络或重新登录" };
      return {
      version, registered: !!config.token, ...(config.server ? { server: config.server } : {}), ...(config.name ? { name: config.name } : {}),
      running: !!running, loginPending: !!login, agents: config.agents, managedEnabled: config.managedExecutionEnabled === true,
      health, ...profileCache,
    }; }
    case "login": {
      if (login || running) throw new Error("先暂停接单，再进行登录");
      const origin = serverOrigin(request.server);
      if (config.server && config.server !== origin && hasRecordedHosts()) throw new Error("原服务器仍有会话记录，请先在原服务器核实和结束这些会话");
      login = new AbortController();
      try {
        const next = await new API(origin, undefined, login.signal).login(config, request.name || hostname(), (url, code) => event({ type: "authorization", url, code }),
          process.platform === "win32" ? "Windows Desktop" : "Windows Desktop (WSL)");
        if (login.signal.aborted) throw new Error("登录已取消");
        if (config.nodeId && next.nodeId !== config.nodeId && hasRecordedHosts()) throw new Error("已有会话属于原账号；请先核实原账号会话，不能将其转给其他账号");
        saveConfig(root, next); profileCache = { products: [], repos: [] }; profileAt = 0; return { registered: true };
      } finally { login = undefined; }
    }
    case "cancelLogin": login?.abort(); return {};
    case "logout": {
      login?.abort(); await stop(); delete config.token; saveConfig(root, config); profileCache = { products: [], repos: [] }; profileAt = 0; return {};
    }
    case "rename": await api().call("PATCH", "/api/v1/node/me", { nickname: request.name }); config.name = request.name; saveConfig(root, config); return {};
    case "agent": {
      if (!["claude_code", "codex", "opencode"].includes(request.kind)) throw new Error("不支持的 Agent");
      if (request.enabled) {
        api(); const settings = object(request.settings);
        if (Object.keys(settings).some((key) => !["executable", "environmentScript", "shellExecutable", "serviceRegistration"].includes(key))
          || Object.values(settings).some((value) => typeof value !== "string" || value.length > 2000 || /[\r\n\0]/.test(value))) throw new Error("无效的 Agent 配置");
        validateLaunchPaths(settings);
        config.agents[request.kind] = { ...settings, checkRevision: randomUUID() }; saveConfig(root, config);
        return detectAgents({ ...config, agents: { [request.kind]: config.agents[request.kind] } });
      }
      delete config.agents[request.kind]; saveConfig(root, config); return {};
    }
    case "checkAgent": {
      if (request.kind && !config.agents[request.kind]) throw new Error("此 Agent 尚未启用");
      for (const kind of Object.keys(config.agents) as Kind[]) if (!request.kind || kind === request.kind) config.agents[kind]!.checkRevision = randomUUID();
      saveConfig(root, config); return detectAgents(request.kind ? { ...config, agents: { [request.kind]: config.agents[request.kind] } } : config);
    }
    case "managed": {
      if (typeof request.enabled !== "boolean" || request.enabled && !config.agents.codex) throw new Error("请先明确启用 Codex 集成");
      config.managedExecutionEnabled = request.enabled; saveConfig(root, config); return {};
    }
    case "repository": {
      const value = await profile();
      if (!value.products.some((product: { id: string }) => product.id === request.productId)) throw new Error("请选择有权访问的项目");
      const repos: RepoMapping[] = value.repos.filter((repo: RepoMapping) => repo.productId !== request.productId);
      if (request.path) repos.push({ productId: request.productId, repoPath: await verifyRepo(request.path) });
      await api().call("PUT", "/api/v1/node/repos", { repos: repos.map(({ productId, repoPath }) => ({ productId, repoPath })) }); profileCache = { ...value, repos }; profileAt = Date.now(); return {};
    }
    case "run": if (request.enabled) await start(); else await stop(); return {};
    default: throw new Error("此请求不属于节点运行时");
  }
}

if (process.argv[2] === "_bridge") {
  await runBridge(root, entry, process.argv.slice(3)).catch((error) => { console.error(safeError(error)); process.exitCode = 1; });
} else if (process.argv[2] === "_node") {
  const abort = new AbortController();
  process.once("SIGTERM", () => abort.abort()); process.once("SIGINT", () => abort.abort());
  await runNode(root, entry, abort.signal, (text) => event({ type: "status", text }), observe(), { managedAllowed: true }).catch((error) => { event({ type: "status", text: safeError(error) }); process.exitCode = 1; });
} else if (process.argv[2] === "_host") {
  await runHost(root, process.argv[3] ?? "").catch((error) => { event({ type: "status", text: safeError(error) }); process.exitCode = 1; });
} else {
  // Stdout is a bounded local RPC stream. It never contains node credentials.
  const input = createInterface({ input: process.stdin });
  input.on("line", (line) => {
    if (line.length > 64_000) { event({ type: "status", text: "本地请求超出限制" }); return; }
    let message: { id: string; request: DesktopRequest };
    try { message = JSON.parse(line); if (!/^[0-9]+$/.test(message.id) || !message.request?.method) throw new Error(); }
    catch { return; }
    void handleDesktopRequest(message.request).then(
      (value) => process.stdout.write(JSON.stringify({ id: message.id, value }) + "\n"),
      (error) => process.stdout.write(JSON.stringify({ id: message.id, error: safeError(error) }) + "\n"),
    );
  });
  input.once("close", () => { login?.abort(); void stop().finally(() => process.exit(0)); });
}
