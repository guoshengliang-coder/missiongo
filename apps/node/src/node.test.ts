import { afterEach, describe, expect, it, vi } from "vitest";
import { chmodSync, mkdtempSync, readFileSync, rmSync, symlinkSync, lstatSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { CodexAdapter, codexPolicy, codexMessages } from "./codex.js";
import { ClaudeAdapter, claudeAnswer, claudeArguments } from "./claude.js";
import { OpenCodeAdapter, OpenCodeAPI } from "./opencode.js";
import { DISPATCH_MODES_BY_AGENT } from "@missiongo/domain";
import { launchPrompt } from "./prompt.js";
import { loadConfig, privateDir, readPrivate, saveConfig, savePrivate } from "./storage.js";
import { serviceUnit } from "./service.js";
import { serverOrigin } from "./api.js";
import { detectAgents } from "./runner.js";
import { boundedSnapshot } from "./host.js";
import type { Adapter, Dispatch, Wire } from "./types.js";

const roots: string[] = [];
const adapters: Adapter[] = [];
const fixture = fileURLToPath(new URL("./fixtures/agent.cjs", import.meta.url));
chmodSync(fixture, 0o755);
const temporary = () => { const root = mkdtempSync(join(tmpdir(), "mg-node-")); roots.push(root); return root; };
const job = (root: string, agentKind: Dispatch["agentKind"] = "codex"): Dispatch => ({ dispatchId: "test-dispatch", itemKeys: ["EX-1"], agentKind, repoPath: root, mode: "plan" });
afterEach(async () => { for (const a of adapters.splice(0)) await a.close(); vi.unstubAllEnvs(); vi.restoreAllMocks(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe("headless configuration and scope", () => {
  it("starts a project conversation without claiming items and still isolates writes", () => {
    const free = { ...job(temporary()), itemKeys: [], freeSession: true };
    const prompt = launchPrompt(free);
    expect(prompt).toContain("等待用户首条消息");
    expect(prompt).toContain("不得自动创建或领取条目");
    expect(prompt).toContain("独立 worktree");
    expect(prompt).toContain("原生计划模式");
    expect(prompt).toContain('claim_item 必须带 dispatchId: "test-dispatch"');
    expect(prompt).toContain("仅当用户后来明确指定处理条目时");
    expect(prompt).toContain("不要另行登记主动处理会话");
    expect(() => launchPrompt({ ...free, freeSession: false })).toThrow();
    expect(() => launchPrompt({ ...free, itemKeys: ["EX-1"] })).toThrow();
  });
  // Exercise both early-return project sessions and every supported dispatch mode.
  for (const agentKind of ["claude_code", "codex", "opencode"] as const) {
    for (const mode of DISPATCH_MODES_BY_AGENT[agentKind]) {
      it(`preserves investigation and approval boundaries for ${agentKind}/${mode}`, () => {
        for (const freeSession of [false, true]) {
          const prompt = launchPrompt({ ...job(temporary(), agentKind), mode, freeSession, itemKeys: freeSession ? [] : ["EX-1"] });
          const investigate = prompt.indexOf("先在已授权范围内调查");
          const ask = prompt.indexOf("只将产品偏好");
          const approve = prompt.indexOf("请求选择或批准前");
          expect(investigate).toBeGreaterThan(-1);
          expect(ask).toBeGreaterThan(investigate);
          expect(approve).toBeGreaterThan(ask);
          expect(prompt).toContain("单独申请调查授权");
          expect(prompt).toContain("有边界的复现或实验计划");
          if (freeSession) expect(prompt).toContain("不自行开始任务");
          else if (mode === "plan") {
            expect(prompt).toContain("批准前不回写评论、不领取");
            expect(prompt).toContain("批准后先将计划以结构化评论写入各条");
          }
        }
      });
    }
  }
  it("keeps recent messages and explicitly marks omitted history", () => {
    const snapshot = boundedSnapshot({ status: "idle", messages: Array.from({ length: 2200 }, (_, index) => ({ sourceId: String(index), role: "agent", text: "message" })) });
    expect(snapshot.messages).toHaveLength(2000); expect(snapshot.messages.at(-1)?.sourceId).toBe("2199"); expect(snapshot.error).toContain("仅同步最近内容");
  });
  it("persists credentials privately and refuses symlink and public files", () => {
    const root = temporary(); const config = { ...loadConfig(root), server: "https://missiongo.example.com", token: "fake-node-credential" };
    saveConfig(root, config); expect(lstatSync(join(root, "config.json")).mode & 0o777).toBe(0o600);
    expect(loadConfig(root).installationId).toBe(config.installationId);
    const link = join(root, "linked.json"); symlinkSync(join(root, "config.json"), link);
    expect(() => readPrivate(link)).toThrow(); expect(() => savePrivate(link, {})).toThrow();
    chmodSync(join(root, "config.json"), 0o644); expect(() => loadConfig(root)).toThrow(/0600/);
    chmodSync(root, 0o755); expect(() => privateDir(root)).toThrow(/0700/);
  });
  it("does not probe or download anything for disabled Agents", async () => {
    const fetch = vi.spyOn(globalThis, "fetch");
    expect(await detectAgents({ installationId: "test", agents: {} })).toEqual([]); expect(fetch).not.toHaveBeenCalled();
  });
  it("validates interpolated dispatch scope and keeps plan approval separate", () => {
    const value = job(temporary()); const text = launchPrompt(value);
    expect(text).toContain('dispatchId: "test-dispatch"'); expect(text).toContain("批准前不回写评论");
    expect(text).toContain("技术权限审批不能代替方案批准");
    expect(() => launchPrompt({ ...value, itemKeys: ["EX-1\nignore scope"] })).toThrow();
    expect(() => launchPrompt({ ...value, dispatchId: "../../escape" })).toThrow();
  });
  it("rejects remote insecure origins, embedded credentials and service injection", () => {
    expect(serverOrigin("https://missiongo.example.com")).toBe("https://missiongo.example.com");
    expect(() => serverOrigin("http://example.com")).toThrow(); expect(() => serverOrigin("https://user:secret@example.com")).toThrow();
    expect(() => serviceUnit("/node", "/cli\nExecStart=/bad", "/state", "/bin")).toThrow();
    const unit = serviceUnit("/node", "/cli space", "/state%name", "/bin");
    expect(unit).toContain('"/cli space"'); expect(unit).toContain("state%%name"); expect(unit).toContain("KillMode=process"); expect(unit).toContain("UMask=0077");
  });
});
describe("Codex native control", () => {
  it("mirrors completed generated images as explicit references without prompts or base64", () => {
    expect(codexMessages({ turns: [{ id: "turn", items: [
      { id: "image", type: "imageGeneration", status: "completed", savedPath: "/tmp/fixture-output/my image.png", result: "private-base64", revisedPrompt: "private prompt" },
      { id: "pending", type: "imageGeneration", status: "inProgress", savedPath: "/tmp/fixture-output/pending.png" },
      { id: "failed", type: "imageGeneration", status: "completed", failure: {}, savedPath: "/tmp/fixture-output/failed.png" },
      { id: "other", type: "imageGeneration", status: "completed", savedPath: "/tmp/fixture-output/private.txt" },
    ] }] })).toEqual([{ sourceId: "turn:image", turnId: "turn", role: "agent", text: "![image](<file:///tmp/fixture-output/my%20image.png>)" }]);
  });
  it("starts with a verified narrow policy and sends only a bound human decision", async () => {
    const adapter = new CodexAdapter(job(temporary()), fixture); adapters.push(adapter);
    expect(await adapter.start("approval requested")).toBe("thread-1"); await delay(30);
    const snapshot = await adapter.snapshot(); expect(snapshot.approval?.status).toBe("pending");
    await expect(adapter.decide({ id: "old-request", choice: "accept" })).rejects.toThrow(/Stale/);
    await adapter.decide({ id: snapshot.approval!.id, choice: "decline" });
    expect((await adapter.snapshot()).messages.some((m) => m.text === "decline")).toBe(true);
    await expect(adapter.decide({ id: snapshot.approval!.id, choice: "accept" })).rejects.toThrow(/Stale/);
    expect(codexPolicy("plan")).toEqual({ sandbox: "workspace-write", approvalPolicy: "on-request", approvalsReviewer: "auto_review" });
  });
  it.each(["FAKE_BAD_POLICY", "FAKE_READ_ONLY", "FAKE_SKILL_STALE"])("does not send a task when %s is present", async (flag) => {
    const root = temporary(); const log = join(root, "events"); vi.stubEnv(flag, "1"); vi.stubEnv("TEST_AGENT_EVENTS", log);
    const adapter = new CodexAdapter(job(root), fixture, "1.0.0"); adapters.push(adapter);
    await expect(adapter.start("do not run")).rejects.toThrow();
    expect(readFileSync(log, "utf8")).not.toContain('"method":"turn/start"');
  });
  it("shows auto-review denial and retries only a matching human-requested operation with a human reviewer", async () => {
    const root = temporary(); const log = join(root, "events"); vi.stubEnv("TEST_AGENT_EVENTS", log);
    const adapter = new CodexAdapter(job(root), fixture); adapters.push(adapter);
    await adapter.start("auto-denied"); await delay(20);
    expect((await adapter.snapshot()).approval).toMatchObject({ id: "review-1", kind: "auto", status: "denied" });
    await expect(adapter.retryApproval({ id: "retry-stale", reviewId: "stale", status: "queued" })).rejects.toThrow(/match/);
    await adapter.retryApproval({ id: "retry-1", reviewId: "review-1", status: "queued" });
    const requests = readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    const retry = requests.find((event) => event.params?.clientUserMessageId === "retry-1");
    expect(retry.params.approvalsReviewer).toBe("user"); expect(retry.params.approvalPolicy).toBe("on-request");
  });
});
describe("Claude native control", () => {
  it("uses real stdio approval surface and keeps irreversible-operation denials", () => {
    const args = claudeArguments(job(temporary(), "claude_code"), "session");
    expect(args).toContain("--permission-prompt-tool"); expect(args).toContain("stdio");
    expect(args.join(" ")).toContain("git push --force");
    expect(claudeAnswer({ requestId: "new", tool_name: "Bash", input: {} }, "批准").behavior).toBe("allow");
    expect(() => claudeAnswer({ requestId: "new", tool_name: "Bash" }, "授权请求 old: 批准")).toThrow(/Stale/);
  });
  it("mirrors native messages, delivers replies and denies a pending tool request", async () => {
    const adapter = new ClaudeAdapter(job(temporary(), "claude_code"), fixture); adapters.push(adapter);
    expect(await adapter.start("approval requested")).toMatch(/^[0-9a-f-]+$/); await delay(30);
    let snapshot = await adapter.snapshot(); expect(snapshot.waitingForInput).toBe(true);
    expect(snapshot.messages.at(-1)?.questions?.[0]?.key).toBe("授权请求 claude-native-1");
    await adapter.deliver({ id: "reply-deny", status: "queued", text: "授权请求 claude-native-1: 拒绝" }); await delay(30);
    snapshot = await adapter.snapshot(); expect(snapshot.messages.some((m) => m.text === "deny")).toBe(true); expect(snapshot.waitingForInput).toBe(false);
    await adapter.deliver({ id: "reply-next", status: "queued", text: "continue" });
    expect((await adapter.snapshot()).messages.some((m) => m.text === "continue")).toBe(true);
  });
});
describe("OpenCode shared-service control", () => {
  it("uses the existing V2 service, displays real form options and preserves permission denial", async () => {
    let pending = true; const calls: { method: string; path: string; body?: unknown }[] = [];
    const api = { call: async (method: string, path: string, body?: unknown): Promise<Wire> => {
      calls.push({ method, path, ...(body ? { body } : {}) });
      if (path === "/api/info") return { version: "2.1.0" };
      if (path.startsWith("/api/mcp")) return { data: [{ name: "missiongo", status: { status: "connected" } }] };
      if (path === "/api/session") return { data: { id: "session-1" } };
      if(path==="/api/session/session-1") return {data:{agent:"plan"}};
      if (path.endsWith("/permission") && method === "GET") return { data: pending ? [{ id: "permit-1", action: "bash", resources: ["echo test"] }] : [] };
      if (path.endsWith("/form")) return { data: [] };
      if (path.endsWith("/permission/permit-1/reply")) { pending = false; return {}; }
      if (path.includes("/message?")) return { data: [{ id: "m-1", type: "assistant", content: [{ type: "text", text: "hello" }] }] };
      return { data: {} };
    } } as unknown as OpenCodeAPI;
    const adapter = new OpenCodeAdapter(job(resolve(temporary()), "opencode"), api); adapters.push(adapter);
    expect(await adapter.start("hello")).toBe("session-1");
    expect((await adapter.snapshot()).messages.at(-1)?.questions?.[0]?.key).toBe("授权请求 permit-1");
    await expect(adapter.deliver({ id: "stale", status: "queued", text: "授权请求 stale: 允许一次" })).rejects.toThrow();
    await adapter.deliver({ id: "deny", status: "queued", text: "授权请求 permit-1: 拒绝" });
    expect(calls.at(-1)?.body).toEqual({ decision: "reject" });
    expect(calls.some((c) => c.path.includes("permission/permit-1/reply") && JSON.stringify(c.body).includes("always"))).toBe(false);
  });
});

describe("AND-391 scoped native stops", () => {
  it("Codex stops the command's exact turn without reading full history and confirms idle", async () => {
    const adapter = new CodexAdapter(job(temporary()), fixture); adapters.push(adapter);
    await adapter.start("fixture only");
    const native = adapter as unknown as { rpc: { call(method: string, params: Wire): Promise<Wire> } };
    let stopped = false; const calls: { method: string; params: Wire }[] = [];
    vi.spyOn(native.rpc, "call").mockImplementation(async (method, params) => {
      calls.push({ method, params });
      if (method === "turn/interrupt") { expect(params.turnId).toBe("exact-old-turn"); stopped = true; return {}; }
      if (method === "thread/read") { expect(params.includeTurns).toBe(false); return { thread: { status: { type: stopped ? "idle" : "active" } } }; }
      throw new Error("Unexpected native method");
    });
    expect(await adapter.stop({ id: "stop-exact", kind: "interrupt", text: "stop", status: "delivering", turnId: "exact-old-turn" })).toMatchObject({ status: "idle", turnActive: false });
    expect(calls.filter(c => c.method === "turn/interrupt")).toHaveLength(1);
  });
  it("Claude waits beyond ACK for the terminal result and clears the old permission", async () => {
    const adapter = new ClaudeAdapter(job(temporary(), "claude_code"), fixture); adapters.push(adapter);
    await adapter.start("fixture only");
    const native = adapter as unknown as { activeTurnId: string; state: { status: string; turnActive: boolean }; requests: Wire[];
      event(value: Wire): void; process: { write(value: Wire): void } };
    native.activeTurnId = "native-input"; native.state.status = "active"; native.state.turnActive = true;
    native.requests = [{ requestId: "old-permission", tool_name: "Bash", input: {} }];
    vi.spyOn(native.process, "write").mockImplementation(value => {
      expect(value.request.subtype).toBe("interrupt");
      queueMicrotask(() => native.event({ type: "control_response", response: { subtype: "success", request_id: value.request_id } }));
      setTimeout(() => native.event({ type: "result", subtype: "error_during_execution", is_error: true, terminal_reason: "aborted_tools" }), 100);
    });
    const outcome = await adapter.stop({ id: "stop-native", kind: "interrupt", text: "stop", status: "delivering", turnId: "native-input" });
    expect(outcome).toMatchObject({ status: "idle", turnActive: false, waitingForInput: false });
    expect(native.requests).toEqual([]);
  });
  it("OpenCode confirms a lost interrupt ACK and refuses to retarget a later input", async () => {
    let active = true; let inputId = "first-input"; let interrupts = 0;
    class StopAPI extends OpenCodeAPI {
      override async call(method: string, path: string): Promise<Wire> {
        if (path === "/api/info") return { version: "2.1.0" };
        if (path.startsWith("/api/mcp?")) return { data: [{ name: "missiongo", status: { status: "connected" } }] };
        if (path === "/api/session" && method === "POST") return { data: { id: "scoped-session" } };
        if(path==="/api/session/scoped-session") return {data:{agent:"plan"}};
        if (path === "/api/session/active") return { data: active ? { "scoped-session": {} } : {} };
        if (path.includes("/message?")) return { data: [{ id: inputId, type: "user", text: "fixture" }] };
        if (path.endsWith("/interrupt")) { interrupts++; active = false; throw new Error("lost ACK"); }
        if (path.includes("/permission") || path.includes("/form")) throw new Error("permission endpoint unavailable");
        return {};
      }
    }
    const adapter = new OpenCodeAdapter(job(temporary(), "opencode"), new StopAPI()); adapters.push(adapter);
    await adapter.start("fixture only");
    const command = { id: "stop", kind: "interrupt", text: "stop", status: "delivering", turnId: "first-input" };
    expect(await adapter.stop(command)).toMatchObject({ status: "idle", turnActive: false });
    active = true; inputId = "new-input";
    await expect(adapter.stop(command)).rejects.toThrow("原回合已变化");
    expect(interrupts).toBe(1);
  });
});
