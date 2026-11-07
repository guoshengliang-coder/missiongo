import { afterEach, describe, expect, it, vi } from "vitest";
import { chmodSync, mkdtempSync, readFileSync, rmSync, symlinkSync, lstatSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { CodexAdapter, codexPolicy, codexMessages } from "./codex.js";
import { ClaudeAdapter, claudeAnswer, claudeArguments } from "./claude.js";
import { OpenCodeAdapter, OpenCodeAPI, openCodeMessages } from "./opencode.js";
import { DISPATCH_MODES_BY_AGENT } from "@missiongo/domain";
import { sessionName } from "./session-name.js";
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
  it("AND-404 uses the saved project title in native names and keeps legacy jobs compatible", async () => {
    const title = "修复登录 · 12345678";
    const project = { ...job(temporary()), freeSession: true, itemKeys: [], sessionTitle: title, nodeName: " M4 " };
    expect(sessionName(project)).toBe(`M4-${title}`);
    expect(sessionName({ ...project, sessionTitle: undefined })).toBe("M4-新会话");
    expect(sessionName({ ...project, freeSession: false, itemKeys: ["EX-1"] })).toBe("M4-EX-1");
    const args = claudeArguments({ ...project, agentKind: "claude_code" }, "fixture-ref");
    expect(args[args.indexOf("--name") + 1]).toBe(`M4-${title}`);
    const codex = new CodexAdapter(project, fixture); adapters.push(codex);
    const rpc = codex as unknown as { rpc: { call(method: string, params: Wire): Promise<Wire> } };
    const calls = vi.spyOn(rpc.rpc, "call");
    await codex.start("fixture only");
    expect(calls).toHaveBeenCalledWith("thread/name/set", { threadId: expect.any(String), name: `M4-${title}` });
    const changes: Wire[] = [];
    const api = { call: async (method: string, path: string, body: Wire) => {
      if (path === "/api/info") return { version: "2.1.0" };
      if (path.startsWith("/api/mcp?")) return { data: [{ name: "missiongo", status: { status: "connected" } }] };
      if (path === "/api/session" && method === "POST") return { data: { id: "project-native" } };
      if (method === "PATCH") { changes.push(body); return {}; }
      if (path.includes("/message?")) return { data: [] };
      return { data: { agent: "plan" } };
    } } as unknown as OpenCodeAPI;
    const open = new OpenCodeAdapter({ ...project, agentKind: "opencode" }, api); adapters.push(open);
    await open.start("fixture only");
    expect(changes).toContainEqual({ title: `M4-${title}` });
  });

  it("starts a project conversation without claiming items and still isolates writes", () => {
    const free = { ...job(temporary()), itemKeys: [], freeSession: true };
    const prompt = launchPrompt(free);
    expect(prompt).toContain("等待用户首条消息");
    expect(prompt).toContain("不得自动创建或领取条目");
    expect(prompt).toContain("独立 worktree");
    expect(prompt).toContain("所选原生权限模式");
    expect(prompt).toContain("需求登记与条目创建按用户明确授权");
    expect(prompt).not.toContain("文字同意须引导明确批准操作");
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
          expect(prompt).toContain("本机绝对路径的 Markdown 链接");
          expect(prompt).toContain("20 MiB、整份 32 MiB、最多 64 个资源");
          expect(prompt).toContain("旧 Linux 节点仅支持图片");
          expect(prompt).toContain("文件需要源节点在线");
          expect(prompt).toContain("不能按条目数量决定是否结构化");
          expect(prompt).toContain("输出可见性规范 v3");
          expect(prompt).toContain("最终答复（final_answer）");
          expect(prompt).toContain("最终答复必须自足");
          expect(prompt).not.toContain("若已在进度中展示，最终答复只");
          expect(prompt).toContain("向 request_plan_approval 提交的 plan/validation");
          expect(prompt).toContain("特别是与推荐不同的选择");
          expect(prompt).toContain("普通进度、澄清和等待提示不是正式方案");
          expect(prompt).toContain("有边界的复现或实验计划");
          if (freeSession) expect(prompt).toContain("不自行开始任务");
          else if (mode === "plan") {
            expect(prompt).toContain("领取记录任务归属，不要求方案批准");
            expect(prompt).toContain("批准后用 append_comment(planDocumentId) 将固定文档及摘要归档到各条");
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
    expect(text).toContain('dispatchId: "test-dispatch"'); expect(text).toContain("同一方案与范围只批准一次");
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
  it.each([false,true].flatMap(free=>["auto", "default", "read-only"].map(mode=>({free,mode}))))("Codex $mode preserves permissions from the first turn (free=$free)", async ({free,mode}) => {
    const root=temporary(), log=join(root,"events"); vi.stubEnv("TEST_AGENT_EVENTS",log);
    const adapter=new CodexAdapter({...job(root),itemKeys:free ? [] : ["EX-1"],freeSession:free,mode},fixture); adapters.push(adapter);
    await adapter.start("ready");
    expect((await adapter.snapshot()).mode).toBe(mode);
    await adapter.settings({revision:1,mode:"read-only",planning:true,planApproved:false});
    expect((await adapter.snapshot()).mode).toBe("read-only");
    await adapter.settings({revision:2,mode,planning:true,planApproved:false});
    await adapter.deliver({id:"ordinary-reply",status:"queued",text:"continue"});
    const requests=readFileSync(log,"utf8").trim().split("\n").map(line=>JSON.parse(line));
    expect(requests.find(r=>r.method==="thread/start").params).toMatchObject(codexPolicy(mode));
    const turns=requests.filter(r=>r.method==="turn/start");
    for(const turn of turns) {
      expect(turn.params.collaborationMode.mode).toBe("default");
      expect(turn.params.sandboxPolicy.type).toBe(mode==="read-only" ? "readOnly" : "workspaceWrite");
      expect(turn.params.approvalsReviewer).toBe(mode==="auto" ? "auto_review" : "user");
    }
  });
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
  it("AND-408 labels command prompts as permissions and answers questions without granting", async () => {
    const permissionAdapter = new CodexAdapter(job(temporary()), fixture); adapters.push(permissionAdapter);
    await permissionAdapter.start("approval requested"); await delay(30);
    expect((await permissionAdapter.snapshot()).approval).toMatchObject({ status: "pending", requestKind: "permission" });

    const adapter = new CodexAdapter(job(temporary()), fixture); adapters.push(adapter);
    await adapter.start("question requested"); await delay(30);
    const snapshot = await adapter.snapshot();
    expect(snapshot.approval).toMatchObject({ status: "pending", requestKind: "question",
      action: "选择产品偏好",
      options: [{ id: "choice-0", kind: "choice", label: "方案 A", detail: "保留原有行为" }, { id: "choice-1", kind: "choice", label: "方案 B" }] });
    await adapter.decide({ id: snapshot.approval!.id, choice: "choice-0" });
    expect((await adapter.snapshot()).approval?.status).toBe("resolved");
    const answered = (await adapter.snapshot()).messages.find((m) => m.text.startsWith("answered:"));
    expect(answered?.text).toBe('answered:{"answers":{"q-1":{"answers":["方案 A"]}}}');
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
  it.each(["批准","拒绝"])("preserves the native plan decision after answering ExitPlanMode (%s)",async text=>{
    const adapter=new ClaudeAdapter(job(temporary(),"claude_code"),fixture);adapters.push(adapter);
    await adapter.start("native-plan-fixture");
    await vi.waitFor(async()=>expect((await adapter.snapshot()).messages.some(message=>message.role==="plan")).toBe(true));
    await expect(adapter.deliver({id:"unbound",text:"批准",status:"delivering"})).rejects.toThrow("方案批准按钮");
    await adapter.deliver({id:"bound",text,status:"delivering",planApprovalRevision:"reviewed-plan"});
    const plan=(await adapter.snapshot()).messages.find(message=>message.role==="plan");
    expect(plan).toMatchObject({phase:text==="批准"?"plan_approved":"plan_declined",text:"Implement the reviewed scope and verify the original entry points."});
  });

  it.each([["批准", "accept"], ["拒绝", "decline"], ["取消", "cancel"]])("completes MCP form confirmation %s through the original request", async (choice, action) => {
    const adapter = new ClaudeAdapter(job(temporary(), "claude_code"), fixture); adapters.push(adapter);
    await adapter.start("elicitation");
    await vi.waitFor(async () => expect((await adapter.snapshot()).waitingForInput).toBe(true));
    const pending = await adapter.snapshot();
    expect(pending.messages.at(-1)?.sourceId).toBe("permission-mcp-confirm-1");
    expect(pending.messages.at(-1)?.questions?.[0]).toMatchObject({ key: "授权请求 mcp-confirm-1", options: ["批准", "拒绝", "取消"] });
    expect(pending.messages.at(-1)?.text).toContain("validation goals");
    await expect(adapter.deliver({ id: "unbound", status: "queued", text: "批准" })).rejects.toThrow(/Stale/);
    expect((await adapter.snapshot()).waitingForInput).toBe(true);
    await adapter.deliver({ id: "answer", status: "queued", text: `授权请求 mcp-confirm-1: ${choice}` });
    await vi.waitFor(async () => expect((await adapter.snapshot()).messages.some(message => message.text === action)).toBe(true));
    expect((await adapter.snapshot()).waitingForInput).toBe(false);
    expect((await adapter.snapshot()).messages.find(message => message.sourceId === "permission-mcp-confirm-1")?.questions?.[0]?.answered).toBe(choice);
    await expect(adapter.deliver({ id: "late", status: "queued", text: "授权请求 mcp-confirm-1: 批准" })).rejects.toThrow(/授权请求已变化/);
  });
  it.each(["elicitation fields", "elicitation url", "elicitation unknown"])("returns unsupported %s to the MCP caller without leaving an invisible request", async prompt => {
    const adapter = new ClaudeAdapter(job(temporary(), "claude_code"), fixture); adapters.push(adapter);
    await adapter.start(prompt);
    await vi.waitFor(async () => expect((await adapter.snapshot()).messages.some(message => message.text.includes("不支持此"))).toBe(true));
    expect((await adapter.snapshot()).waitingForInput).toBe(false);
  });
  it("does not apply a cancelled MCP answer to the next pending confirmation", async () => {
    const adapter = new ClaudeAdapter(job(temporary(), "claude_code"), fixture); adapters.push(adapter);
    await adapter.start("elicitation parallel");
    await vi.waitFor(async () => expect((await adapter.snapshot()).messages.at(-1)?.questions?.[0]?.key).toBe("授权请求 mcp-confirm-2"));
    // Wait until the source withdraws the first request, rather than just appending the second.
    await vi.waitFor(async () => expect((await adapter.snapshot()).messages.find(message => message.sourceId === "permission-mcp-confirm-1")?.questions?.[0]?.withdrawn).toBe(true));
    await expect(adapter.deliver({ id: "stale", status: "queued", text: "授权请求 mcp-confirm-1: 批准" })).rejects.toThrow(/Stale/);
    expect((await adapter.snapshot()).waitingForInput).toBe(true);
    await adapter.deliver({ id: "current", status: "queued", text: "授权请求 mcp-confirm-2: 取消" });
    await vi.waitFor(async () => expect((await adapter.snapshot()).waitingForInput).toBe(false));
  });
  it.each([false,true].flatMap(free=>["auto", "bypassPermissions", "default", "plan"].map(mode=>({free,mode}))))("Claude $mode preserves permissions from launch (free=$free)", async ({free,mode})=>{
    const input={...job(temporary(),"claude_code"),itemKeys:free ? [] : ["EX-1"],freeSession:free,mode};
    const args=claudeArguments(input,"session");
    expect(args[args.indexOf("--permission-mode")+1]).toBe(mode);
    const adapter=new ClaudeAdapter(input,fixture); adapters.push(adapter);
    await adapter.start("ready"); expect((await adapter.snapshot()).mode).toBe(mode);
    await adapter.settings({revision:1,mode:"plan",planning:true,planApproved:false});
    expect((await adapter.snapshot()).mode).toBe("plan");
    await adapter.settings({revision:2,mode,planning:true,planApproved:false});
    expect((await adapter.snapshot()).mode).toBe(mode);
  });
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
  it.each(["批准","取消"])("binds an empty confirmation's %s to its exact native form without prompting",async selected=>{
    const writes:{method:string;path:string;body?:Wire}[]=[];
    class EmptyAPI extends OpenCodeAPI {
      override async call(method:string,path:string,body?:Wire):Promise<Wire> {
        if(method!=="GET") writes.push({method,path,body});
        if(path==="/api/info") return {version:"2.1.0"};
        if(path.startsWith("/api/mcp?")) return {data:[{name:"missiongo",status:{status:"connected"}}]};
        if(path==="/api/session"&&method==="POST") return {data:{id:"empty-session"}};
        if(path==="/api/session/empty-session") return {data:{agent:"plan"}};
        if(path.endsWith("/form")&&method==="GET") return {data:[{id:"empty-form",title:"Exact reviewed scope",fields:[]}]};
        return {data:[]};
      }
    }
    const adapter=new OpenCodeAdapter(job(temporary(),"opencode"),new EmptyAPI());adapters.push(adapter);
    await adapter.start("Fixture");writes.length=0;
    const snapshot=await adapter.snapshot();
    expect(snapshot.messages.find(m=>m.sourceId==="form-empty-form")?.questions?.[0]).toMatchObject({key:"确认请求 empty-form",options:["批准","取消"]});
    await expect(adapter.deliver({id:"unbound",status:"delivering",text:"批准"})).rejects.toThrow(/确认请求/);
    await expect(adapter.deliver({id:"stale",status:"delivering",text:"确认请求 another: 批准"})).rejects.toThrow(/确认请求/);
    expect(writes).toHaveLength(0);
    await adapter.deliver({id:"bound",status:"delivering",text:`确认请求 empty-form: ${selected}`});
    expect(writes).toEqual([selected==="批准"?{method:"POST",path:"/api/session/empty-session/form/empty-form/reply",body:{answer:{}}}:{method:"DELETE",path:"/api/session/empty-session/form/empty-form",body:undefined}]);
  });

  it("keeps the latest answers when a long source exceeds the snapshot window", async () => {
    const pages: URLSearchParams[] = [];
    class HistoryAPI extends OpenCodeAPI {
      override async call(method: string, path: string): Promise<Wire> {
        if (path === "/api/info") return { version: "2.1.0" };
        if (path.startsWith("/api/mcp?")) return { data: [{ name: "missiongo", status: { status: "connected" } }] };
        if (path === "/api/session" && method === "POST") return { data: { id: "long-session" } };
        if (path === "/api/session/long-session") return { data: { agent: "plan" } };
        if (path === "/api/session/active") return { data: {} };
        if (path.includes("/message?")) {
          const query = new URL(path, "http://fixture.test").searchParams;
          if (query.get("limit") === "1") return { data: [{ id: "start", type: "user", text: "Start" }] };
          pages.push(query);
          const page = Number(query.get("cursor") ?? 0);
          return { data: Array.from({ length: 100 }, (_, index) => ({ id: `message-${5000-page*100-index}`,
            type: "assistant", content: [{ type: "text", text: `Message ${5000-page*100-index}` }] })), nextCursor: String(page+1) };
        }
        return { data: [] };
      }
    }
    const adapter = new OpenCodeAdapter(job(temporary(), "opencode"), new HistoryAPI()); adapters.push(adapter);
    await adapter.start("Fixture only");
    const snapshot = await adapter.snapshot();
    expect(snapshot.messages.at(-1)?.sourceId).toBe("message-5000");
    expect(snapshot.messages).toHaveLength(1900);
    expect(snapshot.error).toBeUndefined();
    expect(snapshot.history).toMatchObject({complete:false,cursor:expect.any(String)});
    expect(pages[0]?.get("order")).toBe("desc");
    expect(pages.slice(1).every(query => !query.has("order"))).toBe(true);
    const older=await adapter.historyPage(snapshot.history!.cursor!);
    expect(older.messages.at(-1)?.sourceId).toBe("message-3100");
    expect(older.nextCursor).toBe("20");
    expect(pages.at(-1)?.get("cursor")).toBe("19");
    expect(pages.at(-1)?.has("order")).toBe(false);

  });
  it.each([false,true].flatMap(free=>["build", "plan"].map(mode=>({free,mode}))))("OpenCode $mode preserves permissions from launch (free=$free)",async ({free,mode})=>{
    let actual="", initial="";
    const api={call:async(method:string,path:string,body?:Wire):Promise<Wire>=>{
      if(path==="/api/info") return {version:"2.1.0"};
      if(path.startsWith("/api/mcp")) return {data:[{name:"missiongo",status:{status:"connected"}}]};
      if(path==="/api/session" && method==="POST") {actual=initial=body!.agent;return {data:{id:"free"}};}
      if(path==="/api/session/free") return {data:{agent:actual}};
      if(path.endsWith("/agent")) actual=body!.agent;
      return {data:[]};
    }} as unknown as OpenCodeAPI;
    const adapter=new OpenCodeAdapter({...job(temporary(),"opencode"),itemKeys:free ? [] : ["EX-1"],freeSession:free,mode},api);adapters.push(adapter);
    await adapter.start("ready");expect(initial).toBe(mode);
    await adapter.settings({revision:1,mode:"plan",planning:true,planApproved:false});expect(actual).toBe("plan");
    await adapter.settings({revision:2,mode,planning:true,planApproved:false});expect(actual).toBe(mode);
  });
  it("uses the existing V2 service, displays real form options and preserves permission denial", async () => {
    let pending = true; let resources = ["echo test"]; const calls: { method: string; path: string; body?: unknown }[] = [];
    const api = { call: async (method: string, path: string, body?: unknown): Promise<Wire> => {
      calls.push({ method, path, ...(body ? { body } : {}) });
      if (path === "/api/info") return { version: "2.1.0" };
      if (path.startsWith("/api/mcp")) return { data: [{ name: "missiongo", status: { status: "connected" } }] };
      if (path === "/api/session") return { data: { id: "session-1" } };
      if(path==="/api/session/session-1") return {data:{agent:"plan"}};
      if (path.endsWith("/permission") && method === "GET") return { data: pending ? [{ id: "permit-1", action: "bash", resources }] : [] };
      if (path.endsWith("/form")) return { data: [] };
      if (path.endsWith("/permission/permit-1/reply")) { pending = false; return {}; }
      if (path.includes("/message?")) return { data: [{ id: "m-1", type: "assistant", content: [{ type: "text", text: "hello" }] }] };
      return { data: {} };
    } } as unknown as OpenCodeAPI;
    const adapter = new OpenCodeAdapter(job(resolve(temporary()), "opencode"), api); adapters.push(adapter);
    expect(await adapter.start("hello")).toBe("session-1");
    expect((await adapter.snapshot()).messages.at(-1)?.questions?.[0]?.key).toBe("授权请求 permit-1");
    await expect(adapter.deliver({ id: "stale", status: "queued", text: "授权请求 stale: 允许一次" })).rejects.toThrow();
    resources = ["scope-".repeat(1000), "last-resource"];
    expect((await adapter.snapshot()).messages.at(-1)?.questions?.[0]?.detail).toBe(JSON.stringify(resources));
    resources = ["x".repeat(512_001)];
    expect((await adapter.snapshot()).messages.at(-1)?.questions?.[0]?.options).toEqual(["拒绝"]);
    await expect(adapter.deliver({id:"oversize",status:"queued",text:"授权请求 permit-1: 允许一次"})).rejects.toThrow(/展示上限/);
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

it("preserves long snapshot text and never substitutes a shortened message", () => {
  const text = "  " + "正文🎉".repeat(60_000) + "\n";
  expect(boundedSnapshot({ status: "idle", messages: [{ sourceId: "long", role: "agent", text }] }).messages[0]?.text).toBe(text);
  const result = boundedSnapshot({ status: "idle", history: { complete: true }, messages: [{ sourceId: "huge", role: "agent", text: "x".repeat(4_000_001) }] });
  expect(result.messages).toEqual([]);
  expect(result.history).toMatchObject({ complete: false, error: "too_large" });
});

 it("keeps tools and private blocks out of Codex and OpenCode conversation text", () => {
  const text = '  {"aggregatedOutput":"user supplied JSON"}  ';
  expect(codexMessages({ turns: [{ id: "turn", items: [
    ...["commandExecution", "mcpToolCall", "dynamicToolCall", "fileChange", "webSearch", "reasoning"].map(type => ({ id: type, type, text: "private" })),
    { id: "reply", type: "agentMessage", phase: "commentary", text },
  ] }] }).map(message => message.text)).toEqual([text]);
  expect(openCodeMessages([{ id: "reply", type: "assistant", content: [
    { type: "tool", text: "private" }, { type: "reasoning", text: "private" }, { type: "text", text },
  ] }]).map(message => message.text)).toEqual([text]);
});

it("does not mirror Claude child tasks or internal user frames as conversation", async () => {
  const adapter = new ClaudeAdapter(job(temporary(), "claude_code"), fixture); adapters.push(adapter);
  const consume = (value: Wire) => (adapter as unknown as { event(value: Wire): void }).event(value);
  consume({ type: "assistant", uuid: "child", parent_tool_use_id: "task", message: { content: [{ type: "text", text: "internal child" }] } });
  consume({ type: "user", uuid: "injected", message: { content: "internal context" } });
  consume({ type: "user", uuid: "meta", origin: { kind: "human" }, isMeta: true, message: { content: "internal metadata" } });
  consume({ type: "user", uuid: "summary", origin: { kind: "human" }, isCompactSummary: true, message: { content: "internal summary" } });
  consume({ type: "user", uuid: "human", origin: { kind: "human" }, message: { content: "  JSON {}  " } });
  consume({ type: "assistant", uuid: "reply", message: { content: [
    { type: "thinking", text: "private" }, { type: "tool_use", text: "private" }, { type: "text", text: "Visible reply" },
  ] } });
  expect((await adapter.snapshot()).messages.map(message => message.text)).toEqual(["  JSON {}  ", "Visible reply"]);
});

it("keeps a long Claude native confirmation complete and rejects oversized or unkeyed acceptance",()=>{
  const request={subtype:"elicitation",requestId:"long-form",mode:"form",message:"完整边界".repeat(10000),requested_schema:{type:"object",properties:{},required:[],additionalProperties:false}};
  expect(claudeAnswer(request,"授权请求 long-form: 批准")).toEqual({action:"accept",content:{}});
  expect(()=>claudeAnswer(request,"批准")).toThrow();
  expect(claudeAnswer({...request,message:"x".repeat(512001)},"授权请求 long-form: 批准")).toEqual({action:"cancel"});
});


it("preserves Claude choice explanations without changing submitted labels",async()=>{
  const adapter=new ClaudeAdapter(job(temporary(),"claude_code"),fixture);adapters.push(adapter);
  const request={tool_name:"AskUserQuestion",requestId:"choices",input:{questions:[{question:"Choose",options:[{label:"A",description:"Keeps history"},{label:"B",description:"Needs migration"}]}]}};
  (adapter as unknown as {requests:Wire[]}).requests=[request];
  const question=(await adapter.snapshot()).messages.at(-1)?.questions?.[0];
  expect(question).toMatchObject({options:["A","B"],detail:"A: Keeps history\nB: Needs migration"});
  expect(claudeAnswer(request,"A").updatedInput.answers).toEqual({Choose:"A"});
});

it("preserves OpenCode field and option explanations and still sends source option values",async()=>{
 const writes:Wire[]=[];
 class FormAPI extends OpenCodeAPI {
  override async call(method:string,path:string,body?:Wire):Promise<Wire>{
   if(method!=="GET"&&path.endsWith("/reply"))writes.push(body!);
   if(path==="/api/info")return {version:"2.1.0"};
   if(path.startsWith("/api/mcp?"))return {data:[{name:"missiongo",status:{status:"connected"}}]};
   if(path==="/api/session"&&method==="POST")return {data:{id:"description-session"}};
   if(path==="/api/session/description-session")return {data:{agent:"plan"}};
   if(path.endsWith("/form")&&method==="GET")return {data:[{id:"choices",title:"Choice",fields:[{key:"scope",title:"Scope",type:"string",description:"Choose one",options:[{value:"small",label:"Small",description:"Keeps existing data"},{value:"full",label:"Full",description:"Requires migration"}]}]}]};
   return {data:[]};
  }
 }
 const adapter=new OpenCodeAdapter(job(temporary(),"opencode"),new FormAPI());adapters.push(adapter);
 await adapter.start("Fixture");
 const question=(await adapter.snapshot()).messages.find(m=>m.sourceId==="form-choices")?.questions?.[0];
 expect(question).toMatchObject({options:["Small","Full"],detail:"Choose one\nSmall: Keeps existing data\nFull: Requires migration"});
 await adapter.deliver({id:"answer",status:"queued",text:"Scope: Small"});
 expect(writes).toEqual([{answer:{scope:"small"}}]);
});

it("does not accept a Codex choice whose explanation exceeds the transport limit",async()=>{
 const adapter=new CodexAdapter(job(temporary()),fixture);adapters.push(adapter);
 const ref=await adapter.start("Fixture");
 (adapter as unknown as {request(event:Wire):void}).request({id:900,method:"item/tool/requestUserInput",params:{threadId:ref,turnId:"turn",questions:[{id:"q",question:"Choose",options:[{label:"A",description:"x".repeat(4001)}]}]}});
 const approval=(await adapter.snapshot()).approval!;
 expect(approval.status).toBe("unavailable");
 expect(approval.options?.[0]?.detail).toContain("展示上限");
 await expect(adapter.decide({id:approval.id,choice:"choice-0"})).rejects.toThrow(/unsupported/);
});
