import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { legacyIntegratorPrompt } from "./legacy-merge-authorization.js";
import { recoveryDetailPrefix } from "./merge-recovery-transport.js";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "./app.js";
import { createAiAccessToken, hashPassword } from "./admin-auth.js";
import { AgentSessionStore } from "./agent-session-store.js";
import { MergeDeliveries, type DeliveryInput } from "./merge-deliveries.js";
import { ExternalNativeSessionStore } from "./external-native-session-store.js";
import { FreeSessionStore } from "./free-session-store.js";
import { DispatchStore } from "./dispatch-store.js";

const config = { id: "conversation-admin", username: "admin@example.test", passwordScrypt: hashPassword("synthetic password"),
  sessionSecret: "synthetic-conversation-handover-secret", cookieSecure: false };
const apps: ReturnType<typeof buildApp>[] = [];
afterEach(async () => { await Promise.all(apps.splice(0).map(app => app.close())); });

type Identity = { dispatchId?: string; sessionId?: string; session?: { agentKind: string; refKind: string; sessionRef: string } };
type Result = { resultType?:string; requestState?:string; inputRequests?:unknown; isError?: boolean; error?: unknown; content?: { type: string; text?: string }[];
  structuredContent?: { executionAuthorization?: string; executionIdentity?: Identity; sessionId?: string; [key: string]: unknown } };
const completion = { kind: "commit", commit: "a".repeat(40), targetBranch: "main" };

async function fixture(databasePath=":memory:") {
  const app = buildApp({ databasePath, adminAccount: config, writeTools: "comments", statusCheckTime: false });
  apps.push(app);
  const store = app.missionGoStore, accounts = app.missionGoAccounts, db = store.database.connection;
  const owner = accounts.createAccount({ email: "owner@example.test", password: "synthetic password", role: "member" });
  const other = accounts.createAccount({ email: "other@example.test", password: "synthetic password", role: "member" });
  const product = store.createProduct({ name: "Conversation handover", keyPrefix: "CON", createdByAccountId: config.id });
  const grant = (canOperate = true, canUseAi = true) => accounts.replacePermissions(owner.id,
    [{ productId: product.id, canView: true, canOperate, canUseAi }]);
  grant();
  accounts.replacePermissions(other.id, [{ productId: product.id, canView: true, canOperate: true, canUseAi: true }]);
  const item = store.createWorkItem({ productId: product.id, title: "Synthetic handover", description: "Protocol regression only",
    type: "task", priority: "normal", status: "ready", environment: { platform: "shared" } });
  const session = { agentKind: "opencode", refKind: "native", sessionRef: randomUUID() };
  const call = async (name: string, input: Record<string, unknown>, options: { accountId?: string; clientId?: string; scopes?: string[]; native?:Record<string,unknown> } = {}): Promise<Result> => {
    const account = accounts.getAccount(options.accountId ?? owner.id);
    const token = createAiAccessToken(config, { id: account.id, username: account.email, role: account.role },
      accounts.credentialsStamp(account), options.clientId ?? "original-client", options.scopes ?? ["missiongo:read", "missiongo:write"]).token;
    // No automatic credential injection and no seeded plan decision.
    const response = await app.inject({ method: "POST", url: "/mcp",
      headers: { authorization: `Bearer ${token}`, accept: "application/json, text/event-stream",...(options.native?{"mcp-method":"tools/call","mcp-name":name}:{}) },
      payload: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: input,...options.native } } });
    const raw = response.headers["content-type"]?.includes("text/event-stream")
      ? response.body.split("\n").find(line => line.startsWith("data: "))!.slice(6) : response.body;
    const parsed = JSON.parse(raw);
    return parsed.result ?? { error: parsed.error ?? parsed };
  };
  const launch = (projectKind?: "codex" | "claude_code" | "opencode") => {
    const kind = projectKind ?? "opencode";
    const dispatches = new DispatchStore(store.database);
    const node = dispatches.registerNode({ accountId: owner.id, installationId: randomUUID(), name: "Synthetic node" });
    dispatches.recordHeartbeat(node.nodeId, [{ kind, planApprovalProtocol: 1, ready: true }], [], "*", { supportsFreeSessions: true });
    dispatches.replaceOwnRepos(node.nodeId, [{ productId: product.id, repoPath: "/synthetic/conversation" }]);
    const dispatch = dispatches.createDispatch({ accountId: owner.id, nodeId: node.nodeId, agentKind: kind, mode: "default", itemKeys: [item.key] });
    dispatches.claimNextDispatch(node.nodeId);
    dispatches.recordDispatchResult({ nodeId: node.nodeId, dispatchId: dispatch.id, status: "launched" });
    if (projectKind) db.prepare(`INSERT INTO free_session_starts(dispatch_id,account_id,request_key,product_id,initial_text,config_json,ready)
      VALUES (?,?,?,?,?,'{}',1)`).run(dispatch.id, owner.id, randomUUID(), product.id, "Synthetic project conversation");
    const projectSessionId = new AgentSessionStore(store.database).createForDispatch({ dispatchId: dispatch.id, nodeId: node.nodeId, sessionRef: session.sessionRef });
    return { dispatch, node, projectSessionId };
  };
  const claimInput = { itemKey: item.key, agentId: "Synthetic OpenCode", session, authorizationMode: "conversation", idempotencyKey: "claim" };
  const complete = (identity: Identity) => call("submit_development_complete", { itemKey: item.key, ...identity, completion,
    requiredArtifacts: ["web"], idempotencyKey: "complete" });
  const snapshot = () => ({ item: store.getWorkItem(item.key), timeline: store.getTimeline(item.key),
    claims: db.prepare("SELECT * FROM mcp_agent_claim_receipts").all(),
    credentials: db.prepare("SELECT * FROM builder_execution_authorizations").all() });
  const safe = (result: Result) => {
    expect(result.error ?? result.isError, JSON.stringify(result)).toBeFalsy();
    expect(JSON.stringify(result)).not.toContain("executionAuthorization");
    for (const credential of db.prepare("SELECT id FROM builder_execution_authorizations").all() as { id: string }[]) {
      expect(JSON.stringify(result)).not.toContain(credential.id);
    }
  };
  return { app, store, accounts, db, owner, other, grant, item, session, call, launch, claimInput, complete, snapshot, safe };
}


const proposal = (key: string): DeliveryInput => ({itemKeys:[key],repository:"https://github.com/example/project",pullRequest:12,
  head:"a".repeat(40),targetBranch:"main",summary:"Verified change",validation:"Synthetic regression passed",requiredArtifacts:["web"],
  evidence:{head:"a".repeat(40),base:"b".repeat(40),checkedAt:new Date().toISOString(),checks:"passed",mergeable:"clean",source:"synthetic Git fixture"}});
async function prepared() {
  const f=await fixture(), launched=f.launch();
  const claimed=await f.call("claim_item",{...f.claimInput,session:undefined,dispatchId:launched.dispatch.id});
  f.safe(claimed);
  const merges=new MergeDeliveries(f.store), input=proposal(f.item.key), identity={dispatchId:launched.dispatch.id};
  const d=merges.propose(f.owner.id,"original-client",identity,"offer",input);
  const config={productId:f.item.productId,nodeId:launched.node.nodeId,agentKind:"opencode" as const,mode:"default"};
  return {...f,...launched,merges,input,identity,d,config};
}
describe("AND-423 explicit merge deliveries",()=>{
  it("keeps item status unchanged until verified merge and binds confirmation to its revision",async()=>{
    const f=await prepared();
    expect(f.store.getWorkItem(f.item.key).status).toBe("in_progress");
    expect(f.d.blocker).toBeUndefined();
    expect(()=>f.merges.decide(f.owner.id,f.d.id,"wrong","confirm")).toThrow();
    expect(()=>f.merges.decide(f.other.id,f.d.id,f.d.revision,"confirm")).toThrow();
    expect(f.merges.decide(f.owner.id,f.d.id,f.d.revision,"confirm").state).toBe("confirmed");
    expect(f.store.getWorkItem(f.item.key).status).toBe("in_progress");
  });
  it("invalidates a human confirmation when development continues or head changes",async()=>{
    const f=await prepared();
    f.merges.decide(f.owner.id,f.d.id,f.d.revision,"confirm");
    new AgentSessionStore(f.store.database).enqueue(f.owner.id,f.projectSessionId,"Continue changing this feature",[]);
    expect(f.merges.list(f.item.productId,f.owner.id)).toEqual([]);
    expect(()=>f.merges.start(f.owner.id,randomUUID(),[{id:f.d.id,revision:f.d.revision}],f.config,false)).toThrow();
    const g=await prepared();
    g.merges.decide(g.owner.id,g.d.id,g.d.revision,"confirm");
    expect(g.merges.refresh(g.owner.id,"original-client",g.identity,g.d.id,{...g.input.evidence,head:"c".repeat(40)}).state).toBe("withdrawn");
  });
  it("AND-446 preserves declined attention only for its input turn and reoffers explicitly",async()=>{
    const f=await prepared();
    expect(f.d.reconfirmation).toBe(false);
    expect(f.merges.attentionSessionIds(f.item.productId,f.owner.id)).toEqual([f.projectSessionId]);
    expect(f.merges.attentionSessionIds(f.item.productId,f.other.id)).toEqual([]);
    f.merges.decide(f.owner.id,f.d.id,f.d.revision,"withdraw");
    expect(f.merges.list(f.item.productId,f.owner.id)).toEqual([]);
    expect(f.merges.attentionSessionIds(f.item.productId,f.owner.id)).toEqual([f.projectSessionId]);
    new AgentSessionStore(f.store.database).enqueue(f.owner.id,f.projectSessionId,"Ordinary conversation",[]);
    expect(f.merges.attentionSessionIds(f.item.productId,f.owner.id)).toEqual([]);
    const again=f.merges.propose(f.owner.id,"original-client",f.identity,"offer-again",f.input);
    expect(again).toMatchObject({state:"proposed",reconfirmation:true});
    expect(f.merges.list(f.item.productId,f.owner.id)).toHaveLength(1);
    expect(()=>f.merges.decide(f.owner.id,f.d.id,f.d.revision,"confirm")).toThrow();
    expect(f.merges.decide(f.owner.id,again.id,again.revision,"confirm").state).toBe("confirmed");
  });
  it("AND-446 leaves a confirmed offer intact when a new message is rejected",async()=>{
    const f=await prepared();f.merges.decide(f.owner.id,f.d.id,f.d.revision,"confirm");
    expect(()=>new AgentSessionStore(f.store.database).enqueue(f.other.id,f.projectSessionId,"Rejected input",[])).toThrow();
    expect(f.merges.list(f.item.productId,f.owner.id)[0]?.state).toBe("confirmed");
  });
  it("serializes batches, retries the same reservation, and never unlocks missing outcomes",async()=>{
    const f=await prepared();f.merges.decide(f.owner.id,f.d.id,f.d.revision,"confirm");
    const key=randomUUID(),selection=[{id:f.d.id,revision:f.d.revision}];
    const b=f.merges.start(f.owner.id,key,selection,f.config,false);
    expect(new AgentSessionStore(f.store.database).getForAccount(f.owner.id,b.sessionId).sessionPurpose).toBe("integration");
    expect(new AgentSessionStore(f.store.database).listForAccount(f.owner.id).find(row=>row.id===b.sessionId)?.sessionPurpose).toBe("integration");
    // The conversation is named after the integrated work, not its instructions (AND-449).
    expect(f.db.prepare("SELECT session_title FROM free_session_starts WHERE dispatch_id=?").get(b.dispatchId))
      .toMatchObject({session_title:`集成 · ${f.item.key}`});
    expect(f.merges.start(f.owner.id,key,selection,f.config,false).id).toBe(b.id);
    expect(()=>f.merges.start(f.owner.id,key,[{id:f.d.id,revision:"wrong"}],f.config,false)).toThrow();
    expect(()=>f.merges.start(f.owner.id,randomUUID(),selection,f.config,false)).toThrow();
    const dispatches=new DispatchStore(f.store.database);
    dispatches.claimNextDispatch(f.node.nodeId);
    dispatches.recordDispatchResult({nodeId:f.node.nodeId,dispatchId:b.dispatchId,status:"launched"});
    expect(()=>f.merges.finish(f.owner.id,b.dispatchId,b.id)).toThrow();
    expect(()=>f.merges.report(f.owner.id,f.dispatch.id,b.id,f.d.id,{status:"merged",head:f.d.head,commit:"c".repeat(40),detail:"Merged"})).toThrow();
    f.merges.report(f.owner.id,b.dispatchId,b.id,f.d.id,{status:"merged",head:f.d.head,commit:"c".repeat(40),detail:"Verified merge"});
    expect(f.store.getWorkItem(f.item.key).status).toBe("development_complete");
    expect(f.merges.finish(f.owner.id,b.dispatchId,b.id).state).toBe("finished");
    expect(new AgentSessionStore(f.store.database).getForAccount(f.owner.id,b.sessionId).sessionPurpose).toBe("integration");
    expect(f.db.prepare("SELECT COUNT(*) AS n FROM dispatch_items WHERE dispatch_id=?").get(b.dispatchId)).toMatchObject({n:0});
  });
  it("AND-455 dispatches auto-merge as the batch default and keeps the merge gate intact",async()=>{
    const f=await prepared();f.merges.decide(f.owner.id,f.d.id,f.d.revision,"confirm");
    const b=f.merges.start(f.owner.id,randomUUID(),[{id:f.d.id,revision:f.d.revision}],f.config,false,1);
    const prompt=(f.db.prepare("SELECT initial_text FROM free_session_starts WHERE dispatch_id=?").get(b.dispatchId) as {initial_text:string}).initial_text;
    // Arming auto-merge replaces per-item waiting for a merge notification.
    expect(prompt).toContain("gh pr merge --auto --merge --match-head-commit");
    expect(prompt).toContain("--disable-auto");
    // The gate is not relaxed: exact head binding, protected checks and no --admin.
    expect(prompt).toContain("--match-head-commit");
    expect(prompt).toContain("禁止 --admin");
    expect(prompt).toContain("required checks 全绿");
  });
  it.each([false,true])("AND-507/508 front-loads read-only readiness and itemized evidence even when publish=%s",async publish=>{
    const f=await prepared();f.merges.decide(f.owner.id,f.d.id,f.d.revision,"confirm");
    const b=f.merges.start(f.owner.id,randomUUID(),[{id:f.d.id,revision:f.d.revision}],f.config,publish,1);
    const prompt=(f.db.prepare("SELECT initial_text FROM free_session_starts WHERE dispatch_id=?").get(b.dispatchId) as {initial_text:string}).initial_text;
    expect(prompt).toContain("先做发布就绪预检，再保存集成计划");
    expect(prompt).toContain("missiongo-release readiness --candidates");
    expect(prompt).toContain("全量 list_release_candidates(includeUnscoped:true)");
    expect(prompt).toContain("不自动安装");
    expect(prompt).toContain("未选择发布也做只读调查，但不构建、安装或发布");
    expect(prompt).toContain("按operation核实实际合并或既有references后刷新主线和release:state");
    expect(prompt).toContain("仅在原授权范围内一次准备");
    expect(prompt).toContain("启动快照不是部署凭据");
    expect(prompt).toContain("对象/结果/证据与验证缺口/下一步责任");
    expect(prompt).toContain("限定目标文件摘要和实际入口成功检查");
    expect(prompt).toContain("部分产物不能报完整交付");
    expect(prompt).toContain("不得隐藏或改写原生源消息");
    expect(prompt).toContain("不重复全量计数/列表/日志");
    expect(prompt).toContain("未核实送达不报通知成功，人工验收由人决定");
    expect(f.store.getWorkItem(f.item.key).status).toBe("in_progress");
    expect(b.publish).toBe(publish);
  });
  it("preserves confirmation when only same-head evidence refreshes",async()=>{
    const f=await prepared();f.merges.decide(f.owner.id,f.d.id,f.d.revision,"confirm");
    f.merges.refresh(f.owner.id,"original-client",f.identity,f.d.id,{...f.input.evidence,checkedAt:new Date(Date.now()-360_000).toISOString()});
    expect(f.merges.list(f.item.productId,f.owner.id)[0]?.blocker).toBe("stale");
    const refreshed=f.merges.refresh(f.owner.id,"original-client",f.identity,f.d.id,{...f.input.evidence,checkedAt:new Date().toISOString()});
    expect(refreshed.state).toBe("confirmed");expect(refreshed.revision).toBe(f.d.revision);
  });
  it.each(["stale", "pending", "failed", "conflicting", "unknown"] as const)("delegates %s evidence to the frozen merge batch",async(reason)=>{
    const f=await prepared();f.merges.decide(f.owner.id,f.d.id,f.d.revision,"confirm");
    f.merges.refresh(f.owner.id,"original-client",f.identity,f.d.id,{...f.input.evidence,
      ...(reason==="stale"?{checkedAt:new Date(Date.now()-360_000).toISOString()}:reason==="conflicting"?{mergeable:"conflicting" as const}:{checks:reason})});
    expect(f.merges.list(f.item.productId,f.owner.id)[0]?.blocker).toBe(reason);
    const b=f.merges.start(f.owner.id,randomUUID(),[{id:f.d.id,revision:f.d.revision}],f.config,false);
    const dispatches=new DispatchStore(f.store.database);
    dispatches.claimNextDispatch(f.node.nodeId);dispatches.recordDispatchResult({nodeId:f.node.nodeId,dispatchId:b.dispatchId,status:"launched"});
    const entry=f.merges.batch(f.owner.id,b.dispatchId,b.id).entries[0]!;
    expect(entry.head).toBe(f.d.head);expect(entry.revision).toBe(f.d.revision);expect(entry.blocker).toBeUndefined();
    expect(()=>f.merges.report(f.owner.id,b.dispatchId,b.id,f.d.id,{status:"merged",head:"b".repeat(40),commit:"c".repeat(40),detail:"Wrong head"})).toThrow();
  });
  it("keeps the batch usable after safe pre-launch retry changes only its dispatch",async()=>{
    const f=await prepared();f.merges.decide(f.owner.id,f.d.id,f.d.revision,"confirm");
    const b=f.merges.start(f.owner.id,randomUUID(),[{id:f.d.id,revision:f.d.revision}],f.config,false);
    const dispatches=new DispatchStore(f.store.database),sessions=new AgentSessionStore(f.store.database);
    const free=new FreeSessionStore(f.store.database,dispatches,sessions);
    free.stop(f.owner.id,b.dispatchId);
    const next=free.retry(f.owner.id,b.dispatchId);
    expect(next.agentSessionId).toBe(b.sessionId);
    expect(sessions.getForAccount(f.owner.id,b.sessionId).sessionPurpose).toBe("integration");
    dispatches.claimNextDispatch(f.node.nodeId);dispatches.recordDispatchResult({nodeId:f.node.nodeId,dispatchId:next.id,status:"launched"});
    expect(f.merges.batch(f.owner.id,next.id,b.id).id).toBe(b.id);
    expect(()=>f.merges.batch(f.owner.id,b.dispatchId,b.id)).toThrow();
  });
  it("reconciles partial success without changing blocked items or repeating completed handoffs",async()=>{
    const f=await prepared();
    const second=f.store.createWorkItem({productId:f.item.productId,title:"Second",description:"Synthetic",type:"task",priority:"normal",status:"ready",environment:{platform:"shared"}});
    const claim=await f.call("claim_item",{...f.claimInput,itemKey:second.key,session:{...f.session,sessionRef:randomUUID()},idempotencyKey:"second"});f.safe(claim);
    const secondIdentity={sessionId:claim.structuredContent!.sessionId!};
    const d2=f.merges.propose(f.owner.id,"original-client",secondIdentity,"offer-second",{...proposal(second.key),pullRequest:13});
    for(const d of [f.d,d2])f.merges.decide(f.owner.id,d.id,d.revision,"confirm");
    const b=f.merges.start(f.owner.id,randomUUID(),[f.d,d2].map(d=>({id:d.id,revision:d.revision})),f.config,false);
    const dispatches=new DispatchStore(f.store.database);dispatches.claimNextDispatch(f.node.nodeId);
    dispatches.recordDispatchResult({nodeId:f.node.nodeId,dispatchId:b.dispatchId,status:"launched"});
    const result={status:"merged" as const,head:f.d.head,commit:"c".repeat(40),detail:"Verified integration"};
    f.merges.report(f.owner.id,b.dispatchId,b.id,f.d.id,result);
    const events=f.store.getTimeline(f.item.key);
    f.merges.report(f.owner.id,b.dispatchId,b.id,f.d.id,result);expect(f.store.getTimeline(f.item.key)).toEqual(events);
    expect(()=>f.merges.finish(f.owner.id,b.dispatchId,b.id)).toThrow();
    f.merges.report(f.owner.id,b.dispatchId,b.id,d2.id,{status:"blocked",head:d2.head,detail:"Verified conflict; no merge scheduled"});
    f.merges.finish(f.owner.id,b.dispatchId,b.id);
    expect(f.store.getWorkItem(f.item.key).status).toBe("development_complete");expect(f.store.getWorkItem(second.key).status).toBe("in_progress");
  });
  it.each(["operate","ai"])("enforces revoked %s permission at the HTTP and MCP boundaries",async permission=>{
    const f=await prepared();
    const login=await f.app.inject({method:"POST",url:"/api/v1/auth/login",payload:{username:f.owner.email,password:"synthetic password"}});
    const cookie=login.headers["set-cookie"]!.toString().split(";")[0]!;
    f.grant(permission!=="operate",permission!=="ai");
    const response=await f.app.inject({method:"POST",url:`/api/v1/merge-deliveries/${f.d.id}/decision`,headers:{cookie},payload:{revision:f.d.revision,decision:"confirm"}});
    expect(response.statusCode).toBe(404); // Existing product guard hides inaccessible operations.
    const result=await f.call("refresh_merge_delivery",{identity:f.identity,deliveryId:f.d.id,evidence:f.input.evidence});
    expect(result.error || result.isError).toBeTruthy();
    expect(f.merges.list(f.item.productId,f.owner.id)[0]?.state).toBe("proposed");
  });
  it("denies read-only and another client delivery writes",async()=>{
    const f=await prepared();
    for(const options of [{scopes:["missiongo:read"]},{clientId:"other-client"},{accountId:f.other.id}]) {
      const result=await f.call("propose_merge_delivery",{identity:f.identity,idempotencyKey:randomUUID(),delivery:f.input},options);
      expect(result.error || result.isError).toBeTruthy();
    }
  });
  it("confirms immediately on a quoted same-turn instruction and stays idempotent",async()=>{
    const f=await prepared();
    const d=f.merges.propose(f.owner.id,"original-client",f.identity,"instruction",{...f.input},{quote:"  添加到待合并  "});
    expect(d.state).toBe("confirmed");expect(d.confirmedBy).toBe("session-instruction");expect(d.instructionQuote).toBe("添加到待合并");
    const again=f.merges.propose(f.owner.id,"original-client",f.identity,"instruction",{...f.input},{quote:"添加到待合并"});
    expect(again.state).toBe("confirmed");expect(again.confirmedBy).toBe("session-instruction");
    const b=f.merges.start(f.owner.id,randomUUID(),[{id:d.id,revision:d.revision}],f.config,false);
    expect(b.state).toBe("active");
  });
  it("keeps the confirmation origin explicit and never overwrites it",async()=>{
    const f=await prepared();
    expect(f.merges.decide(f.owner.id,f.d.id,f.d.revision,"confirm").confirmedBy).toBe("console");
    const g=await prepared();
    const d=g.merges.propose(g.owner.id,"original-client",g.identity,"instruction",{...g.input},{quote:"加入待合并"});
    expect(g.merges.decide(g.owner.id,d.id,d.revision,"confirm").confirmedBy).toBe("session-instruction");
    expect(()=>g.merges.propose(g.owner.id,"original-client",g.identity,"instruction",{...g.input,pullRequest:14},{quote:"加入待合并"})).toThrow();
  });
  // Semantic interpretation remains the Agent's job. These exercise transport and
  // domain effects after a valid current-turn queue instruction has been identified.
  it.each(["添加到待集成", "加入待集成", "提交到待集成", "添加到待合并", "加入待合并", "提交到待合并", "添加到待合成", "添加到待发布"])("queues a current delivery with original wording: %s",async quote=>{
    const f=await prepared();
    const ordered=await f.call("propose_merge_delivery",{identity:f.identity,idempotencyKey:"mcp-instruction",delivery:f.input,instructionConfirmation:{quote}});
    f.safe(ordered);
    expect(ordered.structuredContent!.delivery).toMatchObject({state:"confirmed",confirmedBy:"session-instruction",instructionQuote:quote});
    const repeated=await f.call("propose_merge_delivery",{identity:f.identity,idempotencyKey:"mcp-instruction",delivery:f.input,instructionConfirmation:{quote}});
    expect(repeated.structuredContent!.delivery).toMatchObject({id:(ordered.structuredContent!.delivery as {id:string}).id,state:"confirmed",instructionQuote:quote});
    expect(f.merges.batches(f.item.productId,f.owner.id)).toEqual([]);
    expect(f.store.getWorkItem(f.item.key).status).toBe("in_progress");
    const plain=await f.call("propose_merge_delivery",{identity:f.identity,idempotencyKey:"mcp-plain",delivery:f.input});
    f.safe(plain);
    expect(plain.structuredContent!.delivery).toMatchObject({state:"proposed"});
  });
});

describe("planned integration batches",()=>{
  async function batchFixture(count=1,noRelease=false,publish=false) {
    const f=await prepared(),deliveries=[noRelease ? f.merges.propose(f.owner.id,"original-client",f.identity,"no-release-offer",{...f.input,requiredArtifacts:[],noReleaseReason:"Internal merge/CI tools only"}) : f.d];
    for(let i=1;i<count;i++) {
      const item=f.store.createWorkItem({productId:f.item.productId,title:`Related ${i}`,description:"Synthetic integration",type:"task",priority:"normal",status:"ready",environment:{platform:"shared"}});
      const claim=await f.call("claim_item",{...f.claimInput,itemKey:item.key,session:{...f.session,sessionRef:randomUUID()},idempotencyKey:`claim-${i}`});f.safe(claim);
      deliveries.push(f.merges.propose(f.owner.id,"original-client",{sessionId:claim.structuredContent!.sessionId!},`offer-${i}`,{...proposal(item.key),pullRequest:12+i}));
    }
    for(const d of deliveries)f.merges.decide(f.owner.id,d.id,d.revision,"confirm");
    const b=f.merges.start(f.owner.id,randomUUID(),deliveries.map(d=>({id:d.id,revision:d.revision})),f.config,publish,1);
    const dispatches=new DispatchStore(f.store.database);dispatches.claimNextDispatch(f.node.nodeId);dispatches.recordDispatchResult({nodeId:f.node.nodeId,dispatchId:b.dispatchId,status:"launched"});
    const current=()=>new MergeDeliveries(f.store).batch(f.owner.id,b.dispatchId,b.id);
    const act=(action:Parameters<MergeDeliveries["integrate"]>[5],key=randomUUID(),revision=current().integration!.revision)=>
      f.merges.integrate(f.owner.id,b.dispatchId,b.id,revision,key,action);
    const plan={kind:"plan" as const,base:"b".repeat(40),summary:"Foundation, dependent feature, independent fix",validation:"Verify the final combined target",entries:deliveries.map((d,i)=>({deliveryId:d.id,head:d.head,dependsOn:i===1?[deliveries[0]!.id]:[],group:i<2?"shared interface":"independent",reason:"Read overlapping changes",validation:"Behavior and compatibility tests"}))};
    const check=(id:string,head="a".repeat(40))=>act({kind:"check",deliveryId:id,expectedHead:head,base:"b".repeat(40),checkedAt:new Date().toISOString(),checks:"passed",mergeable:"clean",local:"passed",source:"Synthetic CI",validation:"Local and remote checks passed"});
    const merged=(id:string,head="a".repeat(40))=>f.merges.report(f.owner.id,b.dispatchId,b.id,id,{status:"merged",head,commit:"c".repeat(40),detail:"Verified real merge in synthetic fixture"});
    return {...f,b,deliveries,current,act,plan,check,merged};
  }
  it("archives a published old round without borrowing its receipt for rework (AND-501/435)",async()=>{
    const f=await batchFixture(),d=f.deliveries[0]!;
    f.act(f.plan);f.check(d.id);f.merged(d.id);
    const event=f.store.getDeliveryRecords(f.item.key)[0]!;
    f.store.submitForVerification({itemKey:f.item.key,developmentEventId:event.id,completion:event.completion!,
      releases:[{artifact:"web",version:"old",sourceCommit:"e".repeat(40)}],deployedCommit:"e".repeat(40),receiptDigest:"f".repeat(64),idempotencyKey:"old-release"});
    f.store.transitionWorkItem({itemKey:f.item.key,actor:"human",to:"ready",reason:"verification_failed",note:"Rework",attribution:{accountId:config.id}});
    const before=f.store.getTimeline(f.item.key);
    expect(f.merges.queue(f.item.productId,f.owner.id).deliveries).toEqual([]);
    expect(f.merges.queue(f.item.productId,f.owner.id,"history").deliveries[0]!.queue).toMatchObject({stage:"history",resolution:"historical",publishedArtifacts:["web"]});
    expect(f.store.getDeliveryRecords(f.item.key)).toEqual([]);
    expect(f.store.getWorkItem(f.item.key).status).toBe("ready");
    expect(f.store.getTimeline(f.item.key)).toEqual(before);
    expect(()=>f.merges.publicationPreview(f.owner.id,f.item.productId,[{id:d.id,revision:d.revision}])).toThrow();
  });
  it("recognizes an exact legacy no-release handover without a development event ID (AND-450)",async()=>{
    const f=await batchFixture(1,true),d=f.deliveries[0]!;
    f.act(f.plan);f.check(d.id);f.merged(d.id);
    const e=f.store.getDevelopmentEvidence(f.item.key),item=f.store.getWorkItem(f.item.key);
    f.store.submitNonReleaseForVerification({itemKey:item.key,completion:e.completion!,expectedRevision:item.revision,
      developmentEventId:e.handover!.id,roundKey:e.roundKey!,evidenceDigest:e.handover!.payload.evidenceDigest as string,
      validation:{checks:[{name:"No release",method:"Synthetic tools",result:"passed",evidence:"Bound event"}],remainingVerification:[],limitations:[]},
      idempotencyKey:"legacy-no-release",attribution:{accountId:f.owner.id}});
    // Reproduce the early persisted receipt shape, using only this isolated fixture DB.
    const receipt=f.store.getTimeline(item.key).find(v=>v.payload.reason==="non_release_submitted")!;
    const legacy={...receipt.payload};delete legacy.developmentEventId;
    f.db.prepare("UPDATE work_item_events SET payload_json=? WHERE id=?").run(JSON.stringify(legacy),receipt.id);
    f.db.prepare("INSERT OR IGNORE INTO merge_display_dirty(kind,id) VALUES ('item',?)").run(item.id);
    expect(f.store.getDeliveryRecords(item.key)[0]!.published).toBe(true);
    expect(f.merges.queue(item.productId,f.owner.id).deliveries).toEqual([]);
    expect(f.merges.queue(item.productId,f.owner.id,"history").deliveries[0]!.queue).toMatchObject({resolution:"not_required"});
    // The actual AND-450 receipt also lacks a completion reference.
    delete legacy.completion;delete legacy.pullRequestUrl;
    f.db.prepare("UPDATE work_item_events SET payload_json=? WHERE id=?").run(JSON.stringify(legacy),receipt.id);
    expect(f.store.getDeliveryRecords(item.key)[0]!.published).toBe(true);
    const validRevision=legacy.revision;
    legacy.revision=-1;
    f.db.prepare("UPDATE work_item_events SET payload_json=? WHERE id=?").run(JSON.stringify(legacy),receipt.id);
    expect(f.store.getDeliveryRecords(item.key)[0]!.published).toBe(false);
    legacy.revision=validRevision;legacy.roundKey="different-round";
    f.db.prepare("UPDATE work_item_events SET payload_json=? WHERE id=?").run(JSON.stringify(legacy),receipt.id);
    expect(f.store.getDeliveryRecords(item.key)[0]!.published).toBe(false);
  });
  it("keeps an early human no-release transition in review without inventing formal handover",async()=>{
    const f=await batchFixture(1,true),d=f.deliveries[0]!;
    f.act(f.plan);f.check(d.id);f.merged(d.id);
    const event=f.store.getDeliveryRecords(f.item.key)[0]!;
    f.store.transitionWorkItem({itemKey:f.item.key,actor:"human",to:"pending_verification",reason:"non_release_submitted",attribution:{accountId:config.id}});
    const timeline=f.store.getTimeline(f.item.key),receipt=timeline.find(e=>e.payload.reason==="non_release_submitted")!;
    expect(receipt.actorKind).toBe("human");expect(receipt.payload.developmentEventId).toBeUndefined();
    expect(f.store.getDeliveryRecords(f.item.key)[0]).toMatchObject({id:event.id,published:false});
    const queue=f.merges.queue(f.item.productId,f.owner.id,"review");
    expect(f.merges.queue(f.item.productId,f.owner.id).deliveries).toEqual([]);
    expect(queue.counts.review).toBe(1);expect(queue.counts.release??0).toBe(0);
    expect(queue.deliveries[0]!.queue).toMatchObject({stage:"review",blocker:expect.stringContaining("无需发布交接证据")});
    expect(()=>f.merges.publicationPreview(f.owner.id,f.item.productId,[{id:d.id,revision:d.revision}])).toThrow();
    expect(f.store.getTimeline(f.item.key)).toEqual(timeline);
    expect(f.store.getWorkItem(f.item.key).status).toBe("pending_verification");
  });
  it("separates missing evidence into review and refuses publication selection",async()=>{
    const f=await batchFixture(),d=f.deliveries[0]!;
    f.act(f.plan);f.check(d.id);f.merged(d.id);
    const e=f.store.getDeliveryRecords(f.item.key)[0]!;
    // Simulate a historical import that lost its exact integration identity.
    f.db.prepare("UPDATE work_item_events SET payload_json=json_remove(payload_json,'$.completion','$.pullRequestUrl') WHERE id=?").run(e.id);
    f.db.prepare("INSERT OR IGNORE INTO merge_display_dirty(kind,id) VALUES ('item',?)").run(f.item.id);
    const q=f.merges.queue(f.item.productId,f.owner.id,"review");
    expect(f.merges.queue(f.item.productId,f.owner.id).deliveries).toEqual([]);
    expect(q.counts.review).toBe(1);expect(q.counts.release??0).toBe(0);
    expect(q.deliveries[0]!.queue).toMatchObject({stage:"review",blocker:expect.any(String)});
    expect(()=>f.merges.publicationPreview(f.owner.id,f.item.productId,[{id:d.id,revision:d.revision}])).toThrow();
  });
  it.each(["missing","null","unknown"])("keeps %s delivery rounds in review instead of silently archiving",async shape=>{
    const f=await batchFixture(),d=f.deliveries[0]!;
    f.act(f.plan);f.check(d.id);f.merged(d.id);
    const event=f.store.getDeliveryRecords(f.item.key)[0]!;
    const raw=f.db.prepare("SELECT payload_json FROM work_item_events WHERE id=?").get(event.id) as {payload_json:string};
    const payload=JSON.parse(raw.payload_json);
    if(shape==="missing")delete payload.roundKey;else payload.roundKey=shape==="null"?null:"unknown-round";
    f.db.prepare("UPDATE work_item_events SET payload_json=? WHERE id=?").run(JSON.stringify(payload),event.id);
    f.db.prepare("INSERT OR IGNORE INTO merge_display_dirty(kind,id) VALUES ('item',?)").run(f.item.id);
    const q=f.merges.queue(f.item.productId,f.owner.id,"review");
    expect(f.merges.queue(f.item.productId,f.owner.id).deliveries).toEqual([]);
    expect(q.counts.review).toBe(1);expect(q.counts.history??0).toBe(0);
    expect(q.deliveries[0]!.queue).toMatchObject({stage:"review",blocker:"交付处理轮次待核实，请核对原交付。"});
    expect(()=>f.merges.publicationPreview(f.owner.id,f.item.productId,[{id:d.id,revision:d.revision}])).toThrow();
    expect(f.store.getWorkItem(f.item.key).status).toBe("development_complete");
  });
  it("keeps exceptions outside all and starts one scoped read-only investigation across retries",async()=>{
    const f=await batchFixture(1,true),d=f.deliveries[0]!;
    f.act(f.plan);f.check(d.id);f.merged(d.id);
    const before=f.store.getTimeline(f.item.key),status=f.store.getWorkItem(f.item.key).status;
    expect(f.merges.queue(f.item.productId,f.owner.id).deliveries).toEqual([]);
    const context=f.merges.reviewContext(f.owner.id,d.id),scope=context.queue.review!.scopeDigest;
    const input=()=>f.merges.startReview(f.owner.id,d.id,d.revision,scope,"review-request-stable",f.config);
    const first=input(),sessionId=first.queue.review!.sessionId!;
    expect(input().queue.review!.sessionId).toBe(sessionId);
    expect(()=>f.merges.startReview(f.owner.id,d.id,d.revision,scope,"review-request-stable",{...f.config,mode:"different"})).toThrow();
    expect(f.merges.startReview(f.owner.id,d.id,d.revision,scope,"another-human-click",f.config).queue.review!.sessionId).toBe(sessionId);
    expect(f.db.prepare("SELECT count(*) AS n FROM delivery_reviews").get()).toMatchObject({n:1});
    const start=f.db.prepare("SELECT initial_text,session_title FROM free_session_starts WHERE dispatch_id=(SELECT dispatch_id FROM delivery_reviews WHERE delivery_id=?)").get(d.id) as {initial_text:string;session_title:string};
    expect(start.initial_text).toContain("只读核查");expect(start.initial_text).toContain("不领取或创建条目");expect(start.initial_text).toContain(d.repository);expect(start.session_title).toContain("交付核查");
    expect(()=>f.merges.reviewContext(f.other.id,d.id)).toThrow();
    expect(()=>f.merges.startReview(f.owner.id,d.id,d.revision,"stale","stale-request-key",f.config)).toThrow();
    expect(()=>f.merges.closeReview(f.owner.id,d.id,scope,first.queue.review!.caseId!,"No further integration")).toThrow(/尚未结束/);
    expect(f.store.getTimeline(f.item.key)).toEqual(before);expect(f.store.getWorkItem(f.item.key).status).toBe(status);
    expect(f.store.getDeliveryRecords(f.item.key)[0]!.published).toBe(false);
  });
  it("requires current project operation/AI grants and original delivery ownership for investigation routes",async()=>{
    const f=await batchFixture(1,true),d=f.deliveries[0]!;f.act(f.plan);f.check(d.id);f.merged(d.id);
    const login=async(email:string)=>{const r=await f.app.inject({method:"POST",url:"/api/v1/auth/login",payload:{username:email,password:"synthetic password"}});return r.headers["set-cookie"]!.toString().split(";")[0]!;};
    const cookie=await login(f.owner.email),otherCookie=await login(f.other.email),path=`/api/v1/merge-deliveries/${d.id}/review`;
    expect((await f.app.inject({method:"GET",url:path,headers:{cookie:otherCookie}})).statusCode).toBe(404);
    const context=f.merges.reviewContext(f.owner.id,d.id);
    const payload={...f.config,revision:d.revision,scopeDigest:context.queue.review!.scopeDigest,requestKey:"route-investigation-key"};
    f.grant(false,true);expect((await f.app.inject({method:"POST",url:path,headers:{cookie},payload})).statusCode).toBe(404);
    f.grant(true,false);expect((await f.app.inject({method:"POST",url:path,headers:{cookie},payload})).statusCode).toBe(404);
    expect(f.db.prepare("SELECT count(*) AS n FROM delivery_reviews").get()).toMatchObject({n:0});
    f.grant();const started=await f.app.inject({method:"POST",url:path,headers:{cookie},payload});expect(started.statusCode).toBe(200);
    expect(started.json().queue.review.sessionId).toBeTypeOf("string");
    const queue=await f.app.inject({method:"GET",url:`/api/v1/products/${f.item.productId}/integration-queue?stage=all`,headers:{cookie}});
    expect(queue.json()).toMatchObject({deliveries:[],counts:{review:1}});
  });
  it("archives only a human-confirmed finished investigation and invalidates closure on scope changes",async()=>{
    const f=await batchFixture(1,true),d=f.deliveries[0]!;f.act(f.plan);f.check(d.id);f.merged(d.id);
    const before=f.store.getTimeline(f.item.key),context=f.merges.reviewContext(f.owner.id,d.id),scope=context.queue.review!.scopeDigest;
    const started=f.merges.startReview(f.owner.id,d.id,d.revision,scope,"finished-review-key",f.config),r=started.queue.review!;
    const dispatchId=(f.db.prepare("SELECT dispatch_id FROM delivery_reviews WHERE id=?").get(r.caseId!) as {dispatch_id:string}).dispatch_id;
    const dispatches=new DispatchStore(f.store.database);dispatches.claimNextDispatch(f.node.nodeId);dispatches.recordDispatchResult({nodeId:f.node.nodeId,dispatchId,status:"launched"});
    const sessions=new AgentSessionStore(f.store.database);sessions.createForDispatch({dispatchId,nodeId:f.node.nodeId,sessionRef:randomUUID()});
    // Synthetic node acknowledgement; no external command is executed.
    f.db.prepare("UPDATE agent_session_commands SET status='delivered',delivered_at=? WHERE session_id=?").run(new Date().toISOString(),r.sessionId!);
    sessions.recordSnapshot({nodeId:f.node.nodeId,sessionId:r.sessionId!,status:"idle",turnState:{turnActive:false,waitingForInput:true},messages:[{sourceId:"answer",role:"agent",text:"No product artifact is required. Formal handover is still missing."}]});
    expect(()=>f.merges.closeReview(f.owner.id,d.id,scope,r.caseId!,"Confirmed no integration work")).toThrow(/尚未结束/);
    sessions.recordSnapshot({nodeId:f.node.nodeId,sessionId:r.sessionId!,status:"idle",turnState:{turnActive:false,waitingForInput:false},messages:[{sourceId:"answer",role:"agent",text:"No product artifact is required. Formal handover is still missing."}]});
    expect(()=>f.merges.closeReview(f.owner.id,d.id,scope,r.caseId!," ")).toThrow();
    // A settled interrupt must not hide the newer unanswered user message.
    const newerInputAt=new Date(Date.now()+1000).toISOString(),messageId=randomUUID(),stopId=randomUUID();
    f.db.prepare("INSERT INTO agent_session_commands(id,session_id,account_id,kind,text,status,created_at) VALUES (?,?,?,'message','Follow-up','delivered',?)").run(messageId,r.sessionId!,f.owner.id,newerInputAt);
    f.db.prepare("INSERT INTO agent_session_commands(id,session_id,account_id,kind,text,status,created_at) VALUES (?,?,?,'interrupt','Stop','delivered',?)").run(stopId,r.sessionId!,f.owner.id,new Date(Date.now()+2000).toISOString());
    expect(sessions.getForAccount(f.owner.id,r.sessionId!).command!.kind).toBe("interrupt");
    expect(f.merges.reviewContext(f.owner.id,d.id).latestInputAt).toBe(newerInputAt);
    expect(()=>f.merges.closeReview(f.owner.id,d.id,scope,r.caseId!,"Cannot use an answer from before the follow-up")).toThrow(/尚未结束/);
    f.db.prepare("DELETE FROM agent_session_commands WHERE id IN (?,?)").run(messageId,stopId);

    const closed=f.merges.closeReview(f.owner.id,d.id,scope,r.caseId!,"Confirmed no integration work; preserve missing handover as history");
    expect(closed.queue).toMatchObject({stage:"review",review:{closedAt:expect.any(String),closeNote:expect.any(String)}});
    expect(f.merges.closeReview(f.owner.id,d.id,scope,r.caseId!,closed.queue.review!.closeNote!)).toEqual(closed);
    expect(()=>f.merges.closeReview(f.owner.id,d.id,scope,r.caseId!,"Changed conclusion")).toThrow();
    expect(f.merges.queue(f.item.productId,f.owner.id,"review").deliveries).toEqual([]);
    expect(f.merges.queue(f.item.productId,f.owner.id,"reviewed").deliveries[0]!.queue.review!.closedAt).toBeTypeOf("string");
    expect(f.merges.queue(f.item.productId,f.owner.id,"history").deliveries).toEqual([]);
    expect(f.merges.queue(f.item.productId,f.owner.id).counts).toMatchObject({reviewed:1});
    expect(f.store.getDeliveryRecords(f.item.key)[0]!.published).toBe(false);expect(f.store.getTimeline(f.item.key)).toEqual(before);
    // Synthetic delivery revision change keeps the same exception, but expires its conclusion.
    const changedDelivery=JSON.parse((f.db.prepare("SELECT data_json FROM merge_deliveries WHERE id=?").get(d.id) as {data_json:string}).data_json);
    changedDelivery.revision=randomUUID();
    f.db.prepare("UPDATE merge_deliveries SET data_json=? WHERE id=?").run(JSON.stringify(changedDelivery),d.id);
    expect(f.merges.queue(f.item.productId,f.owner.id,"review").deliveries).toHaveLength(1);
    expect(()=>f.merges.closeReview(f.owner.id,d.id,scope,r.caseId!,"Old conclusion")).toThrow();
    expect(f.db.prepare("SELECT closed_at FROM delivery_reviews WHERE id=?").get(r.caseId!)).toMatchObject({closed_at:expect.any(String)});
    expect(f.merges.reviewContext(f.owner.id,d.id).previousReviews).toEqual([expect.objectContaining({caseId:r.caseId,closeNote:closed.queue.review!.closeNote})]);
    // A real content edit begins a new delivery round: the obsolete delivery becomes history.
    f.store.updateWorkItem(f.item.key,{title:"Changed item content after exception closure"});
    expect(f.merges.queue(f.item.productId,f.owner.id,"reviewed").deliveries).toEqual([]);
    expect(f.merges.queue(f.item.productId,f.owner.id,"history").deliveries[0]!.queue.resolution).toBe("historical");
    expect(()=>f.merges.closeReview(f.owner.id,d.id,scope,r.caseId!,"Old conclusion")).toThrow();
  });
  it("reuses large exact batch templates while returning independent live JSON containers",async()=>{
    const f=await batchFixture(),d=f.deliveries[0]!;
    f.act(f.plan);f.check(d.id);f.merged(d.id);
    const raw=JSON.parse((f.db.prepare("SELECT data_json FROM merge_batches WHERE id=?").get(f.b.id) as {data_json:string}).data_json);
    raw.integration.plans[0].summary="Synthetic long history. ".repeat(2000);
    raw.integration.events[0].detail=JSON.parse('{"__proto__":{"polluted":true},"constructor":"own","nested":[null,false,4,{"text":"original"}]}');
    const save=()=>f.db.prepare("UPDATE merge_batches SET data_json=? WHERE id=?").run(JSON.stringify(raw),f.b.id);
    save();
    const text=(f.db.prepare("SELECT data_json FROM merge_batch_projection WHERE id=?").get(f.b.id) as {data_json:string}).data_json;
    let parses=0;const parse=JSON.parse,spy=vi.spyOn(JSON,"parse").mockImplementation((input,...args)=>{if(input===text)parses++;return parse(input,...args);});
    try {
      const first=f.merges.batches(f.item.productId,f.owner.id),second=f.merges.batches(f.item.productId,f.owner.id);
      expect(first).toEqual(second);expect(parses).toBe(1);
      expect(first).toEqual(f.merges.recomputeBatches(f.item.productId,f.owner.id));
      const detail=first[0]!.integration!.events[0]!.detail as unknown as Record<string,unknown>;
      expect(Object.getPrototypeOf(detail)).toBe(Object.prototype);expect(Object.hasOwn(detail,"__proto__")).toBe(true);
      expect(detail.__proto__).toEqual({polluted:true});expect(({} as Record<string,unknown>).polluted).toBeUndefined();
      first[0]!.integration!.plans[0]!.summary="Caller mutation";
      (detail.nested as unknown[])[3]="Caller nested mutation";
      expect(f.merges.batches(f.item.productId,f.owner.id)).toEqual(second);
      expect(f.merges.batches(f.item.productId,f.other.id)).toEqual([]);
      expect(f.merges.batches("other-product",f.owner.id)).toEqual([]);
      expect(f.merges.batches(f.item.productId,f.owner.id,f.b.sessionId)).toEqual(second);
      expect(()=>f.store.database.transaction(()=>{
        raw.integration.plans[0].summary="Synthetic uncommitted history. ".repeat(2000);save();
        // Source projections normally flush at outer commit; explicitly model
        // an in-transaction projection update before rolling the fixture back.
        f.db.prepare("UPDATE merge_batch_projection SET data_json=json_set(data_json,'$.integration.plans[0].summary',?) WHERE id=?").run(raw.integration.plans[0].summary,f.b.id);
        expect(f.merges.batches(f.item.productId,f.owner.id)[0]!.integration!.plans[0]!.summary).toBe(raw.integration.plans[0].summary);
        throw Error("rollback template input");
      })).toThrow("rollback template input");
      expect(f.merges.batches(f.item.productId,f.owner.id)).toEqual(second);
      save();expect(f.merges.batches(f.item.productId,f.owner.id)[0]!.integration!.plans[0]!.summary).toBe(raw.integration.plans[0].summary);
    } finally {spy.mockRestore();}
  });
  it("aggregates session stages with exact expiry, scope and JSON key preservation",async()=>{
    const f=await prepared(),now=Date.now(),session='quoted-"-\\-会话';
    const insert=f.db.prepare("INSERT INTO merge_session_projection VALUES (?,?,?,?,?,?)");
    insert.run(f.item.productId,f.owner.id,session,"publishing",now,"publication_unknown");
    insert.run(f.item.productId,f.owner.id,"future","publishing",now+1000,"publication_partial");
    insert.run(f.item.productId,f.owner.id,"stable","published",null,null);
    insert.run(f.item.productId,f.other.id,"other","merged",null,null);
    insert.run("other-product",f.owner.id,"other-product","merged",null,null);
    const clock=vi.spyOn(Date,"now").mockReturnValue(now);
    try {
      const expected={[session]:"publication_unknown",future:"publishing",stable:"published"};
      expect(f.merges.sessionProgress(f.item.productId,f.owner.id)).toEqual(expected);
      expect(f.merges.sessionProgress(f.item.productId,f.owner.id,session)).toEqual({[session]:"publication_unknown"});
      expect(f.merges.sessionProgress(f.item.productId,f.owner.id,"missing")).toEqual({});
      clock.mockReturnValue(now+1000);
      expect(f.merges.sessionProgress(f.item.productId,f.owner.id).future).toBe("publication_partial");
      f.db.prepare("UPDATE merge_session_projection SET stage='merged',expires_at=NULL,expired_stage=NULL WHERE session_id='future'").run();
      expect(f.merges.sessionProgress(f.item.productId,f.owner.id).future).toBe("merged");
    } finally {clock.mockRestore();}
  });
  it("checks live activity only for sensitive pending entries without changing publication semantics",async()=>{
    const f=await batchFixture(2),[pending,published]=f.deliveries;
    f.act(f.plan);for(const d of f.deliveries){f.check(d.id);f.merged(d.id);}
    const release=(d:typeof f.d,key:string)=>{
      const itemKey=d.itemKeys[0]!,event=f.store.getDeliveryRecords(itemKey)[0]!;
      f.store.submitForVerification({itemKey,developmentEventId:event.id,completion:event.completion!,releases:[{artifact:"web",version:"1",sourceCommit:"e".repeat(40)}],deployedCommit:"e".repeat(40),receiptDigest:"f".repeat(64),idempotencyKey:key});
    };
    release(published!,"activity-published");
    const queries:string[]=[],prepare=f.db.prepare.bind(f.db);
    const spy=vi.spyOn(f.db,"prepare").mockImplementation(sql=>{if(sql.startsWith("SELECT session_id,activity FROM merge_display_activity"))queries.push(sql);return prepare(sql);});
    try {
      const read=f.merges.batches(f.item.productId,f.owner.id);
      expect(read).toEqual(f.merges.recomputeBatches(f.item.productId,f.owner.id));
      expect(queries).toHaveLength(1);expect(queries[0]!.match(/\?/g)).toHaveLength(1);
      new AgentSessionStore(f.store.database).enqueue(f.owner.id,pending!.sessionId,"New pending implementation input",[]);
      const changed=f.merges.batches(f.item.productId,f.owner.id)[0]!;
      expect(changed.presentation.entries[published!.id]!.publication).toBe("published");
      expect(changed.presentation.entries[pending!.id]!.publication).toBe("unknown");
      release(pending!,"activity-complete");queries.length=0;
      const complete=f.merges.batches(f.item.productId,f.owner.id);
      expect(complete[0]!.presentation.entries[pending!.id]!.publication).toBe("published");
      expect(queries).toEqual([]);
      // Every read still returns independent objects; caller changes cannot leak.
      complete[0]!.presentation.entries[published!.id]!.publication="unknown";
      expect(f.merges.batches(f.item.productId,f.owner.id)[0]!.presentation.entries[published!.id]!.publication).toBe("published");
    } finally {spy.mockRestore();}
  });
  it("AND-469 shares current stages and preserves history when a new input clears completion",async()=>{
    const f=await batchFixture(), d=f.deliveries[0]!;
    const progress=()=>f.merges.sessionProgress(f.item.productId,f.owner.id);
    expect(progress()).toMatchObject({[d.sessionId]:"merging",[f.b.sessionId]:"merging"});
    expect(f.merges.attentionSessionIds(f.item.productId,f.owner.id)).toContain(d.sessionId);
    f.act(f.plan); f.check(d.id); f.merged(d.id);
    expect(progress()).toMatchObject({[d.sessionId]:"merged",[f.b.sessionId]:"merged"});
    // Repeated reads, new Agent output and a late old human echo do not clear it.
    new AgentSessionStore(f.store.database).recordSnapshot({nodeId:f.node.nodeId,sessionId:d.sessionId,status:"idle",messages:[
      {sourceId:"old-echo",role:"user",text:"Earlier input",occurredAt:"2020-01-01T00:00:00.000Z"},
      {sourceId:"result",role:"agent",text:"Delivery result"}]});
    expect(progress()[f.b.sessionId]).toBe("merged");
    expect(progress()[d.sessionId]).toBe("merged");
    // Saved execution settings clear only that conversation's current label.
    f.db.prepare("UPDATE agent_sessions SET settings_revision=settings_revision+1 WHERE id=?").run(f.b.sessionId);
    expect(progress()[f.b.sessionId]).toBeUndefined();
    expect(f.merges.batches(f.item.productId,f.owner.id)[0]?.results[d.id]?.status).toBe("merged");
    const command=new AgentSessionStore(f.store.database).enqueue(f.owner.id,d.sessionId,"A new adjustment",[]);
    const persisted=f.db.prepare("SELECT data_json FROM merge_batches WHERE id=?").get(f.b.id) as {data_json:string};
    const boundary=JSON.parse(persisted.data_json).displayBoundaries[d.sessionId];
    f.db.prepare("UPDATE agent_session_commands SET created_at=? WHERE id=?").run(boundary.at,command.id);
    expect(progress()[d.sessionId]).toBeUndefined();
  });
  it("AND-469 reads old completion without inventing a settings baseline or clearing historical facts",async()=>{
    const f=await batchFixture(),d=f.deliveries[0]!;
    f.act(f.plan);f.check(d.id);f.merged(d.id);
    const raw=JSON.parse((f.db.prepare("SELECT data_json FROM merge_batches WHERE id=?").get(f.b.id) as {data_json:string}).data_json);
    delete raw.displayBoundaries;
    f.db.prepare("UPDATE merge_batches SET data_json=? WHERE id=?").run(JSON.stringify(raw),f.b.id);
    expect(f.merges.sessionProgress(f.item.productId,f.owner.id)[d.sessionId]).toBe("merged");
    f.db.prepare("UPDATE agent_sessions SET settings_revision=2 WHERE id=?").run(d.sessionId);
    expect(f.merges.sessionProgress(f.item.productId,f.owner.id)[d.sessionId]).toBeUndefined();
    expect(f.merges.batches(f.item.productId,f.owner.id)[0]?.results[d.id]?.status).toBe("merged");
  });
  it("AND-469 accepts only authorized publication signals, expires them and never treats ended as a receipt",async()=>{
    const f=await batchFixture(1,false,true),d=f.deliveries[0]!;
    const signal=()=>({kind:"publication_progress" as const,state:"publishing" as const,checkedAt:new Date().toISOString(),resultsDigest:f.current().resultsDigest,detail:"Verified release process started"});
    expect(()=>f.act(signal())).toThrow();
    f.act(f.plan);f.check(d.id);f.merged(d.id);
    expect(()=>f.act(signal())).toThrow();
    f.act({kind:"final_validation",head:"c".repeat(40),checkedAt:new Date().toISOString(),validation:"Combination passed",source:"Synthetic actual target"});
    expect(()=>f.act({...signal(),resultsDigest:"0".repeat(64)})).toThrow();
    expect(()=>f.act({...signal(),checkedAt:"2020-01-01T00:00:00.000Z"})).toThrow();
    f.act(signal(),"publication-heartbeat");
    expect(f.merges.sessionProgress(f.item.productId,f.owner.id)[d.sessionId]).toBe("publishing");
    expect(()=>f.merges.finish(f.owner.id,f.b.dispatchId,f.b.id)).toThrow(/发布/);
    const clock=vi.spyOn(Date,"now").mockReturnValue(Date.now()+360_000);
    try { expect(f.merges.sessionProgress(f.item.productId,f.owner.id)[d.sessionId]).toBe("publication_unknown"); } finally { clock.mockRestore(); }
    f.act({...signal(),state:"ended"});
    expect(f.merges.sessionProgress(f.item.productId,f.owner.id)[d.sessionId]).toBe("publication_unknown");
    const g=await batchFixture();g.act(g.plan);g.check(g.deliveries[0]!.id);g.merged(g.deliveries[0]!.id);
    g.act({kind:"final_validation",head:"c".repeat(40),checkedAt:new Date().toISOString(),validation:"Passed",source:"Fixture"});
    expect(()=>g.act({...signal(),resultsDigest:g.current().resultsDigest})).toThrow();
  });
  it("AND-511 refreshes history when no-release evidence supplements a human pending-verification move",async()=>{
    const f=await batchFixture(1,true),d=f.deliveries[0]!;
    f.act(f.plan);f.check(d.id);f.merged(d.id);
    f.store.transitionWorkItem({itemKey:f.item.key,actor:"human",to:"pending_verification",reason:"manual_override",note:"Human move without release evidence",attribution:{accountId:config.id}});
    expect(f.merges.queue(f.item.productId,f.owner.id).counts.review).toBe(1);
    expect(f.merges.queue(f.item.productId,f.owner.id).counts.release??0).toBe(0);
    const e=f.store.getDevelopmentEvidence(f.item.key),item=f.store.getWorkItem(f.item.key);
    f.store.submitNonReleaseForVerification({itemKey:item.key,completion:e.completion!,expectedRevision:item.revision,
      developmentEventId:e.handover!.id,roundKey:e.roundKey!,evidenceDigest:e.handover!.payload.evidenceDigest as string,
      validation:{checks:[{name:"No-release handover",method:"Synthetic merged fixture",result:"passed",evidence:"Exact development event verified"}],remainingVerification:["Human acceptance"],limitations:[]},
      idempotencyKey:"queue-no-release-supplement",attribution:{accountId:f.owner.id}});
    expect(f.merges.queue(f.item.productId,f.owner.id).counts.release??0).toBe(0);
    expect(f.merges.queue(f.item.productId,f.owner.id,"history").deliveries).toHaveLength(1);
    expect(f.store.getWorkItem(f.item.key).status).toBe("pending_verification");
  });
  it("hands only this active batch's unchanged no-release merged item to verification",async()=>{
    const f=await batchFixture(1,true),d=f.deliveries[0]!;
    const validation={checks:[{name:"Merged target",method:"Verify integration and run checks",result:"passed" as const,evidence:"Synthetic merged Git fixture"}],remainingVerification:["Human review"],limitations:[]};
    const input=()=>{
      const e=f.store.getDevelopmentEvidence(f.item.key),item=f.store.getWorkItem(f.item.key);
      return {itemKey:item.key,completion:e.completion!,expectedRevision:item.revision,developmentEventId:e.handover!.id,
        roundKey:e.roundKey!,evidenceDigest:e.handover!.payload.evidenceDigest as string,validation,idempotencyKey:"batch-no-release",
        attribution:{accountId:f.owner.id,clientId:"original-client"}};
    };
    f.act(f.plan);f.check(d.id);f.merged(d.id);
    const raw=input(),batch={batchId:f.b.id,deliveryId:d.id,expectedRevision:f.current().integration!.revision};
    // An observed merge does not grant a handover whose own development step is blocked.
    const persisted=f.db.prepare("SELECT data_json FROM merge_batches WHERE id=?").get(f.b.id) as {data_json:string};
    const blocked=JSON.parse(persisted.data_json);
    blocked.reconciliation.handoffs[f.item.key].status="blocked";
    f.db.prepare("UPDATE merge_batches SET data_json=? WHERE id=?").run(JSON.stringify(blocked),f.b.id);
    expect(()=>f.merges.submitNonRelease(f.owner.id,f.b.dispatchId,batch,raw)).toThrow();
    f.db.prepare("UPDATE merge_batches SET data_json=? WHERE id=?").run(persisted.data_json,f.b.id);
    expect(()=>f.merges.submitNonRelease(f.owner.id,f.dispatch.id,batch,raw)).toThrow();
    expect(()=>f.merges.submitNonRelease(f.other.id,f.b.dispatchId,batch,raw)).toThrow();
    expect(()=>f.merges.submitNonRelease(f.owner.id,f.b.dispatchId,{...batch,expectedRevision:0},raw)).toThrow();
    expect(()=>f.merges.submitNonRelease(f.owner.id,f.b.dispatchId,batch,{...raw,itemKey:"CON-999"})).toThrow();
    expect(f.merges.submitNonRelease(f.owner.id,f.b.dispatchId,batch,raw).status).toBe("pending_verification");
    expect(f.merges.submitNonRelease(f.owner.id,f.b.dispatchId,batch,raw).status).toBe("pending_verification");
    const events=f.store.getTimeline(f.item.key).filter(e=>e.toStatus === "pending_verification");
    expect(events).toHaveLength(1);
    expect(events[0]!.payload).toMatchObject({reason:"non_release_submitted",mergeBatchId:f.b.id,deliveryId:d.id,authorizationBasis:"merge_non_release_handover",validation});
    f.act({kind:"final_validation",head:"c".repeat(40),checkedAt:new Date().toISOString(),source:"Synthetic merged target",validation:"Combination verified"});
    f.merges.finish(f.owner.id,f.b.dispatchId,f.b.id);
    expect(()=>f.merges.submitNonRelease(f.owner.id,f.b.dispatchId,{...batch,expectedRevision:f.current().integration!.revision},raw)).toThrow();
  });
  it("plans dependencies, repairs a regression, waits for CI and reconciles the complete combination",async()=>{
    const f=await batchFixture(3),[a,b,c]=f.deliveries;
    expect(()=>f.check(a!.id)).toThrow();
    expect(()=>f.act({...f.plan,entries:f.plan.entries.slice(1)})).toThrow();
    expect(()=>f.act({...f.plan,entries:[f.plan.entries[1]!,f.plan.entries[0]!,f.plan.entries[2]!]})).toThrow();
    f.act(f.plan);f.check(b!.id);expect(()=>f.merged(b!.id)).toThrow();
    f.check(a!.id);f.merged(a!.id);
    expect(f.current().integration!.entries[b!.id]!.check).toBeUndefined();
    const reservation=f.act({kind:"prepare_repair",deliveryId:b!.id,expectedHead:b!.head,base:"c".repeat(40),reason:"Fix shared interface regression"},"repair-reservation");
    expect(reservation.integration!.entries[b!.id]!.repair!.id).toBe("repair-reservation");
    const repair={kind:"repair" as const,deliveryId:b!.id,expectedHead:b!.head,repairId:"repair-reservation",head:"d".repeat(40),commits:["d".repeat(40)],validation:"Regression reproduced then fixed",source:"Synthetic verified commit chain"};
    expect(()=>f.act({...repair,expectedHead:"e".repeat(40)})).toThrow();
    expect(()=>f.act({...repair,repairId:"unrelated"})).toThrow();
    const rev=f.current().integration!.revision;f.act(repair,"repair-result",rev);f.act(repair,"repair-result",rev);
    expect(f.current().integration!.entries[b!.id]!.repairs).toHaveLength(1);
    expect(f.current().entries.find(d=>d.id===b!.id)).toMatchObject({head:b!.head,executionHead:repair.head});
    f.act({kind:"check",deliveryId:b!.id,expectedHead:repair.head,base:"c".repeat(40),checkedAt:new Date().toISOString(),checks:"pending",mergeable:"clean",local:"passed",source:"CI still running",validation:"Wait for CI"});
    expect(()=>f.merged(b!.id,repair.head)).toThrow();
    // Independent work can proceed while a dependent repair is waiting.
    f.check(c!.id);f.merged(c!.id);
    f.check(b!.id,repair.head);f.merged(b!.id,repair.head);
    expect(()=>f.merges.finish(f.owner.id,f.b.dispatchId,f.b.id)).toThrow();
    f.act({kind:"final_validation",head:"f".repeat(40),checkedAt:new Date().toISOString(),validation:"Combined behavior and repository checks passed",source:"Target main at verified head"});
    expect(f.merges.finish(f.owner.id,f.b.dispatchId,f.b.id).state).toBe("finished");
    expect(f.current().integration!.plans).toHaveLength(1);
    expect(f.current().integration!.finalValidation).toBeDefined();
  });
  it("rejects stale writes, changed source scope, cross-session calls and altered retries",async()=>{
    const f=await batchFixture();f.act(f.plan,"plan");
    // Reusing a key for a different body is reported as a key conflict, not as a
    // changed delivery: the generic code sent integrators to the PR and the item.
    let keyConflict: unknown;
    try { f.act({...f.plan,summary:"Different"},"plan",0); } catch (error) { keyConflict = error; }
    expect((keyConflict as {code?:string})?.code).toBe("merge_integration_idempotency_conflict");
    let staleWrite: unknown;
    try { f.act(f.plan,"stale",0); } catch (error) { staleWrite = error; }
    expect((staleWrite as {code?:string})?.code).toBe("merge_delivery_changed");
    expect(()=>f.merges.integrate(f.other.id,f.b.dispatchId,f.b.id,1,"other",f.plan)).toThrow();
    expect(()=>f.merges.integrate(f.owner.id,f.dispatch.id,f.b.id,1,"source-session",f.plan)).toThrow();
    for(const options of [{scopes:["missiongo:read"]},{accountId:f.other.id}]) {
      const result=await f.call("record_merge_integration",{batchId:f.b.id,dispatchId:f.b.dispatchId,expectedRevision:1,idempotencyKey:randomUUID(),action:f.plan},options);
      expect(result.error||result.isError).toBeTruthy();
    }
    new AgentSessionStore(f.store.database).enqueue(f.owner.id,f.projectSessionId,"Change the delivery",[]);
    expect(()=>f.act({kind:"prepare_repair",deliveryId:f.d.id,expectedHead:f.d.head,base:"b".repeat(40),reason:"Repair"})).toThrow();
  });
  it("persists unknown repairs and rejects stale checks without unlocking the batch",async()=>{
    const f=await batchFixture();f.act(f.plan);
    f.act({kind:"prepare_repair",deliveryId:f.d.id,expectedHead:f.d.head,base:"b".repeat(40),reason:"Investigate and repair"},"reserved");
    expect(f.current().integration!.entries[f.d.id]!.repair?.id).toBe("reserved");
    expect(()=>f.check(f.d.id)).toThrow();expect(()=>f.merges.finish(f.owner.id,f.b.dispatchId,f.b.id)).toThrow();
    expect(()=>f.merges.report(f.owner.id,f.b.dispatchId,f.b.id,f.d.id,{status:"blocked",head:f.d.head,detail:"Unknown push outcome"})).toThrow();
  });
  it("records a plan through MCP and safely cancels only a proven unpushed repair",async()=>{
    const f=await batchFixture();
    const input={batchId:f.b.id,dispatchId:f.b.dispatchId,expectedRevision:0,idempotencyKey:"mcp-plan",action:f.plan};
    f.safe(await f.call("record_merge_integration",input));f.safe(await f.call("record_merge_integration",input));
    expect(f.current().integration!.plans).toHaveLength(1);
    f.act({kind:"prepare_repair",deliveryId:f.d.id,expectedHead:f.d.head,base:"b".repeat(40),reason:"Bound investigation"},"reservation");
    const cancel={kind:"cancel_repair" as const,deliveryId:f.d.id,expectedHead:f.d.head,repairId:"reservation",observedHead:f.d.head,noExecutionRemaining:true as const,reason:"No change was pushed",source:"Remote head checked and no process remains"};
    expect(()=>f.act({...cancel,observedHead:"e".repeat(40)})).toThrow();
    f.act(cancel);expect(f.current().integration!.entries[f.d.id]!.repair).toBeUndefined();
    const check={kind:"check" as const,deliveryId:f.d.id,expectedHead:f.d.head,base:"b".repeat(40),checkedAt:new Date().toISOString(),checks:"failed" as const,mergeable:"clean" as const,local:"passed" as const,source:"Synthetic CI",validation:"Actual failure"};
    f.act(check);expect(()=>f.merged(f.d.id)).toThrow();
    expect(()=>f.act({...check,checkedAt:new Date(Date.now()-360_000).toISOString()})).toThrow();
    f.grant(true,false);
    const denied=await f.call("record_merge_integration",{...input,idempotencyKey:"revoked",expectedRevision:f.current().integration!.revision});
    expect(denied.error||denied.isError).toBeTruthy();
  });
  it("recovers exact historical authorization without replacing the batch or changing retry parameters",async()=>{
    const f=await prepared();f.merges.decide(f.owner.id,f.d.id,f.d.revision,"confirm");
    const key=randomUUID(),selection=[{id:f.d.id,revision:f.d.revision}];
    const b=f.merges.start(f.owner.id,key,selection,f.config,false);
    const dispatches=new DispatchStore(f.store.database);dispatches.claimNextDispatch(f.node.nodeId);dispatches.recordDispatchResult({nodeId:f.node.nodeId,dispatchId:b.dispatchId,status:"launched"});
    const setPrompt=(text:string)=>f.store.database.connection.prepare("UPDATE free_session_starts SET initial_text=? WHERE dispatch_id=?").run(text,b.dispatchId);
    for(const prompt of [legacyIntegratorPrompt("different-batch",false),legacyIntegratorPrompt(b.id,true),legacyIntegratorPrompt(b.id,false)+" extra instructions"]) {
      setPrompt(prompt);expect(f.merges.batch(f.owner.id,b.dispatchId,b.id).integration).toBeUndefined();
    }
    setPrompt(legacyIntegratorPrompt(b.id,false));
    f.store.database.connection.prepare("UPDATE free_session_starts SET ready=0 WHERE dispatch_id=?").run(b.dispatchId);
    expect(f.merges.batch(f.owner.id,b.dispatchId,b.id).integration).toBeUndefined();
    f.store.database.connection.prepare("UPDATE free_session_starts SET ready=1 WHERE dispatch_id=?").run(b.dispatchId);
    f.store.database.connection.prepare("UPDATE merge_batches SET data_json=? WHERE id=?").run(JSON.stringify({...b,state:"finished"}),b.id);
    expect(f.merges.batch(f.owner.id,b.dispatchId,b.id).integration).toBeUndefined();
    f.store.database.connection.prepare("UPDATE merge_batches SET data_json=? WHERE id=?").run(JSON.stringify(b),b.id);
    const restored=f.merges.batch(f.owner.id,b.dispatchId,b.id);
    expect(restored.integration?.recoveredAuthorization?.dispatchId).toBe(b.dispatchId);
    expect(restored.entries[0]!.mergeReady).toBe(false);
    const action={kind:"plan" as const,base:"b".repeat(40),summary:"Recover existing authorization",validation:"Combined verification",entries:[{deliveryId:f.d.id,head:f.d.head,dependsOn:[],group:"one",reason:"Original scope",validation:"Check repaired head"}]};
    f.merges.integrate(f.owner.id,b.dispatchId,b.id,0,"recover-plan",action);
    f.merges.integrate(f.owner.id,b.dispatchId,b.id,0,"recover-plan",action);
    const loaded=new MergeDeliveries(f.store).batch(f.owner.id,b.dispatchId,b.id);
    expect(loaded.integration!.plans).toHaveLength(1);expect(loaded.integration!.recoveredAuthorization).toEqual(restored.integration!.recoveredAuthorization);
    expect(f.merges.start(f.owner.id,key,selection,f.config,false).id).toBe(b.id);
    expect(()=>f.merges.start(f.owner.id,key,selection,f.config,false,1)).toThrow();
    f.merges.integrate(f.owner.id,b.dispatchId,b.id,1,"recover-repair",{kind:"prepare_repair",deliveryId:f.d.id,expectedHead:f.d.head,base:"b".repeat(40),reason:"Recover verified original-session repair"});
    f.merges.integrate(f.owner.id,b.dispatchId,b.id,2,"recover-head",{kind:"repair",deliveryId:f.d.id,expectedHead:f.d.head,repairId:"recover-repair",head:"e".repeat(40),commits:["e".repeat(40)],validation:"Git chain checked",source:"Synthetic historical recovery"});
    expect(f.merges.batch(f.owner.id,b.dispatchId,b.id).entries[0]!.executionHead).toBe("e".repeat(40));
  });
  it("does not silently grant repair authority to legacy batches or retries",async()=>{
    const f=await prepared();f.merges.decide(f.owner.id,f.d.id,f.d.revision,"confirm");
    const key=randomUUID(),selection=[{id:f.d.id,revision:f.d.revision}];
    const b=f.merges.start(f.owner.id,key,selection,f.config,false);
    expect(()=>f.merges.start(f.owner.id,key,selection,f.config,false,1)).toThrow();
    const dispatches=new DispatchStore(f.store.database);dispatches.claimNextDispatch(f.node.nodeId);dispatches.recordDispatchResult({nodeId:f.node.nodeId,dispatchId:b.dispatchId,status:"launched"});
    expect(()=>f.merges.integrate(f.owner.id,b.dispatchId,b.id,0,"legacy",{kind:"progress",deliveryId:f.d.id,expectedHead:f.d.head,phase:"investigating",detail:"Read"})).toThrow();
  });
});

describe("AND-439 batch reconciliation",()=>{
  async function recoveryFixture(options:{mixed?:boolean;publish?:boolean;protocol?:1;artifacts?:string[]}={}) {
    const f=await fixture(),launched=f.launch("opencode"),merges=new MergeDeliveries(f.store);
    const keys=[f.item.key];
    if(options.mixed)keys.push(f.store.createWorkItem({productId:f.item.productId,title:"Other row",description:"Synthetic",type:"task",priority:"normal",status:"ready",environment:{platform:"web"}}).key);
    for(const itemKey of keys)f.safe(await f.call("claim_item",{...f.claimInput,session:undefined,dispatchId:launched.dispatch.id,itemKey,idempotencyKey:`claim-${itemKey}`}));
    const d=merges.propose(f.owner.id,"original-client",{dispatchId:launched.dispatch.id},"offer",{...proposal(f.item.key),itemKeys:keys,...(options.artifacts?{requiredArtifacts:options.artifacts}:{})});
    merges.decide(f.owner.id,d.id,d.revision,"confirm");
    const b=merges.start(f.owner.id,randomUUID(),[{id:d.id,revision:d.revision}],{productId:f.item.productId,nodeId:launched.node.nodeId,agentKind:"opencode",mode:"default"},options.publish??false,options.protocol);
    const ds=new DispatchStore(f.store.database);ds.claimNextDispatch(launched.node.nodeId);ds.recordDispatchResult({nodeId:launched.node.nodeId,dispatchId:b.dispatchId,status:"launched"});
    const preview=()=>merges.preview(f.owner.id,b.id);
    const request=(action:Parameters<MergeDeliveries["requestReconciliation"]>[5],key=randomUUID())=>{
      const snapshot=preview().snapshot;merges.requestReconciliation(f.owner.id,b.dispatchId,b.id,key,snapshot,action);return {key,snapshot};
    };
    const approve=(r:{key:string;snapshot:string})=>merges.decideReconciliation(f.owner.id,b.id,r.key,r.snapshot,"approved",true);
    const apply=(key:string)=>merges.applyReconciliation(f.owner.id,b.dispatchId,b.id,key);
    const merged=()=>merges.report(f.owner.id,b.dispatchId,b.id,d.id,{status:"merged",head:d.head,commit:"c".repeat(40),detail:"Verified Git fixture"});
    const evidence={head:"e".repeat(40),commit:"c".repeat(40),targetHead:"f".repeat(40),source:d.pullRequestUrl,checkedAt:new Date().toISOString(),checks:"passed" as const,local:"passed" as const,originalIncluded:true as const,targetIncludesMerge:true as const,validation:"Synthetic external merge and local validation"};
    const final=()=>merges.recordCombinedValidation(f.owner.id,b.dispatchId,b.id,{head:"f".repeat(40),checkedAt:new Date().toISOString(),source:"Synthetic actual target",validation:"Combined regression passed"});
    return {...f,...launched,merges,d,b,keys,preview,request,approve,apply,merged,evidence,final};
  }
  it("records one bound native recovery decision without performing recovery or trusting an Agent attestation",async()=>{
    const f=await recoveryFixture();
    const r=f.request({kind:"accept_merge",deliveryId:f.d.id,evidence:f.evidence});
    const name="request_merge_reconciliation_approval";
    const input={batchId:f.b.id,requestId:r.key,snapshot:r.snapshot,idempotencyKey:"native-recovery-approval"};
    const nativeMeta={"io.modelcontextprotocol/protocolVersion":"2026-07-28","io.modelcontextprotocol/clientInfo":{name:"opencode",version:"fixture"},"io.modelcontextprotocol/clientCapabilities":{elicitation:{form:{}}}};
    const first=await f.call(name,input,{native:{_meta:nativeMeta}});
    expect(first,JSON.stringify(first)).toMatchObject({resultType:"input_required",requestState:expect.any(String)});
    expect(JSON.stringify(first.inputRequests)).toContain("人工核实没有未结束");
    expect(f.preview().entries[0]?.result).toBeUndefined();
    const native={_meta:nativeMeta,requestState:first.requestState,inputResponses:{humanConfirmation:{action:"accept",content:{}}}};
    expect((await f.call(name,{...input,noExecutionRemaining:true},{native})).isError).toBe(true);
    expect(await f.call(name,input,{native})).toMatchObject({structuredContent:{approved:true,source:"native"}});
    expect(f.preview().reconciliation?.requests.find(x=>x.id===r.key)?.decision).toBe("approved");
    expect(f.preview().entries[0]?.result).toBeUndefined();
    expect(f.store.getWorkItem(f.item.key).status).toBe("in_progress");
    expect(await f.call(name,input,{native:{_meta:nativeMeta}})).toMatchObject({structuredContent:{approved:true,source:"existing"}});
    expect(f.db.prepare("SELECT COUNT(*) AS n FROM native_human_confirmations").get()).toEqual({n:1});
    f.apply(r.key);const before=f.store.getTimeline(f.item.key);f.apply(r.key);
    expect(f.store.getTimeline(f.item.key)).toEqual(before);
  });
  it("reads without mutation and requires human authorization bound to the exact snapshot",async()=>{
    const f=await recoveryFixture(),before=f.db.prepare("SELECT data_json FROM merge_batches WHERE id=?").get(f.b.id);
    expect(f.preview().entries[0]).toMatchObject({originalHead:f.d.head,executionHead:f.d.head});
    const read=await f.call("get_review_content",{kind:"recovery",id:f.b.id},{scopes:["missiongo:read"]});
    expect(read.isError,JSON.stringify(read)).not.toBe(true);
    expect(JSON.parse(read.structuredContent!.text as string)).toMatchObject({snapshot:f.preview().snapshot});
    expect((await f.call("get_review_content",{kind:"recovery",id:f.b.id},{accountId:f.other.id,scopes:["missiongo:read"]})).isError).toBe(true);

    expect(f.db.prepare("SELECT data_json FROM merge_batches WHERE id=?").get(f.b.id)).toEqual(before);
    const action={kind:"accept_merge" as const,deliveryId:f.d.id,evidence:f.evidence},r=f.request(action);
    expect(()=>f.apply(r.key)).toThrow(/人工/);
    expect(()=>f.merges.decideReconciliation(f.other.id,f.b.id,r.key,r.snapshot,"approved",true)).toThrow();
    expect(()=>f.merges.decideReconciliation(f.owner.id,f.b.id,r.key,r.snapshot,"approved",false)).toThrow();
    expect(()=>f.merges.requestReconciliation(f.owner.id,f.b.dispatchId,f.b.id,r.key,r.snapshot,{...action,evidence:{...f.evidence,head:"f".repeat(40)}})).toThrow();
    f.approve(r);f.apply(r.key);const timeline=f.store.getTimeline(f.item.key);f.apply(r.key);
    expect(f.store.getTimeline(f.item.key)).toEqual(timeline);expect(f.store.getWorkItem(f.item.key).status).toBe("development_complete");
    expect(f.preview().entries[0]).toMatchObject({originalHead:f.d.head,result:{head:f.evidence.head,commit:f.evidence.commit}});
    expect(()=>f.merges.finish(f.owner.id,f.b.dispatchId,f.b.id)).toThrow();f.final();
    expect(f.merges.finish(f.owner.id,f.b.dispatchId,f.b.id).state).toBe("finished");
  });
  it("keeps blocked history while accepting an externally merged result",async()=>{
    const f=await recoveryFixture();
    const blocked={status:"blocked" as const,head:f.d.head,detail:"Verified dependency failure"};
    f.merges.report(f.owner.id,f.b.dispatchId,f.b.id,f.d.id,blocked);
    const r=f.request({kind:"accept_merge",deliveryId:f.d.id,evidence:f.evidence});f.approve(r);f.apply(r.key);
    expect(f.preview().reconciliation?.history).toContainEqual(expect.objectContaining({action:"accept_merge",previous:blocked}));
    expect(f.preview().entries[0]?.result?.status).toBe("merged");
  });
  it("retries a blocked delivery in the original batch and preserves the old outcome",async()=>{
    const f=await recoveryFixture();f.merges.report(f.owner.id,f.b.dispatchId,f.b.id,f.d.id,{status:"blocked",head:f.d.head,detail:"Old obstacle"});
    const r=f.request({kind:"retry_blocked",deliveryId:f.d.id,reason:"Obstacle resolved"});f.approve(r);f.apply(r.key);
    expect(f.preview().entries[0]?.result).toBeUndefined();expect(f.preview().reconciliation?.history.at(-1)?.previous).toMatchObject({status:"blocked"});
    f.merged();f.final();expect(f.merges.finish(f.owner.id,f.b.dispatchId,f.b.id).state).toBe("finished");
  });
  it("recovers a finished original batch only after explicit authorization",async()=>{
    const f=await recoveryFixture();f.merges.report(f.owner.id,f.b.dispatchId,f.b.id,f.d.id,{status:"blocked",head:f.d.head,detail:"Obstacle"});f.merges.finish(f.owner.id,f.b.dispatchId,f.b.id);
    const r=f.request({kind:"accept_merge",deliveryId:f.d.id,evidence:f.evidence});
    expect(()=>f.approve(r)).toThrow(/活动/);
    const pending=f.db.prepare("SELECT id FROM agent_session_commands WHERE session_id=? AND status='queued'").all(f.b.sessionId) as {id:string}[];
    for(const command of pending)new AgentSessionStore(f.store.database).recordSnapshot({nodeId:f.node.nodeId,sessionId:f.b.sessionId,status:"idle",messages:[],turnState:{turnActive:false},commandId:command.id,commandStatus:"delivered"});
    new AgentSessionStore(f.store.database).recordSnapshot({nodeId:f.node.nodeId,sessionId:f.b.sessionId,status:"idle",messages:[],turnState:{turnActive:false}});
    f.approve(r);f.apply(r.key);
    expect(f.preview().state).toBe("active");expect(f.preview().batchId).toBe(f.b.id);
  });
  it("persists Git success and independent handoffs, then appends missing evidence for manual completion",async()=>{
    const f=await recoveryFixture({mixed:true,publish:true});
    f.store.transitionWorkItem({itemKey:f.item.key,actor:"human",to:"development_complete",reason:"manual_override",note:"Human advancement",attribution:{accountId:config.id}});
    const human=f.store.getDevelopmentEvidence(f.item.key).handover!;
    f.merged();expect(f.preview().entries[0]?.result?.status).toBe("merged");
    expect(f.store.getWorkItem(f.keys[1]!).status).toBe("development_complete");
    expect(f.preview().reconciliation?.handoffs[f.item.key]?.status).toBe("blocked");
    const r=f.request({kind:"retry_handover",deliveryId:f.d.id});f.approve(r);f.apply(r.key);
    expect(f.store.getDevelopmentEvidence(f.item.key).handover).toEqual(human);
    expect(f.store.getDevelopmentReleaseScope(f.item.key)).toEqual(["web"]);
    const listing=await f.call("list_release_candidates",{productId:f.item.productId,includeUnscoped:true});f.safe(listing);
    const rows=listing.structuredContent!.candidates as Array<Record<string,unknown>>;
    expect(rows).toHaveLength(2);expect(rows.every(row=>row.completion&&row.developmentEventId)).toBe(true);
    expect(()=>f.merges.finish(f.owner.id,f.b.dispatchId,f.b.id)).toThrow(/发布/);
    const clean=rows.map(({requiredArtifacts:_artifacts,...row})=>({...row,releases:[{artifact:"web",version:"test",sourceCommit:"f".repeat(40)}]}));
    f.safe(await f.call("submit_release_batch",{productId:f.item.productId,idempotencyKey:"release-after-evidence",deployedCommit:"f".repeat(40),receiptDigest:"e".repeat(64),items:clean}));
    expect(f.store.getWorkItem(f.item.key).status).toBe("pending_verification");
    expect(f.merges.finish(f.owner.id,f.b.dispatchId,f.b.id).state).toBe("finished");
  });
  it("preserves held items while completing other rows of the same PR",async()=>{
    const f=await recoveryFixture({mixed:true});f.store.transitionWorkItem({itemKey:f.item.key,actor:"human",to:"on_hold",reason:"request_human_input",note:"Human hold",executionDisposition:"keep_running",attribution:{accountId:config.id}});
    f.merged();expect(f.store.getWorkItem(f.item.key).status).toBe("on_hold");expect(f.store.getWorkItem(f.keys[1]!).status).toBe("development_complete");
    expect(f.preview().reconciliation?.handoffs[f.item.key]?.detail).toMatch(/暂缓/);
    expect(()=>f.merges.finish(f.owner.id,f.b.dispatchId,f.b.id)).toThrow(/交接/);
  });
  it.each(["before-approval","after-approval"])("rejects concurrent changes %s",async phase=>{
    const f=await recoveryFixture(),r=f.request({kind:"accept_merge",deliveryId:f.d.id,evidence:f.evidence});
    if(phase==="after-approval")f.approve(r);
    f.store.transitionWorkItem({itemKey:f.item.key,actor:"human",to:"development_complete",reason:"manual_override",note:"Concurrent move",attribution:{accountId:config.id}});
    expect(()=>phase==="after-approval"?f.apply(r.key):f.approve(r)).toThrow();expect(f.preview().entries[0]?.result).toBeUndefined();
  });
  it("rejects scope conflicts and preserves advanced states",async()=>{
    const f=await recoveryFixture();f.merged();
    f.store.transitionWorkItem({itemKey:f.item.key,actor:"human",to:"pending_verification",reason:"manual_override",note:"Human verification",attribution:{accountId:config.id}});
    const r=f.request({kind:"retry_handover",deliveryId:f.d.id});f.approve(r);const before=f.store.getTimeline(f.item.key);f.apply(r.key);
    expect(f.store.getTimeline(f.item.key)).toEqual(before);expect(f.store.getWorkItem(f.item.key).status).toBe("pending_verification");
  });
  it("rejects replay after permissions are revoked",async()=>{
    const f=await recoveryFixture(),r=f.request({kind:"accept_merge",deliveryId:f.d.id,evidence:f.evidence});f.approve(r);f.apply(r.key);f.grant(true,false);
    expect(()=>f.apply(r.key)).toThrow();expect(()=>f.merges.recordCombinedValidation(f.owner.id,f.b.dispatchId,f.b.id,{head:"f".repeat(40),checkedAt:new Date().toISOString(),source:"Fixture",validation:"Passed"})).toThrow();
  });
  it("requires a human publication decision and retains the selected publication intent",async()=>{
    const f=await recoveryFixture({publish:true});f.merged();expect(()=>f.merges.finish(f.owner.id,f.b.dispatchId,f.b.id)).toThrow(/发布/);
    const r=f.request({kind:"defer_publication",reason:"Wait for device validation"});expect(()=>f.apply(r.key)).toThrow();f.approve(r);f.apply(r.key);
    expect(f.merges.finish(f.owner.id,f.b.dispatchId,f.b.id)).toMatchObject({state:"finished",publish:true});
    expect(f.store.getWorkItem(f.item.key).status).toBe("development_complete");
  });
  it("exposes scoped MCP recovery without any agent approval tool",async()=>{
    const f=await recoveryFixture(),snapshot=f.preview().snapshot;
    f.safe(await f.call("get_merge_reconciliation",{batchId:f.b.id}));
    const input={batchId:f.b.id,dispatchId:f.b.dispatchId,idempotencyKey:"mcp-recovery",snapshot,action:{kind:"accept_merge",deliveryId:f.d.id,evidence:f.evidence}};
    f.safe(await f.call("request_merge_reconciliation",input));f.safe(await f.call("request_merge_reconciliation",input));
    expect((await f.call("apply_merge_reconciliation",{batchId:f.b.id,dispatchId:f.b.dispatchId,requestId:input.idempotencyKey})).isError).toBe(true);
    for(const options of [{scopes:["missiongo:read"]},{accountId:f.other.id}])expect((await f.call("request_merge_reconciliation",{...input,idempotencyKey:randomUUID()},options)).isError).toBe(true);
    const login=await f.app.inject({method:"POST",url:"/api/v1/auth/login",payload:{username:f.owner.email,password:"synthetic password"}}),cookie=login.headers["set-cookie"]!.toString().split(";")[0]!;
    const approved=await f.app.inject({method:"POST",url:`/api/v1/merge-batches/${f.b.id}/reconciliation/${input.idempotencyKey}/decision`,headers:{cookie},payload:{snapshot,decision:"approved",noExecutionRemaining:true}});
    expect(approved.statusCode,approved.body).toBe(200);f.safe(await f.call("apply_merge_reconciliation",{batchId:f.b.id,dispatchId:f.b.dispatchId,requestId:input.idempotencyKey}));
  });
  it("recovers through the old tool catalogue without minting approval or changing ordinary progress",async()=>{
    const f=await recoveryFixture({protocol:1});
    f.merges.integrate(f.owner.id,f.b.dispatchId,f.b.id,0,"plan",{kind:"plan",base:"b".repeat(40),summary:"Plan",validation:"Combined",entries:[{deliveryId:f.d.id,head:f.d.head,dependsOn:[],group:"one",reason:"Fixture",validation:"Regression"}]});
    f.merges.integrate(f.owner.id,f.b.dispatchId,f.b.id,1,"ordinary",{kind:"progress",deliveryId:f.d.id,expectedHead:f.d.head,phase:"investigating",detail:"request recovery after investigation"});
    expect(f.preview().reconciliation?.requests).toBeUndefined();
    f.merges.report(f.owner.id,f.b.dispatchId,f.b.id,f.d.id,{status:"blocked",head:f.d.head,detail:"External merged head differs"});
    const snapshot=f.preview().snapshot;
    const transport=(key:string,payload:unknown,head=f.d.head,revision=3)=>({batchId:f.b.id,dispatchId:f.b.dispatchId,expectedRevision:revision,idempotencyKey:key,
      action:{kind:"progress",deliveryId:f.d.id,expectedHead:head,phase:"investigating",detail:recoveryDetailPrefix+JSON.stringify(payload)}});
    const input=transport("old-request",{operation:"request",snapshot,action:{kind:"accept_merge",deliveryId:f.d.id,evidence:f.evidence}});
    const loaded=await f.call("get_merge_batch",{batchId:f.b.id,dispatchId:f.b.dispatchId});f.safe(loaded);
    expect(loaded.structuredContent!.recovery).toMatchObject({snapshot});expect(loaded.structuredContent!.recoveryTransport).toMatchObject({tool:"record_merge_integration"});
    for(const options of [{scopes:["missiongo:read"]},{accountId:f.other.id}])expect((await f.call("record_merge_integration",input,options)).isError).toBe(true);
    expect((await f.call("record_merge_integration",{...input,dispatchId:randomUUID()})).isError).toBe(true);
    expect((await f.call("record_merge_integration",{...input,expectedRevision:1})).isError).toBe(true);
    expect((await f.call("record_merge_integration",transport("stale",{operation:"request",snapshot:"0".repeat(64),action:{kind:"accept_merge",deliveryId:f.d.id,evidence:f.evidence}}))).isError).toBe(true);
    expect((await f.call("record_merge_integration",transport("other-delivery",{operation:"request",snapshot,action:{kind:"accept_merge",deliveryId:randomUUID(),evidence:f.evidence}}))).isError).toBe(true);
    expect((await f.call("record_merge_integration",{...input,idempotencyKey:"ordinary"})).isError).toBe(true);
    f.safe(await f.call("record_merge_integration",input));f.safe(await f.call("record_merge_integration",input));
    expect(f.preview().snapshot).toBe(snapshot);expect(f.preview().reconciliation?.requests).toHaveLength(1);
    const applying=transport("old-apply",{operation:"apply",requestId:"old-request"});
    expect((await f.call("record_merge_integration",applying)).isError).toBe(true);
    expect((await f.call("record_merge_integration",transport("approve",{operation:"approve",requestId:"old-request"}))).isError).toBe(true);
    expect((await f.call("record_merge_integration",transport("bad-json",{operation:"apply",requestId:"old-request",decision:"approved"}))).isError).toBe(true);
    expect(f.preview().entries[0]?.result?.status).toBe("blocked");
    f.approve({key:"old-request",snapshot});f.safe(await f.call("record_merge_integration",applying));
    const after=f.preview(),timeline=f.store.getTimeline(f.item.key);
    f.safe(await f.call("record_merge_integration",applying));
    expect(f.preview()).toEqual(after);expect(f.store.getTimeline(f.item.key)).toEqual(timeline);
    expect((await f.call("record_merge_integration",{...applying,action:{...applying.action,expectedHead:"0".repeat(40)}})).isError).toBe(true);
    f.grant(false);expect((await f.call("record_merge_integration",applying)).isError).toBe(true);f.grant();
    expect(after.entries[0]).toMatchObject({originalHead:f.d.head,executionHead:f.evidence.head,result:{status:"merged"}});
    expect(()=>f.merges.finish(f.owner.id,f.b.dispatchId,f.b.id)).toThrow();
    f.safe(await f.call("record_merge_integration",{batchId:f.b.id,dispatchId:f.b.dispatchId,expectedRevision:4,idempotencyKey:"old-final",
      action:{kind:"final_validation",head:f.evidence.targetHead,checkedAt:new Date().toISOString(),source:"Synthetic target checks",validation:"Combined check passed"}}));
    expect(f.merges.finish(f.owner.id,f.b.dispatchId,f.b.id).state).toBe("finished");
  });
  it("settles an existing reservation through external evidence without claiming it as a repair",async()=>{
    const f=await recoveryFixture({protocol:1});
    f.merges.integrate(f.owner.id,f.b.dispatchId,f.b.id,0,"plan",{kind:"plan",base:"b".repeat(40),summary:"Plan",validation:"Combined",entries:[{deliveryId:f.d.id,head:f.d.head,dependsOn:[],group:"one",reason:"Fixture",validation:"Regression"}]});
    f.merges.integrate(f.owner.id,f.b.dispatchId,f.b.id,1,"reserved",{kind:"prepare_repair",deliveryId:f.d.id,expectedHead:f.d.head,base:"b".repeat(40),reason:"Original reservation"});
    const r=f.request({kind:"accept_merge",deliveryId:f.d.id,evidence:f.evidence});f.approve(r);f.apply(r.key);
    const current=f.merges.batch(f.owner.id,f.b.dispatchId,f.b.id);
    expect(current.integration?.entries[f.d.id]?.repairs).toEqual([]);expect(current.integration?.entries[f.d.id]?.repair).toBeUndefined();
    expect(f.preview().reconciliation?.history).toContainEqual(expect.objectContaining({action:"external_merge_settled_reservation",previous:expect.objectContaining({id:"reserved"})}));
    f.final();expect(f.merges.finish(f.owner.id,f.b.dispatchId,f.b.id).state).toBe("finished");
  });
  it("retains exact legacy authorization during read-only preview and staged recovery",async()=>{
    const f=await recoveryFixture();
    f.db.prepare("UPDATE free_session_starts SET initial_text=? WHERE dispatch_id=?").run(legacyIntegratorPrompt(f.b.id,false),f.b.dispatchId);
    const before=f.db.prepare("SELECT data_json FROM merge_batches WHERE id=?").get(f.b.id);
    f.preview();expect(f.db.prepare("SELECT data_json FROM merge_batches WHERE id=?").get(f.b.id)).toEqual(before);
    const r=f.request({kind:"accept_merge",deliveryId:f.d.id,evidence:f.evidence});f.approve(r);f.apply(r.key);f.final();
    expect(f.merges.finish(f.owner.id,f.b.dispatchId,f.b.id).state).toBe("finished");
  });
  it("appends another verified integration without overwriting the earlier completion metadata",async()=>{
    const f=await recoveryFixture();
    f.store.submitDevelopmentComplete({itemKey:f.item.key,completion:{kind:"github",url:"https://github.com/example/project/pull/99"},requiredArtifacts:["androidApp"],idempotencyKey:"different-completion",attribution:{accountId:f.owner.id}});
    f.merged();const r=f.request({kind:"retry_handover",deliveryId:f.d.id});f.approve(r);const before=f.store.getTimeline(f.item.key);f.apply(r.key);
    expect(f.store.getTimeline(f.item.key).slice(0,before.length)).toEqual(before);
    expect(f.store.getDeliveryRecords(f.item.key)).toHaveLength(2);
    expect(f.preview().reconciliation?.handoffs[f.item.key]?.status).toBe("completed");
  });
  it("does not treat manual verification without release receipts as published",async()=>{
    const f=await recoveryFixture({publish:true});f.merged();
    f.store.transitionWorkItem({itemKey:f.item.key,actor:"human",to:"pending_verification",reason:"manual_override",note:"Human move",attribution:{accountId:config.id}});
    expect(()=>f.merges.finish(f.owner.id,f.b.dispatchId,f.b.id)).toThrow(/发布凭据/);
    expect(f.merges.batches(f.item.productId,f.owner.id)[0]!.presentation.entries[f.d.id]!.publication).not.toBe("published");
  });
  it("does not let later conversation input block an independently published unchanged delivery",async()=>{
    const f=await recoveryFixture({publish:true});f.merged();
    const listing=await f.call("list_release_candidates",{productId:f.item.productId,includeUnscoped:true});
    const row=(listing.structuredContent!.candidates as Record<string,unknown>[])[0]!;
    const {requiredArtifacts:_scope,...candidate}=row;
    f.safe(await f.call("submit_release_batch",{productId:f.item.productId,idempotencyKey:"published",deployedCommit:"f".repeat(40),receiptDigest:"a".repeat(64),
      items:[{...candidate,releases:[{artifact:"web",version:"test",sourceCommit:"f".repeat(40)}]}]}));
    expect(f.merges.sessionProgress(f.item.productId,f.owner.id)[f.d.sessionId]).toBe("published");
    new AgentSessionStore(f.store.database).enqueue(f.owner.id,f.d.sessionId,"Discuss next work",[]);
    expect(f.merges.sessionProgress(f.item.productId,f.owner.id)[f.d.sessionId]).toBeUndefined();
    expect(f.preview().entries[0]?.items[0]?.blocker).toBeUndefined();
    const before=f.store.getTimeline(f.item.key);
    expect(f.merges.finish(f.owner.id,f.b.dispatchId,f.b.id).state).toBe("finished");
    expect(f.store.getTimeline(f.item.key)).toEqual(before);
    f.store.transitionWorkItem({itemKey:f.item.key,actor:"human",to:"ready",reason:"verification_failed",note:"New rework",attribution:{accountId:config.id}});
    expect(f.preview().entries[0]?.items[0]?.blocker).toBeTruthy();
    const display=f.merges.batches(f.item.productId,f.owner.id).find(b=>b.id===f.b.id)!.presentation.entries[f.d.id]!;
    expect(display.publication).toBe("published");
    expect(display.releases).toMatchObject([{artifact:"web",version:"test",sourceCommit:"f".repeat(40)}]);
  });
  it("closes the original external-merge batch after supplementing a manually advanced item",async()=>{
    const f=await recoveryFixture({publish:true,artifacts:["web","androidApp"]});
    f.merges.report(f.owner.id,f.b.dispatchId,f.b.id,f.d.id,{status:"blocked",head:f.d.head,detail:"External head differs"});
    f.store.transitionWorkItem({itemKey:f.item.key,actor:"human",to:"development_complete",reason:"resolution_submitted",attribution:{accountId:config.id}});
    f.store.transitionWorkItem({itemKey:f.item.key,actor:"human",to:"pending_verification",reason:"release_verified",attribution:{accountId:config.id}});
    new AgentSessionStore(f.store.database).enqueue(f.owner.id,f.d.sessionId,"Next discussion",[]);
    const item=f.preview().entries[0]!.items[0]!;
    expect(item.missingPublicationEvidence).toBe(true);expect(item.blocker).toBeTruthy();
    const statuses=f.store.getTimeline(f.item.key).filter(e=>e.eventType==="status_changed");
    f.safe(await f.call("submit_release_batch",{productId:f.item.productId,idempotencyKey:"manual-published",deployedCommit:"f".repeat(40),receiptDigest:"a".repeat(64),
      items:[{itemKey:f.item.key,expectedRevision:item.revision,developmentEventId:item.developmentEventId,roundKey:item.roundKey,
        completion:{kind:"github",url:f.d.pullRequestUrl},releases:[{artifact:"web",version:"test",sourceCommit:"f".repeat(40)}]}]}));
    const r=f.request({kind:"accept_merge",deliveryId:f.d.id,evidence:f.evidence});f.approve(r);f.apply(r.key);f.final();
    expect(f.preview().entries[0]?.items[0]).toMatchObject({status:"pending_verification",missingPublicationEvidence:false,handoff:{status:"completed"}});
    expect(f.merges.finish(f.owner.id,f.b.dispatchId,f.b.id).state).toBe("finished");
    expect(f.store.getTimeline(f.item.key).filter(e=>e.eventType==="status_changed")).toEqual(statuses);
  });
  it("does not heal a rejected delivery or reuse stale supplement evidence",async()=>{
    const f=await recoveryFixture();f.merged();
    f.store.transitionWorkItem({itemKey:f.item.key,actor:"human",to:"pending_verification",reason:"manual_override",note:"Human move",attribution:{accountId:config.id}});
    f.store.transitionWorkItem({itemKey:f.item.key,actor:"human",to:"ready",reason:"verification_failed",note:"Rejected",attribution:{accountId:config.id}});
    const r=f.request({kind:"retry_handover",deliveryId:f.d.id});f.approve(r);f.apply(r.key);
    expect(f.store.getWorkItem(f.item.key).status).toBe("ready");expect(f.preview().reconciliation?.handoffs[f.item.key]?.status).toBe("blocked");
  });
  it("refuses recovery when the original batch node is revoked",async()=>{
    const f=await recoveryFixture(),r=f.request({kind:"accept_merge",deliveryId:f.d.id,evidence:f.evidence});f.approve(r);
    f.db.prepare("UPDATE nodes SET revoked_at=? WHERE id=?").run(new Date().toISOString(),f.node.nodeId);
    expect(()=>f.apply(r.key)).toThrow();expect(f.preview().entries[0]?.result).toBeUndefined();
  });

});

it("reads delivery content on read-only scope without confirming, and denies another account or revoked scope",async()=>{
  const f=await prepared();
  const args={kind:"delivery",id:f.d.id};
  const read=await f.call("get_review_content",args,{scopes:["missiongo:read"]});
  expect(read.isError,JSON.stringify(read)).not.toBe(true);
  expect(JSON.parse(read.structuredContent!.text as string)).toMatchObject({summary:f.input.summary,validation:f.input.validation,state:"proposed"});
  expect((await f.call("get_review_content",args,{accountId:f.other.id,scopes:["missiongo:read"]})).isError).toBe(true);
  f.grant(true,false);
  const denied=await f.call("get_review_content",args,{scopes:["missiongo:read"]});
  expect(denied.isError ?? Boolean(denied.error)).toBe(true);
  expect(f.merges.readForAccount(f.owner.id,f.d.id).state).toBe("proposed");
});

it("AND-460 projects delivery-only attention consistently and keeps later independent instructions", async () => {
  const f = await prepared(), sessions = new AgentSessionStore(f.store.database);
  const login = await f.app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { username: f.owner.email, password: "synthetic password" } });
  const headers = { cookie: String(login.headers["set-cookie"]).split(";")[0]! };
  const list = async () => (await f.app.inject({ method: "GET", url: "/api/v1/agent-sessions", headers })).json().sessions[0];
  const snapshot = (sourceId: string, text: string) => sessions.recordSnapshot({ nodeId: f.node.nodeId, sessionId: f.projectSessionId,
    status: "idle", messages: [{ sourceId, role: "agent", phase: "final_answer", text }] });
  snapshot("delivery", "代码与检查已完成，请发起合并。");
  const first = sessions.pendingAttention(f.projectSessionId)!;
  expect(sessions.completeAttention(f.projectSessionId, first.messageHash, { needsAttention: true, kind: "instruction", reason: "等待发起合并", model: "synthetic", deliveryOnly: true })).toBe(true);
  expect(await list()).toMatchObject({ needsAttention: false, attention: { state: "needed", handledByDelivery: true, reason: "等待发起合并" } });
  f.merges.decide(f.owner.id, f.d.id, f.d.revision, "confirm");
  expect((await list()).needsAttention).toBe(false);
  f.merges.decide(f.owner.id, f.d.id, f.d.revision, "withdraw");
  expect((await list()).needsAttention).toBe(false);
  snapshot("independent", "请决定另一项独立安排。");
  const second = sessions.pendingAttention(f.projectSessionId)!;
  expect(sessions.completeAttention(f.projectSessionId, second.messageHash, { needsAttention: true, kind: "instruction", reason: "独立安排", model: "synthetic", deliveryOnly: false })).toBe(true);
  expect(await list()).toMatchObject({ needsAttention: true, attention: { reason: "独立安排" } });
  expect((await list()).attention.handledByDelivery).toBeUndefined();
  // A legacy cached verdict has no delivery attribution and remains visible.
  f.db.prepare("UPDATE agent_session_attention SET delivery_only=NULL WHERE session_id=?").run(f.projectSessionId);
  expect((await list()).needsAttention).toBe(true);
  f.db.prepare("UPDATE work_items SET content_version=content_version+1 WHERE id=?").run(f.item.id);
  expect(f.merges.attentionSessionIds(f.item.productId, f.owner.id)).toEqual([]);
});

it("keeps parallel merge proposals and accepts an existing claimant's proposal during verification",async()=>{
 const f=await prepared();
 const claim=await f.call("claim_item",{...f.claimInput,session:{...f.session,sessionRef:randomUUID()},idempotencyKey:"parallel-merge-claim"});f.safe(claim);
 const identity={sessionId:claim.structuredContent!.sessionId!};
 const second=f.merges.propose(f.owner.id,"original-client",identity,"parallel-offer",{...f.input,pullRequest:13});
 expect(f.merges.list(f.item.productId,f.owner.id).filter(row=>row.state!=="withdrawn").map(row=>row.id)).toEqual(expect.arrayContaining([f.d.id,second.id]));
 f.store.submitDevelopmentComplete({itemKey:f.item.key,completion,requiredArtifacts:["web"],attribution:{accountId:f.owner.id},idempotencyKey:"first-merge"});
 f.store.submitForVerification({itemKey:f.item.key,completion,releases:[{artifact:"web",version:"1.0",sourceCommit:"a".repeat(40)}],deployedCommit:"a".repeat(40),receiptDigest:"b".repeat(64),attribution:{accountId:f.owner.id},idempotencyKey:"first-publication"});
 const next=f.merges.propose(f.owner.id,"original-client",identity,"verification-offer",{...f.input,pullRequest:14});
 expect(next.state).toBe("proposed");expect(f.store.getWorkItem(f.item.key).status).toBe("pending_verification");
 expect(f.merges.list(f.item.productId,f.owner.id).find(row=>row.id===f.d.id)?.state).toBe("proposed");
});

describe("AND-476 independent integration defaults",()=>{
  it("saves only opted-in accepted batches, isolates dispatch/accounts and does not overwrite newer preferences on replay",async()=>{
    const f=await prepared(), store=new DispatchStore(f.store.database);
    store.setDispatchDefaults(f.owner.id,{nodeId:f.node.nodeId,agentKind:"opencode",agents:{opencode:{mode:"plan"}}});
    store.setDispatchDefaults(f.owner.id,{agents:{codex:{mode:"auto",model:"kept"}}},"integration");
    f.merges.decide(f.owner.id,f.d.id,f.d.revision,"confirm");
    const selection=[{id:f.d.id,revision:f.d.revision}];
    const batch=f.merges.start(f.owner.id,"integration-default-save",selection,f.config,false,1,true);
    expect(store.getDispatchDefaults(f.owner.id,"integration")).toEqual({nodeId:f.node.nodeId,agentKind:"opencode",agents:{codex:{mode:"auto",model:"kept"},opencode:{mode:"default"}}});
    expect(store.getDispatchDefaults(f.owner.id).agents.opencode?.mode).toBe("plan");
    expect(store.getDispatchDefaults(f.other.id,"integration")).toEqual({agents:{}});
    store.setDispatchDefaults(f.owner.id,{agents:{codex:{mode:"plan"}}},"integration");
    expect(f.merges.start(f.owner.id,"integration-default-save",selection,f.config,false,1,true).id).toBe(batch.id);
    expect(store.getDispatchDefaults(f.owner.id,"integration")).toEqual({agents:{codex:{mode:"plan"}}});
    expect(()=>f.merges.start(f.owner.id,"integration-default-save",selection,f.config,false,1,false)).toThrow();
  });
  it("keeps existing defaults when not opted in and rolls back the whole batch if saving fails",async()=>{
    const f=await prepared(),store=new DispatchStore(f.store.database);
    f.merges.decide(f.owner.id,f.d.id,f.d.revision,"confirm");
    f.merges.start(f.owner.id,"without-default",[{id:f.d.id,revision:f.d.revision}],f.config,false,1);
    expect(store.getDispatchDefaults(f.owner.id,"integration")).toEqual({agents:{}});
    const g=await prepared();g.merges.decide(g.owner.id,g.d.id,g.d.revision,"confirm");
    const before=g.db.prepare("SELECT count(*) AS n FROM dispatches").get();
    const original=DispatchStore.prototype.setDispatchDefaults;
    const spy=vi.spyOn(DispatchStore.prototype,"setDispatchDefaults").mockImplementation(function(account,body,scope){
      if(scope==="integration")throw new Error("Synthetic preference write failure");
      return original.call(this,account,body,scope);
    });
    try {
      expect(()=>g.merges.start(g.owner.id,"rollback-default",[{id:g.d.id,revision:g.d.revision}],g.config,false,1,true)).toThrow("Synthetic preference write failure");
      expect(g.db.prepare("SELECT count(*) AS n FROM dispatches").get()).toEqual(before);
      expect(g.db.prepare("SELECT count(*) AS n FROM merge_batches").get()).toEqual({n:0});
      expect(g.merges.list(g.item.productId,g.owner.id)[0]?.state).toBe("confirmed");
    } finally {spy.mockRestore();}
  });
});

it("AND-476 reads only the current account's integration defaults through the authenticated API",async()=>{
  const f=await prepared(),store=new DispatchStore(f.store.database);
  store.setDispatchDefaults(f.owner.id,{agents:{codex:{mode:"auto"}}},"integration");
  store.setDispatchDefaults(f.other.id,{agents:{opencode:{mode:"plan"}}},"integration");
  const login=await f.app.inject({method:"POST",url:"/api/v1/auth/login",payload:{username:f.owner.email,password:"synthetic password"}});
  const raw=login.headers["set-cookie"];
  const cookie=(Array.isArray(raw)?raw[0]:raw)!.split(";")[0]!;
  const read=await f.app.inject({method:"GET",url:"/api/v1/integration-defaults",headers:{cookie}});
  expect(read.statusCode).toBe(200);expect(read.json()).toEqual({agents:{codex:{mode:"auto"}}});
  expect((await f.app.inject({method:"GET",url:"/api/v1/integration-defaults"})).statusCode).toBe(401);
  const invalid=await f.app.inject({method:"POST",url:`/api/v1/products/${f.item.productId}/merge-batches`,headers:{cookie},payload:{requestKey:"invalid",selection:[],publish:false,saveAsDefault:"true"}});
  expect(invalid.statusCode).toBe(400);
});
describe("standalone project deliveries",()=>{
  async function standalone(artifacts=["web","macosApp"],publish=false) {
    const f=await fixture(),launched=f.launch("codex"),merges=new MergeDeliveries(f.store);
    const identity={dispatchId:launched.dispatch.id},input={...proposal(f.item.key),itemKeys:[],productId:f.item.productId,requiredArtifacts:artifacts,
      ...(!artifacts.length?{noReleaseReason:"Only local verification fixtures"}:{})};
    const offered=await f.call("propose_merge_delivery",{identity,idempotencyKey:"standalone",delivery:input,instructionConfirmation:{quote:"加入待合并"}});f.safe(offered);
    const d=merges.list(f.item.productId,f.owner.id)[0]!;
    const b=merges.start(f.owner.id,randomUUID(),[{id:d.id,revision:d.revision}],{productId:f.item.productId,nodeId:launched.node.nodeId,agentKind:"codex",mode:"default"},publish);
    const ds=new DispatchStore(f.store.database);ds.claimNextDispatch(launched.node.nodeId);ds.recordDispatchResult({nodeId:launched.node.nodeId,dispatchId:b.dispatchId,status:"launched"});
    return {...f,...launched,merges,identity,input,d,b};
  }
  const merged={status:"merged" as const,head:"a".repeat(40),commit:"c".repeat(40),detail:"Verified exact-head integration"};
  const proof={deployedCommit:"e".repeat(40),receiptDigest:"f".repeat(64)};
  it("merges without claiming an item and retains release coverage after a merge-only batch finishes",async()=>{
    const f=await standalone(),before=f.snapshot();
    expect(f.d.itemKeys).toEqual([]);expect(f.merges.list(f.item.productId,f.owner.id)[0]!.state).toBe("batched");
    expect(f.merges.batches(f.item.productId,f.owner.id)[0]!.presentation.entries[f.d.id]!.publication).toBe("pending");
    f.merges.report(f.owner.id,f.b.dispatchId,f.b.id,f.d.id,merged);f.merges.finish(f.owner.id,f.b.dispatchId,f.b.id);
    expect(f.snapshot()).toEqual(before);
    const listing=await f.call("list_release_candidates",{productId:f.item.productId,includeUnscoped:true});f.safe(listing);
    expect(listing.structuredContent).toMatchObject({coverageVersion:2,candidates:[{kind:"delivery",deliveryId:f.d.id,expectedRevision:f.d.revision,requiredArtifacts:["web","macosApp"]}]});
    const release={productId:f.item.productId,idempotencyKey:"standalone-release",...proof,deliveries:[{deliveryId:f.d.id,expectedRevision:f.d.revision,releases:[{artifact:"web",version:"1",sourceCommit:"e".repeat(40)}]}]};
    const partial=await f.call("submit_release_batch",release);f.safe(partial);
    expect(partial.structuredContent).toMatchObject({deliveries:[{deliveryId:f.d.id,outcome:"submitted"}]});
    f.safe(await f.call("submit_release_batch",release));
    expect(f.merges.batches(f.item.productId,f.owner.id)[0]!.presentation.entries[f.d.id]!.publication).toBe("partial");
    expect((await f.call("list_release_candidates",{productId:f.item.productId,includeUnscoped:true})).structuredContent!.candidates).toHaveLength(1);
    f.safe(await f.call("submit_release_batch",{...release,idempotencyKey:"finish-release",deliveries:[{...release.deliveries[0],releases:[{artifact:"macosApp",version:"2",sourceCommit:"e".repeat(40)}]}]}));
    expect((await f.call("list_release_candidates",{productId:f.item.productId,includeUnscoped:true})).structuredContent!.candidates).toEqual([]);
    expect(f.merges.batches(f.item.productId,f.owner.id)[0]!.presentation.entries[f.d.id]!.publication).toBe("published");
    expect(f.snapshot()).toEqual(before);
  });
  it("requires complete publication receipts to finish a publish batch, but explicit no-release work needs none",async()=>{
    const f=await standalone(["macosApp"],true);f.merges.report(f.owner.id,f.b.dispatchId,f.b.id,f.d.id,merged);
    expect(()=>f.merges.finish(f.owner.id,f.b.dispatchId,f.b.id)).toThrow(/发布凭据/);
    const bad={productId:f.item.productId,idempotencyKey:"bad",...proof,deliveries:[{deliveryId:f.d.id,expectedRevision:"0".repeat(64),releases:[{artifact:"macosApp",version:"2",sourceCommit:"e".repeat(40)}]}]};
    expect((await f.call("submit_release_batch",bad)).isError).toBe(true);
    f.safe(await f.call("submit_release_batch",{...bad,idempotencyKey:"valid",deliveries:[{...bad.deliveries[0],expectedRevision:f.d.revision}]}));
    expect(f.merges.finish(f.owner.id,f.b.dispatchId,f.b.id).state).toBe("finished");
    const g=await standalone([],true);g.merges.report(g.owner.id,g.b.dispatchId,g.b.id,g.d.id,merged);g.merges.finish(g.owner.id,g.b.dispatchId,g.b.id);
    const listing=await g.call("list_release_candidates",{productId:g.item.productId,includeUnscoped:true});
    expect(listing.structuredContent).toMatchObject({candidates:[],noReleaseDeliveries:[{deliveryId:g.d.id,noReleaseReason:g.input.noReleaseReason}]});
  });
  it("registers external project conversations with ownership and project isolation",async()=>{
    const f=await fixture(),session={agentKind:"codex",refKind:"tracking",sessionRef:randomUUID()};
    const registered=await f.call("register_agent_session",{productId:f.item.productId,session});f.safe(registered);
    const identity={sessionId:registered.structuredContent!.sessionId!},delivery={...proposal(f.item.key),itemKeys:[],productId:f.item.productId};
    const offer=await f.call("propose_merge_delivery",{identity,delivery,idempotencyKey:"external"});f.safe(offer);
    const otherClient=await f.call("propose_merge_delivery",{identity,delivery,idempotencyKey:"foreign"},{clientId:"foreign-client"});expect(otherClient.isError).toBe(true);
    const unrelated=f.store.createProduct({name:"Unrelated",keyPrefix:"OTHER",createdByAccountId:config.id});
    expect((await f.call("propose_merge_delivery",{identity,delivery:{...delivery,productId:unrelated.id},idempotencyKey:"foreign-project"})).isError).toBe(true);
    const merges=new MergeDeliveries(f.store),d=merges.list(f.item.productId,f.owner.id)[0]!;
    merges.decide(f.owner.id,d.id,d.revision,"confirm");
    f.db.prepare("UPDATE external_agent_sessions SET archived_at=? WHERE id=?").run(new Date().toISOString(),identity.sessionId);
    expect(merges.list(f.item.productId,f.owner.id)).toEqual([]);
    expect(f.store.getWorkItem(f.item.key).status).toBe("ready");
  });
  it("paginates mixed item and standalone candidates without gaps, including empty no-release pages",async()=>{
    const f=await standalone();f.merges.report(f.owner.id,f.b.dispatchId,f.b.id,f.d.id,merged);f.merges.finish(f.owner.id,f.b.dispatchId,f.b.id);
    f.safe(await f.call("claim_item",f.claimInput));
    const claimed=f.db.prepare("SELECT id FROM external_agent_sessions WHERE session_ref=?").get(f.session.sessionRef) as {id:string};
    f.safe(await f.complete({sessionId:claimed.id}));
    const found:Record<string,unknown>[]=[],cursors:number[]=[];let beforeSequence:number|undefined;
    do {
      const listing=await f.call("list_release_candidates",{productId:f.item.productId,includeUnscoped:true,limit:1,...(beforeSequence?{beforeSequence}:{})});f.safe(listing);
      found.push(...listing.structuredContent!.candidates as Record<string,unknown>[]);
      beforeSequence=listing.structuredContent!.nextBeforeSequence as number|undefined;
      if(beforeSequence){expect(cursors).not.toContain(beforeSequence);cursors.push(beforeSequence);}
    }while(beforeSequence);
    expect(found).toHaveLength(2);expect(found.some(c=>c.deliveryId===f.d.id)).toBe(true);expect(found.some(c=>c.itemKey===f.item.key)).toBe(true);
  });
  it("checks project permissions for external node discovery and standalone release handover",async()=>{
    const f=await fixture(),node=f.launch("codex").node;
    const registered=await f.call("register_agent_session",{productId:f.item.productId,session:{agentKind:"codex",refKind:"native",sessionRef:randomUUID(),autoConnect:true}});f.safe(registered);
    const id=registered.structuredContent!.sessionId!,native=new ExternalNativeSessionStore(f.store),authorized:string[]=[];
    const discovery=native.listForNode(f.owner.id,node.nodeId,"worker",product=>{authorized.push(product);},true);
    expect(discovery.some(s=>s.id===id)).toBe(true);expect(authorized).toContain(f.item.productId);
    expect(native.listForNode(f.owner.id,node.nodeId,"worker",()=>{throw new Error("Permission revoked");},true)).toEqual([]);
    const read=await f.call("get_agent_session",{sessionId:id});f.safe(read);
    const g=await standalone();g.merges.report(g.owner.id,g.b.dispatchId,g.b.id,g.d.id,merged);g.grant(false,true);
    expect((await g.call("submit_release_batch",{productId:g.item.productId,idempotencyKey:"revoked",...proof,deliveries:[{deliveryId:g.d.id,expectedRevision:g.d.revision,releases:[{artifact:"web",version:"1",sourceCommit:"e".repeat(40)}]}]})).isError).toBe(true);
    expect(g.merges.batches(g.item.productId,g.owner.id)[0]!.presentation.entries[g.d.id]!.publication).toBe("pending");
  });
  it("invalidates source changes and supersedes only the same standalone PR",async()=>{
    const f=await fixture(),launched=f.launch("codex"),merges=new MergeDeliveries(f.store),identity={dispatchId:launched.dispatch.id};
    const input={...proposal(f.item.key),itemKeys:[],productId:f.item.productId};
    const first=merges.propose(f.owner.id,"original-client",identity,"first",input);merges.decide(f.owner.id,first.id,first.revision,"confirm");
    const second=merges.propose(f.owner.id,"original-client",identity,"second",{...input,pullRequest:13});
    expect(merges.list(f.item.productId,f.owner.id)).toHaveLength(2);
    const renewed=merges.propose(f.owner.id,"original-client",identity,"renewed",input);
    expect(renewed.reconfirmation).toBe(true);expect(merges.list(f.item.productId,f.owner.id).map(d=>d.id)).toEqual([renewed.id,second.id]);
    new AgentSessionStore(f.store.database).enqueue(f.owner.id,launched.projectSessionId,"Continue changing the implementation",[]);
    expect(merges.list(f.item.productId,f.owner.id)).toEqual([]);
  });
});

// The reference calculations stay available to test the projection after real
// writes. Normal reads must never call them, even on the first request.
describe("AND-484 write-time display projections",()=>{
  it("matches full recomputation across writes and keeps all four reads lightweight",async()=>{
    const f=await prepared();
    const verify=()=>{
      const expected={list:f.merges.recomputeList(f.item.productId,f.owner.id),
        batches:f.merges.recomputeBatches(f.item.productId,f.owner.id),
        attention:f.merges.recomputeAttentionSessionIds(f.item.productId,f.owner.id),
        progress:f.merges.recomputeSessionProgress(f.item.productId,f.owner.id)};
      const item=vi.spyOn(f.store,"getWorkItem").mockImplementation(()=>{throw new Error("Read assembled detail");});
      const events=vi.spyOn(f.store,"getTimeline").mockImplementation(()=>{throw new Error("Read assembled timeline");});
      try {
        expect(f.merges.list(f.item.productId,f.owner.id)).toEqual(expected.list);
        expect(f.merges.batches(f.item.productId,f.owner.id)).toEqual(expected.batches);
        expect(f.merges.attentionSessionIds(f.item.productId,f.owner.id)).toEqual(expected.attention);
        expect(f.merges.sessionProgress(f.item.productId,f.owner.id)).toEqual(expected.progress);
      }finally{item.mockRestore();events.mockRestore();}
    };
    verify();f.merges.decide(f.owner.id,f.d.id,f.d.revision,"confirm");verify();
    const clock=vi.spyOn(Date,"now").mockReturnValue(Date.now()+360_000);
    try{verify();expect(f.merges.list(f.item.productId,f.owner.id)[0]?.blocker).toBe("stale");}finally{clock.mockRestore();}
    f.grant(false);verify();f.grant();verify();
    new AgentSessionStore(f.store.database).enqueue(f.owner.id,f.projectSessionId,"New authorized input",[]);verify();
    expect(f.merges.list(f.item.productId,f.owner.id)).toEqual([]);
  });
  it("keeps mismatched heads stale and observes user-to-Agent history corrections",async()=>{
    const f=await prepared();
    const d=f.merges.propose(f.owner.id,"original-client",f.identity,"mismatched-head",{...f.input,evidence:{...f.input.evidence,head:"f".repeat(40)}});
    expect(d.blocker).toBe("stale");
    expect(f.merges.list(f.item.productId,f.owner.id)).toEqual(f.merges.recomputeList(f.item.productId,f.owner.id));
    new AgentSessionStore(f.store.database).recordSnapshot({nodeId:f.node.nodeId,sessionId:f.projectSessionId,status:"idle",messages:[{sourceId:"source-user",role:"user",text:"A newer input"}]});
    expect(f.merges.list(f.item.productId,f.owner.id)).toEqual([]);
    f.db.prepare("UPDATE agent_session_messages SET role='agent' WHERE session_id=? AND source_id='source-user'").run(f.projectSessionId);
    expect(f.merges.list(f.item.productId,f.owner.id)).toEqual(f.merges.recomputeList(f.item.productId,f.owner.id));
    expect(f.merges.list(f.item.productId,f.owner.id)).toHaveLength(1);
  });
  it("rolls back source and projection together, including a failed nested transaction",async()=>{
    const f=await prepared(),before=f.merges.list(f.item.productId,f.owner.id);
    let fail=false;
    f.store.database.registerProjectionWriter("synthetic-failure",()=>{if(fail)throw new Error("projection failure");});
    fail=true;
    expect(()=>f.merges.decide(f.owner.id,f.d.id,f.d.revision,"confirm")).toThrow("projection failure");
    fail=false;
    expect(f.merges.list(f.item.productId,f.owner.id)).toEqual(before);
    expect(f.merges.readForAccount(f.owner.id,f.d.id).state).toBe("proposed");
    f.store.database.transaction(()=>{
      expect(()=>f.store.database.transaction(()=>{f.merges.decide(f.owner.id,f.d.id,f.d.revision,"confirm");throw new Error("rollback nested");})).toThrow("rollback nested");
    });
    expect(f.merges.list(f.item.productId,f.owner.id)).toEqual(before);
    expect(f.db.prepare("SELECT * FROM merge_display_dirty").all()).toEqual([]);
  });
  it("does not refresh display rows for ordinary Agent output or unchanged snapshots",async()=>{
    const f=await prepared();
    const before=f.db.prepare("SELECT total_changes() AS n").get() as {n:number};
    f.db.exec(`CREATE TEMP TABLE observed_refreshes(value INTEGER);
      CREATE TEMP TRIGGER observe_display AFTER INSERT ON merge_delivery_projection BEGIN INSERT INTO observed_refreshes VALUES(1); END;`);
    new AgentSessionStore(f.store.database).recordSnapshot({nodeId:f.node.nodeId,sessionId:f.projectSessionId,status:"idle",messages:[{sourceId:"new-output",role:"agent",text:"Only an output"}]});
    expect((f.db.prepare("SELECT total_changes() AS n").get() as {n:number}).n).toBeGreaterThan(before.n);
    expect(f.db.prepare("SELECT * FROM observed_refreshes").all()).toEqual([]);
    f.store.createComment({itemKey:f.item.key,actorKind:"human",bodyKind:"free",body:{text:"An ordinary comment"}});
    expect(f.db.prepare("SELECT * FROM observed_refreshes").all()).toEqual([]);
  });
});

for(const [itemCount,batchCount] of [[500,100],[1000,200]])it(`AND-484 scale ${itemCount} items and ${batchCount} historical batches`,async()=>{
  const f=await prepared(),db=f.db;
  const source=JSON.parse((db.prepare("SELECT data_json FROM merge_deliveries WHERE id=?").get(f.d.id) as {data_json:string}).data_json);
  const baseItem=db.prepare("SELECT * FROM work_items WHERE id=?").get(f.item.id) as Record<string,string|number|null>;
  const columns=Object.keys(baseItem),insertItem=db.prepare(`INSERT INTO work_items(${columns.join(",")}) VALUES (${columns.map(()=>"?").join(",")})`);
  const started=performance.now();
  f.store.database.transaction(()=>{
    for(let i=1;i<itemCount;i++){
      const row={...baseItem,id:`synthetic-item-${i}`,item_key:`CON-${i+1}`,sequence:i+1,title:`Synthetic item ${i}`};
      insertItem.run(...columns.map(column=>row[column as keyof typeof row] as string|number|null));
    }
    // A long diagnostic history is deliberately present but irrelevant to reads.
    for(let i=0;i<100;i++)db.prepare(`INSERT INTO work_item_events(id,item_id,event_type,actor_kind,payload_json,timeline_seq,created_at)
      VALUES (?,?,'synthetic_diagnostic','system',?,?,?)`).run(`synthetic-event-${i}`,f.item.id,JSON.stringify({text:"Historical diagnostic ".repeat(100)}),100+i,new Date().toISOString());
    for(let i=0;i<batchCount;i++){
      const batchId=`synthetic-batch-${i}`,ids:string[]=[],results:Record<string,unknown>={};
      for(let j=0;j<20;j++){
        const id=`synthetic-delivery-${i}-${j}`;ids.push(id);results[id]={status:"merged",head:source.head,commit:"c".repeat(40),detail:"Synthetic historic result"};
        db.prepare("INSERT INTO merge_deliveries(id,product_id,account_id,client_id,request_key,state,data_json) VALUES (?,?,?,?,?,'merged',?)")
          .run(id,f.item.productId,f.owner.id,"original-client",id,JSON.stringify({...source,id,state:"merged",batchId}));
      }
      db.prepare("INSERT INTO merge_batches(id,product_id,account_id,request_key,state,data_json) VALUES (?,?,?,?,'finished',?)")
        .run(batchId,f.item.productId,f.owner.id,batchId,JSON.stringify({id:batchId,productId:f.item.productId,accountId:f.owner.id,requestKey:batchId,
          dispatchId:batchId,sessionId:batchId,config:f.config,publish:false,deliveries:ids,selection:[],state:"finished",createdAt:new Date().toISOString(),results}));
    }
  });
  const initializationMs=performance.now()-started;
  let queries=0;
  const prepare=db.prepare.bind(db);
  const counter=vi.spyOn(db,"prepare").mockImplementation(sql=>{queries++;return prepare(sql);});
  const referenceAt=performance.now();
  const expected={deliveries:f.merges.recomputeList(f.item.productId,f.owner.id),batches:f.merges.recomputeBatches(f.item.productId,f.owner.id),
    attentionSessionIds:f.merges.recomputeAttentionSessionIds(f.item.productId,f.owner.id),sessionProgress:f.merges.recomputeSessionProgress(f.item.productId,f.owner.id)};
  const referenceMs=performance.now()-referenceAt,referenceQueries=queries;queries=0;
  const login=await f.app.inject({method:"POST",url:"/api/v1/auth/login",payload:{username:f.owner.email,password:"synthetic password"}});
  const cookie=login.headers["set-cookie"]!.toString().split(";")[0]!;
  const heavy=vi.spyOn(f.store,"getTimeline").mockImplementation(()=>{throw new Error("Hot read loaded timeline");});
  queries=0;
  const times:number[]=[],queryCounts:number[]=[];
  try{
    for(let i=0;i<30;i++){
      queries=0;
      const at=performance.now(),response=await f.app.inject({method:"GET",url:`/api/v1/products/${f.item.productId}/merge-deliveries`,headers:{cookie}});
      times.push(performance.now()-at);queryCounts.push(queries);expect(response.statusCode).toBe(200);
      if(i===0)expect(response.json()).toEqual(expected);
    }
  }finally{heavy.mockRestore();counter.mockRestore();}
  // Cold reads may prepare fixed SQL once; warm reads reuse statements but still execute them.
  expect(new Set(queryCounts.slice(1)).size).toBe(1);expect(Math.max(...queryCounts)).toBeLessThan(25);
  const writeAt=performance.now();
  f.store.updateWorkItem(`CON-${itemCount}`,{title:"One unrelated item update"});
  const writeMs=performance.now()-writeAt,firstMs=times[0]!;
  db.exec(`CREATE TEMP TABLE observed_activity_refresh(kind TEXT);
    CREATE TEMP TRIGGER observe_activity_batch AFTER INSERT ON merge_batch_projection BEGIN INSERT INTO observed_activity_refresh VALUES('batch'); END;
    CREATE TEMP TRIGGER observe_activity_delivery AFTER INSERT ON merge_delivery_projection BEGIN INSERT INTO observed_activity_refresh VALUES('delivery'); END;`);
  const messageAt=performance.now();
  new AgentSessionStore(f.store.database).enqueue(f.owner.id,f.projectSessionId,"A new input after historical deliveries",[]);
  const relatedMessageWriteMs=performance.now()-messageAt;
  expect(db.prepare("SELECT * FROM observed_activity_refresh WHERE kind='batch'").all()).toEqual([]);
  expect(db.prepare("SELECT * FROM observed_activity_refresh WHERE kind='delivery'").all()).toHaveLength(1);
  expect(f.merges.batches(f.item.productId,f.owner.id)).toEqual(f.merges.recomputeBatches(f.item.productId,f.owner.id));
  expect(f.merges.sessionProgress(f.item.productId,f.owner.id)).toEqual(f.merges.recomputeSessionProgress(f.item.productId,f.owner.id));
  times.sort((a,b)=>a-b);
  console.log(JSON.stringify({benchmark:"AND-484",itemCount,batchCount,deliveries:batchCount*20,events:100,returnedBatches:20,initializationMs,referenceMs,referenceQueries,readQueries:queryCounts[0],firstMs,p50:times[15],p95:times[28],max:times[29],unrelatedWriteMs:writeMs,relatedMessageWriteMs}));
  // Latency is reported rather than made a flaky CI assertion. The strict
  // guard is that every cold/hot request succeeds without the history reader.
  expect(times).toHaveLength(30);
},60_000);

 it("AND-484 filters retired history through partial indexes",async()=>{
   const f=await prepared();
   for(const [predicate,index] of [["visible=1","merge_delivery_projection_visible"],["attention=1","merge_delivery_projection_attention"]]) {
     const plan=f.db.prepare(`EXPLAIN QUERY PLAN SELECT session_id FROM merge_delivery_projection WHERE product_id=? AND account_id=? AND ${predicate} ${predicate==="attention=1" ? "GROUP BY session_id ORDER BY MAX(sequence) DESC" : "ORDER BY sequence DESC"}`).all(f.item.productId,f.owner.id);
     expect(JSON.stringify(plan)).toContain(index);
   }
 });

it("AND-484 query work should be bounded by live rows rather than retired history",async()=>{
  const f=await prepared(),db=f.db;
  const template=db.prepare("SELECT * FROM merge_delivery_projection WHERE id=?").get(f.d.id) as Record<string,string|number|null>;
  const keys=Object.keys(template),insert=db.prepare(`INSERT INTO merge_delivery_projection(${keys.join(',')}) VALUES (${keys.map(()=>'?').join(',')})`);
  f.store.database.transaction(()=>{
    for(let i=0;i<500000;i++){
      const row={...template,id:`retired-${i}`,sequence:i+100,visible:0,attention:0,data_json:'{}'};
      insert.run(...keys.map(key=>row[key as keyof typeof row] as string|number|null));
    }
  });
  const queries=["SELECT data_json,fresh_from,fresh_until,fresh_blocker FROM merge_delivery_projection WHERE product_id=? AND account_id=? AND visible=1 ORDER BY sequence DESC",
    "SELECT session_id FROM merge_delivery_projection WHERE product_id=? AND account_id=? AND attention=1 GROUP BY session_id ORDER BY MAX(sequence) DESC"];
  const results=queries.map(sql=>{
    const plan=db.prepare('EXPLAIN QUERY PLAN '+sql).all(f.item.productId,f.owner.id);
    const times=[];for(let i=0;i<10;i++){const at=performance.now();db.prepare(sql).all(f.item.productId,f.owner.id);times.push(performance.now()-at);}
    expect(JSON.stringify(plan)).toContain(sql.includes("visible=1") ? "merge_delivery_projection_visible" : "merge_delivery_projection_attention");
    return {plan,maxMs:Math.max(...times)};
  });
  console.log(JSON.stringify({audit:'retired-history-scan',rows:500000,results}));
  expect(f.merges.list(f.item.productId,f.owner.id)).toHaveLength(1);
},60_000);

describe("AND-497 scoped conversation delivery reads",()=>{
 it("isolates session, account and project without changing the full list or freshness semantics",async()=>{
  const f=await prepared();
  const login=await f.app.inject({method:"POST",url:"/api/v1/auth/login",payload:{username:f.owner.email,password:"synthetic password"}});
  const cookie=login.headers["set-cookie"]!.toString().split(";")[0]!;
  const read=(sessionId:string,productId=f.item.productId)=>f.app.inject({method:"GET",url:`/api/v1/products/${productId}/merge-deliveries?sessionId=${encodeURIComponent(sessionId)}`,headers:{cookie}});
  const own=await read(f.d.sessionId);expect(own.statusCode).toBe(200);expect(own.json().deliveries.map((d:{id:string})=>d.id)).toEqual([f.d.id]);
  expect((await read("no-delivery")).json()).toEqual({deliveries:[],batches:[],attentionSessionIds:[],sessionProgress:{}});
  expect(f.merges.list(f.item.productId,f.other.id,f.d.sessionId)).toEqual([]);
  expect(f.merges.list(f.item.productId,f.owner.id)).toHaveLength(1);
  const privateProduct=f.store.createProduct({name:"Private",keyPrefix:"PRIVATE",createdByAccountId:config.id});
  expect((await read(f.d.sessionId,privateProduct.id)).statusCode).toBe(404);
  expect((await read("")).statusCode).toBe(400);
  new AgentSessionStore(f.store.database).enqueue(f.owner.id,f.projectSessionId,"Continue changing",[]);
  expect((await read(f.d.sessionId)).json().deliveries).toEqual([]);
 });
 it("returns standalone offers and only the requested integration batch",async()=>{
  const f=await fixture(),launched=f.launch("codex"),merges=new MergeDeliveries(f.store);
  const d=merges.propose(f.owner.id,"original-client",{dispatchId:launched.dispatch.id},"standalone",{...proposal(f.item.key),itemKeys:[],productId:f.item.productId});
  expect(merges.list(f.item.productId,f.owner.id,d.sessionId).map(row=>row.id)).toEqual([d.id]);
  merges.decide(f.owner.id,d.id,d.revision,"confirm");
  const batch=merges.start(f.owner.id,"batch",[{id:d.id,revision:d.revision}],{productId:f.item.productId,nodeId:launched.node.nodeId,agentKind:"codex",mode:"default"},false);
  expect(merges.batches(f.item.productId,f.owner.id,batch.sessionId).map(row=>row.id)).toEqual([batch.id]);
  expect(merges.batches(f.item.productId,f.owner.id,"unrelated")).toEqual([]);
 });
});

describe("AND-511 two-step integration queue",()=>{
  async function mergedProject(artifacts=["web","macosApp"],databasePath=":memory:") {
    const f=await fixture(databasePath),launched=f.launch("codex"),merges=new MergeDeliveries(f.store);
    const input={...proposal(f.item.key),itemKeys:[],productId:f.item.productId,requiredArtifacts:artifacts};
    const d=merges.propose(f.owner.id,"original-client",{dispatchId:launched.dispatch.id},"queue-offer",input);
    merges.decide(f.owner.id,d.id,d.revision,"confirm");
    const conf={productId:f.item.productId,nodeId:launched.node.nodeId,agentKind:"codex" as const,mode:"default"};
    const original=merges.start(f.owner.id,"merge-only",[{id:d.id,revision:d.revision}],conf,false);
    const launchBatch=(b:{dispatchId:string})=>{const dispatches=new DispatchStore(f.store.database);dispatches.claimNextDispatch(launched.node.nodeId);dispatches.recordDispatchResult({nodeId:launched.node.nodeId,dispatchId:b.dispatchId,status:"launched"});};
    launchBatch(original);
    merges.report(f.owner.id,original.dispatchId,original.id,d.id,{status:"merged",head:d.head,commit:"c".repeat(40),detail:"Synthetic verified merge"});
    merges.finish(f.owner.id,original.dispatchId,original.id);
    return {...f,...launched,merges,input,d,conf,original,launchBatch,selection:[{id:d.id,revision:d.revision}]};
  }
  it("keeps merge-only work visible after source input; partial receipts stay pending until every artifact is covered",async()=>{
    const f=await mergedProject();
    expect(f.merges.list(f.item.productId,f.owner.id)).toEqual([]); // old offer API is unchanged
    let q=f.merges.queue(f.item.productId,f.owner.id);
    expect(q.counts).toMatchObject({release:1});expect(q.deliveries[0]!.queue.pendingArtifacts).toEqual(["web","macosApp"]);
    new AgentSessionStore(f.store.database).enqueue(f.owner.id,f.projectSessionId,"A new topic",[]);
    expect(f.merges.queue(f.item.productId,f.owner.id).counts).toMatchObject({release:1});
    const record=(artifact:string,key:string)=>f.merges.recordRelease(f.owner.id,"original-client",{productId:f.item.productId,idempotencyKey:key,deployedCommit:"e".repeat(40),receiptDigest:"f".repeat(64),deliveries:[{deliveryId:f.d.id,expectedRevision:f.d.revision,releases:[{artifact,version:"1",sourceCommit:"e".repeat(40)}]}]});
    record("web","web");q=f.merges.queue(f.item.productId,f.owner.id);
    expect(q.deliveries[0]!.queue).toMatchObject({stage:"release",publishedArtifacts:["web"],pendingArtifacts:["macosApp"]});
    record("macosApp","mac");expect(f.merges.queue(f.item.productId,f.owner.id).deliveries).toEqual([]);
    expect(f.merges.queue(f.item.productId,f.owner.id,"history").deliveries).toHaveLength(1);
    expect(f.merges.queue(f.item.productId,f.other.id).deliveries).toEqual([]);
    const original=f.db.prepare("SELECT data_json FROM merge_deliveries WHERE id=?").get(f.d.id) as {data_json:string};
    expect(JSON.parse(original.data_json).batchId).toBe(f.original.id);
  });
  it("runs publish-only through immutable references, forbids repeat report/repair and requires fresh reference validation",async()=>{
    const f=await mergedProject();const scope=f.merges.publicationPreview(f.owner.id,f.item.productId,f.selection);
    expect(scope.blockers).toEqual([]);
    const b=f.merges.start(f.owner.id,"publish-only",f.selection,f.conf,true,1,false,"publish_only",scope.digest);f.launchBatch(b);
    let current=f.merges.batch(f.owner.id,b.dispatchId,b.id);
    expect(current.references?.[f.d.id]?.batchId).toBe(f.original.id);expect(current.entries[0]!.mergeReady).toBe(false);
    expect(()=>f.merges.report(f.owner.id,b.dispatchId,b.id,f.d.id,{status:"merged",head:f.d.head,commit:"c".repeat(40),detail:"Do not repeat"})).toThrow();
    const act=(action:Parameters<MergeDeliveries['integrate']>[5])=>{current=f.merges.integrate(f.owner.id,b.dispatchId,b.id,current.integration!.revision,randomUUID(),action);return current;};
    act({kind:"plan",base:"b".repeat(40),summary:"Verify historical integration",validation:"Live target",entries:[{deliveryId:f.d.id,head:f.d.head,dependsOn:[],group:"published",reason:"Historical reference",validation:"Verify ancestor"}]});
    expect(()=>act({kind:"prepare_repair",deliveryId:f.d.id,expectedHead:f.d.head,base:"b".repeat(40),reason:"Must not mutate historical PR"})).toThrow();
    expect(()=>act({kind:"final_validation",head:"c".repeat(40),checkedAt:new Date().toISOString(),validation:"Missing reference verification",source:"Synthetic"})).toThrow();
    expect(()=>f.merges.recordCombinedValidation(f.owner.id,b.dispatchId,b.id,{head:"c".repeat(40),checkedAt:new Date().toISOString(),validation:"Cannot bypass references",source:"Synthetic"})).toThrow(/独立核实/);
    act({kind:"verify_reference",deliveryId:f.d.id,expectedHead:f.d.head,commit:"c".repeat(40),checkedAt:new Date().toISOString(),source:"Synthetic live Git ancestor verification"});
    act({kind:"final_validation",head:"c".repeat(40),checkedAt:new Date().toISOString(),validation:"Verified live target",source:"Synthetic"});
    act({kind:"publication_progress",state:"publishing",resultsDigest:current.resultsDigest,checkedAt:new Date().toISOString(),detail:"Synthetic publication start"});
    act({kind:"publication_progress",state:"ended",resultsDigest:current.resultsDigest,checkedAt:new Date().toISOString(),detail:"Synthetic end without receipt"});
    expect(()=>f.merges.finish(f.owner.id,b.dispatchId,b.id)).toThrow(/发布凭据/);
    expect(f.merges.start(f.owner.id,"publish-only",f.selection,f.conf,true,1,false,"publish_only",scope.digest).id).toBe(b.id);
    expect(()=>f.merges.start(f.owner.id,"publish-only",f.selection,f.conf,false,1,false,"merge_only")).toThrow();
  });
  it("refuses stale preview and blocks new unreviewed candidates before publication",async()=>{
    const f=await mergedProject(),old=f.merges.publicationPreview(f.owner.id,f.item.productId,f.selection);
    expect(()=>f.merges.start(f.owner.id,"bad-scope",f.selection,f.conf,true,1,false,"publish_only","wrong")).toThrow();
    const b=f.merges.start(f.owner.id,"reviewed",f.selection,f.conf,true,1,false,"publish_only",old.digest);f.launchBatch(b);
    let current=f.merges.batch(f.owner.id,b.dispatchId,b.id);
    const act=(action:Parameters<MergeDeliveries['integrate']>[5])=>{current=f.merges.integrate(f.owner.id,b.dispatchId,b.id,current.integration!.revision,randomUUID(),action);};
    act({kind:"plan",base:"b".repeat(40),summary:"Read references",validation:"Verify",entries:[{deliveryId:f.d.id,head:f.d.head,dependsOn:[],group:"history",reason:"Already merged",validation:"Verify"}]});
    act({kind:"verify_reference",deliveryId:f.d.id,expectedHead:f.d.head,commit:"c".repeat(40),checkedAt:new Date().toISOString(),source:"Synthetic Git"});
    act({kind:"final_validation",head:"c".repeat(40),checkedAt:new Date().toISOString(),validation:"Verified",source:"Synthetic"});
    const claim=await f.call("claim_item",f.claimInput);f.safe(claim);
    f.safe(await f.complete({sessionId:claim.structuredContent!.sessionId!}));
    expect(()=>act({kind:"publication_progress",state:"publishing",checkedAt:new Date().toISOString(),resultsDigest:current.resultsDigest,detail:"Not authorized for new candidate"})).toThrow(/范围/);
  });
  it("combines pending PRs and historical references without changing the source batch",async()=>{
    const f=await mergedProject();const d=f.merges.propose(f.owner.id,"original-client",{dispatchId:f.dispatch.id},"second",{...f.input,pullRequest:13,summary:"New pending change"});
    f.merges.decide(f.owner.id,d.id,d.revision,"confirm");
    const selection=[...f.selection,{id:d.id,revision:d.revision}],scope=f.merges.publicationPreview(f.owner.id,f.item.productId,selection);
    const b=f.merges.start(f.owner.id,"mixed",selection,f.conf,true,1,false,"merge_and_publish",scope.digest);f.launchBatch(b);
    const batch=f.merges.batch(f.owner.id,b.dispatchId,b.id);
    expect(batch.results[f.d.id]!.status).toBe("merged");expect(batch.results[d.id]).toBeUndefined();
    const history=f.db.prepare("SELECT data_json FROM merge_deliveries WHERE id=?").get(f.d.id) as {data_json:string};expect(JSON.parse(history.data_json).batchId).toBe(f.original.id);
    expect(()=>f.merges.start(f.owner.id,"wrong-publish-only",selection,f.conf,true,1,false,"publish_only",scope.digest)).toThrow();
    expect(f.merges.queue(f.item.productId,f.owner.id).deliveries.some(row=>row.id===d.id)).toBe(false);
    let current=batch;
    const act=(action:Parameters<MergeDeliveries['integrate']>[5])=>{current=f.merges.integrate(f.owner.id,b.dispatchId,b.id,current.integration!.revision,randomUUID(),action);};
    act({kind:"plan",base:"b".repeat(40),summary:"Mixed plan",validation:"Combination",entries:[f.d,d].map(v=>({deliveryId:v.id,head:v.head,dependsOn:[],group:"mixed",reason:"Synthetic",validation:"Verify"}))});
    act({kind:"verify_reference",deliveryId:f.d.id,expectedHead:f.d.head,commit:"c".repeat(40),checkedAt:new Date().toISOString(),source:"Synthetic target ancestor"});
    act({kind:"check",deliveryId:d.id,expectedHead:d.head,base:"b".repeat(40),checkedAt:new Date().toISOString(),source:"Synthetic live checks",checks:"passed",mergeable:"clean",local:"passed",validation:"Synthetic local and CI"});
    current=f.merges.report(f.owner.id,b.dispatchId,b.id,d.id,{status:"merged",head:d.head,commit:"d".repeat(40),detail:"New merge only"});
    act({kind:"final_validation",head:"d".repeat(40),checkedAt:new Date().toISOString(),validation:"Mixed target verified",source:"Synthetic"});
    expect(()=>act({kind:"publication_progress",state:"publishing",resultsDigest:current.resultsDigest,checkedAt:new Date().toISOString(),detail:"Own new merge is within the frozen scope"})).not.toThrow();

  });
  it("paginates queue history with account-scoped counts without reading event bodies",async()=>{
    const f=await mergedProject();const spy=vi.spyOn(f.store,"getTimeline").mockImplementation(()=>{throw Error("No hot history reads");});
    try{expect(f.merges.queue(f.item.productId,f.owner.id,"release",undefined,1).nextBeforeSequence).toBeTypeOf("number");expect(f.merges.queue(f.item.productId,f.owner.id).counts.release).toBe(1);}finally{spy.mockRestore();}
  });
  it("rebuilds queue metadata once on upgrade without rewriting immutable delivery history",async()=>{
    const dir=mkdtempSync(join(tmpdir(),"and511-queue-migration-")),path=join(dir,"data.sqlite");
    let reopened:ReturnType<typeof buildApp>|undefined;
    try {
      const f=await mergedProject(["web"],path);
      const original=f.db.prepare("SELECT data_json FROM merge_deliveries WHERE id=?").get(f.d.id);
      f.db.exec("DROP INDEX integration_queue_stage; DELETE FROM schema_migrations WHERE version=202611120007;");
      f.db.prepare("UPDATE merge_delivery_projection SET data_json=json_remove(data_json,'$.queue')").run();
      await f.app.close();
      reopened=buildApp({databasePath:path,adminAccount:config,writeTools:"comments",statusCheckTime:false});
      const merges=new MergeDeliveries(reopened.missionGoStore);
      expect(merges.queue(f.item.productId,f.owner.id).counts.release).toBe(1);
      expect(reopened.missionGoStore.database.connection.prepare("SELECT data_json FROM merge_deliveries WHERE id=?").get(f.d.id)).toEqual(original);
      expect(reopened.missionGoStore.database.connection.prepare("SELECT count(*) AS count FROM schema_migrations WHERE version=202611120007").get()).toMatchObject({count:1});
    }finally{await reopened?.close();rmSync(dir,{recursive:true,force:true});}
  });
  it("reclassifies existing cached queue rows on lifecycle upgrade without changing source evidence",async()=>{
    const dir=mkdtempSync(join(tmpdir(),"queue-lifecycle-upgrade-")),path=join(dir,"data.sqlite");
    let reopened:ReturnType<typeof buildApp>|undefined;
    try {
      const f=await mergedProject(["web"],path);
      const original=f.db.prepare("SELECT data_json FROM merge_deliveries WHERE id=?").get(f.d.id);
      f.db.exec("DELETE FROM schema_migrations WHERE version=202611121510");
      f.db.prepare("UPDATE merge_delivery_projection SET data_json=json_set(data_json,'$.queue.stage','history')").run();
      await f.app.close();
      reopened=buildApp({databasePath:path,adminAccount:config,writeTools:"comments",statusCheckTime:false});
      expect(new MergeDeliveries(reopened.missionGoStore).queue(f.item.productId,f.owner.id).counts.release).toBe(1);
      expect(reopened.missionGoStore.database.connection.prepare("SELECT data_json FROM merge_deliveries WHERE id=?").get(f.d.id)).toEqual(original);
      expect(reopened.missionGoStore.database.connection.prepare("SELECT count(*) AS count FROM schema_migrations WHERE version=202611121510").get()).toMatchObject({count:1});
    } finally {await reopened?.close();rmSync(dir,{recursive:true,force:true});}
  });
  it("requires receipts for unselected but reviewed extra coverage before completing publication",async()=>{
    const f=await mergedProject(["web"]);
    const d=f.merges.propose(f.owner.id,"original-client",{dispatchId:f.dispatch.id},"extra",{...f.input,pullRequest:14,summary:"Extra merged change"});
    f.merges.decide(f.owner.id,d.id,d.revision,"confirm");
    const old=f.merges.start(f.owner.id,"extra-merge",[{id:d.id,revision:d.revision}],f.conf,false);f.launchBatch(old);
    f.merges.report(f.owner.id,old.dispatchId,old.id,d.id,{status:"merged",head:d.head,commit:"d".repeat(40),detail:"Synthetic extra merge"});f.merges.finish(f.owner.id,old.dispatchId,old.id);
    const scope=f.merges.publicationPreview(f.owner.id,f.item.productId,f.selection);
    expect(scope.candidates.find(c=>c.deliveryId===d.id)?.selected).toBe(false);
    const b=f.merges.start(f.owner.id,"publish-all",f.selection,f.conf,true,1,false,"publish_only",scope.digest);f.launchBatch(b);
    let current=f.merges.batch(f.owner.id,b.dispatchId,b.id);
    const act=(action:Parameters<MergeDeliveries['integrate']>[5])=>{current=f.merges.integrate(f.owner.id,b.dispatchId,b.id,current.integration!.revision,randomUUID(),action);};
    act({kind:"plan",base:"b".repeat(40),summary:"Read selected reference",validation:"Verify",entries:[{deliveryId:f.d.id,head:f.d.head,dependsOn:[],group:"history",reason:"Already merged",validation:"Verify"}]});
    act({kind:"verify_reference",deliveryId:f.d.id,expectedHead:f.d.head,commit:"c".repeat(40),checkedAt:new Date().toISOString(),source:"Synthetic Git"});
    act({kind:"final_validation",head:"d".repeat(40),checkedAt:new Date().toISOString(),validation:"Verified",source:"Synthetic"});
    const receipt=(delivery:typeof f.d,key:string)=>f.merges.recordRelease(f.owner.id,"original-client",{productId:f.item.productId,idempotencyKey:key,deployedCommit:"e".repeat(40),receiptDigest:"f".repeat(64),deliveries:[{deliveryId:delivery.id,expectedRevision:delivery.revision,releases:[{artifact:"web",version:"1",sourceCommit:"e".repeat(40)}]}]});
    receipt(f.d,"selected-receipt");expect(()=>f.merges.finish(f.owner.id,b.dispatchId,b.id)).toThrow(/Extra merged change/);
    receipt(d,"extra-receipt");expect(f.merges.finish(f.owner.id,b.dispatchId,b.id).state).toBe("finished");
  });

  it("projects per-item partial receipts with the exact development event and leaves acceptance to people",async()=>{
    const f=await prepared();
    const d=f.merges.propose(f.owner.id,"original-client",f.identity,"item-scope",{...f.input,requiredArtifacts:["web","macosApp"]});
    f.merges.decide(f.owner.id,d.id,d.revision,"confirm");
    const b=f.merges.start(f.owner.id,"item-merge",[{id:d.id,revision:d.revision}],f.config,false);
    const dispatches=new DispatchStore(f.store.database);dispatches.claimNextDispatch(f.node.nodeId);dispatches.recordDispatchResult({nodeId:f.node.nodeId,dispatchId:b.dispatchId,status:"launched"});
    f.merges.report(f.owner.id,b.dispatchId,b.id,d.id,{status:"merged",head:d.head,commit:"c".repeat(40),detail:"Synthetic item merge"});f.merges.finish(f.owner.id,b.dispatchId,b.id);
    const completion={kind:"github" as const,url:d.pullRequestUrl},event=f.store.getDeliveryRecords(f.item.key)[0]!;
    const release=(artifact:string)=>f.store.submitForVerification({itemKey:f.item.key,developmentEventId:event.id,completion,releases:[{artifact,version:"1",sourceCommit:"e".repeat(40)}],deployedCommit:"e".repeat(40),receiptDigest:"f".repeat(64),idempotencyKey:`item-${artifact}`});
    release("web");const q=f.merges.queue(f.item.productId,f.owner.id);
    expect(q.deliveries[0]!.queue).toMatchObject({stage:"release",publishedArtifacts:["web"],pendingArtifacts:["macosApp"],records:[{itemKey:f.item.key,developmentEventId:event.id,roundKey:event.roundKey}]});
    expect(f.store.getWorkItem(f.item.key).status).toBe("development_complete");
    release("macosApp");expect(f.merges.queue(f.item.productId,f.owner.id).deliveries).toEqual([]);expect(f.store.getWorkItem(f.item.key).status).toBe("pending_verification");
  });
  it("keeps queue and preview scoped to the account, rejects malformed actions and preserves the read snapshot",async()=>{
    const f=await mergedProject();
    const login=async(email:string)=>{const r=await f.app.inject({method:"POST",url:"/api/v1/auth/login",payload:{username:email,password:"synthetic password"}});return r.headers["set-cookie"]!.toString().split(";")[0]!;};
    const owner=await login(f.owner.email),other=await login(f.other.email);
    expect((await f.app.inject({method:"GET",url:`/api/v1/products/${f.item.productId}/integration-queue`,headers:{cookie:owner}})).json().counts.release).toBe(1);
    expect((await f.app.inject({method:"GET",url:`/api/v1/products/${f.item.productId}/integration-queue`,headers:{cookie:other}})).json().deliveries).toEqual([]);
    const before=f.snapshot();
    const preview=await f.app.inject({method:"POST",url:`/api/v1/products/${f.item.productId}/integration-preview`,headers:{cookie:owner},payload:{selection:f.selection}});
    expect(preview.statusCode).toBe(200);expect(f.snapshot()).toEqual(before);
    const denied=await f.app.inject({method:"POST",url:`/api/v1/products/${f.item.productId}/integration-preview`,headers:{cookie:other},payload:{selection:f.selection}});expect(denied.statusCode).toBe(409);
    expect((await f.app.inject({method:"POST",url:`/api/v1/products/${f.item.productId}/merge-batches`,headers:{cookie:owner},payload:{...f.conf,requestKey:"invalid-action",selection:f.selection,publish:true,operation:"arbitrary"}})).statusCode).toBe(400);
    f.grant(false,true);
    expect((await f.app.inject({method:"POST",url:`/api/v1/products/${f.item.productId}/integration-preview`,headers:{cookie:owner},payload:{selection:f.selection}})).statusCode).toBe(404);
  });

});
