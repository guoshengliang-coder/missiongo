import { approvedClaimFixture } from "./testing-fixtures.js";
import { ExternalAgentSessionStore } from "./external-agent-session-store.js";
import { hasOngoingItemExecution } from "./builder-authority.js";
import { createAiAccessToken } from "./admin-auth.js";
import { randomUUID,scryptSync } from "node:crypto";
import { afterEach,beforeEach,describe,expect,it } from "vitest";
import { buildApp } from "./app.js";
import { transitionPolicy } from "./item-policy.js";
import { deliveryRound } from "./delivery-round.js";
import { assertExecutionAuthorization } from "./builder-authority.js";

const salt=Buffer.from("policy-tests-only");
const config={id:"policy-admin",username:"admin@example.test",passwordScrypt:`scrypt:${salt.toString("base64url")}:${scryptSync("password-123",salt,64).toString("base64url")}`,sessionSecret:"test-session-secret-with-sufficient-length",cookieSecure:false};
let app:ReturnType<typeof buildApp>;
let item:ReturnType<ReturnType<typeof buildApp>["missionGoStore"]["getWorkItem"]>;
let productId:string;
let ids:Record<string,string>;
let cookies:Record<string,string>;
const password="password-123";
beforeEach(async()=>{
 app=buildApp({databasePath:":memory:",adminAccount:config,adminToken:"operator-fixture",writeTools:"comments",statusCheckTime:false});
 const accounts=app.missionGoAccounts,store=app.missionGoStore;
 productId=store.createProduct({name:"Policy",keyPrefix:"POL",createdByAccountId:config.id}).id;
 ids={admin:config.id};cookies={};
 for(const role of ["project_admin","proposer","builder","executor","operator","viewer"]){
  const account=accounts.createAccount({email:`${role}@example.test`,password,role:"member"});ids[role]=account.id;
  accounts.replacePermissions(account.id,[{productId,canView:true,canOperate:["builder","executor","operator"].includes(role),canUseAi:false}]);
 }
 accounts.replaceProjectAdministrators(productId,[config.id,ids.project_admin!],[config.id],config.id);
 item=store.createWorkItem({productId,title:"Request",description:"Scope A",type:"requirement",priority:"normal",status:"ready",environment:{platform:"web"},attribution:{accountId:ids.proposer}});
 store.database.connection.prepare("UPDATE work_items SET builder_account_id=? WHERE id=?").run(ids.builder!,item.id);
 store.database.connection.prepare(`INSERT INTO item_executions(id,item_id,account_id,scope,status,created_by,created_at,updated_at) VALUES (?,?,?,'Implement module','assigned',?,?,?)`).run(randomUUID(),item.id,ids.executor!,config.id,new Date().toISOString(),new Date().toISOString());
 item=store.getWorkItem(item.key);
 for(const [name,id] of Object.entries(ids)){
  const response=await app.inject({method:"POST",url:"/api/v1/auth/login",payload:{username:accounts.getAccount(id).email,password}});
  const header=response.headers["set-cookie"];
  cookies[name]=(Array.isArray(header)?header[0]:header)!.split(";")[0]!;
 }
});
afterEach(async()=>{await app.close();});
function move(to:string,reason:string,role="admin",extra:Record<string,unknown>={}){
 const current=app.missionGoStore.getWorkItem(item.key);
 return app.inject({method:"POST",url:`/api/v1/items/${item.key}/transitions`,headers:{cookie:cookies[role]!},payload:{to,reason,note:"Reviewed decision",expectedStatus:current.status,expectedRevision:current.revision,idempotencyKey:randomUUID(),...(["on_hold","cancelled"].includes(to)?{executionDisposition:"keep_running"}:{}),...extra}});
}
function preset(status:"in_progress"|"development_complete"|"pending_verification"|"done"|"cancelled"|"on_hold"){
 app.missionGoStore.transitionWorkItem({itemKey:item.key,to:status,reason:status === "on_hold" ? "request_human_input" : "manual_override",actor:"human",note:"Test fixture: audited stage",attribution:{accountId:config.id}});
}
describe("AND-357 role matrix and current responsibility",()=>{
 it.each([
  ["pending_verification","done","verification_passed",["admin","project_admin","proposer"]],
  ["pending_verification","ready","verification_failed",["admin","project_admin","proposer","builder"]],
  ["ready","cancelled","cancelled",["admin","project_admin","proposer","builder"]],
  ["cancelled","inbox","restored",["admin","project_admin","proposer","builder"]],
  ["done","ready","reopened",["admin","project_admin","proposer"]],
  ["in_progress","ready","released",["admin","project_admin","builder"]],
  ["ready","in_progress","claim",["builder","executor"]],
  ["ready","inbox","reopened",["admin","project_admin","proposer"]],
  ["in_progress","development_complete","resolution_submitted",["admin","project_admin","builder","executor"]],
 ] as const)("%s → %s follows the same role policy",(from,to,reason,allowed)=>{
  for(const role of Object.keys(ids)) expect(transitionPolicy(app.missionGoStore.database,{...item,status:from},ids[role],to,reason).allowed,role).toBe((allowed as readonly string[]).includes(role));
 });
 it("does not require AI for human Builders, and excludes read-only performers",async()=>{
  const builders=await app.inject({method:"GET",url:`/api/v1/products/${productId}/builders`,headers:{cookie:cookies.admin!}});
  expect(builders.json().builders.map((a:{id:string})=>a.id)).toContain(ids.builder);
  expect(builders.json().builders.map((a:{id:string})=>a.id)).not.toContain(ids.viewer);
  const response=await move("in_progress","claim","builder");expect(response.statusCode,response.body).toBe(200);
 });
 it("removes old Builder rights immediately and unions proposer/Builder roles",()=>{
  const db=app.missionGoStore.database;
  db.connection.prepare("UPDATE work_items SET builder_account_id=? WHERE id=?").run(ids.operator!,item.id);
  const current=app.missionGoStore.getWorkItem(item.key);
  expect(transitionPolicy(db,current,ids.builder,"cancelled","cancelled").allowed).toBe(false);
  db.connection.prepare("UPDATE work_items SET builder_account_id=? WHERE id=?").run(ids.proposer!,item.id);
  expect(transitionPolicy(db,{...app.missionGoStore.getWorkItem(item.key),status:"pending_verification"},ids.proposer,"done","verification_passed").allowed).toBe(true);
 });
 it("allows a viewing proposer to decide and attach reasons, without unrelated editing",async()=>{
  const upload=await app.inject({method:"POST",url:`/api/v1/items/${item.key}/attachments`,headers:{cookie:cookies.proposer!,"content-type":"application/octet-stream","x-missiongo-filename":"reason.md","x-missiongo-content-type":"text/markdown","x-missiongo-transition-upload":"true"},payload:Buffer.from("reason")});
  expect(upload.statusCode,upload.body).toBe(201);
  const result=await move("cancelled","cancelled","proposer",{attachmentIds:[upload.json().id]});expect(result.statusCode,result.body).toBe(200);
  const event=app.missionGoStore.getTimeline(item.key).findLast(e=>e.eventType==="status_changed")!;
  expect(event).toMatchObject({accountId:ids.proposer,payload:{roles:["proposer"],contentVersion:1,attachmentIds:[upload.json().id]}});
  expect((await app.inject({method:"PATCH",url:`/api/v1/items/${item.key}`,headers:{cookie:cookies.proposer!},payload:{title:"Not permitted"}})).statusCode).toBe(404);
 });
 it("records Builder returns as verification_failed and not a separate withdrawal",async()=>{
  preset("pending_verification");const result=await move("ready","manual_override","builder");
  // Every return from verification is the same decision, including legacy reason names.
  expect(result.statusCode).toBe(200);
  expect(app.missionGoStore.getTimeline(item.key).findLast(e=>e.eventType==="status_changed")).toMatchObject({accountId:ids.builder,payload:{reason:"verification_failed",roles:expect.arrayContaining(["builder"])}});
 });
});
describe("AND-357 revision, round and evidence fences",()=>{
 it("retries one decision once and refuses an old page after an ABA status cycle",async()=>{
  preset("pending_verification");const old=app.missionGoStore.getWorkItem(item.key);
  const payload={expectedStatus:old.status,expectedRevision:old.revision,idempotencyKey:"accept-once"};
  const first=await move("done","verification_passed","proposer",payload);expect(first.statusCode,first.body).toBe(200);
  const count=app.missionGoStore.getTimeline(item.key).length;
  expect((await move("done","verification_passed","proposer",payload)).statusCode).toBe(200);
  expect(app.missionGoStore.getTimeline(item.key)).toHaveLength(count);
  await move("ready","reopened","proposer");preset("pending_verification");
  const stale=await move("done","verification_passed","proposer",{...payload,idempotencyKey:"stale-page"});expect(stale.statusCode,stale.body).toBe(409);
 });
 it("freezes accepted scope, snapshots new scope and invalidates the delivery association",async()=>{
  preset("in_progress");const store=app.missionGoStore;
  const oldRound=deliveryRound(store.database,item.id);
  store.updateWorkItem(item.key,{description:"Scope B",attribution:{accountId:ids.builder}});
  expect(store.getWorkItem(item.key).contentVersion).toBe(2);expect(deliveryRound(store.database,item.id)).not.toBe(oldRound);
  expect(store.database.connection.prepare("SELECT version FROM item_content_versions WHERE item_id=? ORDER BY version").all(item.id)).toEqual([{version:1},{version:2}]);
  preset("pending_verification");expect(()=>store.updateWorkItem(item.key,{title:"New scope",attribution:{accountId:ids.builder}})).toThrow();
  await move("done","verification_passed","proposer");expect(()=>store.updateWorkItem(item.key,{description:"Scope C",attribution:{accountId:config.id}})).toThrow();
  expect((await move("cancelled","manual_override")).statusCode).toBe(403);
 });
 it("saves the exact hold origin and restores cancelled work to inbox only",async()=>{
  await move("on_hold","request_human_input","proposer");expect(app.missionGoStore.getWorkItem(item.key).heldFrom).toBe("ready");
  expect((await move("ready","resume","proposer")).statusCode).toBe(200);
  await move("cancelled","cancelled","builder");expect((await move("in_progress","manual_override")).statusCode).toBe(403);
  expect((await move("inbox","restored","proposer")).statusCode).toBe(200);
 });
 it("keeps archived projects read-only, permitting role repair and manager restore",async()=>{
  app.missionGoStore.createProduct({name:"Other",keyPrefix:"OTH"});
  app.missionGoStore.updateProduct(productId,{archived:true});
  expect((await move("in_progress","claim","builder")).statusCode).toBe(409);
  expect(()=>app.missionGoStore.createWorkItem({productId,title:"Blocked",description:"",type:"task",priority:"normal"})).toThrow();
 });
 it("never treats operator or AI bearer tokens as human business decisions",async()=>{
  preset("pending_verification");
  const result=await app.inject({method:"POST",url:`/api/v1/items/${item.key}/transitions`,headers:{authorization:"Bearer operator-fixture"},payload:{to:"done",reason:"verification_passed",expectedRevision:app.missionGoStore.getWorkItem(item.key).revision,idempotencyKey:"operator-cannot-accept"}});
  expect(result.statusCode).toBe(403);expect(app.missionGoStore.getWorkItem(item.key).status).toBe("pending_verification");
 });
 it("requires current execution credentials even before the first Builder handover",()=>{
  preset("in_progress");const db=app.missionGoStore.database;
  expect(()=>assertExecutionAuthorization(db,item.id,ids.builder!,"client")).toThrow();
  const key=randomUUID(),at=new Date().toISOString();
  db.connection.prepare("INSERT INTO builder_execution_authorizations(id,item_id,account_id,client_id,created_at,round_key) VALUES (?,?,?,?,?,?)").run(key,item.id,ids.builder!,"client",at,deliveryRound(db,item.id,true));
  expect(()=>assertExecutionAuthorization(db,item.id,ids.builder!,"client",key)).not.toThrow();
  preset("pending_verification");app.missionGoStore.transitionWorkItem({itemKey:item.key,to:"ready",actor:"human",reason:"verification_failed",note:"Need changes",attribution:{accountId:ids.builder}});
  expect(()=>assertExecutionAuthorization(db,item.id,ids.builder!,"client",key)).toThrow();
 });
 it("clearing selected AI grants never becomes all, and disabled accounts reach nothing",()=>{
  const accounts=app.missionGoAccounts;
  accounts.replacePermissions(config.id,[{productId,canView:true,canOperate:true,canUseAi:true}]);
  accounts.replacePermissions(config.id,[]);expect(accounts.reachableProductIds(accounts.getAccount(config.id),"ai")).toEqual([]);
  accounts.replacePermissions(ids.operator!,[],"none");expect(accounts.allows(accounts.getAccount(ids.operator!),productId,"ai")).toBe(false);
 });
 it("queues fail/cancel/reopen notifications to current responsible people with proposer fallback",async()=>{
  preset("pending_verification");await move("ready","verification_failed","builder");
  const db=app.missionGoStore.database.connection;
  let recipients=db.prepare("SELECT account_id FROM dingtalk_notifications WHERE kind='decision' ORDER BY account_id").all() as Array<{account_id:string}>;
  expect(recipients.map(x=>x.account_id)).toEqual([ids.proposer,ids.builder].sort());
  app.missionGoAccounts.updateAccount(ids.proposer!,{disabled:true});
  await move("cancelled","cancelled","builder");
  recipients=db.prepare("SELECT account_id FROM dingtalk_notifications WHERE kind='decision' AND event_id=(SELECT id FROM work_item_events WHERE item_id=? AND to_status='cancelled' ORDER BY timeline_seq DESC LIMIT 1) ORDER BY account_id").all(item.id) as typeof recipients;
  expect(recipients.map(x=>x.account_id)).toEqual([ids.admin,ids.project_admin,ids.builder].sort());
 });
});

describe("AND-357 public command boundaries",()=>{
 it("requires an observed version and an explicit decision on ongoing execution",async()=>{
  const raw=await app.inject({method:"POST",url:`/api/v1/items/${item.key}/transitions`,headers:{cookie:cookies.builder!},payload:{to:"in_progress",reason:"claim"}});
  expect(raw.statusCode).toBe(400);
  await move("in_progress","claim","builder");
  const current=app.missionGoStore.getWorkItem(item.key);
  const hold=await app.inject({method:"POST",url:`/api/v1/items/${item.key}/transitions`,headers:{cookie:cookies.builder!},payload:{to:"on_hold",reason:"request_human_input",note:"Wait",expectedStatus:current.status,expectedRevision:current.revision,idempotencyKey:"explicit-disposition"}});
  expect(hold.json().code).toBe("execution_disposition_required");
 });
 it("blocks conflicting rework until the real execution is ended, without pretending a status change stopped it",async()=>{
  await move("in_progress","claim","builder");
  preset("pending_verification");await move("ready","verification_failed","builder");
  const blocked=await move("in_progress","claim","builder");expect(blocked.json().code).toBe("execution_stop_unconfirmed");
  const executions=app.missionGoStore.database.connection.prepare("SELECT id,account_id FROM item_executions WHERE item_id=?").all(item.id) as Array<{id:string;account_id:string}>;
  for(const row of executions){
   const ended=await app.inject({method:"PATCH",url:`/api/v1/items/${item.key}/executions/${row.id}`,headers:{cookie:cookies.admin!},payload:{status:"completed",result:"Original execution ended; scope requires a new round"}});
   expect(ended.statusCode,ended.body).toBe(200);
  }
  expect((await move("in_progress","claim","builder")).statusCode).toBe(200);
 });
});

function policyAiToken(role:string) {
 const account=app.missionGoAccounts.getAccount(ids[role]!);
 return createAiAccessToken(config,{id:account.id,username:account.email,role:account.role},app.missionGoAccounts.credentialsStamp(account),"policy-client",["missiongo:read","missiongo:write"]).token;
}
async function rawMcp(token:string,name:string,args:Record<string,unknown>) {
 if(name==="claim_item") approvedClaimFixture(app.missionGoStore,token,args);
 const response=await app.inject({method:"POST",url:"/mcp",headers:{authorization:`Bearer ${token}`,"content-type":"application/json",accept:"application/json, text/event-stream"},payload:{jsonrpc:"2.0",id:1,method:"tools/call",params:{name,arguments:args}}});
 const body=response.headers["content-type"]?.includes("text/event-stream") ? response.body.split("\n").find(line=>line.startsWith("data: "))!.slice(6) : response.body;
 return {status:response.statusCode,...JSON.parse(body)};
}
describe("AND-357 real MCP authorization",()=>{
 it("requires operate plus AI and a current claim credential, before and after rework",async()=>{
  const accounts=app.missionGoAccounts;
  const grant=(operate:boolean)=>accounts.replacePermissions(ids.builder!,[{productId,canView:true,canOperate:operate,canUseAi:true}]);
  grant(true);const token=policyAiToken("builder");
  const claim=await rawMcp(token,"claim_item",{itemKey:item.key,agentId:"Test agent",idempotencyKey:"mcp-current-claim"});
  expect(claim.result.isError,JSON.stringify(claim)).not.toBe(true);
  const credential=claim.result.structuredContent.executionAuthorization;
  const input={itemKey:item.key,pullRequestUrl:"https://github.com/example/project/pull/1",requiredArtifacts:["web"],idempotencyKey:"mcp-development"};
  expect((await rawMcp(token,"submit_development_complete",input)).result.isError).toBe(true);
  grant(false);expect((await rawMcp(token,"submit_development_complete",{...input,executionAuthorization:credential})).result.isError).toBe(true);
  expect(app.missionGoStore.getWorkItem(item.key).status).toBe("in_progress");
  grant(true);expect((await rawMcp(token,"submit_development_complete",{...input,executionAuthorization:credential})).result.structuredContent.item.status).toBe("development_complete");
  const published=await rawMcp(token,"submit_for_verification",{itemKey:item.key,executionAuthorization:credential,pullRequestUrl:input.pullRequestUrl,releases:[{artifact:"web",version:"2",sourceCommit:"b".repeat(40)}],deployedCommit:"b".repeat(40),receiptDigest:"c".repeat(64),idempotencyKey:"mcp-published"});
  expect(published.result.structuredContent.item.status).toBe("pending_verification");
  await move("ready","verification_failed","builder");
  expect((await rawMcp(token,"submit_development_complete",{...input,executionAuthorization:credential,idempotencyKey:"old-execution-after-fail"})).result.isError).toBe(true);
  expect(app.missionGoStore.getWorkItem(item.key).status).toBe("ready");
 });
 it("does not grant creation, claims or upload writes to an AI-only viewer",async()=>{
  app.missionGoAccounts.replacePermissions(ids.operator!,[{productId,canView:true,canOperate:false,canUseAi:true}]);
  const token=policyAiToken("operator"),before=app.missionGoStore.listWorkItems({productId}).length;
  const create=await rawMcp(token,"create_item",{productId,title:"Forbidden",description:"",type:"task",priority:"normal",status:"ready",platform:"web",agentName:"Test agent",summary:"Fixture",idempotencyKey:"forbidden-create"});
  expect(create.result.isError).toBe(true);
  const claim=await rawMcp(token,"claim_item",{itemKey:item.key,agentId:"Test agent",idempotencyKey:"forbidden-claim"});expect(claim.result.isError).toBe(true);
  const upload=await rawMcp(token,"prepare_attachment_upload",{productId,uploadId:randomUUID(),filename:"fixture.md",contentType:"text/markdown",sizeBytes:1,sha256:"a".repeat(64)});expect(upload.result.isError).toBe(true);
  expect(app.missionGoStore.listWorkItems({productId})).toHaveLength(before);
  const context=await rawMcp(token,"get_item_context",{itemKey:item.key});
  expect(context.result.structuredContent.executionPolicy.transitions.every((d:{allowed:boolean})=>!d.allowed)).toBe(true);
 });
});

it("audits explicit AI scope changes with the real human account and before/after grants",async()=>{
 const response=await app.inject({method:"PUT",url:`/api/v1/accounts/${ids.operator}/products`,headers:{cookie:cookies.admin!},payload:{aiScope:"none",permissions:[]}});
 expect(response.statusCode).toBe(200);
 const row=app.missionGoStore.database.connection.prepare("SELECT actor_kind,actor_account_id,before_json,after_json FROM account_access_audit WHERE subject_id=? ORDER BY rowid DESC LIMIT 1").get(ids.operator!) as {actor_kind:string;actor_account_id:string;before_json:string;after_json:string};
 expect(row).toMatchObject({actor_kind:"human",actor_account_id:ids.admin});expect(JSON.parse(row.before_json).permissions).toHaveLength(1);expect(JSON.parse(row.after_json)).toEqual({aiScope:"none",permissions:[]});
});

it("keeps account-wide AI prohibitions and all-project scope unchanged when project grants are edited",async()=>{
 const accounts=app.missionGoAccounts;
 for(const scope of ["none","all"] as const){
  accounts.replacePermissions(ids.operator!,[{productId,canView:true,canOperate:true,canUseAi:true}],scope);
  const response=await app.inject({method:"PUT",url:`/api/v1/products/${productId}/accounts`,headers:{cookie:cookies.project_admin!},payload:{accounts:[{accountId:ids.operator,canView:true,canOperate:true,canUseAi:true}]}});
  expect(response.statusCode).toBe(200);expect(accounts.getAccount(ids.operator!).aiScope).toBe(scope);
  expect(accounts.allows(accounts.getAccount(ids.operator!),productId,"ai")).toBe(scope === "all");
  expect(response.json().accounts.find((a:{account:{id:string}})=>a.account.id === ids.operator).aiScope).toBe(scope);
 }
});

it("requires a healthy source observation for a connected native session even after progress says completed",async()=>{
 await move("in_progress","claim","builder");
 const store=app.missionGoStore,db=store.database.connection,progress=new ExternalAgentSessionStore(store);
 const owner={accountId:ids.builder!,clientId:"policy-client"};
 const session=progress.register(owner,{agentKind:"codex",sessionRef:"policy-native-session",refKind:"native"},item.key);
 progress.report(owner,session,item.key,"completed","Reporting only conversation progress","complete-policy-progress");
 db.prepare("UPDATE item_executions SET status='completed' WHERE item_id=?").run(item.id);
 expect(hasOngoingItemExecution(store.database,item.id)).toBe(false);
 const now=new Date().toISOString();
 db.prepare(`INSERT INTO nodes(id,account_id,installation_id,name,token_hash,agents_json,last_seen_at,created_at,updated_at)
   VALUES ('policy-node',?,'policy-installation','Policy node','synthetic','[]',?,?,?)`).run(ids.builder!,now,now,now);
 db.prepare("UPDATE external_agent_sessions SET native_node_id='policy-node' WHERE id=?").run(session);
 expect(hasOngoingItemExecution(store.database,item.id)).toBe(true);
 db.prepare("UPDATE external_agent_sessions SET native_snapshot_json=?,native_synced_at=? WHERE id=?").run(JSON.stringify({status:"idle",turnState:{turnActive:false}}),now,session);
 expect(hasOngoingItemExecution(store.database,item.id)).toBe(false);
 db.prepare("UPDATE nodes SET last_seen_at='2000-01-01T00:00:00.000Z' WHERE id='policy-node'").run();
 expect(hasOngoingItemExecution(store.database,item.id)).toBe(true);
});
