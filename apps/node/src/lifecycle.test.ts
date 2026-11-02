import { afterEach, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, chmodSync, existsSync, realpathSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { API } from "./api.js";
import { hostDirectory } from "./host.js";
import { runNode } from "./runner.js";
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

it("reconnects the original detached host after a node restart and never replays a delivered reply", async () => {
  const directory = realpathSync(mkdtempSync("/tmp/mg-cycle-")); scratch.push(directory);
  const stateRoot = join(directory, "node");
  const fixture = fileURLToPath(new URL("./fixtures/agent.cjs", import.meta.url)); chmodSync(fixture, 0o755);
  const events = join(directory, "agent-events");
  vi.stubEnv("TEST_AGENT_EVENTS", events); vi.stubEnv("HOME", directory); vi.stubEnv("CLAUDE_CONFIG_DIR", join(directory, ".claude"));
  execFileSync("git", ["init", directory], { stdio: "ignore" });
  const config = { ...loadConfig(stateRoot), server: "https://missiongo.example.com", token: "fake-node-token", agents: { claude_code: { executable: fixture } } };
  saveConfig(stateRoot, config);
  execFileSync(process.execPath, ["scripts/build-node.mjs"], { cwd: root, stdio: "ignore" });
  const entry = join(root, "apps/node/dist/package/cli.mjs");
  let claimed = false; let ref: string | undefined; let delivered = 0; let replay = false;
  const dispatch = { dispatchId: "cycle", itemKeys: ["EX-1"], repoPath: directory, agentKind: "claude_code", mode: "default" };
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const path = new URL(String(input)).pathname; const body: Wire = init?.body ? JSON.parse(String(init.body)) : {};
    if (path === "/downloads/missiongo-skill/SKILL.md") return new Response("---\nname: missiongo\nversion: 1.0.0\n---\nFixture only");
    if (path.endsWith("/node/heartbeat")) return Response.json({ repos: [{ productId: "product", path: directory }], expectedSkillVersion: "1.0.0" });
    if (path.endsWith("/claim-next")) {
      if (!claimed) { claimed = true; return Response.json(dispatch); }
      await delay(25); return new Response(null, { status: 204 });
    }
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
