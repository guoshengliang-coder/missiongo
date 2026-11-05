import { afterEach, expect, it, vi } from "vitest";
import { chmodSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { CodexAdapter } from "./codex.js";
import { ClaudeAdapter } from "./claude.js";
import { OpenCodeAdapter, type OpenCodeAPI } from "./opencode.js";
import type { Adapter, Dispatch, Wire } from "./types.js";

const fixture = fileURLToPath(new URL("./fixtures/agent.cjs", import.meta.url));
const roots: string[] = [], adapters: Adapter[] = [];
const job = (agentKind: Dispatch["agentKind"] = "codex"): Dispatch => {
  const root = realpathSync(mkdtempSync("/tmp/mg-settings-")); roots.push(root); chmodSync(fixture, 0o755);
  return { dispatchId: "settings", itemKeys: [], freeSession: true, repoPath: root, agentKind, mode: "auto" };
};
afterEach(async () => {
  for (const adapter of adapters.splice(0)) await adapter.close();
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

it("updates loaded Codex permissions explicitly and verifies both read-only and workspace modes", async () => {
  const dispatch = job(), events = join(dispatch.repoPath, "wire");
  vi.stubEnv("FAKE_IGNORE_RESUME", "1"); vi.stubEnv("TEST_AGENT_EVENTS", events);
  const adapter = new CodexAdapter(dispatch, fixture);
  adapters.push(adapter); await adapter.start("fixture only");
  await adapter.settings({ revision: 1, mode: "read-only", planning: true });
  expect((await adapter.snapshot()).mode).toBe("read-only");
  await adapter.settings({ revision: 2, mode: "auto", planning: false });
  expect((await adapter.snapshot()).mode).toBe("auto");
  const updates = readFileSync(events, "utf8").trim().split("\n").map(line => JSON.parse(line)).filter(x => x.method === "thread/settings/update");
  expect(updates).toHaveLength(2);
  expect(updates[0].params).toMatchObject({ approvalPolicy: "on-request", approvalsReviewer: "user", sandboxPolicy: { type: "readOnly" } });
  expect(updates[1].params).toMatchObject({ approvalsReviewer: "auto_review", sandboxPolicy: { type: "workspaceWrite", networkAccess: false } });
  expect(updates[1].params.sandboxPolicy.writableRoots).toContain(dispatch.repoPath);
});

it.each(["FAKE_UNSUPPORTED_SETTINGS", "FAKE_UNCONFIRMED_UPDATE"])("refuses unverified Codex settings when %s is enabled", async flag => {
  const dispatch = job();
  vi.stubEnv("FAKE_IGNORE_RESUME", "1"); vi.stubEnv(flag, "1");
  const adapter = new CodexAdapter(dispatch, fixture);
  adapters.push(adapter); await adapter.start("fixture only");
  await expect(adapter.settings({ revision: 1, mode: "read-only", planning: true })).rejects.toThrow();
  expect((await adapter.snapshot()).mode).toBe("auto");
  await expect(adapter.deliver({ id: "blocked", text: "must not arrive", status: "delivering" }, { controlOnly: true })).rejects.toThrow(/未发送/);
});

it("keeps Claude native permission answers usable while blocking ordinary prompts", async () => {
  const dispatch = { ...job("claude_code"), mode: "acceptEdits" };
  const adapter = new ClaudeAdapter(dispatch, fixture); adapters.push(adapter);
  await adapter.start("approval requested");
  for (let n = 0; n < 100 && !(await adapter.snapshot()).waitingForInput; n++) await delay(10);
  await adapter.deliver({ id: "deny", text: "授权请求 claude-native-1: 拒绝", status: "delivering" }, { controlOnly: true });
  await expect(adapter.deliver({ id: "blocked", text: "ordinary reply", status: "delivering" }, { controlOnly: true })).rejects.toThrow(/未发送/);
});

function openFixture(ignoreModel: boolean) {
  let agent = "build", model: Wire = { providerID: "fixture", id: "old", variant: "low" };
  let replies = 0, prompts = 0, waiting = false;
  const api = { call: async (method: string, path: string, body?: Wire): Promise<Wire> => {
    if (path === "/api/info") return { version: "2.1.4" };
    if (path.startsWith("/api/mcp")) return { data: [{ name: "missiongo", status: { status: "connected" } }] };
    if (path === "/api/session") return { data: { id: "settings" } };
    if (path === "/api/session/settings") return { data: { agent, model } };
    if (path.endsWith("/agent")) agent = body!.agent;
    if (path.endsWith("/model") && !ignoreModel) model = body!.model;
    if (path.endsWith("/permission")) return { data: waiting ? [{ id: "permit", action: "fixture" }] : [] };
    if (path.endsWith("/permission/permit/reply")) { replies++; waiting = false; }
    if (path.endsWith("/prompt")) prompts++;
    return { data: [] };
  } } as unknown as OpenCodeAPI;
  return { api, wait: () => { waiting = true; }, state: () => ({ agent, model, replies, prompts }) };
}

it("requires OpenCode model/effort readback and preserves effort-only model identity", async () => {
  const source = openFixture(false), adapter = new OpenCodeAdapter({ ...job("opencode"), mode: "build" }, source.api);
  adapters.push(adapter); await adapter.start("fixture only");
  await adapter.settings({ revision: 1, model: "fixture/new", effort: "high", planning: false });
  expect(source.state().model).toEqual({ providerID: "fixture", id: "new", variant: "high" });
  await adapter.settings({ revision: 2, effort: "low" });
  expect(source.state().model).toEqual({ providerID: "fixture", id: "new", variant: "low" });
});

it("rejects an ignored OpenCode model update without losing permission responses", async () => {
  const source = openFixture(true), adapter = new OpenCodeAdapter({ ...job("opencode"), mode: "build" }, source.api);
  adapters.push(adapter); await adapter.start("fixture only");
  await expect(adapter.settings({ revision: 1, model: "fixture/new" })).rejects.toThrow(/confirm/);
  await expect(adapter.deliver({ id: "blocked", text: "must not arrive", status: "delivering" }, { controlOnly: true })).rejects.toThrow(/未发送/);
  source.wait();
  await adapter.deliver({ id: "deny", text: "授权请求 permit: 拒绝", status: "delivering" }, { controlOnly: true });
  expect(source.state()).toMatchObject({ replies: 1, prompts: 1 }); // Only the initial prompt.
});
