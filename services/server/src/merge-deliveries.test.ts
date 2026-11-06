import { legacyIntegratorPrompt } from "./legacy-merge-authorization.js";
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
type Result = { isError?: boolean; error?: unknown; content?: { type: string; text?: string }[];
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
  const call = async (name: string, input: Record<string, unknown>, options: { accountId?: string; clientId?: string; scopes?: string[] } = {}): Promise<Result> => {
    const account = accounts.getAccount(options.accountId ?? owner.id);
    const token = createAiAccessToken(config, { id: account.id, username: account.email, role: account.role },
      accounts.credentialsStamp(account), options.clientId ?? "original-client", options.scopes ?? ["missiongo:read", "missiongo:write"]).token;
    // No automatic credential injection and no seeded plan decision.
    const response = await app.inject({ method: "POST", url: "/mcp",
      headers: { authorization: `Bearer ${token}`, accept: "application/json, text/event-stream" },
      payload: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: input } } });
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
    expect(f.merges.list(f.item.productId,f.owner.id)[0]?.blocker).toBe("changed");
    expect(()=>f.merges.start(f.owner.id,randomUUID(),[{id:f.d.id,revision:f.d.revision}],f.config,false)).toThrow();
    const g=await prepared();
    g.merges.decide(g.owner.id,g.d.id,g.d.revision,"confirm");
    expect(g.merges.refresh(g.owner.id,"original-client",g.identity,g.d.id,{...g.input.evidence,head:"c".repeat(40)}).state).toBe("withdrawn");
  });
  it("serializes batches, retries the same reservation, and never unlocks missing outcomes",async()=>{
    const f=await prepared();f.merges.decide(f.owner.id,f.d.id,f.d.revision,"confirm");
    const key=randomUUID(),selection=[{id:f.d.id,revision:f.d.revision}];
    const b=f.merges.start(f.owner.id,key,selection,f.config,false);
    expect(new AgentSessionStore(f.store.database).getForAccount(f.owner.id,b.sessionId).sessionPurpose).toBe("integration");
    expect(new AgentSessionStore(f.store.database).listForAccount(f.owner.id).find(row=>row.id===b.sessionId)?.sessionPurpose).toBe("integration");
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
    expect(()=>f.act({...f.plan,summary:"Different"},"plan",0)).toThrow();
    expect(()=>f.act(f.plan,"stale",0)).toThrow();
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
