import { scryptSync } from "node:crypto";
import { mkdtemp,rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach,describe,expect,it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "./app.js";
import { createAiAccessToken } from "./admin-auth.js";
const apps:FastifyInstance[]=[];const dirs:string[]=[];
afterEach(async()=>{await Promise.all(apps.splice(0).map(a=>a.close()));await Promise.all(dirs.splice(0).map(d=>rm(d,{recursive:true,force:true})));});
async function seed() {
 const directory=await mkdtemp(join(tmpdir(),"missiongo-insights-api-"));dirs.push(directory);
 const salt=Buffer.from("status-insights-tests");
 const adminAccount={id:"owner",username:"owner@example.test",passwordScrypt:`scrypt:${salt.toString("base64url")}:${scryptSync("password-for-tests",salt,64).toString("base64url")}`,sessionSecret:"only-a-test-session-secret",cookieSecure:false};
 const app=buildApp({databasePath:":memory:",attachmentsPath:directory,adminAccount,writeTools:"comments",statusCheckTime:false});apps.push(app);
 const login=async(username:string,password:string)=>{
  const response=await app.inject({method:"POST",url:"/api/v1/auth/login",payload:{username,password}});
  expect(response.statusCode).toBe(200);return String(response.headers["set-cookie"]).split(";")[0]!;
 };
 const cookie=await login(adminAccount.username,"password-for-tests");
 const create=async(name:string,keyPrefix:string)=>{
  const response=await app.inject({method:"POST",url:"/api/v1/products",headers:{cookie},payload:{name,keyPrefix}});
  expect(response.statusCode).toBe(201);return response.json<{id:string}>();
 };
 const shared=await create("Shared","SHR"),hidden=await create("Private project","SEC");
 app.missionGoStore.setProductReleaseArtifacts(shared.id,["web"]);
 const member=app.missionGoAccounts.createAccount({email:"member@example.test",password:"member-password-long",role:"member"});
 const permissions=await app.inject({method:"PUT",url:`/api/v1/accounts/${member.id}/products`,headers:{cookie},payload:{permissions:[{productId:shared.id,canView:true,canOperate:false,canUseAi:true}]}});expect(permissions.statusCode).toBe(200);
 const memberCookie=await login("member@example.test","member-password-long");
 const item=app.missionGoStore.createWorkItem({productId:shared.id,title:"Shared issue",description:"Body",type:"bug",priority:"normal",environment:{platform:"web"}});
 app.missionGoStore.createWorkItem({productId:hidden.id,title:"Must remain private",description:"Private",type:"bug",priority:"normal",environment:{platform:"web"}});
 app.missionGoStore.transitionWorkItem({itemKey:item.key,to:"ready",reason:"triaged",actor:"human"});
 app.missionGoStore.claimWorkItem({itemKey:item.key,agentId:"test",idempotencyKey:"claim"});
 const stamp=app.missionGoAccounts.credentialsStamp(app.missionGoAccounts.getAccount(member.id));
 const token=createAiAccessToken(adminAccount,{id:member.id,username:member.email,role:"member"},stamp,"insights-client",["missiongo:read"]).token;
 const call=async(name:string,args:Record<string,unknown>,write=false)=>{
  const activeToken=write ? createAiAccessToken(adminAccount,{id:member.id,username:member.email,role:"member"},stamp,"insights-client-write",["missiongo:read","missiongo:write"]).token : token;
  const response=await app.inject({method:"POST",url:"/mcp",headers:{authorization:`Bearer ${activeToken}`,accept:"application/json, text/event-stream"},payload:{jsonrpc:"2.0",id:1,method:"tools/call",params:{name,arguments:args}}});
  const raw=response.headers["content-type"]?.includes("text/event-stream")?response.body.split("\n").find(l=>l.startsWith("data: "))!.slice(6):response.body;
  return JSON.parse(raw) as {result?:{structuredContent?:Record<string,unknown>;isError?:boolean};error?:unknown};
 };
 return {app,cookie,memberCookie,shared,hidden,item,call};
}
describe("status-check and insight API permissions",()=>{
 it("allows read-only project statistics and refuses an explicitly unauthorized project",async()=>{
  const {call,shared,hidden}=await seed();
  const result=await call("get_project_insights",{period:"today"});
  expect(result.result?.isError).not.toBe(true);
  expect(result.result?.structuredContent).toMatchObject({projects:[{productId:shared.id,productName:"Shared"}]});
  const denied=await call("get_project_insights",{productIds:[hidden.id],period:"today"});
  expect(denied.error || denied.result?.isError).toBeTruthy();
  expect(JSON.stringify(denied)).not.toContain("Private project");
  const detail=await call("list_project_insight_items",{productIds:[shared.id],period:"today",metric:"created",limit:1});
  expect(detail.result?.structuredContent).toMatchObject({total:1});
  for (const metric of ["period_end_backlog", "repeat_returned"]) {
   const expanded=await call("list_project_insight_items",{productIds:[shared.id],period:"today",metric});
   expect(expanded.result?.isError).not.toBe(true);
   expect(expanded.result?.structuredContent).toMatchObject({metric,total:metric==="period_end_backlog" ? 1 : 0});
  }
 });
 it("separates viewing results from triggering or editing a check",async()=>{
  const {app,cookie,memberCookie,shared,hidden,item}=await seed();
  expect((await app.inject({method:"GET",url:`/api/v1/products/${shared.id}/status-checks`,headers:{cookie:memberCookie}})).statusCode).toBe(200);
  expect((await app.inject({method:"GET",url:`/api/v1/products/${hidden.id}/status-checks`,headers:{cookie:memberCookie}})).statusCode).toBe(404);
  expect((await app.inject({method:"POST",url:`/api/v1/items/${item.key}/status-checks`,headers:{cookie:memberCookie}})).statusCode).toBe(404);
  const registered=await app.inject({method:"PUT",url:`/api/v1/items/${item.key}/handover`,headers:{cookie},payload:{pullRequestUrl:"https://github.com/example/project/pull/1",requiredArtifacts:["web"]}});
  expect(registered.statusCode).toBe(200);
  const checked=await app.inject({method:"POST",url:`/api/v1/items/${item.key}/status-checks`,headers:{cookie}});
  expect(checked.json()).toMatchObject({queued:1,items:[{status:"waiting_node"}]});
  expect((await app.inject({method:"POST",url:"/api/v1/node/status-checks/claim",headers:{cookie}})).statusCode).toBe(401);
 });
 it("rejects malformed scopes and read-scope handover mutations",async()=>{
  const {app,cookie,item,call}=await seed();
  const invalid=await app.inject({method:"PUT",url:`/api/v1/items/${item.key}/handover`,headers:{cookie},payload:{pullRequestUrl:"file:///example",requiredArtifacts:[]}});
  expect(invalid.statusCode).toBe(400);
  const denied=await call("register_item_handover",{itemKey:item.key,pullRequestUrl:"https://github.com/example/project/pull/1",requiredArtifacts:["web"]});
  expect(denied.error || denied.result?.isError).toBeTruthy();
  const cannotOperate=await call("register_item_handover",{itemKey:item.key,pullRequestUrl:"https://github.com/example/project/pull/1",requiredArtifacts:["web"]},true);
  expect(cannotOperate.error || cannotOperate.result?.isError).toBeTruthy();
 });
});

describe("Web statistics (AND-297)",()=>{
 it("uses ordinary view permissions even without AI access, and agrees with the shared MCP calculation",async()=>{
  const {app,cookie,memberCookie,shared,hidden,call}=await seed();
  const response=await app.inject({url:"/api/v1/project-insights?period=today",headers:{cookie:memberCookie}});
  expect(response.statusCode).toBe(200);expect(response.headers["cache-control"]).toBe("no-store");
  const web=response.json();const mcp=await call("get_project_insights",{period:"today"});
  expect(web.projects.map((p:{productId:string})=>p.productId)).toEqual([shared.id]);
  expect(web.aggregate.counts).toEqual((mcp.result!.structuredContent!.aggregate as {counts:unknown}).counts);
  expect(JSON.stringify(web)).not.toContain("Must remain private");
  expect(web.aggregate.trend.length).toBe(1);
  const member=app.missionGoAccounts.listAccounts().find(a=>a.email==="member@example.test")!;
  const changed=await app.inject({method:"PUT",url:`/api/v1/accounts/${member.id}/products`,headers:{cookie},payload:{permissions:[{productId:shared.id,canView:true,canOperate:false,canUseAi:false}]}});expect(changed.statusCode).toBe(200);
  expect((await app.inject({url:`/api/v1/project-insights?productIds=${shared.id}&period=today`,headers:{cookie:memberCookie}})).statusCode).toBe(200);
  const denied=await app.inject({url:`/api/v1/project-insights?productIds=${hidden.id}`,headers:{cookie:memberCookie}});
  expect(denied.statusCode).toBe(404);expect(denied.body).not.toContain("Private project");
  expect((await app.inject({url:`/api/v1/project-insights/items?productIds=${hidden.id}&metric=created`,headers:{cookie:memberCookie}})).statusCode).toBe(404);
 });
 it("requires authentication, rejects invalid scope/filter/pagination and supports filtered detail paging",async()=>{
  const {app,memberCookie,shared}=await seed();
  expect((await app.inject({url:"/api/v1/project-insights"})).statusCode).toBe(401);
  for(const suffix of ["productIds=","types=bogus","period=custom&startDate=2026-02-30&endDate=2026-03-01","timezone=bad-zone","sql=SELECT","period=today&startDate=2026-01-01"]){
   expect((await app.inject({url:`/api/v1/project-insights?${suffix}`,headers:{cookie:memberCookie}})).statusCode,suffix).toBe(400);
  }
  for(const suffix of ["metric=bogus","metric=created&offset=NaN","metric=created&limit=101","metric=created&types=bogus"]){
   expect((await app.inject({url:`/api/v1/project-insights/items?${suffix}`,headers:{cookie:memberCookie}})).statusCode,suffix).toBe(400);
  }
  for(let i=0;i<2;i++)app.missionGoStore.createWorkItem({productId:shared.id,title:`Extra ${i}`,description:"Body",type:"task",priority:"normal",environment:{platform:"web"}});
  const base=`/api/v1/project-insights/items?period=today&metric=created&types=task&productIds=${shared.id}&limit=1`;
  const first=await app.inject({url:base,headers:{cookie:memberCookie}});expect(first.json()).toMatchObject({total:2,nextOffset:1});
  const next=await app.inject({url:base+"&offset=1",headers:{cookie:memberCookie}});expect(next.json()).toMatchObject({total:2});
  expect(next.json().items[0].itemKey).not.toBe(first.json().items[0].itemKey);expect(next.json().nextOffset).toBeUndefined();
 });
});

describe("saved batch API boundaries",()=>{
 it("saves personal batches with view permission, denies hidden items and isolates owners",async()=>{
  const {app,cookie,memberCookie,item,hidden,shared}=await seed();
  const path="/api/v1/project-insights/batches";
  expect((await app.inject({url:path})).statusCode).toBe(401);
  expect((await app.inject({method:"POST",url:path,headers:{cookie:memberCookie},payload:{name:"Invalid",itemKeys:[item.key],sql:"SELECT"}})).statusCode).toBe(400);
  const secret=app.missionGoStore.createWorkItem({productId:hidden.id,title:"Secret batch item",description:"Private",type:"task",priority:"normal",environment:{platform:"web"}});
  expect((await app.inject({method:"POST",url:path,headers:{cookie:memberCookie},payload:{name:"Hidden",itemKeys:[item.key,secret.key]}})).statusCode).toBe(404);
  expect((await app.inject({url:path,headers:{cookie:memberCookie}})).json()).toEqual({batches:[]});
  const saved=await app.inject({method:"POST",url:path,headers:{cookie:memberCookie},payload:{name:"Selected feedback",itemKeys:[item.key,item.key]}});
  expect(saved.statusCode).toBe(201);expect(saved.json().itemCount).toBe(1);
  const id=saved.json().id;
  expect((await app.inject({url:path,headers:{cookie:memberCookie}})).json()).toMatchObject({batches:[{id,delivered:0,effective:1,unavailable:0,deliveryRate:0}]});
  expect((await app.inject({url:path,headers:{cookie}})).json()).toEqual({batches:[]});
  expect((await app.inject({url:`${path}/${id}`,headers:{cookie:memberCookie}})).json()).toMatchObject({total:1,processing:1});
  expect((await app.inject({url:`${path}/${id}`,headers:{cookie}})).statusCode).toBe(404);
  expect((await app.inject({method:"DELETE",url:`${path}/${id}`,headers:{cookie}})).statusCode).toBe(404);
  const account=app.missionGoAccounts.listAccounts().find(a=>a.email==="member@example.test")!;
  await app.inject({method:"PUT",url:`/api/v1/accounts/${account.id}/products`,headers:{cookie},payload:{permissions:[]}});
  const revoked=await app.inject({url:`${path}/${id}`,headers:{cookie:memberCookie}});
  expect(revoked.json()).toMatchObject({total:1,unavailable:1,deliveryRate:null,items:[]});expect(revoked.body).not.toContain(item.title);expect(revoked.body).not.toContain(shared.id);
  const overview=await app.inject({url:path,headers:{cookie:memberCookie}});
  expect(overview.json()).toMatchObject({batches:[{id,unavailable:1,deliveryRate:null}]});
  expect(overview.body).not.toContain(item.title);expect(overview.body).not.toContain(shared.id);
  expect((await app.inject({method:"DELETE",url:`${path}/${id}`,headers:{cookie:memberCookie}})).statusCode).toBe(204);
  expect(app.missionGoStore.getWorkItem(item.key).id).toBe(item.id);
 });
});
