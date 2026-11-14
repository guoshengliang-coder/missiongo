import { afterEach, expect, it, vi } from "vitest";
import { buildApp } from "./app.js";
import { createAiAccessToken, hashPassword } from "./admin-auth.js";
import { AgentSessionStore, type AgentSessionMessageInput } from "./agent-session-store.js";
import { AgentHistory } from "./agent-history.js";
import { AgentArtifacts } from "./agent-artifacts.js";
import { PlanDocuments } from "./plan-documents.js";
import { ImplementationPlans, planDigest } from "./implementation-plans.js";
import { DocumentPlanApprovals } from "./document-plan-approval.js";

const apps:ReturnType<typeof buildApp>[]=[];
afterEach(async()=>{await Promise.all(apps.splice(0).map(a=>a.close()));});
async function fixture(kind="codex") {
  const config={id:"owner",username:"owner@example.test",passwordScrypt:hashPassword("fixture-password"),sessionSecret:"synthetic-document-approval-secret",cookieSecure:false};
  const app=buildApp({adminAccount:config,writeTools:"comments"});
  apps.push(app);
  const store=app.missionGoStore,db=store.database.connection;
  const product=store.createProduct({name:"Document fixture",keyPrefix:"DP"});
  const item=store.createWorkItem({productId:product.id,title:"Review",description:"Boundary",type:"task",priority:"normal",status:"ready",environment:{platform:"web"}});
  const now=new Date().toISOString();
  db.prepare(`INSERT INTO nodes(id,account_id,installation_id,name,token_hash,agents_json,last_seen_at,created_at,updated_at)
    VALUES ('node','owner','fixture','Fixture','synthetic','[]',?,?,?)`).run(now,now,now);
  db.prepare(`INSERT INTO dispatches(id,account_id,node_id,agent_kind,mode,status,repo_path,created_at)
    VALUES ('dispatch','owner','node',?,'auto','launched','synthetic-repo',?)`).run(kind,now);
  db.prepare("INSERT INTO dispatch_items(dispatch_id,item_id,position) VALUES ('dispatch',?,0)").run(item.id);
  const sessions=new AgentSessionStore(store.database),id=sessions.createForDispatch({dispatchId:"dispatch",nodeId:"node",sessionRef:"original-thread"});
  vi.useFakeTimers({toFake:["Date"]});vi.setSystemTime(new Date(Date.now()-5000));
  const document=new PlanDocuments(store).prepare({accountId:"owner",identity:"dispatch:dispatch",keys:[item.key],summary:"Repair the reviewed failure",markdown:"Repair the reviewed failure\n\nKeep the original scope.",origin:"https://fixture.test",requestKey:"document"});
  const plans=new ImplementationPlans(store.database),revision=planDigest([document.identity,plans.scope(document.keys),document.plan,""]);
  plans.request("owner",document.identity,revision,{keys:document.keys,documentId:document.id,plan:document.plan,validation:""});
  vi.useRealTimers();
  const base=Date.now()-3000;
  const messages:AgentSessionMessageInput[]=[{sourceId:"display",turnId:"planning-turn",role:"agent",phase:"final_answer",text:document.plan+"\n\n[Review](https://fixture.test/?console=agent)",occurredAt:new Date(base).toISOString()},
    {sourceId:"decision",turnId:"implementation-turn",role:"user",text:"批准",occurredAt:new Date(base+1000).toISOString()}];
  const history=new AgentHistory(store.database,new AgentArtifacts(store.database,""));
  const report=(input=messages,complete=true)=>{sessions.recordSnapshot({nodeId:"node",sessionId:id,status:"idle",messages:input});
    history.observe("owner","node",id,complete?{complete:true}:{complete:false,error:"unsupported"});};
  const service=new DocumentPlanApprovals(store.database);
  const recover=(key="recover")=>service.recover("owner",id,document.id,revision,key);
  const login=await app.inject({method:"POST",url:"/api/v1/auth/login",payload:{username:"owner@example.test",password:"fixture-password"}});
  const headers={cookie:login.headers["set-cookie"]!.toString().split(";")[0]!};
  const account=app.missionGoAccounts.getAccount("owner");
  const token=createAiAccessToken(config,{id:account.id,username:account.email,role:account.role},app.missionGoAccounts.credentialsStamp(account),"fixture-client",["missiongo:read","missiongo:write"]).token;
  const call=async(args:Record<string,unknown>)=>{
    const response=await app.inject({method:"POST",url:"/mcp",headers:{authorization:`Bearer ${token}`,accept:"application/json, text/event-stream"},
      payload:{jsonrpc:"2.0",id:1,method:"tools/call",params:{name:"recover_plan_approval",arguments:args}}});
    const raw=response.headers["content-type"]?.includes("text/event-stream")?response.body.split("\n").find(l=>l.startsWith("data: "))!.slice(6):response.body;
    return JSON.parse(raw).result;
  };
  return {app,store,db,item,id,document,revision,plans,sessions,messages,report,history,service,recover,headers,call};
}

it.each(["codex","claude_code","opencode"])("records exact %s document decisions once, without starting another turn",async kind=>{
  const f=await fixture(kind);f.report();
  expect(f.service.inspect("owner",f.id).code).toBe("ready_to_restore");
  expect(f.plans.proposal("owner",f.document.identity)?.approved).toBe(false); // inspection is read only
  expect(f.recover().code).toBe("restored");
  expect(f.recover().code).toBe("already_approved");
  expect(f.plans.proposal("owner",f.document.identity)).toMatchObject({approved:true,documentId:f.document.id});
  const audit=f.db.prepare("SELECT display_source_id,acceptance_source_id,accepted_at FROM document_plan_decisions").get();
  expect(audit).toMatchObject({display_source_id:"display",acceptance_source_id:"decision",accepted_at:f.messages[1]!.occurredAt});
  expect(f.db.prepare("SELECT COUNT(*) AS n FROM document_plan_decisions").get()).toMatchObject({n:1});
  expect(f.db.prepare("SELECT COUNT(*) AS n FROM agent_session_commands").get()).toMatchObject({n:0});
  expect(()=>f.db.prepare("UPDATE document_plan_decisions SET accepted_at='changed'").run()).toThrow(/immutable/);
});

it.each(["好","继续","批准？","不批准","如果通过就批准",'引用：“批准”'])("does not classify %s as a decision",async text=>{
 const f=await fixture();f.report([f.messages[0]!,{...f.messages[1]!,text}]);
 expect(f.recover().code).toBe("evidence_missing");
 expect(f.plans.canImplement("owner",f.document.identity)).toBe(false);
});

it.each(["commentary","wrong-document","truncated","same-turn","before-display","new-requirement","multi-plan","changed-suffix"])("rejects ambiguous evidence: %s",async change=>{
 const f=await fixture();const messages=f.messages.map(m=>({...m}));
 if(change==="commentary")messages[0]!.phase="commentary";
 if(change==="wrong-document")messages[0]!.text=messages[0]!.text.replace(f.document.id,"00000000-0000-4000-8000-000000000000");
 if(change==="truncated")messages[0]!.text=f.document.plan.slice(0,-10);
 if(change==="same-turn")messages[1]!.turnId=messages[0]!.turnId;
 if(change==="before-display")messages[1]!.occurredAt=messages[0]!.occurredAt;
 if(change==="new-requirement")messages.splice(1,0,{sourceId:"new-requirement",role:"user",text:"Change the implementation",occurredAt:new Date(Date.parse(messages[0]!.occurredAt!)+500).toISOString()});
 if(change==="changed-suffix")messages[0]!.text+="\nAlso change the scope before implementing.";
 if(change==="multi-plan")messages[0]!.text+="\n[Other](https://fixture.test/?planDocument=00000000-0000-4000-8000-000000000000)";
 f.report(messages);expect(f.recover().code).toBe("evidence_missing");
});

it("keeps incomplete history, old scopes, wrong identities and stale revisions unapproved",async()=>{
 const f=await fixture();f.report(f.messages,false);
 expect(f.recover().code).toBe("history_incomplete");
 f.report();expect(f.service.inspect("outsider",f.id).code).toBe("identity_unavailable");
 expect(f.service.recover("owner",f.id,f.document.id,"old-revision","wrong").code).toBe("scope_changed");
 f.db.prepare("UPDATE work_items SET content_version=content_version+1 WHERE id=?").run(f.item.id);
 expect(f.recover().code).toBe("scope_changed");
 expect(f.db.prepare("SELECT COUNT(*) AS n FROM implementation_plan_approvals").get()).toMatchObject({n:0});
});

it("recovers authenticated cached history explicitly; completing or reading history never approves",async()=>{
 const f=await fixture();f.report([],false);
 f.history.observe("owner","node",f.id,{complete:false,cursor:"source-page"});
 const cursor=f.history.available("owner",f.id).nextCursor!;
 f.history.request("owner",f.id,cursor);
 f.history.complete("owner","node",cursor,{messages:f.messages});
 expect(f.service.inspect("owner",f.id).code).toBe("ready_to_restore");
 expect(f.plans.canImplement("owner",f.document.identity)).toBe(false);
 expect(f.recover().code).toBe("restored");
});

it("rejects conflicting mirrors and revoked nodes",async()=>{
 const f=await fixture();f.report();
 f.history.observe("owner","node",f.id,{complete:false,cursor:"conflict"});
 const cursor=f.history.available("owner",f.id).nextCursor!;f.history.request("owner",f.id,cursor);
 f.history.complete("owner","node",cursor,{messages:[{...f.messages[1]!,text:"Not an approval"}]});
 expect(f.recover().code).toBe("source_conflict");
 f.db.prepare("UPDATE nodes SET revoked_at=? WHERE id='node'").run(new Date().toISOString());
 expect(f.recover().code).toBe("identity_unavailable");
});

it("HTTP recovery is distinct from reading, preserves an existing Web approval and checks exact scope",async()=>{
 const f=await fixture();f.report();
 const detail=await f.app.inject({url:`/api/v1/agent-sessions/${f.id}`,headers:f.headers});
 expect(detail.json()).toMatchObject({documentPlanApproval:{code:"ready_to_restore"},implementationPlan:{approved:false}});
 const url=`/api/v1/agent-sessions/${f.id}/plan-approval/recover`;
 const payload={documentId:f.document.id,revision:f.revision,requestKey:"http-recover"};
 expect((await f.app.inject({method:"POST",url,payload})).statusCode).toBe(401);
 const response=await f.app.inject({method:"POST",url,headers:f.headers,payload});
 expect(response.statusCode,response.body).toBe(200);expect(response.json().code).toBe("restored");
 const records=(await f.app.inject({url:`/api/v1/agent-sessions/${f.id}/plan-records`,headers:f.headers})).json();
 expect(records.records[0].approval.documentDecision).toMatchObject({acceptedAt:f.messages[1]!.occurredAt,displaySourceId:"display",acceptanceSourceId:"decision"});
 expect((await f.app.inject({method:"POST",url,headers:f.headers,payload})).json().code).toBe("already_approved");
 expect(f.db.prepare("SELECT COUNT(*) AS n FROM agent_session_commands").get()).toMatchObject({n:0});
});

it("MCP recovery requires the original dispatch and cannot accept a caller's approval assertion",async()=>{
 const f=await fixture();f.report();
 const args={itemKey:f.item.key,dispatchId:"dispatch",documentId:f.document.id,revision:f.revision,idempotencyKey:"mcp-recover"};
 expect((await f.call({...args,approved:true})).isError).toBe(true);
 expect((await f.call({...args,dispatchId:"unrelated"})).isError).toBe(true);
 expect((await f.call(args)).structuredContent).toMatchObject({code:"restored",documentId:f.document.id});
 expect((await f.call(args)).structuredContent.code).toBe("already_approved");
});

it("does not overwrite a Web decision or change its queued continuation on recovery",async()=>{
 const f=await fixture();f.report();
 f.plans.record({accountId:"owner",identity:f.document.identity,revision:f.revision,planHash:f.revision,keys:f.document.keys,source:"web",plan:f.document.plan});
 expect(f.recover().code).toBe("already_approved");
 expect(f.db.prepare("SELECT source FROM implementation_plan_approvals").get()).toMatchObject({source:"web"});
 expect(f.db.prepare("SELECT COUNT(*) AS n FROM document_plan_decisions").get()).toMatchObject({n:0});
});

it("authenticates live node reports before synchronizing a document decision",async()=>{
 const f=await fixture();
 const {createHash}=await import("node:crypto");
 f.db.prepare("UPDATE nodes SET token_hash=? WHERE id='node'").run(createHash("sha256").update("synthetic-original-node-token").digest("hex"));
 const payload={status:"idle",messages:f.messages,history:{complete:true}};
 const url=`/api/v1/node/agent-sessions/${f.id}/snapshot`;
 expect((await f.app.inject({method:"POST",url,payload})).statusCode).toBe(401);
 const response=await f.app.inject({method:"POST",url,headers:{"x-missiongo-node-id":"node",authorization:"Bearer synthetic-original-node-token"},payload});
 expect(response.statusCode,response.body).toBe(204);
 expect(f.plans.canImplement("owner",f.document.identity)).toBe(true);
 expect(f.db.prepare("SELECT COUNT(*) AS n FROM agent_session_commands").get()).toMatchObject({n:0});
});

it.each(["codex","claude_code","opencode"])("uses the original external %s binding and rejects another OAuth client",async kind=>{
 const f=await fixture();
 const {ExternalAgentSessionStore}=await import("./external-agent-session-store.js");
 const sessions=new ExternalAgentSessionStore(f.store);
 const identity={agentKind:kind as "codex"|"claude_code"|"opencode",refKind:"native" as const,sessionRef:"external-thread"};
 const id=sessions.prepareApproval({accountId:"owner",clientId:"fixture-client"},identity,[f.item.key],"external-setup");
 f.db.prepare("UPDATE external_agent_sessions SET native_node_id='node',native_generation=1 WHERE id=?").run(id);
 vi.useFakeTimers({toFake:["Date"]});vi.setSystemTime(new Date(Date.now()-5000));
 const document=new PlanDocuments(f.store).prepare({accountId:"owner",identity:`native:fixture-client:${kind}:native:external-thread`,keys:[f.item.key],summary:"External exact plan",markdown:"External exact plan\n\nScope",origin:"https://fixture.test",requestKey:"external-doc"});
 const revision=planDigest([document.identity,f.plans.scope(document.keys),document.plan,""]);
 f.plans.request("owner",document.identity,revision,{keys:document.keys,plan:document.plan,validation:"",documentId:document.id});
 vi.useRealTimers();
 for(const [position,message] of f.messages.map(m=>m.role==="agent"?{...m,text:document.plan}:m).entries())
  f.db.prepare("INSERT INTO external_native_messages(id,session_id,source_id,payload_json,position) VALUES (?,?,?,?,?)")
   .run(`external-${position}`,id,message.sourceId,JSON.stringify(message),position);
 const {observeMessageTimes}=await import("./session-message-clock.js");
 observeMessageTimes(f.db,`external:${id}`,f.messages);
 f.history.observe("owner","node",id,{complete:true});
 const args={itemKey:f.item.key,sessionId:id,documentId:document.id,revision,idempotencyKey:"external-recovery"};
 expect((await f.call(args)).structuredContent.code).toBe("restored");
 const other=sessions.prepareApproval({accountId:"owner",clientId:"other-client"},{...identity,sessionRef:"other-client-thread"},[f.item.key],"other-setup");
 expect((await f.call({...args,sessionId:other})).isError).toBe(true);
 expect(f.db.prepare("SELECT COUNT(*) AS n FROM external_native_commands").get()).toMatchObject({n:0});
});


it("does not use a stored receipt-time fallback as the original decision time",async()=>{
 const f=await fixture();f.report();
 f.db.prepare("DELETE FROM session_message_times WHERE source_id='native:decision'").run();
 expect(f.recover().code).toBe("history_incomplete");
 expect(f.plans.canImplement("owner",f.document.identity)).toBe(false);
});

it.each(["display-question","intervening-question"])("does not reuse a form answer as document approval: %s",async mode=>{
 const f=await fixture();const messages=f.messages.map(m=>({...m}));
 const questions=[{title:"Allow the diagnostic command?",options:["批准","拒绝"]}];
 if(mode==="display-question")messages[0]={...messages[0]!,questions};
 else messages.splice(1,0,{sourceId:"permission",role:"agent",phase:"commentary",text:"Command permission",questions,
   occurredAt:new Date(Date.parse(messages[0]!.occurredAt!)+500).toISOString()});
 f.report(messages);
 expect(f.recover().code).toBe("evidence_missing");
 expect(f.plans.canImplement("owner",f.document.identity)).toBe(false);
});

it.each(["multibyte-text","question-data"])("bounds source evidence before loading it: %s",async mode=>{
 const f=await fixture();f.report();
 if(mode==="multibyte-text")f.db.prepare("UPDATE agent_session_messages SET text=? WHERE session_id=? AND source_id='display'")
   .run("中".repeat(12*1024*1024),f.id);
 else f.db.prepare("UPDATE agent_session_messages SET questions_json=? WHERE session_id=? AND source_id='display'")
   .run(JSON.stringify([{title:"x".repeat(33*1024*1024)}]),f.id);
 expect(f.recover().code).toBe("history_incomplete");
 expect(f.plans.canImplement("owner",f.document.identity)).toBe(false);
});


it("accepts the known navigation/status footer without granting its text as extra scope",async()=>{
 const f=await fixture();
 f.report([{...f.messages[0]!,text:f.document.plan+"\n\n[审阅并批准实施方案](https://fixture.test/?console=agent)\n\n方案已保存并完整回读，当前尚未批准、未修改产品代码。依 [missiongo Skill](/fixture/SKILL.md)“选择不等于批准”，等待本批方案的一次明确实施批准。"},f.messages[1]!]);
 expect(f.recover().code).toBe("restored");
});

it.each(["archive","dispatch-revoked","builder-changed"])("does not restore across %s authority boundaries",async action=>{
 const f=await fixture();f.report();
 if(action==="archive")f.sessions.setArchived("owner",f.id,true);
 if(action==="dispatch-revoked") {
   const now=new Date().toISOString();
   f.db.prepare("INSERT INTO builder_handovers(id,item_id,initiated_by,note,status,created_at,updated_at) VALUES ('fixture',?,'owner','','completed',?,?)").run(f.item.id,now,now);
   f.db.prepare("INSERT INTO builder_revoked_dispatches(dispatch_id,handover_id) VALUES ('dispatch','fixture')").run();
 }
 if(action==="builder-changed")f.db.prepare("UPDATE work_items SET builder_account_id='other-owner' WHERE id=?").run(f.item.id);
 expect(f.recover().code).toBe("identity_unavailable");
 expect(f.plans.canImplement("owner",f.document.identity)).toBe(false);
});
