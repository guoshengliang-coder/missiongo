import { legacyIntegratorPrompt } from "./legacy-merge-authorization.js";
import { recoveryDetailPrefix } from "./merge-recovery-transport.js";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "./app.js";
import { createAiAccessToken, hashPassword } from "./admin-auth.js";
import { AgentSessionStore } from "./agent-session-store.js";
import { MergeDeliveries, type DeliveryInput } from "./merge-deliveries.js";
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

async function fixture() {
  const app = buildApp({ databasePath: ":memory:", adminAccount: config, writeTools: "comments", statusCheckTime: false });
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
  it("confirms through the MCP tool only when instructionConfirmation is carried",async()=>{
    const f=await prepared();
    const ordered=await f.call("propose_merge_delivery",{identity:f.identity,idempotencyKey:"mcp-instruction",delivery:f.input,instructionConfirmation:{quote:"添加到待合并"}});
    f.safe(ordered);
    expect(ordered.structuredContent!.delivery).toMatchObject({state:"confirmed",confirmedBy:"session-instruction"});
    const plain=await f.call("propose_merge_delivery",{identity:f.identity,idempotencyKey:"mcp-plain",delivery:f.input});
    f.safe(plain);
    expect(plain.structuredContent!.delivery).toMatchObject({state:"proposed"});
  });
});

describe("planned integration batches",()=>{
  async function batchFixture(count=1) {
    const f=await prepared(),deliveries=[f.d];
    for(let i=1;i<count;i++) {
      const item=f.store.createWorkItem({productId:f.item.productId,title:`Related ${i}`,description:"Synthetic integration",type:"task",priority:"normal",status:"ready",environment:{platform:"shared"}});
      const claim=await f.call("claim_item",{...f.claimInput,itemKey:item.key,session:{...f.session,sessionRef:randomUUID()},idempotencyKey:`claim-${i}`});f.safe(claim);
      deliveries.push(f.merges.propose(f.owner.id,"original-client",{sessionId:claim.structuredContent!.sessionId!},`offer-${i}`,{...proposal(item.key),pullRequest:12+i}));
    }
    for(const d of deliveries)f.merges.decide(f.owner.id,d.id,d.revision,"confirm");
    const b=f.merges.start(f.owner.id,randomUUID(),deliveries.map(d=>({id:d.id,revision:d.revision})),f.config,false,1);
    const dispatches=new DispatchStore(f.store.database);dispatches.claimNextDispatch(f.node.nodeId);dispatches.recordDispatchResult({nodeId:f.node.nodeId,dispatchId:b.dispatchId,status:"launched"});
    const current=()=>new MergeDeliveries(f.store).batch(f.owner.id,b.dispatchId,b.id);
    const act=(action:Parameters<MergeDeliveries["integrate"]>[5],key=randomUUID(),revision=current().integration!.revision)=>
      f.merges.integrate(f.owner.id,b.dispatchId,b.id,revision,key,action);
    const plan={kind:"plan" as const,base:"b".repeat(40),summary:"Foundation, dependent feature, independent fix",validation:"Verify the final combined target",entries:deliveries.map((d,i)=>({deliveryId:d.id,head:d.head,dependsOn:i===1?[deliveries[0]!.id]:[],group:i<2?"shared interface":"independent",reason:"Read overlapping changes",validation:"Behavior and compatibility tests"}))};
    const check=(id:string,head="a".repeat(40))=>act({kind:"check",deliveryId:id,expectedHead:head,base:"b".repeat(40),checkedAt:new Date().toISOString(),checks:"passed",mergeable:"clean",local:"passed",source:"Synthetic CI",validation:"Local and remote checks passed"});
    const merged=(id:string,head="a".repeat(40))=>f.merges.report(f.owner.id,b.dispatchId,b.id,id,{status:"merged",head,commit:"c".repeat(40),detail:"Verified real merge in synthetic fixture"});
    return {...f,b,deliveries,current,act,plan,check,merged};
  }
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
  it("refuses incompatible existing completion metadata instead of overwriting a human event",async()=>{
    const f=await recoveryFixture();
    f.store.submitDevelopmentComplete({itemKey:f.item.key,completion:{kind:"github",url:"https://github.com/example/project/pull/99"},requiredArtifacts:["androidApp"],idempotencyKey:"different-completion",attribution:{accountId:f.owner.id}});
    f.merged();const r=f.request({kind:"retry_handover",deliveryId:f.d.id});f.approve(r);const before=f.store.getTimeline(f.item.key);f.apply(r.key);
    expect(f.store.getTimeline(f.item.key)).toEqual(before);expect(f.preview().reconciliation?.handoffs[f.item.key]?.detail).toMatch(/冲突/);
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
    new AgentSessionStore(f.store.database).enqueue(f.owner.id,f.d.sessionId,"Discuss next work",[]);
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
