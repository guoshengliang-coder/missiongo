import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { afterEach, expect, it } from "vitest";
import { AgentSessionStore, type AgentSessionMessageInput } from "./agent-session-store.js";
import { buildApp } from "./app.js";
import { createAiAccessToken, hashPassword } from "./admin-auth.js";
import { ImplementationPlans } from "./implementation-plans.js";
import { itemExecutionBlockers } from "./item-execution-blockers.js";

const apps=new Set<ReturnType<typeof buildApp>>(), roots:string[]=[];
afterEach(async()=>{await Promise.all([...apps].map(app=>app.close()));apps.clear();await Promise.all(roots.splice(0).map(root=>rm(root,{recursive:true,force:true})));});
const config={id:"legacy-owner",username:"legacy@example.test",passwordScrypt:hashPassword("fixture-password"),sessionSecret:"synthetic-legacy-recovery-secret",cookieSecure:false};

async function fixture(acceptance="native",upgrade=true,batch=false) {
  const root=await mkdtemp(join(tmpdir(),"native-plan-recovery-"));roots.push(root);
  const options={databasePath:join(root,"db.sqlite"),adminAccount:config,writeTools:"comments" as const};
  let app=buildApp(options);apps.add(app);
  const store=app.missionGoStore,db=store.database.connection;
  const product=store.createProduct({name:"Legacy recovery",keyPrefix:"LEG",createdByAccountId:config.id});
  const item=store.createWorkItem({productId:product.id,title:"Recover native approval",description:"Frozen scope",status:"ready",type:"task",priority:"normal",environment:{platform:"web"}});
  const items=[item];
  if(batch) items.push(store.createWorkItem({productId:product.id,title:"Second scoped item",description:"Frozen batch",status:"ready",type:"task",priority:"normal",environment:{platform:"web"}}));
  const now=new Date().toISOString();
  db.prepare(`INSERT INTO nodes(id,account_id,installation_id,name,token_hash,agents_json,last_seen_at,created_at,updated_at)
    VALUES ('node',?,'fixture','Fixture','synthetic','[{"kind":"codex","planApprovalProtocol":1}]',?,?,?)`).run(config.id,now,now,now);
  db.prepare(`INSERT INTO dispatches(id,account_id,node_id,agent_kind,mode,status,repo_path,created_at)
    VALUES ('original-dispatch',?,'node','codex','auto','launched','synthetic-repo',?)`).run(config.id,now);
  db.prepare("INSERT INTO dispatch_items(dispatch_id,item_id,position) VALUES ('original-dispatch',?,0)").run(item.id);
  if(batch) db.prepare("INSERT INTO dispatch_items(dispatch_id,item_id,position) VALUES ('original-dispatch',?,1)").run(items[1]!.id);
  const sessions=new AgentSessionStore(store.database);
  const sessionId=sessions.createForDispatch({dispatchId:"original-dispatch",nodeId:"node",sessionRef:"original-native-thread"});
  const plans=new ImplementationPlans(store.database);
  plans.request(config.id,"dispatch:original-dispatch","original-request",{keys:items.map(item=>item.key),plan:"Earlier MCP synopsis of the implementation",validation:"Existing validation goals"});
  const planText=`# ${items.map(item=>item.key).join(", ")} implementation\nImplement and test the exact scoped behavior.\nVerify the migration, same-session claim and published handoff.`;
  const messages:AgentSessionMessageInput[]=[
    {sourceId:"native-plan",turnId:"plan-turn",role:"plan",text:planText,occurredAt:new Date(Date.now()-120000).toISOString()},
    {sourceId:"native-decision",turnId:"user-turn",role:acceptance==="agent"?"agent":"user",text:acceptance==="native"||acceptance==="agent"?`PLEASE IMPLEMENT THIS PLAN:\n${planText}`:acceptance,occurredAt:new Date(Date.now()-60000).toISOString()},
  ];
  sessions.recordSnapshot({nodeId:"node",sessionId,status:"idle",messages});
  // Recreate the real upgrade boundary. This is an isolated test database only.
  if(upgrade) db.exec(`DROP TABLE implementation_plan_recoveries; DROP TABLE implementation_plan_recovery_candidates;
    DELETE FROM schema_migrations WHERE version=202611051005;`);
  await app.close();apps.delete(app);app=buildApp(options);apps.add(app);
  const tokenFor=(clientId="original-client",scopes=["missiongo:read","missiongo:write"])=>{
    const account=app.missionGoAccounts.getAccount(config.id);
    return createAiAccessToken(config,{id:account.id,username:account.email,role:account.role},app.missionGoAccounts.credentialsStamp(account),clientId,scopes).token;
  };
  const call=async(name:string,args:Record<string,unknown>,token=tokenFor())=>{
    const response=await app.inject({method:"POST",url:"/mcp",headers:{authorization:`Bearer ${token}`,accept:"application/json, text/event-stream"},payload:{jsonrpc:"2.0",id:1,method:"tools/call",params:{name,arguments:args}}});
    const raw=response.headers["content-type"]?.includes("text/event-stream")?response.body.split("\n").find(line=>line.startsWith("data: "))!.slice(6):response.body;
    return JSON.parse(raw).result;
  };
  const claimArgs={itemKey:item.key,agentId:"Fixture",dispatchId:"original-dispatch",idempotencyKey:"original-claim-key"};
  const applyMode=()=>{
    const row=app.missionGoStore.database.connection.prepare("SELECT settings_revision FROM agent_sessions WHERE id=?").get(sessionId) as {settings_revision:number};
    new AgentSessionStore(app.missionGoStore.database).recordSnapshot({nodeId:"node",sessionId,status:"idle",messages:[],settingsRevision:row.settings_revision});
  };
  const nodeReport=async(payload:Record<string,unknown>)=>{
    app.missionGoStore.database.connection.prepare("UPDATE nodes SET token_hash=? WHERE id='node'").run(createHash('sha256').update('fixture-node-token').digest('hex'));
    return app.inject({method:'POST',url:`/api/v1/node/agent-sessions/${sessionId}/snapshot`,headers:{authorization:'Bearer fixture-node-token'},payload:{status:'idle',messages:[],...payload}});
  };
  return {app,options,store:app.missionGoStore,db:app.missionGoStore.database.connection,item,items,product,sessionId,messages,planText,call,claimArgs,applyMode,tokenFor,nodeReport};
}

it("freezes evidence without approving, then restores the exact native decision and completes a normal same-dispatch handoff",async()=>{
  const f=await fixture();
  expect(f.db.prepare("SELECT COUNT(*) AS n FROM implementation_plan_recovery_candidates").get()).toMatchObject({n:1});
  expect(f.db.prepare("SELECT COUNT(*) AS n FROM implementation_plan_approvals").get()).toMatchObject({n:0});
  expect(f.store.getWorkItem(f.item.key).status).toBe("ready");
  const first=await f.call("claim_item",f.claimArgs);
  expect(first.isError,JSON.stringify(first)).not.toBe(true);
  expect(first.structuredContent).toMatchObject({statusChanged:false,claimPending:true,continuationScheduled:true});
  expect(f.db.prepare("SELECT source,plan_text,validation_text FROM implementation_plan_approvals").get()).toEqual({source:"native",plan_text:f.planText,validation_text:""});
  const audit=f.db.prepare("SELECT * FROM implementation_plan_recoveries").get();
  expect(audit).toMatchObject({client_id:"original-client",previous_revision:"original-request",session_id:f.sessionId,plan_source_id:"native-plan",acceptance_source_id:"native-decision",native_accepted_at:f.messages[1]!.occurredAt});
  expect(String(audit!.recovered_at)>f.messages[1]!.occurredAt!).toBe(true);
  expect(f.db.prepare("SELECT COUNT(*) AS n FROM builder_execution_authorizations").get()).toMatchObject({n:0});
  expect(f.db.prepare("SELECT COUNT(*) AS n FROM work_item_events WHERE to_status='in_progress'").get()).toMatchObject({n:0});
  f.applyMode();
  const claim=await f.call("claim_item",f.claimArgs);
  expect(claim.isError,JSON.stringify(claim)).not.toBe(true);
  const executionAuthorization=claim.structuredContent.executionAuthorization;
  expect(executionAuthorization).toEqual(expect.any(String));
  expect((await f.call("claim_item",f.claimArgs)).structuredContent.executionAuthorization).toBe(executionAuthorization);
  expect(f.db.prepare("SELECT COUNT(*) AS n FROM implementation_plan_recoveries").get()).toMatchObject({n:1});
  expect(f.db.prepare("SELECT COUNT(*) AS n FROM agent_sessions").get()).toMatchObject({n:1});
  expect(f.db.prepare("SELECT COUNT(*) AS n FROM external_agent_sessions").get()).toMatchObject({n:0});
  const info=(await f.call("get_item_plan_approvals",{itemKey:f.item.key})).structuredContent.sessions[0].formalRecords.records[0];
  expect(info).toMatchObject({approved:true,scopeValid:true,plan:f.planText,approval:{source:"native",recovery:{previousRevision:"original-request",planSourceId:"native-plan",acceptanceSourceId:"native-decision"}}});
  const pullRequestUrl="https://github.com/example/fixture/pull/1";
  expect((await f.call("submit_development_complete",{itemKey:f.item.key,executionAuthorization,pullRequestUrl,requiredArtifacts:["web"],idempotencyKey:"completed"})).isError).not.toBe(true);
  expect((await f.call("submit_for_verification",{itemKey:f.item.key,executionAuthorization,pullRequestUrl,releases:[{artifact:"web",version:"1.0.1",sourceCommit:"a".repeat(40)}],deployedCommit:"a".repeat(40),receiptDigest:"b".repeat(64),idempotencyKey:"released"})).isError).not.toBe(true);
  expect(f.store.getWorkItem(f.item.key).status).toBe("pending_verification");
});

it.each(["批准","是的，执行此计划","decline","cancel","agent","PLEASE IMPLEMENT THIS PLAN:\nA different plan"])("does not infer a native decision from %s",async(text)=>{
  const f=await fixture(text);
  expect(f.db.prepare("SELECT COUNT(*) AS n FROM implementation_plan_recovery_candidates").get()).toMatchObject({n:0});
  expect((await f.call("claim_item",f.claimArgs)).isError).toBe(true);
  expect(f.db.prepare("SELECT COUNT(*) AS n FROM implementation_plan_approvals").get()).toMatchObject({n:0});
});

it("never makes post-upgrade conversations eligible from chat or supplied approval flags",async()=>{
  const f=await fixture("native",false);
  expect((await f.call("claim_item",{...f.claimArgs,approved:true})).isError).toBe(true);
  expect(f.db.prepare("SELECT COUNT(*) AS n FROM implementation_plan_recovery_candidates").get()).toMatchObject({n:0});
  expect(f.store.getWorkItem(f.item.key).status).toBe("ready");
});

it.each(["plan","decision","new-plan","scope","new-request","node","dispatch","builder","wrong-dispatch","readonly","cross-account"])("rejects changed or unauthorized historical evidence: %s",async(change)=>{
  const f=await fixture();
  if(change==="plan") f.db.prepare("UPDATE agent_session_messages SET text=text||'changed' WHERE source_id='native-plan'").run();
  if(change==="decision") f.db.prepare("UPDATE agent_session_messages SET role='agent' WHERE source_id='native-decision'").run();
  if(change==="new-plan") new AgentSessionStore(f.store.database).recordSnapshot({nodeId:"node",sessionId:f.sessionId,status:"idle",messages:[{sourceId:"new-plan",role:"plan",turnId:"new-turn",text:"A newer plan supersedes the accepted implementation.",occurredAt:new Date().toISOString()}]});
  if(change==="scope") f.db.prepare("UPDATE work_items SET content_version=content_version+1 WHERE id=?").run(f.item.id);
  if(change==="new-request") new ImplementationPlans(f.store.database).request(config.id,"dispatch:original-dispatch","newer-request",{keys:[f.item.key],plan:"Changed proposal",validation:"Changed tests"});
  if(change==="node") f.db.prepare("UPDATE nodes SET revoked_at=? WHERE id='node'").run(new Date().toISOString());
  if(change==="dispatch") f.db.prepare("UPDATE dispatches SET status='cancelled' WHERE id='original-dispatch'").run();
  if(change==="builder") f.db.prepare("UPDATE work_items SET builder_account_id='new-builder' WHERE id=?").run(f.item.id);
  if(change==="cross-account") f.db.prepare("UPDATE dispatches SET account_id='another-owner' WHERE id='original-dispatch'").run();
  const args=change==="wrong-dispatch"?{...f.claimArgs,dispatchId:"unrelated-dispatch"}:f.claimArgs;
  const result=await f.call("claim_item",args,change==="readonly"?f.tokenFor("reader",["missiongo:read"]):undefined);
  expect(result.isError,JSON.stringify(result)).toBe(true);
  expect(f.db.prepare("SELECT COUNT(*) AS n FROM implementation_plan_approvals").get()).toMatchObject({n:0});
  expect(f.db.prepare("SELECT COUNT(*) AS n FROM builder_execution_authorizations").get()).toMatchObject({n:0});
  expect(f.store.getWorkItem(f.item.key).status).toBe("ready");
});

it("keeps the frozen batch on one conversation and rejects a changed member before any approval",async()=>{
  const f=await fixture("native",true,true);
  f.db.prepare("UPDATE work_items SET content_version=content_version+1 WHERE id=?").run(f.items[1]!.id);
  expect((await f.call("claim_item",f.claimArgs)).isError).toBe(true);
  expect(f.db.prepare("SELECT COUNT(*) AS n FROM implementation_plan_approvals").get()).toMatchObject({n:0});
});

it("restores a batch once and claims each original member with its own real credential",async()=>{
  const f=await fixture("native",true,true);
  await f.call("claim_item",f.claimArgs);f.applyMode();
  for(const item of f.items) {
    const claim=await f.call("claim_item",{...f.claimArgs,itemKey:item.key,idempotencyKey:`claim-${item.key}`});
    expect(claim.isError,JSON.stringify(claim)).not.toBe(true);
    expect(claim.structuredContent.executionAuthorization).toEqual(expect.any(String));
  }
  expect(f.db.prepare("SELECT COUNT(*) AS n FROM implementation_plan_recoveries").get()).toMatchObject({n:1});
  expect(f.db.prepare("SELECT COUNT(*) AS n FROM agent_sessions").get()).toMatchObject({n:1});
});

it("preserves the migration snapshot across restart without capturing later evidence",async()=>{
  const f=await fixture();
  const candidate=f.db.prepare("SELECT * FROM implementation_plan_recovery_candidates").get();
  const later=await fixture("native",false);
  for(const entry of [f,later]) {
    await entry.app.close();apps.delete(entry.app);
    const reopened=buildApp(entry.options);apps.add(reopened);
    const rows=reopened.missionGoStore.database.connection.prepare("SELECT * FROM implementation_plan_recovery_candidates").all();
    expect(rows).toEqual(entry===f?[candidate]:[]);
    expect(reopened.missionGoStore.database.connection.prepare("SELECT COUNT(*) AS n FROM implementation_plan_approvals").get()).toMatchObject({n:0});
  }
});

it("keeps cross-client claim credentials isolated after native recovery",async()=>{
  const f=await fixture();await f.call("claim_item",f.claimArgs);f.applyMode();
  const claim=await f.call("claim_item",f.claimArgs);
  expect((await f.call("submit_development_complete",{itemKey:f.item.key,executionAuthorization:claim.structuredContent.executionAuthorization,pullRequestUrl:"https://github.com/example/fixture/pull/1",requiredArtifacts:["web"],idempotencyKey:"other-client-completion"},f.tokenFor("other-client"))).isError).toBe(true);
  expect((await f.call("recover_execution_authorization",{itemKey:f.item.key,dispatchId:"original-dispatch"},f.tokenFor("other-client"))).isError).toBe(true);
  expect(f.store.getWorkItem(f.item.key).status).toBe("in_progress");
  expect(itemExecutionBlockers(f.store.database,f.item.id)).toEqual([]);
});

it("waits for an authenticated idle mode acknowledgement, queues one transparent continuation, then claims normally",async()=>{
  const f=await fixture();
  expect((await f.call('claim_item',f.claimArgs)).structuredContent.claimPending).toBe(true);
  expect((await f.call('claim_item',f.claimArgs)).structuredContent.claimPending).toBe(true);
  const info=(await f.call('get_item_plan_approvals',{itemKey:f.item.key})).structuredContent.sessions[0].formalRecords.records[0];
  expect(info.approval.recovery.resume).toMatchObject({state:'waiting',commandId:null});
  expect((await f.nodeReport({status:'active',turnState:{turnActive:true}})).statusCode).toBe(204);
  expect(f.db.prepare('SELECT COUNT(*) AS n FROM agent_session_commands').get()).toMatchObject({n:0});
  expect((await f.nodeReport({turnState:{turnActive:false}})).statusCode).toBe(204);
  expect(f.db.prepare('SELECT COUNT(*) AS n FROM agent_session_commands').get()).toMatchObject({n:0});
  const {settings_revision:revision}=f.db.prepare('SELECT settings_revision FROM agent_sessions WHERE id=?').get(f.sessionId) as {settings_revision:number};
  const posted=await f.nodeReport({settingsRevision:revision,turnState:{turnActive:false}});
  expect(posted.statusCode,posted.body).toBe(204);
  expect((await f.nodeReport({settingsRevision:revision,turnState:{turnActive:false}})).statusCode).toBe(204);
  const command=f.db.prepare('SELECT id,text FROM agent_session_commands').get()!;
  expect(command.text).toContain('系统续办');expect(command.text).toContain('不是新的人工批准');
  expect(f.db.prepare('SELECT COUNT(*) AS n FROM agent_session_commands').get()).toMatchObject({n:1});
  expect(f.db.prepare('SELECT state,command_id FROM implementation_plan_recovery_resumes').get()).toMatchObject({state:'queued',command_id:command.id});
  expect(f.db.prepare('SELECT COUNT(*) AS n FROM builder_execution_authorizations').get()).toMatchObject({n:0});
  expect(f.store.getWorkItem(f.item.key).status).toBe('ready');
  const claim=await f.call('claim_item',f.claimArgs);
  expect(claim.isError,JSON.stringify(claim)).not.toBe(true);
  expect(claim.structuredContent).toMatchObject({item:{status:'in_progress'},executionAuthorization:expect.any(String)});
});

it.each(['active','settings-error','source-error','permission','new-input','new-request','archive','stop','builder','taken','pending-reply','tool-permission'])("does not resume over the %s boundary",async(boundary)=>{
  const f=await fixture();await f.call('claim_item',f.claimArgs);
  const sessions=new AgentSessionStore(f.store.database);
  f.applyMode();
  if(boundary==='permission') f.app.missionGoAccounts.replacePermissions(config.id,[{productId:f.product.id,canView:true,canOperate:true,canUseAi:false}]);
  if(boundary==='new-input') sessions.recordSnapshot({nodeId:'node',sessionId:f.sessionId,status:'idle',messages:[{sourceId:'user-steering',role:'user',turnId:'new-user-turn',text:'Pause this work.',occurredAt:new Date().toISOString()}]});
  if(boundary==='new-request') new ImplementationPlans(f.store.database).request(config.id,'dispatch:original-dispatch','replacement',{keys:[f.item.key],plan:'Replacement plan requiring review',validation:'Replacement tests'});
  if(boundary==='archive') {sessions.setArchived(config.id,f.sessionId,true);sessions.setArchived(config.id,f.sessionId,false);}
  if(boundary==='stop') sessions.enqueueInterrupt(config.id,f.sessionId);
  if(boundary==='builder') f.db.prepare("UPDATE work_items SET builder_account_id='new-owner' WHERE id=?").run(f.item.id);
  if(boundary==='taken') await f.call('claim_item',f.claimArgs);
  if(boundary==='pending-reply') sessions.enqueue(config.id,f.sessionId,'Existing explicit input');
  if(boundary==='tool-permission') {
    const {AgentApprovalStore}=await import('./agent-approval-store.js');
    new AgentApprovalStore(f.store.database).record('node',f.sessionId,{id:'permission',kind:'manual',status:'pending',turnId:'tool-turn',action:'Review a tool request',startedAtMs:Date.now()});
  }
  const revision=(f.db.prepare('SELECT settings_revision FROM agent_sessions WHERE id=?').get(f.sessionId) as {settings_revision:number}).settings_revision;
  const before=(f.db.prepare('SELECT COUNT(*) AS n FROM agent_session_commands').get() as {n:number}).n;
  const result=await f.nodeReport(boundary==='active'?{status:'active',turnState:{turnActive:true}}:boundary==='settings-error'?{settingsRevision:revision,settingsError:'Native mode not confirmed',turnState:{turnActive:false}}:boundary==='source-error'?{error:'Native synchronization failed',turnState:{turnActive:false}}:{turnState:{turnActive:false}});
  expect(result.statusCode,result.body).toBe(204);
  expect(f.db.prepare('SELECT COUNT(*) AS n FROM agent_session_commands').get()).toMatchObject({n:before});
  if(['permission','new-input','new-request','archive','stop','builder','taken'].includes(boundary)) expect(f.db.prepare('SELECT state FROM implementation_plan_recovery_resumes').get()).toMatchObject({state:'cancelled'});
});

it("never resends a cancelled continuation",async()=>{
  const f=await fixture();await f.call('claim_item',f.claimArgs);f.applyMode();
  await f.nodeReport({turnState:{turnActive:false}});
  const command=f.db.prepare('SELECT id FROM agent_session_commands').get() as {id:string};
  new AgentSessionStore(f.store.database).cancel(config.id,f.sessionId,command.id);
  await f.nodeReport({turnState:{turnActive:false}});
  expect(f.db.prepare('SELECT COUNT(*) AS n FROM agent_session_commands').get()).toMatchObject({n:1});
  expect(f.db.prepare('SELECT state FROM implementation_plan_recovery_resumes').get()).toMatchObject({state:'cancelled'});
});

it("does not arm a recovered native decision from another OAuth client",async()=>{
  const f=await fixture();await f.call('claim_item',f.claimArgs);
  f.db.prepare('DELETE FROM implementation_plan_recovery_resumes').run();
  expect((await f.call('claim_item',f.claimArgs,f.tokenFor('another-client'))).isError).toBe(true);
  expect(f.db.prepare('SELECT COUNT(*) AS n FROM implementation_plan_recovery_resumes').get()).toMatchObject({n:0});
});

it("keeps original dispatch scope validation for ordinary plan requests",async()=>{
  const f=await fixture('native',false);
  const result=await f.call('request_plan_approval',{itemKeys:[f.item.key],dispatchId:'missing-dispatch',plan:'Do not accept an unrelated dispatch.',validation:'Check original ownership.',approvalMethod:'web'});
  expect(result.isError).toBe(true);
  expect(f.db.prepare("SELECT 1 FROM implementation_plan_requests WHERE identity_key='dispatch:missing-dispatch'").get()).toBeUndefined();
  expect(f.db.prepare('SELECT COUNT(*) AS n FROM implementation_plan_recovery_resumes').get()).toMatchObject({n:0});
});

it("requires the authenticated original node, and keeps a waiting continuation across server restart",async()=>{
  const f=await fixture();await f.call('claim_item',f.claimArgs);
  const denied=await f.app.inject({method:'POST',url:`/api/v1/node/agent-sessions/${f.sessionId}/snapshot`,headers:{authorization:'Bearer untrusted-node'},payload:{status:'idle',messages:[],settingsRevision:999}});
  expect(denied.statusCode).toBe(401);
  expect(f.db.prepare('SELECT COUNT(*) AS n FROM agent_session_commands').get()).toMatchObject({n:0});
  f.db.prepare("UPDATE nodes SET token_hash=? WHERE id='node'").run(createHash('sha256').update('fixture-node-token').digest('hex'));
  const revision=(f.db.prepare('SELECT settings_revision FROM agent_sessions WHERE id=?').get(f.sessionId) as {settings_revision:number}).settings_revision;
  await f.app.close();apps.delete(f.app);
  const reopened=buildApp(f.options);apps.add(reopened);
  const report=()=>reopened.inject({method:'POST',url:`/api/v1/node/agent-sessions/${f.sessionId}/snapshot`,headers:{authorization:'Bearer fixture-node-token'},payload:{status:'idle',messages:[],settingsRevision:revision,turnState:{turnActive:false}}});
  expect((await report()).statusCode).toBe(204);expect((await report()).statusCode).toBe(204);
  expect(reopened.missionGoStore.database.connection.prepare('SELECT state FROM implementation_plan_recovery_resumes').get()).toMatchObject({state:'queued'});
  expect(reopened.missionGoStore.database.connection.prepare('SELECT COUNT(*) AS n FROM agent_session_commands').get()).toMatchObject({n:1});
});
