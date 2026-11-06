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
