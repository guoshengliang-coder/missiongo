import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { buildApp } from "./app.js";
import { createAiAccessToken, hashPassword } from "./admin-auth.js";
import { AgentSessionStore } from "./agent-session-store.js";
import { assertExecutionAuthorization } from "./builder-authority.js";
import { deliveryRound } from "./delivery-round.js";
import { DispatchStore } from "./dispatch-store.js";
import { MissionGoDatabase } from "./storage/database.js";
import { ExternalAgentSessionStore } from "./external-agent-session-store.js";

const apps:ReturnType<typeof buildApp>[]=[];
afterEach(async()=>{await Promise.all(apps.splice(0).map(app=>app.close()));});
const config={id:"handoff-owner",username:"handoff@example.test",passwordScrypt:hashPassword("fixture-password"),sessionSecret:"synthetic-handoff-session-signing-secret",cookieSecure:false};
async function fixture(databasePath?:string) {
  const app=buildApp({adminAccount:config,writeTools:"comments",...(databasePath?{databasePath}:{})});apps.push(app);
  const store=app.missionGoStore,db=store.database.connection,accounts=app.missionGoAccounts;
  const login=await app.inject({method:"POST",url:"/api/v1/auth/login",payload:{username:config.username,password:"fixture-password"}});
  const headers={cookie:login.headers["set-cookie"]!.toString().split(";")[0]!};
  const account=accounts.getAccount(config.id);
  const token=(client="handoff-client")=>createAiAccessToken(config,{id:account.id,username:account.email,role:account.role},accounts.credentialsStamp(account),client,["missiongo:read","missiongo:write"]).token;
  const itemProduct=store.createProduct({name:"Handoff",keyPrefix:"HAND",createdByAccountId:config.id});
  const item=store.createWorkItem({productId:itemProduct.id,title:"Continue human work",description:"Same approved scope",type:"task",priority:"normal",status:"ready",environment:{platform:"web"}});
  store.transitionWorkItem({itemKey:item.key,to:"in_progress",actor:"human",reason:"claim",attribution:{accountId:config.id}});
  const url=`/api/v1/items/${item.key}`;
  const http=(method:"GET"|"POST"|"PATCH",path:string,payload?:unknown,auth=headers)=>app.inject({method,url:path,headers:auth,...(payload===undefined?{}:{payload})});
  const call=async(name:string,args:Record<string,unknown>,client="handoff-client")=>{
    const r=await app.inject({method:"POST",url:"/mcp",headers:{authorization:`Bearer ${token(client)}`,accept:"application/json, text/event-stream"},payload:{jsonrpc:"2.0",id:1,method:"tools/call",params:{name,arguments:args}}});
    const raw=r.headers["content-type"]?.includes("text/event-stream") ? r.body.split("\n").find(line=>line.startsWith("data: "))!.slice(6) : r.body;
    return JSON.parse(raw).result;
  };
  const session=(ref="receiving-terminal")=>({agentKind:"codex",refKind:"native",sessionRef:ref});
  const propose=async(identity:Record<string,unknown>={session:session()})=>{
    const r=await call("request_plan_approval",{itemKeys:[item.key],plan:"Implement the reviewed scope",validation:"Verify scoped takeover",approvalMethod:"web",...identity});
    expect(r.isError,JSON.stringify(r)).not.toBe(true);return r.structuredContent as {sessionId:string;revision:string};
  };
  const approve=async(p:{sessionId:string;revision:string})=>{
    const r=await http("POST",`/api/v1/agent-sessions/${p.sessionId}/plan-approval`,{revision:p.revision});
    expect(r.statusCode,r.body).toBe(201);return r;
  };
  const confirm=async()=>{
    const data=(await http("GET",`${url}/delivery`)).json();
    for(const blocker of data.executionBlockers) {
      const latest=(await http("GET",`${url}/delivery`)).json().executionBlockers.find((row:{id:string})=>row.id===blocker.id);
      const r=await http("POST",`${url}/execution-blockers/${blocker.id}/confirm-stopped`,{revision:latest.revision,note:"Checked this exact execution on its device",confirmedStopped:true});
      expect(r.statusCode,r.body).toBe(200);
    }
  };
  const handoffInput=(target:Record<string,unknown>)=>({expectedRevision:store.getWorkItem(item.key).revision,note:"Continue this task in the specified Agent",idempotencyKey:randomUUID(),target});
  const claim=(identity:Record<string,unknown>={session:session()},idempotencyKey="claim-receiving")=>call("claim_item",{itemKey:item.key,agentId:"Fixture Agent",idempotencyKey,...identity});
  return {app,store,db,accounts,itemProduct,item,url,headers,http,call,session,propose,approve,confirm,handoffInput,claim,token};
}

it("hands human work to the exact original external conversation and claims once without changing business status",async()=>{
  const f=await fixture(),p=await f.propose();
  const before=f.store.getWorkItem(f.item.key);
  f.db.prepare(`INSERT INTO builder_execution_authorizations(id,item_id,account_id,client_id,created_at,round_key) VALUES (?,?,?,?,?,?)`)
    .run("previous-credential",f.item.id,config.id,"old-client",new Date().toISOString(),deliveryRound(f.store.database,f.item.id,true));
  await f.approve(p);
  // Approval-only visibility neither starts an execution nor creates a claim credential.
  expect((await f.http("GET",`${f.url}/delivery`)).json().agentHandoffTargets).toContainEqual(expect.objectContaining({sessionId:p.sessionId}));
  expect(f.db.prepare("SELECT COUNT(*) AS n FROM mcp_agent_claim_receipts").get()).toMatchObject({n:0});
  // An unfinished human record is a warning, not a physical-stop attestation gate.
  const input=f.handoffInput({kind:"session",sessionId:p.sessionId});
  const granted=await f.http("POST",`${f.url}/agent-handoffs`,input);
  expect(granted.statusCode,granted.body).toBe(201);
  expect((await f.http("POST",`${f.url}/agent-handoffs`,input)).json()).toEqual(granted.json());
  expect((await f.http("POST",`${f.url}/agent-handoffs`,{...input,note:"different scope"})).statusCode).toBe(409);
  const wrong=await f.propose({session:f.session("different-terminal")});await f.approve(wrong);
  // A different terminal may now join independently; the explicit handoff target remains bound.
  const competing=await Promise.all([f.claim(),f.claim({session:f.session()},"other-claim-key")]);
  expect(competing.filter(result=>result.isError)).toHaveLength(0);
  const claimed=competing.find(result=>!result.isError)!;
  expect(claimed.isError,JSON.stringify(claimed)).not.toBe(true);
  expect(claimed.structuredContent).toMatchObject({sessionId:p.sessionId,statusChanged:false,item:{status:"in_progress",builderAccountId:before.builderAccountId}});
  const credential=claimed.structuredContent.executionAuthorization;
  expect((await f.claim()).structuredContent.executionAuthorization).toBe(credential);
  expect((await f.claim({session:f.session()},"new-key-reuses-original")).structuredContent.executionAuthorization).toBe(credential);
  expect(f.db.prepare("SELECT status,authorization_revoked FROM item_executions WHERE item_id=?").get(f.item.id)).toMatchObject({status:"handed_over",authorization_revoked:1});
  expect(()=>assertExecutionAuthorization(f.store.database,f.item.id,config.id,"old-client","previous-credential")).toThrow();
  expect(()=>assertExecutionAuthorization(f.store.database,f.item.id,config.id,"handoff-client",credential)).not.toThrow();
  const recovered=await f.call("recover_execution_authorization",{itemKey:f.item.key,session:f.session()});
  expect(recovered.structuredContent.executionAuthorization).toBe(credential);
  expect(f.db.prepare("SELECT COUNT(*) AS n FROM work_item_events WHERE item_id=? AND event_type='execution_taken_over'").get(f.item.id)).toMatchObject({n:1});
});

it("creates a bound dispatch atomically, claims independently of plan/mode, and permits no ordinary in-progress dispatch",async()=>{
  const f=await fixture();await f.confirm();
  const dispatches=new DispatchStore(f.store.database),sessions=new AgentSessionStore(f.store.database);
  const node=dispatches.registerNode({accountId:config.id,name:"Handoff fixture",installationId:randomUUID()});
  dispatches.recordHeartbeat(node.nodeId,[{kind:"codex",planApprovalProtocol:1,ready:true}]);
  dispatches.replaceOwnRepos(node.nodeId,[{productId:f.itemProduct.id,repoPath:"/synthetic/handoff-repository"}]);
  const target={kind:"dispatch",nodeId:node.nodeId,agentKind:"codex",mode:"auto",saveAsDefault:true};
  const parallel=await f.http("POST","/api/v1/dispatches",{...target,itemKeys:[f.item.key]});
  expect(parallel.statusCode).toBe(201);
  dispatches.cancelQueuedDispatch(config.id,parallel.json().id);
  const input=f.handoffInput(target),granted=await f.http("POST",`${f.url}/agent-handoffs`,input);
  expect(granted.statusCode,granted.body).toBe(201);
  const d=granted.json().dispatch;
  expect((await f.http("GET","/api/v1/dispatch-defaults")).json()).toEqual({nodeId:node.nodeId,agentKind:"codex",agents:{codex:{mode:"auto"}}});
  expect((await f.http("POST",`${f.url}/agent-handoffs`,input)).json().dispatch.id).toBe(d.id);
  dispatches.claimNextDispatch(node.nodeId);
  expect(sessions.permitDispatchStart(node.nodeId,d.id)).toBe(true);
  dispatches.recordDispatchResult({nodeId:node.nodeId,dispatchId:d.id,status:"launched",sessionRef:"handoff-thread"});
  const id=sessions.createForDispatch({dispatchId:d.id,nodeId:node.nodeId,sessionRef:"handoff-thread"});
  sessions.recordSnapshot({nodeId:node.nodeId,sessionId:id,status:"idle",messages:[],turnState:{turnActive:false}});
  const identity={dispatchId:d.id};
  // The human handoff supplies execution ownership; plan approval and mode do not gate claiming.
  const result=await f.claim(identity);
  expect(result.isError,JSON.stringify(result)).not.toBe(true);
  expect(result.structuredContent).toMatchObject({statusChanged:false,item:{status:"in_progress"},executionAuthorization:expect.any(String)});
  expect(f.db.prepare("SELECT COUNT(*) AS n FROM external_agent_sessions").get()).toMatchObject({n:0});
});

it.each(["activity","content","archive"])("rejects %s after the human authorized a handoff without issuing credentials",async(change)=>{
  const f=await fixture(),p=await f.propose();await f.approve(p);await f.confirm();
  expect((await f.http("POST",`${f.url}/agent-handoffs`,f.handoffInput({kind:"session",sessionId:p.sessionId}))).statusCode).toBe(201);
  if(change==="activity") {
    const execution=f.db.prepare("SELECT id FROM item_executions WHERE item_id=?").get(f.item.id) as {id:string};
    expect((await f.http("PATCH",`${f.url}/executions/${execution.id}`,{status:"working"})).statusCode).toBe(200);
  } else if(change==="content") f.db.prepare("UPDATE work_items SET content_version=content_version+1 WHERE id=?").run(f.item.id);
  else if(change==="archive") f.db.prepare("UPDATE external_agent_sessions SET archived_at=? WHERE id=?").run(new Date().toISOString(),p.sessionId);
  const r=change==="other-client"?await f.call("claim_item",{itemKey:f.item.key,session:f.session(),agentId:"Fixture",idempotencyKey:"wrong-client"},"other-client"):await f.claim();
  expect(r.isError,JSON.stringify(r)).toBe(true);
  expect(f.db.prepare("SELECT COUNT(*) AS n FROM builder_execution_authorizations").get()).toMatchObject({n:0});
  expect(f.db.prepare("SELECT consumed_at FROM agent_handoffs").get()).toMatchObject({consumed_at:null});
});

it("keeps cookie authorization, stale revisions, archived projects and AI grants at the handoff boundary",async()=>{
  const f=await fixture(),p=await f.propose();await f.confirm();
  const input=f.handoffInput({kind:"session",sessionId:p.sessionId});
  expect((await f.http("POST",`${f.url}/agent-handoffs`,input,{authorization:`Bearer ${f.token()}`} as unknown as typeof f.headers)).statusCode).toBe(401);
  expect((await f.http("POST",`${f.url}/agent-handoffs`,{...input,expectedRevision:0})).statusCode).toBe(409);
  f.db.prepare("UPDATE products SET archived_at=? WHERE id=?").run(new Date().toISOString(),f.itemProduct.id);
  expect((await f.http("POST",`${f.url}/agent-handoffs`,input)).statusCode).toBe(409);
  f.db.prepare("UPDATE products SET archived_at=NULL WHERE id=?").run(f.itemProduct.id);
  f.accounts.replacePermissions(config.id,[],"none");
  expect((await f.http("POST",`${f.url}/agent-handoffs`,input)).statusCode).toBe(403);
  expect(f.db.prepare("SELECT COUNT(*) AS n FROM agent_handoffs").get()).toMatchObject({n:0});
});

it("upgrades an existing database without inventing grants, and preserves a pending grant across reopen",async()=>{
  const path=join(mkdtempSync(join(tmpdir(),"missiongo-handoff-test-")),"test.sqlite");
  const f=await fixture(path),p=await f.propose();await f.approve(p);await f.confirm();
  f.db.exec("DROP TABLE agent_handoffs; DELETE FROM schema_migrations WHERE version=202611051350");
  await f.app.close();apps.splice(apps.indexOf(f.app),1);
  const upgraded=new MissionGoDatabase(path);
  expect(upgraded.connection.prepare("SELECT COUNT(*) AS n FROM agent_handoffs").get()).toMatchObject({n:0});
  expect(upgraded.connection.prepare("SELECT status FROM work_items WHERE id=?").get(f.item.id)).toMatchObject({status:"in_progress"});
  upgraded.close();
  const reopened=buildApp({adminAccount:config,writeTools:"comments",databasePath:path});apps.push(reopened);
  const response=await reopened.inject({method:"POST",url:`${f.url}/agent-handoffs`,headers:f.headers,payload:{expectedRevision:reopened.missionGoStore.getWorkItem(f.item.key).revision,note:"Verified exact handoff",idempotencyKey:"persistent",target:{kind:"session",sessionId:p.sessionId}}});
  expect(response.statusCode,response.body).toBe(201);
  await reopened.close();apps.splice(apps.indexOf(reopened),1);
  const database=new MissionGoDatabase(path);
  expect(database.connection.prepare("SELECT consumed_at,target_session_id FROM agent_handoffs").get()).toMatchObject({consumed_at:null,target_session_id:p.sessionId});database.close();
});

it.each(["queued","delivering","delivery_unknown","active"])("does not hand off across an old source with %s work",async state=>{
  const f=await fixture(),p=await f.propose();await f.approve(p);
  const old=new ExternalAgentSessionStore(f.store).register({accountId:config.id,clientId:"old-client"},
    {agentKind:"codex",refKind:"native",sessionRef:"old-source"},f.item.key);
  f.db.prepare("UPDATE external_agent_sessions SET native_snapshot_json=?,native_synced_at=? WHERE id=?")
    .run(JSON.stringify({status:"unavailable",turnState:{}}),new Date().toISOString(),old);
  await f.confirm();
  if(state==="active") {
    const nodes=new DispatchStore(f.store.database),node=nodes.registerNode({accountId:config.id,name:"Active source",installationId:randomUUID()});
    nodes.recordHeartbeat(node.nodeId,[{kind:"codex",ready:true,planApprovalProtocol:1}]);
    f.db.prepare("UPDATE external_agent_sessions SET native_node_id=?,native_snapshot_json=? WHERE id=?")
      .run(node.nodeId,JSON.stringify({status:"active",turnState:{turnActive:true}}),old);
  }
  else f.db.prepare("INSERT INTO external_native_commands(id,session_id,text,status,created_at) VALUES (?,?,?,?,?)")
    .run(randomUUID(),old,"More work",state,new Date().toISOString());
  const data=(await f.http("GET",`${f.url}/delivery`)).json();
  expect(data.executionBlockers).toContainEqual(expect.objectContaining({source:"external",canConfirmStopped:false}));
  expect((await f.http("POST",`${f.url}/agent-handoffs`,f.handoffInput({kind:"session",sessionId:p.sessionId}))).json().code).toBe("execution_stop_unconfirmed");
  expect(f.db.prepare("SELECT COUNT(*) AS n FROM agent_handoffs").get()).toMatchObject({n:0});
});

it("requires a fresh handoff when old work changes even if it is subsequently confirmed stopped again",async()=>{
  const f=await fixture(),p=await f.propose();await f.approve(p);await f.confirm();
  expect((await f.http("POST",`${f.url}/agent-handoffs`,f.handoffInput({kind:"session",sessionId:p.sessionId}))).statusCode).toBe(201);
  const execution=f.db.prepare("SELECT id FROM item_executions WHERE item_id=?").get(f.item.id) as {id:string};
  await f.http("PATCH",`${f.url}/executions/${execution.id}`,{status:"working"});
  await f.confirm();
  expect((await f.claim()).isError).toBe(true);
  expect((await f.http("POST",`${f.url}/agent-handoffs`,f.handoffInput({kind:"session",sessionId:p.sessionId}))).statusCode).toBe(201);
  expect((await f.claim()).isError).not.toBe(true);
});

it("reuses an existing project conversation without creating an external mirror",async()=>{
  const f=await fixture(),nodes=new DispatchStore(f.store.database),sessions=new AgentSessionStore(f.store.database);
  const node=nodes.registerNode({accountId:config.id,name:"Project fixture",installationId:randomUUID()});
  nodes.recordHeartbeat(node.nodeId,[{kind:"codex",ready:true,planApprovalProtocol:1}]);
  const dispatchId=randomUUID(),now=new Date().toISOString();
  f.db.prepare(`INSERT INTO dispatches(id,account_id,node_id,agent_kind,mode,status,repo_path,created_at) VALUES (?,?,?,'codex','auto','launched','/synthetic/project',?)`)
    .run(dispatchId,config.id,node.nodeId,now);
  f.db.prepare(`INSERT INTO free_session_starts(dispatch_id,account_id,request_key,product_id,initial_text,config_json,ready) VALUES (?,?,?,?,?,'{}',1)`)
    .run(dispatchId,config.id,randomUUID(),f.itemProduct.id,"Original project discussion");
  const id=sessions.createForDispatch({dispatchId,nodeId:node.nodeId,sessionRef:"original-project"});
  sessions.recordSnapshot({nodeId:node.nodeId,sessionId:id,status:"idle",messages:[]});
  const p=await f.propose({dispatchId});await f.confirm();
  expect((await f.http("GET",`${f.url}/delivery`)).json().agentHandoffTargets).toContainEqual(expect.objectContaining({sessionId:id,dispatchId}));
  const r=await f.http("POST",`${f.url}/agent-handoffs`,f.handoffInput({kind:"session",sessionId:id}));
  expect(r.statusCode,r.body).toBe(201);await f.approve(p);
  const desired=sessions.listForNode(node.nodeId).find(row=>row.id===id)!.desiredSettings!;
  sessions.recordSnapshot({nodeId:node.nodeId,sessionId:id,status:"idle",messages:[],mode:desired.mode!,settingsRevision:desired.revision});
  const claimed=await f.claim({session:f.session("original-project")});
  expect(claimed.isError,JSON.stringify(claimed)).not.toBe(true);
  expect(claimed.structuredContent).toMatchObject({projectSessionId:id,dispatchId,statusChanged:false});
  expect(f.db.prepare("SELECT COUNT(*) AS n FROM external_agent_sessions").get()).toMatchObject({n:0});
});

it("rechecks a dispatch handoff at delivery and launch and leaves other queued work runnable",async()=>{
  const f=await fixture();await f.confirm();
  const dispatches=new DispatchStore(f.store.database),sessions=new AgentSessionStore(f.store.database);
  const node=dispatches.registerNode({accountId:config.id,name:"Launch gate fixture",installationId:randomUUID()});
  dispatches.recordHeartbeat(node.nodeId,[{kind:"codex",ready:true,planApprovalProtocol:1}]);
  dispatches.replaceOwnRepos(node.nodeId,[{productId:f.itemProduct.id,repoPath:"/synthetic/launch-gate"}]);
  const r=await f.http("POST",`${f.url}/agent-handoffs`,f.handoffInput({kind:"dispatch",nodeId:node.nodeId,agentKind:"codex",mode:"auto"}));
  const dispatch=r.json().dispatch;expect(r.statusCode,r.body).toBe(201);
  const execution=f.db.prepare("SELECT id FROM item_executions WHERE item_id=?").get(f.item.id) as {id:string};
  await f.http("PATCH",`${f.url}/executions/${execution.id}`,{status:"working"});
  expect(dispatches.claimNextDispatch(node.nodeId)).toBeUndefined();
  const other=f.store.createWorkItem({productId:f.itemProduct.id,title:"Independent work",description:"Does not share the stopped source",type:"task",priority:"normal",status:"ready",environment:{platform:"web"}});
  const ordinary=dispatches.createDispatch({accountId:config.id,nodeId:node.nodeId,agentKind:"codex",mode:"auto",itemKeys:[other.key]});
  expect(dispatches.claimNextDispatch(node.nodeId)?.dispatchId).toBe(ordinary.id);
  // Simulate the race where the node received the job before old activity resumed.
  f.db.prepare("UPDATE dispatches SET status='delivered' WHERE id=?").run(dispatch.id);
  expect(sessions.permitDispatchStart(node.nodeId,dispatch.id)).toBe(false);
  expect(f.db.prepare("SELECT consumed_at FROM agent_handoffs").get()).toMatchObject({consumed_at:null});
});
