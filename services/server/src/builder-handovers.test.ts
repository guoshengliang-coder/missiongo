import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "./app.js";
import { createAiAccessToken, hashPassword } from "./admin-auth.js";
import { DispatchStore } from "./dispatch-store.js";
import { AgentSessionStore } from "./agent-session-store.js";
import { BuilderHandovers } from "./builder-handovers.js";
import { StatusChecks } from "./status-checks.js";
import { ExternalAgentSessionStore } from "./external-agent-session-store.js";
import type { FastifyInstance } from "fastify";

const apps: FastifyInstance[] = [];
const password = "synthetic handover password", passwordScrypt = hashPassword(password);
afterEach(async()=>{ await Promise.all(apps.splice(0).map(app=>app.close())); });
async function fixture() {
  const config={id:"admin",username:"admin@example.com",passwordScrypt,sessionSecret:"synthetic-builder-handover-secret",cookieSecure:false};
  const app = buildApp({adminAccount:config,writeTools:"comments"});
  apps.push(app);
  const store=app.missionGoStore, accounts=app.missionGoAccounts, db=store.database.connection;
  const a=accounts.createAccount({email:"a@example.com",password,role:"member"});
  const b=accounts.createAccount({email:"b@example.com",password,role:"member"});
  const product=store.createProduct({name:"Handover",keyPrefix:"HO",createdByAccountId:"admin"});
  for (const account of [a,b]) accounts.replacePermissions(account.id,[{productId:product.id,canView:true,canOperate:true,canUseAi:true}]);
  const login=async(username:string)=> (await app.inject({method:"POST",url:"/api/v1/auth/login",payload:{username,password}})).headers["set-cookie"]!.toString().split(";")[0]!;
  const aCookie=await login(a.email),bCookie=await login(b.email),adminCookie=await login("admin@example.com");
  const dispatches=new DispatchStore(store.database), sessions=new AgentSessionStore(store.database), handovers=new BuilderHandovers(store);
  const node=(accountId:string)=>{
    const node=dispatches.registerNode({accountId,installationId:randomUUID(),name:"Test node"});
    dispatches.recordHeartbeat(node.nodeId,[{kind:"opencode",ready:true}]);
    dispatches.replaceOwnRepos(node.nodeId,[{productId:product.id,repoPath:"/synthetic/repo"}]);
    return node;
  };
  const aNode=node(a.id),bNode=node(b.id);
  const item=()=>store.createWorkItem({productId:product.id,status:"ready",environment:{platform:"shared"},type:"task",priority:"normal",title:"Handover task",description:"Work"});
  const dispatch=(keys:string[],accountId=a.id,nodeId=aNode.nodeId,force=false)=>dispatches.createDispatch({accountId,nodeId,agentKind:"opencode",mode:"default",itemKeys:keys,force});
  const launch=(keys:string[])=>{
    const d=dispatch(keys);
    dispatches.claimNextDispatch(aNode.nodeId);
    dispatches.recordDispatchResult({nodeId:aNode.nodeId,dispatchId:d.id,status:"launched"});
    const sessionId=sessions.createForDispatch({dispatchId:d.id,nodeId:aNode.nodeId,sessionRef:randomUUID()});
    sessions.recordSnapshot({nodeId:aNode.nodeId,sessionId,status:"active",messages:[],turnState:{turnActive:true}});
    return {d,sessionId};
  };
  const start=(key:string,actor="human" as "human"|"agent",accountId=a.id)=>actor === "human"
    ? store.transitionWorkItem({itemKey:key,to:"in_progress",actor,reason:"claim",attribution:{accountId}})
    : store.claimWorkItem({itemKey:key,agentId:"Test agent",attribution:{accountId},idempotencyKey:randomUUID()});
  const transfer=(key:string,target=b.id,expected:string|null=a.id)=>handovers.start(key,a.id,target,expected,"Transfer delivery");
  const stopCommand=(dispatchId:string)=>(db.prepare("SELECT stop_command_id FROM builder_revoked_dispatches WHERE dispatch_id=?").get(dispatchId) as {stop_command_id:string}).stop_command_id;
  const snapshot=(sessionId:string,commandId:string,status:"active"|"idle"|"unavailable"="idle",commandStatus:"delivered"|"failed"="delivered")=>{
    sessions.recordSnapshot({nodeId:aNode.nodeId,sessionId,status,messages:[],turnState:{turnActive:status === "active"},commandId,commandStatus});
    handovers.forSession(sessionId);
  };
  const mcp=async(account:typeof a,name:string,args:Record<string,unknown>,clientId="handover-test-client")=>{
    const token=createAiAccessToken(config,{id:account.id,username:account.email,role:account.role},accounts.credentialsStamp(account),clientId,["missiongo:read","missiongo:write"]).token;
    const response=await app.inject({method:"POST",url:"/mcp",headers:{authorization:`Bearer ${token}`,accept:"application/json, text/event-stream"},
      payload:{jsonrpc:"2.0",id:1,method:"tools/call",params:{name,arguments:args}}});
    const payload=response.headers["content-type"]?.includes("text/event-stream")
      ? response.body.split("\n").find(line=>line.startsWith("data: "))!.slice(6) : response.body;
    return JSON.parse(payload).result as {isError?:boolean;structuredContent?:Record<string,unknown>};
  };
  return {app,mcp,store,accounts,db,a,b,product,aCookie,bCookie,adminCookie,dispatches,sessions,handovers,aNode,bNode,item,dispatch,launch,start,transfer,stopCommand,snapshot};
}

describe("Builder execution handover",()=>{
  it.each(["human","agent"] as const)("atomically assigns the first %s starter and never overwrites an existing Builder",async actor=>{
    const f=await fixture(),item=f.item();
    const started=f.start(item.key,actor);
    expect(started).toMatchObject({status:"in_progress",builderAccountId:f.a.id});
    expect(()=>f.start(item.key,actor,f.b.id)).toThrow();
    expect(f.store.getWorkItem(item.key).builderAccountId).toBe(f.a.id);
    expect(f.store.getTimeline(item.key).filter(e=>e.eventType==="builder_changed")).toHaveLength(1);
    const assigned=f.item();f.handovers.start(assigned.key,"admin",f.b.id,null,"Assign delivery");
    expect(f.start(assigned.key,actor,f.b.id).builderAccountId).toBe(f.b.id);
  });
  it("does not assign a Builder when the start transition fails",async()=>{
    const f=await fixture(),item=f.store.createWorkItem({productId:f.product.id,type:"task",priority:"normal",title:"Draft",description:"Work"});
    expect(()=>f.start(item.key,"agent")).toThrow();
    expect(f.store.getWorkItem(item.key).builderAccountId).toBeUndefined();
  });
  it("waits for actual stop acknowledgement, preserves state, fences late writes and lets only the new Builder take over",async()=>{
    const f=await fixture(),item=f.item(),{d,sessionId}=f.launch([item.key]);f.start(item.key);
    expect(f.transfer(item.key)).toMatchObject({status:"in_progress",builderAccountId:f.a.id,builderHandover:{status:"stopping"}});
    const command=f.stopCommand(d.id);expect(command).toBeTruthy();
    expect(()=>f.sessions.enqueue(f.a.id,sessionId,"Continue")).toThrow();
    expect(()=>f.dispatches.recordDispatchResult({nodeId:f.aNode.nodeId,dispatchId:d.id,status:"launched"})).toThrow();
    expect(()=>f.store.submitDevelopmentComplete({itemKey:item.key,completion:{kind:"commit",commit:"a".repeat(40),targetBranch:"main"},attribution:{accountId:f.a.id},idempotencyKey:randomUUID()})).toThrow();
    f.snapshot(sessionId,command,"active");
    expect(f.store.getWorkItem(item.key).builderHandover?.status).toBe("stopping");
    f.snapshot(sessionId,command);
    expect(f.store.getWorkItem(item.key)).toMatchObject({status:"in_progress",builderAccountId:f.b.id,builderHandover:{status:"completed",canTakeOver:true}});
    expect(()=>f.dispatch([item.key],f.a.id,f.aNode.nodeId,true)).toThrow();
    const next=f.dispatch([item.key],f.b.id,f.bNode.nodeId);
    f.dispatches.claimNextDispatch(f.bNode.nodeId);
    const claimed=f.store.claimWorkItem({itemKey:item.key,agentId:"New agent",dispatchId:next.id,attribution:{accountId:f.b.id},idempotencyKey:randomUUID()});
    expect(claimed).toMatchObject({status:"in_progress",builderAccountId:f.b.id,builderHandover:{canTakeOver:false}});
    expect(()=>f.store.claimWorkItem({itemKey:item.key,agentId:"Old agent",dispatchId:d.id,attribution:{accountId:f.a.id},idempotencyKey:randomUUID()})).toThrow();
    expect(()=>f.dispatch([item.key],f.b.id,f.bNode.nodeId,true)).toThrow();
  });
  it("cancels an old queued single-item dispatch through the authorized transfer, without launching anything",async()=>{
    const f=await fixture(),item=f.item(),d=f.dispatch([item.key]);
    const result=f.transfer(item.key,f.b.id,null);
    expect(result).toMatchObject({status:"ready",builderAccountId:f.b.id,builderHandover:{status:"completed"}});
    expect(f.dispatches.getDispatch(f.a.id,d.id).status).toBe("cancelled");
    expect(f.dispatches.claimNextDispatch(f.aNode.nodeId)).toBeUndefined();
  });
  it("does not automatically retry after offline or stop failure; only an authorized retry can complete it",async()=>{
    const f=await fixture(),item=f.item(),{d,sessionId}=f.launch([item.key]);f.start(item.key);
    f.db.prepare("UPDATE nodes SET last_seen_at=NULL WHERE id=?").run(f.aNode.nodeId);
    const blocked=f.transfer(item.key);
    expect(blocked.builderHandover).toMatchObject({status:"blocked"});
    expect(f.stopCommand(d.id)).toBeNull();
    f.dispatches.recordHeartbeat(f.aNode.nodeId,[{kind:"opencode",ready:true}]);
    f.handovers.reconcile(blocked.builderHandover!.id);
    expect(f.store.getWorkItem(item.key).builderHandover?.status).toBe("blocked");
    const url=`/api/v1/items/${item.key}/builder-handover/${blocked.builderHandover!.id}/retry`;
    expect((await f.app.inject({method:"POST",url,headers:{cookie:f.bCookie}})).statusCode).toBe(403);
    expect((await f.app.inject({method:"POST",url,headers:{cookie:f.aCookie}})).statusCode).toBe(200);
    const command=f.stopCommand(d.id);f.snapshot(sessionId,command,"idle","failed");
    expect(f.store.getWorkItem(item.key).builderHandover?.status).toBe("blocked");
    f.handovers.retry(item.key,blocked.builderHandover!.id);
    const retryCommand=f.stopCommand(d.id);expect(retryCommand).not.toBe(command);
    f.snapshot(sessionId,retryCommand);
    expect(f.store.getWorkItem(item.key).builderAccountId).toBe(f.b.id);
  });
  it("preflights multi-item scopes and rejects forced replacements without any partial cancellation",async()=>{
    const f=await fixture(),one=f.item(),two=f.item(),d=f.dispatch([one.key,two.key]);
    expect(()=>f.transfer(one.key,f.b.id,null)).toThrow(/多条目/);
    expect(()=>f.dispatch([one.key],f.a.id,f.aNode.nodeId,true)).toThrow();
    expect(()=>f.dispatch([one.key,two.key],f.b.id,f.bNode.nodeId,true)).toThrow();
    expect(f.dispatches.getDispatch(f.a.id,d.id).status).toBe("queued");
    expect(f.db.prepare("SELECT COUNT(*) AS count FROM builder_handovers").get()).toMatchObject({count:0});
    expect(f.db.prepare("SELECT COUNT(*) AS count FROM dispatches").get()).toMatchObject({count:1});
  });
  it("refuses even same-account force when an earlier execution already left the queue",async()=>{
    const f=await fixture(),one=f.item();f.dispatch([one.key]);f.dispatches.claimNextDispatch(f.aNode.nodeId);
    expect(()=>f.dispatch([one.key],f.a.id,f.aNode.nodeId,true)).toThrow();
    expect(()=>f.dispatch([one.key],f.b.id,f.bNode.nodeId,false)).toThrow();
  });
  it("blocks uncontrollable external sessions and protects multi-item external scopes before mutation",async()=>{
    const f=await fixture(),one=f.item(),two=f.item(),external=new ExternalAgentSessionStore(f.store);
    const access={accountId:f.a.id,clientId:"test-client"};
    f.start(one.key);
    const id=external.register(access,{agentKind:"codex",sessionRef:randomUUID(),refKind:"tracking"},one.key);
    expect(f.transfer(one.key).builderHandover).toMatchObject({status:"blocked",reason:expect.stringContaining("外部会话")});
    f.start(two.key);
    const other=external.register(access,{agentKind:"codex",sessionRef:randomUUID(),refKind:"tracking"},two.key);
    const three=f.item();f.start(three.key);
    external.register(access,{agentKind:"codex",sessionRef:(f.db.prepare("SELECT session_ref FROM external_agent_sessions WHERE id=?").get(other) as {session_ref:string}).session_ref,refKind:"tracking"},three.key);
    expect(()=>f.transfer(two.key,f.b.id,f.a.id)).toThrow(/多条目/);
    expect(id).toBeTruthy();
  });
  it("validates operate and AI permissions before any change, and detects a stale concurrent transfer",async()=>{
    const f=await fixture(),item=f.item(),d=f.dispatch([item.key]);
    f.accounts.replacePermissions(f.b.id,[{productId:f.product.id,canView:true,canOperate:false,canUseAi:true}]);
    expect(()=>f.transfer(item.key,f.b.id,null)).toThrow(/操作权限/);
    expect(f.dispatches.getDispatch(f.a.id,d.id).status).toBe("queued");
    expect(()=>f.transfer(item.key,f.a.id,"stale-owner")).toThrow();
    expect(f.db.prepare("SELECT COUNT(*) AS count FROM builder_handovers").get()).toMatchObject({count:0});
  });
  it("does not cancel an earlier queue when a different item in the forced batch is invalid",async()=>{
    const f=await fixture(),one=f.item(),two=f.item(),old=f.dispatch([one.key]);f.start(two.key);
    expect(()=>f.dispatch([one.key,two.key],f.a.id,f.aNode.nodeId,true)).toThrow();
    expect(f.dispatches.getDispatch(f.a.id,old.id).status).toBe("queued");
    expect(f.db.prepare("SELECT COUNT(*) AS count FROM dispatches").get()).toMatchObject({count:1});
    expect(f.store.getWorkItem(one.key).builderAccountId).toBeUndefined();
  });
  it("fences MCP credentials permanently, including when the same account later becomes Builder again",async()=>{
    const f=await fixture(),item=f.item(),{d,sessionId}=f.launch([item.key]);
    const first=await f.mcp(f.a,"claim_item",{itemKey:item.key,agentId:"Old agent",dispatchId:d.id,idempotencyKey:"claim-original"});
    expect(first.isError).not.toBe(true);
    const oldCredential=first.structuredContent!.executionAuthorization;
    const checks=new StatusChecks(f.store);
    const oldEvidence=checks.register(item.key,f.a.id,{completion:{kind:"commit",commit:"a".repeat(40),targetBranch:"main"},requiredArtifacts:[],noReleaseReason:"Synthetic test"});
    f.transfer(item.key);f.snapshot(sessionId,f.stopCommand(d.id));
    const completion={kind:"commit",commit:"a".repeat(40),targetBranch:"main"};
    expect((await f.mcp(f.a,"submit_development_complete",{itemKey:item.key,completion,executionAuthorization:oldCredential,idempotencyKey:"late-old-agent"})).isError).toBe(true);
    const next=f.dispatch([item.key],f.b.id,f.bNode.nodeId);f.dispatches.claimNextDispatch(f.bNode.nodeId);
    const takeover=await f.mcp(f.b,"claim_item",{itemKey:item.key,agentId:"New agent",dispatchId:next.id,idempotencyKey:"claim-takeover"});
    expect(takeover.isError).not.toBe(true);expect(takeover.structuredContent!.statusChanged).toBe(false);
    const credential=takeover.structuredContent!.executionAuthorization;
    const register={itemKey:item.key,completion,requiredArtifacts:[],noReleaseReason:"Synthetic test"};
    expect((await f.mcp(f.b,"register_item_handover",register)).isError).toBe(true);
    expect((await f.mcp(f.b,"register_item_handover",{...register,executionAuthorization:credential},"another-client")).isError).toBe(true);
    expect((await f.mcp(f.b,"register_item_handover",{...register,executionAuthorization:credential})).isError).not.toBe(true);
    checks.report(oldEvidence.id,{merged:{commit:"a".repeat(40),occurredAt:new Date().toISOString()}},{accountId:f.a.id});
    expect(f.store.getWorkItem(item.key).status).toBe("in_progress");
    // No physical process started on the new queued/delivered dispatch: simulate a definite launch failure.
    f.dispatches.recordDispatchResult({nodeId:f.bNode.nodeId,dispatchId:next.id,status:"failed"});
    f.handovers.start(item.key,"admin",f.a.id,f.b.id,"Return delivery");
    expect(f.store.getWorkItem(item.key).builderAccountId).toBe(f.a.id);
    expect((await f.mcp(f.a,"claim_item",{itemKey:item.key,agentId:"Old agent",dispatchId:d.id,idempotencyKey:"claim-original"})).isError).toBe(true);
    expect((await f.mcp(f.a,"submit_development_complete",{itemKey:item.key,completion,executionAuthorization:oldCredential,idempotencyKey:"returned-old-agent"})).isError).toBe(true);
    expect(f.store.getWorkItem(item.key).status).toBe("in_progress");
  });
  it("completes only from an authenticated node snapshot and rejects a stale queued continue acknowledgement",async()=>{
    const f=await fixture(),item=f.item(),{d,sessionId}=f.launch([item.key]);f.start(item.key);
    const message=f.sessions.enqueue(f.a.id,sessionId,"Continue old work");
    f.transfer(item.key);
    const url=`/api/v1/node/agent-sessions/${sessionId}/snapshot`;
    const stale=await f.app.inject({method:"POST",url,headers:{authorization:`Bearer ${f.aNode.token}`},payload:{status:"active",messages:[],commandId:message.id,commandStatus:"delivering"}});
    expect(stale.statusCode).toBe(409);
    const wrongNode=await f.app.inject({method:"POST",url,headers:{authorization:`Bearer ${f.bNode.token}`},payload:{status:"idle",messages:[],turnActive:false,commandId:f.stopCommand(d.id),commandStatus:"delivered"}});
    expect(wrongNode.statusCode).toBe(404);
    const stopped=await f.app.inject({method:"POST",url,headers:{authorization:`Bearer ${f.aNode.token}`},payload:{status:"idle",messages:[],turnActive:false,commandId:f.stopCommand(d.id),commandStatus:"delivered"}});
    expect(stopped.statusCode).toBe(204);
    expect(f.store.getWorkItem(item.key)).toMatchObject({status:"in_progress",builderAccountId:f.b.id,builderHandover:{status:"completed"}});
  });
  it("serializes competing transfers and never starts a second handover",async()=>{
    const f=await fixture(),item=f.item();f.start(item.key);
    const request={method:"POST" as const,url:`/api/v1/items/${item.key}/builder`,headers:{cookie:f.adminCookie},payload:{accountId:f.b.id,expectedBuilderAccountId:f.a.id,note:"Transfer"}};
    const results=await Promise.all([f.app.inject(request),f.app.inject(request)]);
    expect(results.map(r=>r.statusCode).sort()).toEqual([200,409]);
    expect(f.db.prepare("SELECT COUNT(*) AS count FROM builder_handovers").get()).toMatchObject({count:1});
  });

  it("rolls back queue replacement and all item links if writing batch history fails",async()=>{
    const f=await fixture(),one=f.item(),two=f.item(),old=f.dispatch([one.key,two.key]);
    const append=vi.spyOn(f.store,"appendSystemEvent").mockImplementationOnce(()=>{throw new Error("Synthetic history write failure");});
    const response=await f.app.inject({method:"POST",url:"/api/v1/dispatches",headers:{cookie:f.aCookie},payload:{nodeId:f.aNode.nodeId,agentKind:"opencode",mode:"default",itemKeys:[one.key,two.key],force:true}});
    append.mockRestore();
    expect(response.statusCode).toBe(500);
    expect(f.dispatches.getDispatch(f.a.id,old.id).status).toBe("queued");
    expect(f.db.prepare("SELECT COUNT(*) AS count FROM dispatches").get()).toMatchObject({count:1});
    expect(f.db.prepare("SELECT COUNT(*) AS count FROM dispatch_items").get()).toMatchObject({count:2});
  });

  it("shows the new Agent handler after a takeover without a second in-progress transition",async()=>{
    const f=await fixture(),item=f.item(),{d,sessionId}=f.launch([item.key]);f.start(item.key,"agent");
    f.transfer(item.key);f.snapshot(sessionId,f.stopCommand(d.id));
    const next=f.dispatch([item.key],f.b.id,f.bNode.nodeId);f.dispatches.claimNextDispatch(f.bNode.nodeId);
    f.dispatches.recordDispatchResult({nodeId:f.bNode.nodeId,dispatchId:next.id,status:"launched"});
    f.sessions.createForDispatch({dispatchId:next.id,nodeId:f.bNode.nodeId,sessionRef:randomUUID()});
    f.store.claimWorkItem({itemKey:item.key,agentId:"New agent",dispatchId:next.id,attribution:{accountId:f.b.id},idempotencyKey:randomUUID()});
    expect(f.dispatches.listInProgressHandlers(f.a.id)).toEqual([]);
    expect(f.dispatches.listInProgressHandlers(f.b.id)).toMatchObject([{itemKey:item.key,dispatchId:next.id}]);
    expect(f.store.getTimeline(item.key).filter(e=>e.toStatus==="in_progress")).toHaveLength(1);
  });

  it("still stops a running session after a business completion event, and permanently fences closed history",async()=>{
    const f=await fixture(),item=f.item(),{d,sessionId}=f.launch([item.key]);f.start(item.key);
    f.store.transitionWorkItem({itemKey:item.key,to:"development_complete",actor:"human",reason:"resolution_submitted",attribution:{accountId:f.a.id}});
    expect(f.transfer(item.key).builderHandover?.status).toBe("stopping");
    const command=f.stopCommand(d.id);expect(command).toBeTruthy();f.snapshot(sessionId,command);
    expect(f.store.getWorkItem(item.key)).toMatchObject({status:"development_complete",builderAccountId:f.b.id});
    f.handovers.start(item.key,"admin",f.a.id,f.b.id,"Return ownership without reopening work");
    expect(()=>f.sessions.enqueue(f.a.id,sessionId,"Revive old execution")).toThrow(/失效/);
  });

});
