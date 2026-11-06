import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "./app.js";
import { TEST_CONSOLE_ACCOUNT, testConsoleHeaders } from "./testing-fixtures.js";
import { DispatchStore } from "./dispatch-store.js";
import { AgentSessionStore } from "./agent-session-store.js";
import { ExternalAgentSessionStore } from "./external-agent-session-store.js";
import { assertExecutionAuthorization } from "./builder-authority.js";
import { itemExecutionBlockers } from "./item-execution-blockers.js";
import { deliveryRound } from "./delivery-round.js";
import { createAiAccessToken } from "./admin-auth.js";
import { BuilderHandovers } from "./builder-handovers.js";

const apps: FastifyInstance[] = [];
beforeEach(()=>{vi.useFakeTimers({toFake:["Date"]});vi.setSystemTime("2026-11-03T07:30:00Z");});
afterEach(async()=>{vi.useRealTimers();await Promise.all(apps.splice(0).map(app=>app.close()));});
async function fixture() {
  const app = buildApp({adminAccount:TEST_CONSOLE_ACCOUNT});apps.push(app);
  const headers = await testConsoleHeaders(app);
  const store = app.missionGoStore, db = store.database.connection, accountId = TEST_CONSOLE_ACCOUNT.id;
  const product = store.createProduct({name:"Execution lifecycle",keyPrefix:"LC",createdByAccountId:accountId});
  const dispatches = new DispatchStore(store.database);
  const node = dispatches.registerNode({accountId,installationId:randomUUID(),name:"Fixture node"});
  dispatches.recordHeartbeat(node.nodeId,[{kind:"codex",planApprovalProtocol:1,ready:true}]);
  dispatches.replaceOwnRepos(node.nodeId,[{productId:product.id,repoPath:"/synthetic/lifecycle"}]);
  const external = new ExternalAgentSessionStore(store);
  const owner = {accountId,clientId:"lifecycle-test"};
  function create() {
    const item = store.createWorkItem({productId:product.id,title:"Rework dispatch",description:"Scope",type:"task",priority:"normal",status:"ready",environment:{platform:"shared"}});
    store.claimWorkItem({itemKey:item.key,agentId:"Codex",idempotencyKey:randomUUID(),attribution:owner});
    const sessionId = external.register(owner,{agentKind:"codex",refKind:"native",sessionRef:randomUUID()},item.key);
    const authorization = randomUUID();
    db.prepare(`INSERT INTO builder_execution_authorizations(id,item_id,account_id,client_id,created_at,round_key)
      VALUES (?,?,?,?,?,?)`).run(authorization,item.id,accountId,owner.clientId,new Date().toISOString(),deliveryRound(store.database,item.id,true));
    vi.advanceTimersByTime(1000);
    external.report(owner,sessionId,item.key,"completed","Handling ended",randomUUID());
    store.transitionWorkItem({itemKey:item.key,to:"pending_verification",actor:"human",reason:"manual_override",note:"Fixture delivery",attribution:{accountId}});
    snapshot(sessionId,"unavailable");
    store.transitionWorkItem({itemKey:item.key,to:"ready",actor:"human",reason:"verification_failed",note:"Adjust UI",attribution:{accountId}});
    return {item,sessionId,authorization};
  }
  function interrupted() {
    const item=store.createWorkItem({productId:product.id,title:"Interrupted before delivery",description:"Scope",type:"bug",priority:"normal",status:"ready",environment:{platform:"shared"}});
    store.transitionWorkItem({itemKey:item.key,to:"in_progress",reason:"claim",actor:"human",attribution:{accountId}});
    const sessionId=external.register(owner,{agentKind:"codex",refKind:"native",sessionRef:randomUUID()},item.key);
    snapshot(sessionId,"unavailable");
    store.transitionWorkItem({itemKey:item.key,to:"ready",reason:"released",actor:"human",note:"Continue after stopping",attribution:{accountId}});
    return {item,sessionId};
  }
  function snapshot(sessionId:string,status:string,turnActive=false) {
    db.prepare("UPDATE external_agent_sessions SET native_node_id=?,native_snapshot_json=?,native_synced_at=? WHERE id=?")
      .run(node.nodeId,JSON.stringify({status,turnState:{turnActive},error:status==="unavailable" ? "Original conversation not loaded" : undefined}),new Date().toISOString(),sessionId);
  }
  const read = async(key:string)=>(await app.inject({method:"GET",url:`/api/v1/items/${key}/delivery`,headers})).json();
  async function confirm(key:string,blocker?:ReturnType<typeof itemExecutionBlockers>[number],custom:Record<string,unknown>={},auth=headers) {
    const observed=blocker ?? (await read(key)).executionBlockers[0];
    return app.inject({method:"POST",url:`/api/v1/items/${key}/execution-blockers/${encodeURIComponent(observed.id)}/confirm-stopped`,headers:auth,
      payload:{revision:observed.revision,note:"Checked the original device; execution stopped",confirmedStopped:true,...custom}});
  }
  const dispatch=(key:string)=>dispatches.createDispatch({accountId,nodeId:node.nodeId,agentKind:"codex",mode:"default",itemKeys:[key]});
  return {app,store,db,headers,accountId,owner,product,node,dispatches,external,create,interrupted,snapshot,read,confirm,dispatch};
}

it("reproduces the completed/unavailable case, settles only the human-verified execution and preserves old history/credential revocation",async()=>{
  const f=await fixture(),{item,sessionId,authorization}=f.create();
  expect(f.dispatches.checkRedispatch(f.accountId,[item.key])).toMatchObject({allowed:false,reason:"execution_unconfirmed"});
  expect(()=>f.dispatch(item.key)).toThrow(/原执行/);
  const original=f.db.prepare("SELECT progress_status,native_snapshot_json FROM external_agent_sessions WHERE id=?").get(sessionId);
  const delivery=await f.read(item.key);
  expect(delivery.executions[0]).toMatchObject({status:"completed",sessionId});
  expect(delivery.executionBlockers).toMatchObject([{source:"external",status:"unavailable",progressStatus:"completed",nodeName:"Fixture node",reason:"connection_unknown",canConfirmStopped:true,error:"Original conversation not loaded"}]);
  const results=await Promise.all([f.confirm(item.key,delivery.executionBlockers[0]),f.confirm(item.key,delivery.executionBlockers[0])]);
  expect(results.map(r=>r.statusCode).sort()).toEqual([200,409]);
  expect(f.store.getWorkItem(item.key)).toMatchObject({status:"ready"});
  expect(f.store.getWorkItem(item.key).executionDisposition).toBeUndefined();
  expect(f.db.prepare("SELECT progress_status,native_snapshot_json FROM external_agent_sessions WHERE id=?").get(sessionId)).toEqual(original);
  expect((await f.read(item.key)).executionBlockers).toEqual([]);
  expect(f.dispatches.checkRedispatch(f.accountId,[item.key])).toMatchObject({allowed:true,reason:null});
  expect(f.store.getTimeline(item.key).filter(e=>e.eventType==="execution_stop_confirmed")).toMatchObject([{actorKind:"human",payload:{sessionId,source:"external",note:expect.any(String)}}]);
  expect(()=>assertExecutionAuthorization(f.store.database,item.id,f.accountId,f.owner.clientId,authorization)).toThrow(/执行凭据/);
  vi.advanceTimersByTime(1000);f.snapshot(sessionId,"unavailable");
  expect((await f.read(item.key)).executionBlockers).toEqual([]);
  expect(f.dispatch(item.key).status).toBe("queued");
  expect(()=>f.dispatch(item.key)).toThrow();
});

it.each(["queued","delivering","delivery_unknown"])("does not allow completion or manual confirmation to bypass a %s command",async status=>{
  const f=await fixture(),{item,sessionId}=f.create();
  f.db.prepare("INSERT INTO external_native_commands(id,session_id,text,status,created_at) VALUES (?,?,?,?,?)")
    .run(randomUUID(),sessionId,"New work",status,new Date().toISOString());
  const b=(await f.read(item.key)).executionBlockers[0];
  expect(b).toMatchObject({reason:"commands_pending",canConfirmStopped:false});
  expect((await f.confirm(item.key,b)).statusCode).toBe(409);
  expect(()=>f.dispatch(item.key)).toThrow();
});

it.each(["active","stalled","turnActive"])("never treats completed as stopped when the source reports %s",async state=>{
  const f=await fixture(),{item,sessionId}=f.create();
  f.snapshot(sessionId,state==="turnActive"?"idle":state,state==="turnActive");
  const b=(await f.read(item.key)).executionBlockers[0];
  expect(b).toMatchObject({reason:"active",canConfirmStopped:false});
  expect((await f.confirm(item.key,b)).statusCode).toBe(409);
});

it.each(["active","command","progress","message"])("invalidates a human stop check permanently after new %s, even if health becomes unknown again",async change=>{
  const f=await fixture(),{item,sessionId}=f.create();
  expect((await f.confirm(item.key)).statusCode).toBe(200);
  vi.advanceTimersByTime(1000);
  if(change==="active") f.snapshot(sessionId,"active",true);
  if(change==="command") {
    const id=randomUUID();f.db.prepare("INSERT INTO external_native_commands(id,session_id,text,status,created_at) VALUES (?,?,?,'queued',?)").run(id,sessionId,"New work",new Date().toISOString());
    f.db.prepare("UPDATE external_native_commands SET status='delivered' WHERE id=?").run(id);
  }
  if(change==="progress") {
    f.external.report(f.owner,sessionId,item.key,"working","Resumed",randomUUID());
    f.external.report(f.owner,sessionId,item.key,"completed","Finished again",randomUUID());
  }
  if(change==="message") f.db.prepare("INSERT INTO external_native_messages(id,session_id,source_id,payload_json,position) VALUES (?,?,?,?,0)")
    .run(randomUUID(),sessionId,randomUUID(),JSON.stringify({role:"user",text:"More work"}));
  f.snapshot(sessionId,"unavailable");
  expect((await f.read(item.key)).executionBlockers).toHaveLength(1);
  expect(()=>f.dispatch(item.key)).toThrow();
  expect(f.db.prepare("SELECT invalidated_at FROM item_execution_stop_confirmations WHERE item_id=?").get(item.id)).toMatchObject({invalidated_at:expect.any(String)});
});

it("requires fresh evidence, a note, explicit attestation and a signed-in delivery manager; it is not a Bearer/MCP operation",async()=>{
  const f=await fixture(),{item,sessionId}=f.create();
  let b=(await f.read(item.key)).executionBlockers[0];
  expect((await f.confirm(item.key,b,{confirmedStopped:false})).statusCode).toBe(400);
  expect((await f.confirm(item.key,b,{note:"  "})).statusCode).toBe(400);
  expect((await f.confirm(item.key,b,{},{} as typeof f.headers)).statusCode).toBe(401);
  const account=f.app.missionGoAccounts.getAccount(f.accountId);
  const token=createAiAccessToken(TEST_CONSOLE_ACCOUNT,{id:account.id,username:account.email,role:account.role},
    f.app.missionGoAccounts.credentialsStamp(account),f.owner.clientId,["missiongo:read","missiongo:write"]).token;
  expect((await f.app.inject({method:"POST",url:`/api/v1/items/${item.key}/execution-blockers/${encodeURIComponent(b.id)}/confirm-stopped`,
    headers:{authorization:`Bearer ${token}`},payload:{revision:b.revision,note:"An AI cannot attest this",confirmedStopped:true}})).statusCode).toBe(401);
  const other=f.app.missionGoAccounts.createAccount({email:"operator@example.test",password:"operator-password",role:"member"});
  f.app.missionGoAccounts.replacePermissions(other.id,[{productId:f.product.id,canView:true,canOperate:true,canUseAi:true}]);
  const login=await f.app.inject({method:"POST",url:"/api/v1/auth/login",payload:{username:other.email,password:"operator-password"}});
  const cookie=login.headers["set-cookie"]!.toString().split(";")[0]!;
  expect((await f.confirm(item.key,b,{}, {cookie})).statusCode).toBe(403);
  f.db.prepare("INSERT INTO external_native_messages(id,session_id,source_id,payload_json,position) VALUES (?,?,?,?,0)")
    .run(randomUUID(),sessionId,randomUUID(),JSON.stringify({role:"user",text:"Changed evidence"}));
  expect((await f.confirm(item.key,b)).statusCode).toBe(409);
  b=(await f.read(item.key)).executionBlockers[0];
  f.store.updateWorkItem(item.key,{description:"Changed scope"});
  expect((await f.confirm(item.key,b)).statusCode).toBe(409);
  expect((await f.confirm(item.key)).statusCode).toBe(200);
});

it("keeps other executions blocked and confirmations scoped to a single item, including a shared native conversation",async()=>{
  const f=await fixture(),first=f.create(),second=f.create();
  f.db.prepare("INSERT INTO external_agent_session_items(session_id,item_id) VALUES (?,?)").run(first.sessionId,second.item.id);
  expect((await f.confirm(first.item.key)).statusCode).toBe(200);
  expect((await f.read(first.item.key)).executionBlockers).toEqual([]);
  expect((await f.read(second.item.key)).executionBlockers).toHaveLength(2);
  const another=f.create();
  f.db.prepare("INSERT INTO external_agent_session_items(session_id,item_id) VALUES (?,?)").run(another.sessionId,first.item.id);
  expect((await f.read(first.item.key)).executionBlockers).toHaveLength(1);
  expect(()=>f.dispatch(first.item.key)).toThrow();
});

it.each(["offline","revoked"])("keeps unknown %s nodes blocked until a human verifies the exact completed old execution",async state=>{
  const f=await fixture(),{item,sessionId}=f.create();
  f.snapshot(sessionId,"idle");
  if(state==="offline") f.db.prepare("UPDATE nodes SET last_seen_at=NULL WHERE id=?").run(f.node.nodeId);
  if(state==="revoked") f.db.prepare("UPDATE nodes SET revoked_at=? WHERE id=?").run(new Date().toISOString(),f.node.nodeId);
  expect((await f.read(item.key)).executionBlockers[0]).toMatchObject({reason:"connection_unknown",canConfirmStopped:true});
  expect((await f.confirm(item.key)).statusCode).toBe(200);
});

it("releases an idle native session whose last report is older than the window while its node keeps heartbeating",async()=>{
  const f=await fixture(),{item,sessionId}=f.create();
  f.snapshot(sessionId,"idle");
  // Idle sessions report less often than the window; the node heartbeat, not the
  // session report time, carries connection health.
  vi.advanceTimersByTime(120_000);
  f.dispatches.recordHeartbeat(f.node.nodeId,[{kind:"codex",planApprovalProtocol:1,ready:true}]);
  f.db.prepare("UPDATE external_agent_sessions SET native_synced_at='2000-01-01T00:00:00Z' WHERE id=?").run(sessionId);
  expect((await f.read(item.key)).executionBlockers).toEqual([]);
  expect(f.dispatches.checkRedispatch(f.accountId,[item.key]).allowed).toBe(true);
});

it("accepts a stop check when only the observation timestamp moved since the form was read",async()=>{
  const f=await fixture(),{item,sessionId}=f.create();
  const b=(await f.read(item.key)).executionBlockers[0];
  vi.advanceTimersByTime(1000);f.snapshot(sessionId,"unavailable");
  expect((await f.confirm(item.key,b)).statusCode).toBe(200);
});

it("does not require stop confirmation for a completed tracking record or a fresh idle native session",async()=>{
  const f=await fixture(),{item,sessionId}=f.create();
  f.snapshot(sessionId,"idle");
  expect((await f.read(item.key)).executionBlockers).toEqual([]);
  f.db.prepare("UPDATE external_agent_sessions SET native_node_id=NULL,native_snapshot_json=NULL WHERE id=?").run(sessionId);
  expect((await f.read(item.key)).executionBlockers).toEqual([]);
  f.store.transitionWorkItem({itemKey:item.key,to:"in_progress",reason:"claim",actor:"agent",attribution:f.owner});
  f.store.transitionWorkItem({itemKey:item.key,to:"pending_verification",reason:"manual_override",actor:"human",note:"Another delivery",attribution:{accountId:f.accountId}});
  f.store.transitionWorkItem({itemKey:item.key,to:"ready",reason:"verification_failed",actor:"human",note:"More rework",attribution:{accountId:f.accountId}});
  expect(f.store.getWorkItem(item.key).executionDisposition).toBeUndefined();
});

it("also reconciles closed dispatched history while keeping a pending new dispatch fenced",async()=>{
  const f=await fixture();
  const item=f.store.createWorkItem({productId:f.product.id,title:"Dispatched task",description:"Scope",type:"task",priority:"normal",status:"ready",environment:{platform:"shared"}});
  const d=f.dispatch(item.key);f.dispatches.claimNextDispatch(f.node.nodeId);
  f.dispatches.recordDispatchResult({nodeId:f.node.nodeId,dispatchId:d.id,status:"launched"});
  const sessions=new AgentSessionStore(f.store.database);
  const sessionId=sessions.createForDispatch({dispatchId:d.id,nodeId:f.node.nodeId,sessionRef:randomUUID()});
  f.store.claimWorkItem({itemKey:item.key,agentId:"Codex",idempotencyKey:randomUUID(),attribution:f.owner,dispatchId:d.id});
  f.store.transitionWorkItem({itemKey:item.key,to:"pending_verification",reason:"manual_override",actor:"human",note:"Fixture delivery",attribution:{accountId:f.accountId}});
  sessions.recordSnapshot({sessionId,nodeId:f.node.nodeId,status:"unavailable",messages:[],turnState:{}});
  f.store.transitionWorkItem({itemKey:item.key,to:"ready",reason:"verification_failed",actor:"human",note:"Rework",attribution:{accountId:f.accountId}});
  expect((await f.read(item.key)).executionBlockers[0]).toMatchObject({source:"dispatch",canConfirmStopped:true});
  expect((await f.confirm(item.key)).statusCode).toBe(200);
  expect(f.dispatch(item.key).status).toBe("queued");
  const b=(await f.read(item.key)).executionBlockers[0];
  expect(b).toMatchObject({source:"dispatch",canConfirmStopped:false});
  expect((await f.confirm(item.key,b)).statusCode).toBe(409);
});

it("keeps archived projects read-only but allows a human check without a closed handling round",async()=>{
  const f=await fixture(),{item}=f.create();
  f.store.createProduct({name:"Other active project",keyPrefix:"OTHER"});
  const blocker=(await f.read(item.key)).executionBlockers[0];
  f.store.updateProduct(f.product.id,{archived:true});
  expect((await f.read(item.key)).executionBlockers[0].canConfirmStopped).toBe(false);
  expect((await f.confirm(item.key,blocker)).statusCode).toBe(409);
  f.store.updateProduct(f.product.id,{archived:false});
  const open=f.store.createWorkItem({productId:f.product.id,title:"Only self reported",description:"Scope",type:"task",priority:"normal",status:"ready",environment:{platform:"shared"}});
  f.store.claimWorkItem({itemKey:open.key,agentId:"Codex",idempotencyKey:randomUUID(),attribution:f.owner});
  const sessionId=f.external.register(f.owner,{agentKind:"codex",refKind:"native",sessionRef:randomUUID()},open.key);
  f.external.report(f.owner,sessionId,open.key,"completed","A report, not a stop receipt",randomUUID());
  f.snapshot(sessionId,"unavailable");
  f.store.transitionWorkItem({itemKey:open.key,to:"ready",reason:"released",actor:"human",note:"Replan",attribution:{accountId:f.accountId}});
  const b=(await f.read(open.key)).executionBlockers[0];
  expect(b.canConfirmStopped).toBe(true);
  expect((await f.confirm(open.key,b)).statusCode).toBe(200);
});

it("leaves a scoped human performer blocked after settling the old native execution",async()=>{
  const f=await fixture(),{item}=f.create();
  const response=await f.app.inject({method:"POST",url:`/api/v1/items/${item.key}/executions`,headers:f.headers,
    payload:{accountId:f.accountId,scope:"Review follow-up"}});
  expect(response.statusCode).toBe(201);
  const b=(await f.read(item.key)).executionBlockers.find((row:{source:string})=>row.source==="external");
  expect((await f.confirm(item.key,b)).statusCode).toBe(200);
  expect((await f.read(item.key)).executionBlockers).toMatchObject([{source:"performer",reason:"execution_open",canConfirmStopped:true}]);
  expect(()=>f.dispatch(item.key)).toThrow();
});

it("reuses only a still-valid item-scoped human stop check during Builder handover",async()=>{
  const f=await fixture(),{item}=f.create();
  const target=f.app.missionGoAccounts.createAccount({email:"next-builder@example.test",password:"next-builder-password",role:"member"});
  f.app.missionGoAccounts.replacePermissions(target.id,[{productId:f.product.id,canView:true,canOperate:true,canUseAi:true}]);
  expect((await f.confirm(item.key)).statusCode).toBe(200);
  const result=new BuilderHandovers(f.store).start(item.key,f.accountId,target.id,f.accountId,"Continue rework with another Builder");
  expect(result).toMatchObject({builderAccountId:target.id,builderHandover:{status:"completed"}});
  const another=f.create();expect((await f.confirm(another.item.key)).statusCode).toBe(200);
  f.snapshot(another.sessionId,"active",true);f.snapshot(another.sessionId,"unavailable");
  expect(new BuilderHandovers(f.store).start(another.item.key,f.accountId,target.id,f.accountId,"New activity needs another check"))
    .toMatchObject({builderAccountId:f.accountId,builderHandover:{status:"blocked"}});
});


it("recovers interrupted working history one execution at a time through redispatch and a new claim",async()=>{
  const f=await fixture(),{item,sessionId}=f.interrupted();
  const original=f.db.prepare("SELECT progress_status,native_snapshot_json FROM external_agent_sessions WHERE id=?").get(sessionId);
  const oldPerformer=f.db.prepare("SELECT * FROM item_executions WHERE item_id=?").get(item.id);
  const before=await f.read(item.key);
  expect(before.executionBlockers).toHaveLength(2);
  expect(before.executionBlockers).toEqual(expect.arrayContaining([
    expect.objectContaining({source:"external",progressStatus:"working",canConfirmStopped:true}),
    expect.objectContaining({source:"performer",status:"working",scope:"人工领取处理",canConfirmStopped:true}),
  ]));
  const claim=()=>f.store.claimWorkItem({itemKey:item.key,agentId:"Codex",idempotencyKey:randomUUID(),attribution:f.owner});
  expect(claim).toThrow();
  expect(f.dispatches.checkRedispatch(f.accountId,[item.key]).allowed).toBe(false);
  const external=before.executionBlockers.find((b:{source:string})=>b.source==="external");
  expect((await f.confirm(item.key,external)).statusCode).toBe(200);
  // A harmless native poll must not undo a check merely because the last progress report is still working.
  vi.advanceTimersByTime(1000);f.snapshot(sessionId,"unavailable");
  expect((await f.read(item.key)).executionBlockers).toMatchObject([{source:"performer"}]);
  expect(claim).toThrow();
  expect((await f.confirm(item.key)).statusCode).toBe(200);
  expect((await f.read(item.key)).executionBlockers).toEqual([]);
  expect(f.db.prepare("SELECT progress_status,native_snapshot_json FROM external_agent_sessions WHERE id=?").get(sessionId)).toEqual(original);
  expect(f.db.prepare("SELECT * FROM item_executions WHERE item_id=?").get(item.id)).toEqual(oldPerformer);
  expect(f.store.getWorkItem(item.key).status).toBe("ready");
  expect(f.dispatches.checkRedispatch(f.accountId,[item.key]).allowed).toBe(true);
  const dispatch=f.dispatch(item.key);f.dispatches.claimNextDispatch(f.node.nodeId);
  f.dispatches.recordDispatchResult({nodeId:f.node.nodeId,dispatchId:dispatch.id,status:"launched"});
  new AgentSessionStore(f.store.database).createForDispatch({dispatchId:dispatch.id,nodeId:f.node.nodeId,sessionRef:randomUUID()});
  expect(f.store.claimWorkItem({itemKey:item.key,agentId:"Codex",idempotencyKey:randomUUID(),attribution:f.owner,dispatchId:dispatch.id}).status).toBe("in_progress");
  expect(f.store.getTimeline(item.key).filter(e=>e.eventType==="execution_stop_confirmed")).toHaveLength(2);
});

it.each(["active","queued","delivering","delivery_unknown"])("never lets a linked performer check conceal %s source work",async state=>{
  const f=await fixture(),{item,sessionId}=f.interrupted();
  const id=randomUUID();
  f.db.prepare("INSERT INTO item_executions(id,item_id,account_id,scope,kind,session_id,status,created_by,created_at,updated_at) VALUES (?,?,?,'Agent scope','agent',?,'working',?,?,?)")
    .run(id,item.id,f.accountId,sessionId,f.accountId,new Date().toISOString(),new Date().toISOString());
  const original=(await f.read(item.key)).executionBlockers.find((b:{executionId:string})=>b.executionId===id);
  expect((await f.confirm(item.key,original)).statusCode).toBe(200);
  if(state==="active") f.snapshot(sessionId,"active",true);
  else f.db.prepare("INSERT INTO external_native_commands(id,session_id,text,status,created_at) VALUES (?,?,?,?,?)")
    .run(randomUUID(),sessionId,"More work",state,new Date().toISOString());
  const blocker=(await f.read(item.key)).executionBlockers.find((b:{executionId:string})=>b.executionId===id);
  expect(blocker).toMatchObject({canConfirmStopped:false,reason:state==="active"?"active":"commands_pending"});
  expect((await f.confirm(item.key,blocker)).statusCode).toBe(409);
  expect(f.dispatches.checkRedispatch(f.accountId,[item.key]).allowed).toBe(false);
});

it.each(["progress","performer","sourceActivity"])("invalidates interrupted-work confirmations after new %s even when it becomes unavailable again",async change=>{
  const f=await fixture(),{item,sessionId}=f.interrupted();
  const performer=(await f.read(item.key)).executionBlockers.find((b:{source:string})=>b.source==="performer");
  const source=(await f.read(item.key)).executionBlockers.find((b:{source:string})=>b.source==="external");
  expect((await f.confirm(item.key,source)).statusCode).toBe(200);
  expect((await f.confirm(item.key,performer)).statusCode).toBe(200);
  expect((await f.read(item.key)).executionBlockers).toEqual([]);
  if(change==="progress") f.external.report(f.owner,sessionId,item.key,"working","Resumed with the same status",randomUUID());
  if(change==="performer") f.db.prepare("UPDATE item_executions SET status='working' WHERE id=?").run(performer.executionId);
  if(change==="sourceActivity") {f.snapshot(sessionId,"active",true);f.snapshot(sessionId,"unavailable");}
  expect((await f.read(item.key)).executionBlockers.length).toBeGreaterThan(0);
  expect(f.dispatches.checkRedispatch(f.accountId,[item.key]).allowed).toBe(false);
});

it("rejects a stale performer check, preserves separate performer scopes and accepts only fresh human checks",async()=>{
  const f=await fixture(),{item}=f.interrupted();
  const first=(await f.read(item.key)).executionBlockers.find((b:{source:string})=>b.source==="performer");
  f.db.prepare("UPDATE item_executions SET scope='Changed scope' WHERE id=?").run(first.executionId);
  expect((await f.confirm(item.key,first)).statusCode).toBe(409);
  const changed=(await f.read(item.key)).executionBlockers.find((b:{source:string})=>b.source==="performer");
  expect((await f.confirm(item.key,changed,{confirmedStopped:false})).statusCode).toBe(400);
  expect((await f.confirm(item.key,changed,{note:" "})).statusCode).toBe(400);
  expect((await f.confirm(item.key,changed,{},{} as typeof f.headers)).statusCode).toBe(401);
  const results=await Promise.all([f.confirm(item.key,changed),f.confirm(item.key,changed)]);
  expect(results.map(r=>r.statusCode).sort()).toEqual([200,409]);
  expect((await f.read(item.key)).executionBlockers).toMatchObject([{source:"external"}]);
});


it("lets a verification return redispatch and reclaim directly when the node is online and the old session is idle",async()=>{
  const f=await fixture();
  const item=f.store.createWorkItem({productId:f.product.id,title:"Returned item",description:"Scope",type:"task",priority:"normal",status:"ready",environment:{platform:"shared"}});
  const d=f.dispatch(item.key);f.dispatches.claimNextDispatch(f.node.nodeId);
  f.dispatches.recordDispatchResult({nodeId:f.node.nodeId,dispatchId:d.id,status:"launched"});
  const sessions=new AgentSessionStore(f.store.database);
  const sessionId=sessions.createForDispatch({dispatchId:d.id,nodeId:f.node.nodeId,sessionRef:randomUUID()});
  f.store.claimWorkItem({itemKey:item.key,agentId:"Codex",idempotencyKey:randomUUID(),attribution:f.owner,dispatchId:d.id});
  f.store.transitionWorkItem({itemKey:item.key,to:"pending_verification",reason:"manual_override",actor:"human",note:"Delivered",attribution:{accountId:f.accountId}});
  sessions.recordSnapshot({sessionId,nodeId:f.node.nodeId,status:"idle",messages:[],turnState:{}});
  f.store.transitionWorkItem({itemKey:item.key,to:"ready",reason:"verification_failed",actor:"human",note:"Same problem again",attribution:{accountId:f.accountId}});
  vi.advanceTimersByTime(120_000);
  f.dispatches.recordHeartbeat(f.node.nodeId,[{kind:"codex",planApprovalProtocol:1,ready:true}]);
  f.db.prepare("UPDATE agent_sessions SET updated_at='2000-01-01T00:00:00Z' WHERE id=?").run(sessionId);
  expect((await f.read(item.key)).executionBlockers).toEqual([]);
  expect(f.dispatches.checkRedispatch(f.accountId,[item.key]).allowed).toBe(true);
  const redispatch=f.dispatch(item.key);f.dispatches.claimNextDispatch(f.node.nodeId);
  f.dispatches.recordDispatchResult({nodeId:f.node.nodeId,dispatchId:redispatch.id,status:"launched"});
  new AgentSessionStore(f.store.database).createForDispatch({dispatchId:redispatch.id,nodeId:f.node.nodeId,sessionRef:randomUUID()});
  expect(f.store.claimWorkItem({itemKey:item.key,agentId:"Codex",idempotencyKey:randomUUID(),attribution:f.owner,dispatchId:redispatch.id}).status).toBe("in_progress");
});

it("keeps startup placeholders fenced even when their status becomes unavailable",async()=>{
  const f=await fixture(),{item}=f.create();
  expect((await f.confirm(item.key)).statusCode).toBe(200);
  const dispatch=f.dispatch(item.key);f.dispatches.claimNextDispatch(f.node.nodeId);
  f.dispatches.recordDispatchResult({nodeId:f.node.nodeId,dispatchId:dispatch.id,status:"launched"});
  const id=new AgentSessionStore(f.store.database).createForDispatch({dispatchId:dispatch.id,nodeId:f.node.nodeId,sessionRef:`pending:${dispatch.id}`});
  f.db.prepare("UPDATE agent_sessions SET status='unavailable',turn_state_json='{}' WHERE id=?").run(id);
  const blocker=(await f.read(item.key)).executionBlockers[0];
  expect(blocker).toMatchObject({source:"dispatch",reason:"execution_open",canConfirmStopped:false});
  expect((await f.confirm(item.key,blocker)).statusCode).toBe(409);
  expect(()=>f.dispatch(item.key)).toThrow();
});
