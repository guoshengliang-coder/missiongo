import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "./app.js";
import { hashPassword } from "./admin-auth.js";
import { ExternalAgentSessionStore } from "./external-agent-session-store.js";

const apps: FastifyInstance[]=[];
const password="synthetic delivery password";
const passwordScrypt=hashPassword(password);
afterEach(async()=>{await Promise.all(apps.splice(0).map(app=>app.close()));});
async function fixture() {
  const app=buildApp({adminAccount:{id:"admin",username:"admin@example.com",passwordScrypt,sessionSecret:"synthetic-delivery-session-secret",cookieSecure:false}});apps.push(app);
  const signIn=async(username:string)=>{const response=await app.inject({method:"POST",url:"/api/v1/auth/login",payload:{username,password}});expect(response.statusCode).toBe(200);return response.headers["set-cookie"]!.toString().split(";")[0]!;};
  const cookie=await signIn("admin@example.com"); const store=app.missionGoStore; const accounts=app.missionGoAccounts;
  const product=store.createProduct({name:"Delivery",keyPrefix:"DL",createdByAccountId:"admin"});
  const other=store.createProduct({name:"Other",keyPrefix:"OT",createdByAccountId:"admin"});
  const component=store.createComponent({productId:product.id,name:"Web",kind:"web"});
  const a=accounts.createAccount({email:"a@example.com",password,role:"member"});
  const b=accounts.createAccount({email:"b@example.com",password,role:"member"});
  const viewer=accounts.createAccount({email:"viewer@example.com",password,role:"member"});
  for(const member of [a,b]) accounts.replacePermissions(member.id,[{productId:product.id,canView:true,canOperate:true,canUseAi:true}]);
  accounts.replacePermissions(viewer.id,[{productId:product.id,canView:true,canOperate:false,canUseAi:false}]);
  const aCookie=await signIn(a.email),bCookie=await signIn(b.email),viewerCookie=await signIn(viewer.email);
  const call=(method:"GET"|"POST"|"PUT"|"PATCH",url:string,payload?:unknown,auth=cookie)=>app.inject({method,url,headers:{cookie:auth},...(payload!==undefined?{payload}:{})});
  const create=(sourceComponentId?:string)=>store.createWorkItem({productId:product.id,type:"task",priority:"normal",title:"Deliver a feature",description:"Scope",...(sourceComponentId?{sourceComponentId}:{})});
  const moduleUrl=`/api/v1/products/${product.id}/components/${component.id}/builder`;
  return {app,store,accounts,product,other,component,a,b,viewer,aCookie,bCookie,viewerCookie,cookie,call,create,moduleUrl};
}
describe("Builder delivery responsibility",()=>{
  it("assigns module defaults for new items only and leaves manual choices intact",async()=>{
    const f=await fixture();const old=f.create(f.component.id);
    expect((await f.call("PUT",f.moduleUrl,{accountId:f.a.id})).statusCode).toBe(200);
    expect(f.store.listComponents(f.product.id)[0]).toMatchObject({defaultBuilderAccountId:f.a.id});
    const item=f.create(f.component.id);expect(item).toMatchObject({builderAccountId:f.a.id,builderName:"a",builderNeedsReassignment:false});
    expect(f.store.getWorkItem(old.key).builderAccountId).toBeUndefined();
    f.store.updateWorkItem(old.key,{title:"Unrelated title edit",sourceComponentId:f.component.id});
    expect(f.store.getWorkItem(old.key).builderAccountId).toBeUndefined();
    await f.call("PUT",f.moduleUrl,{accountId:f.b.id});expect(f.store.getWorkItem(item.key).builderAccountId).toBe(f.a.id);
    expect(f.create(f.component.id).builderAccountId).toBe(f.b.id);
    const transfer=await f.call("POST",`/api/v1/items/${item.key}/builder`,{accountId:f.b.id,expectedBuilderAccountId:f.a.id,note:"Hand over delivery"},f.aCookie);
    expect(transfer.statusCode).toBe(200);expect(transfer.json()).toMatchObject({builderAccountId:f.b.id,status:item.status});
    const stale=await f.call("POST",`/api/v1/items/${item.key}/builder`,{accountId:f.a.id,expectedBuilderAccountId:f.a.id,note:"Stale transfer"});expect(stale.statusCode).toBe(409);
    f.store.updateWorkItem(item.key,{sourceComponentId:f.component.id});expect(f.store.getWorkItem(item.key).builderAccountId).toBe(f.b.id);
    const timeline=f.store.getTimeline(item.key);expect(timeline.some(event=>event.eventType==="builder_changed" && event.payload.note==="Hand over delivery")).toBe(true);
  });
  it("limits candidates by current AI permission and refuses cross-product or unauthorized changes",async()=>{
    const f=await fixture();
    const builders=await f.call("GET",`/api/v1/products/${f.product.id}/builders`,undefined,f.viewerCookie);
    expect(builders.statusCode).toBe(200);expect(builders.json().builders.map((row:{id:string})=>row.id)).toEqual(expect.arrayContaining([f.a.id,f.b.id]));
    expect(builders.body).not.toContain("@example.com");expect(builders.body).not.toContain("password");expect(builders.json().canConfigure).toBe(false);
    expect((await f.call("PUT",f.moduleUrl,{accountId:f.a.id},f.aCookie)).statusCode).toBe(403);
    expect((await f.call("PUT",f.moduleUrl,{accountId:f.viewer.id})).statusCode).toBe(400);
    expect((await f.call("PUT",`/api/v1/products/${f.other.id}/components/${f.component.id}/builder`,{accountId:"admin"})).statusCode).toBe(404);
    await f.call("PUT",f.moduleUrl,{accountId:f.a.id});const item=f.create(f.component.id);
    expect((await f.call("POST",`/api/v1/items/${item.key}/builder`,{accountId:f.b.id,expectedBuilderAccountId:f.a.id,note:"Unauthorized"},f.bCookie)).statusCode).toBe(403);
    const hidden=f.store.createWorkItem({productId:f.other.id,type:"task",priority:"normal",title:"Hidden",description:"private"});
    expect((await f.call("GET",`/api/v1/items/${hidden.key}/delivery`,undefined,f.aCookie)).statusCode).toBe(404);
    const noSession=await f.app.inject({method:"POST",url:`/api/v1/items/${item.key}/builder`,payload:{accountId:f.b.id,expectedBuilderAccountId:f.a.id,note:"No cookie"}});expect(noSession.statusCode).toBe(401);
    f.accounts.replacePermissions(f.a.id,[]);expect(f.store.getWorkItem(item.key)).toMatchObject({builderAccountId:f.a.id,builderNeedsReassignment:true});expect(f.create(f.component.id).builderAccountId).toBeUndefined();
    f.accounts.updateAccount(f.b.id,{disabled:true});expect((await f.call("POST",`/api/v1/items/${item.key}/builder`,{accountId:f.b.id,expectedBuilderAccountId:f.a.id,note:"Disabled"})).statusCode).toBe(400);
  });
  it("keeps pagination, status summaries and bootstrap under the same Builder filter",async()=>{
    const f=await fixture();await f.call("PUT",f.moduleUrl,{accountId:f.a.id});const first=f.create(f.component.id);f.create(f.component.id);f.create();
    const mine=await f.call("GET",`/api/v1/items?productId=${f.product.id}&builder=mine&limit=1`,undefined,f.aCookie);
    expect(mine.json().items).toHaveLength(1);expect(mine.json().summary).toMatchObject({total:2,byStatus:{inbox:2}});expect(mine.json().nextBeforeSequence).toBeDefined();
    const next=await f.call("GET",`/api/v1/items?productId=${f.product.id}&builder=mine&limit=1&beforeSequence=${mine.json().nextBeforeSequence}`,undefined,f.aCookie);expect(next.json().items[0].key).toBe(first.key);
    const unassigned=await f.call("GET",`/api/v1/items?productId=${f.product.id}&builder=unassigned`);expect(unassigned.json().items).toHaveLength(1);expect(unassigned.json().summary.total).toBe(1);
    const bootstrap=await f.call("GET",`/api/v1/bootstrap?productId=${f.product.id}&builder=mine`,undefined,f.aCookie);expect(bootstrap.json().items).toHaveLength(2);expect(bootstrap.json().summary.total).toBe(2);
  });
  it("preserves parallel and sequential execution history independently of item status and Builder",async()=>{
    const f=await fixture();await f.call("PUT",f.moduleUrl,{accountId:f.a.id});const item=f.create(f.component.id);const url=`/api/v1/items/${item.key}`;
    const assign=await f.call("POST",`${url}/executions`,{accountId:f.a.id,scope:"Frontend implementation"},f.aCookie);expect(assign.statusCode).toBe(201);const first=assign.json().executions[0];
    expect((await f.call("POST",`${url}/executions`,{accountId:f.b.id,scope:"Parallel backend"},f.aCookie)).statusCode).toBe(201);
    expect((await f.call("PATCH",`${url}/executions/${first.id}`,{status:"working"},f.bCookie)).statusCode).toBe(403);
    expect((await f.call("PATCH",`${url}/executions/${first.id}`,{status:"working"},f.aCookie)).statusCode).toBe(200);
    expect((await f.call("POST",`${url}/executions`,{accountId:f.b.id,scope:"Continue frontend",previousId:first.id,note:"Interface is ready; finish integration"},f.aCookie)).statusCode).toBe(201);
    const list=(await f.call("GET",`${url}/delivery`)).json().executions;expect(list).toHaveLength(3);expect(list[0]).toMatchObject({status:"handed_over",result:"Interface is ready; finish integration",endedAt:expect.any(String)});
    expect((await f.call("PATCH",`${url}/executions/${first.id}`,{status:"completed",result:"Overwrite history"},f.aCookie)).statusCode).toBe(409);
    expect((await f.call("POST",`${url}/executions`,{accountId:f.b.id,scope:"Duplicate handover",previousId:first.id,note:"Again"},f.aCookie)).statusCode).toBe(409);
    const second=list.find((row:{previousId:string})=>row.previousId===first.id);
    expect((await f.call("PATCH",`${url}/executions/${second.id}`,{status:"completed",result:""},f.bCookie)).statusCode).toBe(400);
    expect((await f.call("PATCH",`${url}/executions/${second.id}`,{status:"completed",result:"Integration ready"},f.bCookie)).statusCode).toBe(200);
    const followUp=await f.call("POST",`${url}/executions`,{accountId:f.a.id,scope:"Fix verification feedback",previousId:second.id,followUp:true,note:"New findings after this round completed"},f.aCookie);
    expect(followUp.statusCode).toBe(201);expect(followUp.json().executions).toHaveLength(4);
    expect(followUp.json().executions.find((row:{id:string})=>row.id===second.id)).toMatchObject({status:"completed",result:"Integration ready"});
    expect(f.store.getWorkItem(item.key)).toMatchObject({builderAccountId:f.a.id,status:"inbox"});
    expect((await f.call("POST",`${url}/builder`,{accountId:f.b.id,expectedBuilderAccountId:f.a.id,note:"Own delivery now"},f.aCookie)).statusCode).toBe(200);
    expect((await f.call("GET",`${url}/delivery`)).json().executions).toHaveLength(4);
  });
  it("associates actual Agent sessions without inferring completed delivery or exposing other items",async()=>{
    const f=await fixture();const item=f.create(),other=f.create();
    for (const row of [item,other]) {
      f.store.transitionWorkItem({itemKey:row.key,to:"ready",actor:"human",reason:"triaged"});
      f.store.transitionWorkItem({itemKey:row.key,to:"in_progress",actor:"human",reason:"claim"});
    }
    const external=new ExternalAgentSessionStore(f.store);
    external.register({accountId:f.a.id},{agentKind:"codex",refKind:"tracking",sessionRef:"synthetic-conversation-one"},item.key);
    external.register({accountId:f.b.id},{agentKind:"claude_code",refKind:"tracking",sessionRef:"synthetic-conversation-two"},other.key);
    const response=await f.call("GET",`/api/v1/items/${item.key}/delivery`);expect(response.statusCode).toBe(200);expect(response.json().executions).toMatchObject([{kind:"agent",name:"codex",accountId:f.a.id,accountName:"a",status:"working",sessionId:expect.any(String)}]);
    expect(response.body).not.toContain("claude_code");
    const original=response.json().executions[0];
    const handover=await f.call("POST",`/api/v1/items/${item.key}/executions`,{accountId:f.a.id,scope:"Review Agent output",previousId:original.id,note:"Agent implementation is ready for review"});
    expect(handover.statusCode).toBe(201);expect(handover.json().executions).toHaveLength(2);
    expect(handover.json().executions[0]).toMatchObject({kind:"agent",status:"handed_over",sessionId:original.sessionId});
    const next=handover.json().executions[1];
    const back=await f.call("POST",`/api/v1/items/${item.key}/executions`,{kind:"agent",sessionId:original.sessionId,scope:"Fix review findings",previousId:next.id,note:"Review identified follow-up work"});
    expect(back.statusCode).toBe(201);expect(back.json().executions).toHaveLength(3);
    expect(back.json().executions[2]).toMatchObject({kind:"agent",status:"assigned",scope:"Fix review findings",previousId:next.id});
    expect((await f.call("POST",`/api/v1/items/${item.key}/executions`,{kind:"agent",sessionId:"unknown-session",scope:"Must not guess sessions"})).statusCode).toBe(404);
expect(f.store.getWorkItem(item.key).status).toBe("in_progress");
  });
});
