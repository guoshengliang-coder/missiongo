import { NativePerformance } from "./console-performance.js";
import { chmodSync, existsSync, lstatSync, readFileSync } from "node:fs";
import { createServer, request } from "node:http";
import { join } from "node:path";
import { createHash, timingSafeEqual } from "node:crypto";
import { CodexAdapter } from "./codex.js";
import type { HistoryResult } from "./codex-history.js";
import { ClaudeAdapter } from "./claude.js";
import { OpenCodeAdapter, OpenCodeAPI } from "./opencode.js";
import { launchPrompt } from "./prompt.js";
import { skillPaths, skillVersion, syncSkill } from "./skills.js";
import { resolveAgentLaunch } from "./environment.js";
import { probe } from "./process.js";
import { loadConfig, privateDir, readPrivate, safeError, savePrivate } from "./storage.js";
import type { Adapter, Dispatch, HostState, Session, Snapshot } from "./types.js";
import { id, InputRejected } from "./types.js";
import { saveBinding } from "./bindings.js";

export function hostDirectory(root: string, dispatchId: string): string { return join(root, "sessions", id(dispatchId)); }
export function boundedSnapshot(snapshot: Snapshot): Snapshot {
  const messages: Snapshot["messages"] = [];
  let bytes = 0;
  let truncated = false;
  for (const message of [...snapshot.messages].reverse()) {
    if (message.text.length > 4_000_000) { truncated = true; continue; }
    const size = Buffer.byteLength(JSON.stringify(message));
    if (messages.length >= 2000 || bytes + size > 30 * 1024 * 1024) { truncated = true; break; }
    messages.unshift(message); bytes += size;
  }
  return { ...snapshot, messages, ...(truncated ? { error: snapshot.error ?? "agent_history_limited: 镜像历史超出限制，仅同步最近内容；完整记录请在原会话核对。",
    ...(snapshot.history ? { history: { ...snapshot.history, complete: false, error: "too_large" } } : {}) } : {}) };
}
export function socketPath(root: string, dispatchId: string): string {
  if (process.platform === "win32") return `\\\\.\\pipe\\missiongo-${createHash("sha256").update(root).update("\0").update(id(dispatchId)).digest("hex")}`;
  // Linux sockaddr_un is bounded. Keep names short even for long dispatch IDs.
  const path = join(root, `h-${createHash("sha256").update(id(dispatchId)).digest("hex").slice(0, 16)}.sock`);
  if (Buffer.byteLength(path) > 103) throw new Error("Node state path is too long for a Unix socket; set MISSIONGO_NODE_HOME to a shorter private directory");
  return path;
}
class HostHTTPError extends Error { constructor(readonly status: number) { super("Local host rejected request"); } }
const hostProtocols = new Map<string, boolean>();
export async function hostCall(root: string, dispatchId: string, session?: Session, laneOrSignal: "combined" | "observation" | "control" | AbortSignal = "combined", operation?: "sync" | "managed-start" | "managed-stop"): Promise<Snapshot> {
  const signal = typeof laneOrSignal === "string" ? undefined : laneOrSignal;
  const lane = typeof laneOrSignal === "string" ? laneOrSignal : "combined";
  if (operation && operation !== "sync") return callHost<Snapshot>(root, dispatchId, `/${operation}`, session ?? {}, signal);
  if (lane === "combined") return callHost<Snapshot>(root, dispatchId, "/sync", session ?? {}, signal);
  const key = root + ":" + dispatchId;
  let modern = hostProtocols.get(key);
  if (modern === undefined) {
    try {
      const capabilities = await callHost<{protocol: number}>(root, dispatchId, "/capabilities", {}, signal);
      if (capabilities.protocol !== 1) throw new Error("Unsupported host control protocol");
      modern = true;
    }
    catch (error) { if (!(error instanceof HostHTTPError) || error.status !== 404) throw error; modern = false; }
    hostProtocols.set(key, modern);
  }
  // Capability negotiation has no side effect. Never fallback after an input
  // request's unknown outcome, and never restart a surviving old host.
  return callHost<Snapshot>(root, dispatchId, modern ? lane === "control" ? "/control" : "/observe" : "/sync", session ?? {}, signal);
}
export async function hostHistoryCall(root: string, dispatchId: string, sessionRef: string, cursor: string): Promise<HistoryResult> {
  return callHost<HistoryResult>(root, dispatchId, "/history", { sessionRef, cursor });
}
export async function readHostHistory(adapter: Adapter | undefined, sessionRef: string | undefined, input: unknown): Promise<HistoryResult> {
  const request = input as { sessionRef?: unknown; cursor?: unknown } | null;
  if (!adapter?.historyPage || !sessionRef || !request || request.sessionRef !== sessionRef
    || typeof request.cursor !== "string" || !request.cursor || request.cursor.length > 4096) throw new Error("History source unavailable");
  const page = await adapter.historyPage(request.cursor);
  const validMessages = page.messages.length <= 2000 && page.messages.every(message => message.text.length > 0 && message.text.length <= 4_000_000);
  return validMessages && Buffer.byteLength(JSON.stringify(page)) <= 30 * 1024 * 1024 ? page : { messages: [], error: "too_large" };
}
async function callHost<T>(root: string, dispatchId: string, path: string, body: unknown, signal?: AbortSignal): Promise<T> {
  const socket = socketPath(root, dispatchId);
  if (process.platform !== "win32") {
    const stat = lstatSync(socket);
    if (!stat.isSocket() || stat.uid !== process.getuid?.() || stat.mode & 0o077) throw new Error("Invalid private host socket");
  }
  const token = process.platform === "win32" ? readPrivate<HostState>(join(hostDirectory(root, dispatchId), "state.json"))?.ipcToken : undefined;
  if (process.platform === "win32" && !token) throw new Error("Missing local host authorization");
  return new Promise((resolve, reject) => {
    const client = request({ socketPath: socket, path, method: "POST", timeout: 120_000, ...(signal ? { signal } : {}), headers: { "Content-Type": "application/json", ...(token ? { "X-MissionGo-Host-Token": token } : {}) } }, (response) => {
      let text = ""; response.setEncoding("utf8"); response.on("data", (part: string) => {
        text += part; if (text.length > 32 * 1024 * 1024) client.destroy(new Error("Oversized host snapshot"));
      });
      response.on("end", () => { try { if (response.statusCode !== 200) throw new HostHTTPError(response.statusCode ?? 500); resolve(JSON.parse(text)); } catch (error) { reject(error); } });
    });
    client.on("timeout", () => client.destroy(new Error("Local host response timed out")));
    client.on("error", reject); client.end(JSON.stringify(body));
  });
}
export async function runHost(root: string, dispatchId: string): Promise<void> {
  privateDir(root);
  const directory = hostDirectory(root, dispatchId);
  const statePath = join(directory, "state.json");
  const state = readPrivate<HostState>(statePath);
  if (!state || state.phase !== "starting" || state.pid !== 0) throw new Error("Host launch is already consumed; inspect the original session");
  state.pid = process.pid; savePrivate(statePath, state);
  const job: Dispatch = state.dispatch;
  const config = loadConfig(root);
  const agent = config.agents[job.agentKind];
  if (!agent) throw new Error("Agent is not enabled locally");
  let adapter: Adapter | undefined;
  let launchFinished = false;
  const measurement=new NativePerformance();
  const persist = () => savePrivate(statePath, state);
  const socket = socketPath(root, dispatchId);
  // No deleting stale sockets or reusing hosts with a different native identity.
  if (existsSync(socket)) throw new Error("Host socket already exists");
  let queue = Promise.resolve();
  let controlEpoch = 0;
  const decisions = new Set<string>();
  const server = createServer((req, res) => {
    if (process.platform === "win32") {
      const supplied = req.headers["x-missiongo-host-token"];
      if (typeof supplied !== "string" || !state.ipcToken || Buffer.byteLength(supplied) !== Buffer.byteLength(state.ipcToken)
        || !timingSafeEqual(Buffer.from(supplied), Buffer.from(state.ipcToken))) { res.writeHead(403).end(); return; }
    }
    let body = "";
    req.setEncoding("utf8"); req.on("data", (part: string) => { body += part; if (body.length > 1024 * 1024) req.destroy(); });
    req.on("end", () => {
      if (req.method === "POST" && req.url === "/capabilities") {
        res.writeHead(200, {"Content-Type":"application/json"}).end(JSON.stringify({protocol:1})); return;
      }
      if (req.method === "POST" && req.url === "/observe") {
        const epoch = controlEpoch;
        void (async () => {
          try {
            const session = JSON.parse(body) as Session;
            if (!adapter || !launchFinished || state.phase !== "launched" || session.sessionRef !== state.sessionRef) throw new Error("Native session identity mismatch");
            const snapshot = boundedSnapshot(await adapter.snapshot());
            snapshot.performance=measurement.reports(snapshot);
            if (epoch === controlEpoch) { state.snapshot = snapshot; persist(); }
            res.writeHead(200, {"Content-Type":"application/json"}).end(JSON.stringify(snapshot));
          } catch { res.writeHead(409).end(); }
        })(); return;
      }
      // History reads do not enter the command queue or write its journal.
      if (req.method === "POST" && req.url === "/history") {
        void (async () => {
          try {
            if (!launchFinished || state.phase !== "launched") throw new Error("History source unavailable");
            const result = await readHostHistory(adapter, state.sessionRef, JSON.parse(body));
            res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(result));
          } catch { res.writeHead(409).end(); }
        })();
        return;
      }
      queue = queue.then(async () => {
        if (req.method !== "POST" || !["/sync", "/control", "/managed-start", "/managed-stop"].includes(req.url ?? "")) { res.writeHead(404).end(); return; }
        try {
          const session = JSON.parse(body) as Session;
          controlEpoch++;
          if (!adapter || !launchFinished || state.phase !== "launched") { res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(state.snapshot)); return; }
          if (session.sessionRef && session.sessionRef !== state.sessionRef) throw new Error("Native session identity mismatch");
          if (state.managedJob) {
            const intent = state.managedJob.intent; const binding = session.managedExecution;
            if (!binding || binding.id !== intent.id || binding.generation !== intent.generation || binding.stageId !== intent.stageId || binding.runId !== intent.binding.runId || binding.role !== intent.binding.role) throw new Error("Managed host binding differed");
            if (req.url === "/managed-start") {
              if (state.managedStartAttempted && !state.managedStarted) throw new Error("Managed first-turn delivery is unconfirmed; no retry");
              if (!state.managedStarted) {
                state.managedStartAttempted = true; persist();
                if (!adapter.startManagedTurn) throw new Error("Managed adapter unavailable");
                await adapter.startManagedTurn(); state.managedStarted = true; persist();
              }
            } else if (req.url === "/managed-stop") {
              if (!adapter.stopManagedTurn) throw new Error("Managed stop protocol unavailable");
              await adapter.stopManagedTurn();
            } else if (!state.managedStarted && session.command) throw new InputRejected("Managed first turn has not been permitted");
          } else if (!["/sync", "/control"].includes(req.url ?? "")) throw new Error("Not a managed host");
          if (session.desiredSettings && session.desiredSettings.revision > (state.snapshot.settingsRevision ?? 0)) {
            try {
              if (!adapter.settings) throw new Error("Runtime settings unsupported");
              await adapter.settings(session.desiredSettings); delete state.snapshot.settingsError;
            } catch (error) { state.snapshot.settingsError = safeError(error); }
            state.snapshot.settingsRevision = session.desiredSettings.revision;
          }
          if (session.approvalDecision && !decisions.has(session.approvalDecision.id)) {
            await adapter.decide(session.approvalDecision); decisions.add(session.approvalDecision.id);
          }
          if (session.approvalRetry && !session.command) {
            const retry = session.approvalRetry; const key = id(retry.id);
            state.snapshot.approvalRetryId = key;
            if (retry.status === "queued" && !state.commands[key]) {
              state.commands[key] = { status: "delivering" }; persist();
              try {
                if (!adapter.retryApproval) throw new InputRejected("Native approval retry unsupported");
                await adapter.retryApproval(retry); state.commands[key] = { status: "delivered" };
              } catch (error) { state.commands[key] = { status: error instanceof InputRejected ? "failed" : "delivering", error: safeError(error) }; }
              persist();
            }
            const outcome = state.commands[key];
            if (outcome) {
              state.snapshot.approvalRetryStatus = outcome.status;
              if (outcome.error) state.snapshot.approvalRetryError = outcome.error;
              else delete state.snapshot.approvalRetryError;
            }
            if (retry.status === "delivered" && !(await adapter.snapshot()).turnActive && session.approvalReviewMode && adapter.settings) {
              await adapter.settings({ revision: 0, mode: session.approvalReviewMode }); state.snapshot.approvalRetryStatus = "restored";
            }
          }
          if (session.archiveInSource || session.restoreInSource || session.lifecycle === "close") {
            delete state.snapshot.sourceArchived; delete state.snapshot.sourceRestored; delete state.snapshot.sourceArchiveError;
            try {
              if (!adapter.archive) throw new InputRejected("Source archiving is not supported by this Agent");
              await adapter.archive(session.restoreInSource === true);
              state.snapshot.sourceArchived = !session.restoreInSource;
              if (session.restoreInSource) state.snapshot.sourceRestored = true;
            } catch (error) { state.snapshot.sourceArchiveError = safeError(error); }
          }
          const command = session.command;
          let stopSnapshot: Snapshot | undefined;
          if (command && ["queued", "delivering"].includes(command.status)) {
            const key = id(command.id);
            if (!state.commands[key]) {
              if (Object.keys(state.commands).length >= 10_000) throw new Error("Session command journal is full; start a new explicitly authorized conversation");
              // The server-side delivery reservation is made by the parent before IPC.
              // The local journal is durable BEFORE any native input side effect.
              state.commands[key] = { status: "delivering" }; persist();
              if(command.kind!=="interrupt")measurement.begin(key);
              try {
                if (command.attachments?.some((attachment) => !attachment.localPath)) throw new InputRejected("Attachment download was not completed");
                if (command.kind === "interrupt") stopSnapshot = await adapter.stop(command);
                else {await adapter.deliver(command, { controlOnly: state.snapshot.settingsError !== undefined });measurement.delivered(key,adapter.performanceTurn?.(key));}
                if (command.kind === "interrupt" && stopSnapshot) stopSnapshot.stopConfirmed = true;
                state.commands[key] = { status: "delivered", ...(stopSnapshot?.stopConfirmed ? { stopConfirmed: true } : {}) };
              } catch (error) { measurement.failed(key); state.commands[key] = { status: command.kind === "interrupt" || error instanceof InputRejected ? "failed" : "delivery_unknown", error: safeError(error) }; }
              persist();
            }
            const outcome = state.commands[key]!;
            state.snapshot.commandId = key; state.snapshot.commandStatus = outcome.status;
            if (outcome.stopConfirmed) state.snapshot.stopConfirmed = true;
            else delete state.snapshot.stopConfirmed;
            if (outcome.error) state.snapshot.commandError = outcome.error; else delete state.snapshot.commandError;
          }
          let snapshot: Snapshot;
          try { snapshot = boundedSnapshot(stopSnapshot ?? (["/control", "/managed-stop"].includes(req.url ?? "")
            ? adapter.controlSnapshot ? await adapter.controlSnapshot() : { ...state.snapshot, messages: [] }
            : await adapter.snapshot())); }
          catch (error) {
            if (req.url !== "/control" && command?.kind !== "interrupt") throw error;
            // The durable command outcome is already known. An observation
            // failure must not hide that receipt or replay the native input.
            snapshot = { status: "unavailable", messages: [], error: safeError(error) };
          }
          if (!snapshot.error) delete state.snapshot.error;
          if (!snapshot.failure) delete state.snapshot.failure;
          if (!snapshot.approval) delete state.snapshot.approval;
          snapshot.performance=measurement.reports(snapshot);
          state.snapshot = { ...state.snapshot, ...snapshot }; persist();
          res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(state.snapshot));
        } catch (error) { res.writeHead(409, { "Content-Type": "application/json" }).end(JSON.stringify({ error: safeError(error) })); }
      }).catch(() => { if (!res.writableEnded) res.writeHead(500).end(); });
    });
  });
  const shutdown = () => {
    server.close();
    if (adapter) void adapter.close().finally(() => process.exit(0));
    else process.exit(0);
  };
  process.once("SIGTERM", shutdown); process.once("SIGINT", shutdown);
  try {
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(socket, () => { if (process.platform !== "win32") chmodSync(socket, 0o600); resolve(); }); });
    const launch = await resolveAgentLaunch(job.agentKind, agent);
    const localSkill = job.agentKind === "codex" && !state.managedJob ? skillVersion(readFileSync(skillPaths("codex", launch.env)[0]!, "utf8")) : undefined;
    if (job.agentKind === "codex" && !state.managedJob && !localSkill) throw new Error("Install the current MissionGo Skill before dispatching Codex");
    if (job.agentKind === "claude_code") {
      // Resolve inside the detached host, never serialize secrets into state or mutate the node's environment.
      await probe(launch.executable, ["--version"], job.repoPath, launch.env);
      const expected = readPrivate<{ agents?: { kind: string; skill?: { expectedVersion?: string } }[] }>(join(root, "status.json"))
        ?.agents?.find((value) => value.kind === "claude_code")?.skill?.expectedVersion;
      await syncSkill("claude_code", config.server!, expected, launch.env);
      adapter = new ClaudeAdapter(job, launch.executable, launch.env);
    } else adapter = job.agentKind === "codex" ? new CodexAdapter(job, launch.executable, localSkill, launch.env) : new OpenCodeAdapter(job, new OpenCodeAPI(agent.serviceRegistration, launch.env));
    if (state.managedJob) {
      if (!adapter.prepareManaged) throw new Error("Managed adapter unavailable");
      state.managedReceipt = await adapter.prepareManaged(state.managedJob); state.sessionRef = state.managedReceipt.sessionRef;
    } else state.sessionRef = await adapter.start(state.external ? state.initialPrompt ?? "" : launchPrompt(job));
    saveBinding(root, { kind: job.agentKind, sessionRef: state.sessionRef, dispatchId, ...(config.nodeId ? { nodeId: config.nodeId } : {}), ...(state.external ? { external: true } : {}), ...(state.managedJob ? { managed: true } : {}) });
    delete state.initialPrompt;
    if (adapter.initialTurnId) state.initialTurnId = adapter.initialTurnId;
    state.phase = "launched"; state.snapshot = boundedSnapshot(await adapter.snapshot()); launchFinished = true; persist();
  } catch (error) {
    await adapter?.close().catch(() => {});
    state.phase = "failed"; state.launchError = safeError(error);
    state.snapshot = { status: "failed", messages: [], error: state.launchError }; persist(); server.close();
    process.exitCode = 1;
  }
}
