import { afterEach, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, chmodSync, existsSync, realpathSync, writeFileSync, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { API } from "./api.js";
import { hostDirectory, hostCall } from "./host.js";
import { runNode, launch } from "./runner.js";
import { loadConfig, readPrivate, saveConfig } from "./storage.js";
import type { HostState, Wire } from "./types.js";

const root = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const scratch: string[] = [];
const hosts: number[] = [];
afterEach(() => {
  vi.unstubAllEnvs(); vi.restoreAllMocks(); vi.useRealTimers();
  for (const pid of hosts.splice(0)) { try { process.kill(-pid, "SIGTERM"); } catch { /* already exited */ } }
  for (const directory of scratch.splice(0)) rmSync(directory, { recursive: true, force: true });
});

it("completes device authorization without persisting the OAuth token", async () => {
  const requests: { url: string; authorization?: string }[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = String(input); const authorization = (init?.headers as Record<string, string>)?.Authorization;
    requests.push({ url, ...(authorization ? { authorization } : {}) });
    if (url.endsWith("/oauth/register")) return Response.json({ client_id: "public-test-client" });
    if (url.endsWith("/oauth/device_authorization")) return Response.json({ device_code: "fake-device", user_code: "TEST-CODE", expires_in: 60,
      verification_uri: "https://missiongo.example.com/device", verification_uri_complete: "https://missiongo.example.com/device?code=TEST-CODE" });
    if (url.endsWith("/oauth/token")) return Response.json({ access_token: "fake-temporary-oauth", scope: "missiongo:read missiongo:node" });
    if (url.endsWith("/node/register")) return Response.json({ nodeId: "node-test", name: "Ubuntu", token: "fake-device-credential" });
    throw new Error("Unexpected route");
  });
  const display = vi.fn();
  const promise = new API("https://missiongo.example.com").login({ installationId: "install", agents: {} }, "Ubuntu", display);
  const config = await promise;
  expect(config.token).toBe("fake-device-credential"); expect(JSON.stringify(config)).not.toContain("fake-temporary-oauth");
  expect(requests.at(-1)?.authorization).toBe("Bearer fake-temporary-oauth"); expect(display).toHaveBeenCalledOnce();
}, 10_000);

it.each([false,true])("reconnects the original detached host and never replays a delivered reply (control=%s)", async modern => {
  const directory = realpathSync(mkdtempSync("/tmp/mg-cycle-")); scratch.push(directory);
  const stateRoot = join(directory, "node");
  const fixture = fileURLToPath(new URL("./fixtures/agent.cjs", import.meta.url)); chmodSync(fixture, 0o755);
  const events = join(directory, "agent-events");
  vi.stubEnv("TEST_AGENT_EVENTS", events); vi.stubEnv("HOME", directory); vi.stubEnv("CLAUDE_CONFIG_DIR", join(directory, ".claude"));
  execFileSync("git", ["init", directory], { stdio: "ignore" });
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  const environmentScript = join(directory, "gateway-env.sh"); const launcher = join(directory, "claude-launcher");
  writeFileSync(environmentScript, "export ANTHROPIC_AUTH_TOKEN=fixture-gateway-only\n", { mode: 0o600 });
  writeFileSync(launcher, `#!/bin/bash\n[ "$ANTHROPIC_AUTH_TOKEN" = fixture-gateway-only ] || exit 42\nexec ${quote(fixture)} "$@"\n`, { mode: 0o700 });
  const config = { ...loadConfig(stateRoot), server: "https://missiongo.example.com", token: "fake-node-token", agents: { claude_code: { executable: launcher, environmentScript } } };
  saveConfig(stateRoot, config);
  execFileSync(process.execPath, ["scripts/build-node.mjs"], { cwd: root, stdio: "ignore" });
  const entry = join(root, "apps/node/dist/package/cli.mjs");
  let claimed = false; let ref: string | undefined; let delivered = 0; let replay = false;
  const dispatch = { dispatchId: "cycle", itemKeys: ["EX-1"], repoPath: directory, agentKind: "claude_code", mode: "default" };
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const path = new URL(String(input)).pathname; const body: Wire = init?.body ? JSON.parse(String(init.body)) : {};
    if (path === "/downloads/missiongo-skill/SKILL.md") return new Response("---\nname: missiongo\nversion: 1.0.0\n---\nFixture only");
    if (path.endsWith("/node/control-changes")) {
      if (!modern) return Response.json({error:{code:"not_found"}}, {status:404});
      await delay(25); return Response.json({protocol:1,cursor:"fixture"});
    }
    if (path.endsWith("/node/heartbeat")) return Response.json({ repos: [{ productId: "product", repoPath: directory }], expectedSkillVersion: "1.0.0" });
    if (path.endsWith("/node/agent-artifacts")) return Response.json({ jobs: [] });
    if (path.endsWith("/node/agent-history")) return Response.json({ jobs: [] });
    if (path.endsWith("/claim-next")) {
      if (!claimed) { claimed = true; return Response.json(dispatch); }
      await delay(25); return new Response(null, { status: 204 });
    }
    if (path.endsWith("/permit-start")) return Response.json({ allowed: true });
    if (path.endsWith("/result")) { ref = body.sessionRef; return new Response(null, { status: 204 }); }
    if (path.endsWith("/node/agent-sessions")) return Response.json({ sessions: ref ? [{ id: "session", dispatchId: "cycle", agentKind: "claude_code", sessionRef: ref, occupiesExecutionSlot: false,
      ...(!delivered || replay ? { command: { id: "reply-unique", status: "queued", text: "single reply" } } : {}) }] : [] });
    if (path.endsWith("/snapshot")) { if (body.commandStatus === "delivered") { delivered++; replay = false; } return new Response(null, { status: 204 }); }
    throw new Error(`Unexpected test route: ${path}`);
  });
  const logs: string[] = [];
  const until = async (predicate: () => boolean) => {
    for (let n = 0; n < 120; n++) { if (predicate()) return; await delay(100); }
    throw new Error(`Timed out waiting for node behavior: ${logs.join("; ")}`);
  };
  const statePath = join(hostDirectory(stateRoot, "cycle"), "state.json");
  const firstController = new AbortController();
  const firstRun = runNode(stateRoot, entry, firstController.signal, (text) => logs.push(text));
  try { await until(() => delivered > 0); }
  finally { firstController.abort(); await firstRun;
    if (existsSync(statePath)) { const state = readPrivate<HostState>(statePath); if (state?.pid) hosts.push(state.pid); }
  }
  const state = readPrivate<HostState>(statePath)!;
  expect(state.phase).toBe("launched");
  replay = true;
  const secondController = new AbortController();
  const secondRun = runNode(stateRoot, entry, secondController.signal, () => {});
  try { await until(() => delivered > 1); }
  finally { secondController.abort(); await secondRun; }
  expect(readPrivate<HostState>(statePath)?.pid).toBe(state.pid);
  expect(existsSync(events)).toBe(true);
  const inputs = readFileSync(events, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  expect(inputs.filter((event) => event.type === "user" && event.uuid === "reply-unique")).toHaveLength(1);
}, 30_000);

it("delivers input through the real detached host while its full native history read takes two seconds", async()=>{
  const directory=realpathSync(mkdtempSync("/tmp/mg-host-lanes-"));scratch.push(directory);
  const stateRoot=join(directory,"node"), fixture=fileURLToPath(new URL("./fixtures/agent.cjs",import.meta.url));
  const events=join(directory,"events"), gate=join(directory,"slow-history");
  vi.stubEnv("HOME",directory);vi.stubEnv("CODEX_HOME",join(directory,".codex"));
  vi.stubEnv("TEST_AGENT_EVENTS",events);vi.stubEnv("TEST_HISTORY_GATE",gate);vi.stubEnv("TEST_FAIL_CONTROL_OBSERVATION","1");
  const skills=join(directory,".codex/skills/missiongo");mkdirSync(skills,{recursive:true});
  writeFileSync(join(skills,"SKILL.md"),"---\nname: missiongo\nversion: 1.0.0\n---\nFixture only");
  execFileSync("git",["init",directory],{stdio:"ignore"});
  saveConfig(stateRoot,{...loadConfig(stateRoot),server:"https://missiongo.example.com",token:"synthetic",agents:{codex:{executable:fixture}}});
  execFileSync(process.execPath,["scripts/build-node.mjs"],{cwd:root,stdio:"ignore"});
  const state=await launch(stateRoot,{dispatchId:"host-lanes",itemKeys:["EX-1"],repoPath:directory,agentKind:"codex",mode:"default"},join(root,"apps/node/dist/package/cli.mjs"));
  if(state.pid)hosts.push(state.pid);expect(state.phase).toBe("launched");
  const initial=readFileSync(events,"utf8").trim().split("\n").length;
  writeFileSync(gate,"hold");let mirrorDone=false;
  const session={id:"session",dispatchId:"host-lanes",sessionRef:state.sessionRef!,agentKind:"codex" as const};
  const mirror=hostCall(stateRoot,"host-lanes",session,"observation").finally(()=>{mirrorDone=true;});
  await vi.waitFor(()=>expect(readFileSync(events,"utf8").trim().split("\n").slice(initial)
    .some(line=>JSON.parse(line).method==="thread/items/list")).toBe(true));
  const input={...session,command:{id:"command-once",text:"single input",status:"delivering"}};
  const result=await hostCall(stateRoot,"host-lanes",input,"control");
  expect(result.commandStatus).toBe("delivered");expect(result.status).toBe("unavailable");expect(mirrorDone).toBe(false);
  await hostCall(stateRoot,"host-lanes",input,"control");await mirror;
  const turns=readFileSync(events,"utf8").trim().split("\n").map(line=>JSON.parse(line));
  expect(turns.filter(event=>event.method==="turn/start"&&event.params.clientUserMessageId==="command-once")).toHaveLength(1);
},15_000);
