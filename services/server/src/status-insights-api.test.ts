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
