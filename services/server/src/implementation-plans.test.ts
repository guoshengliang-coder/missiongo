import { afterEach, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MissionGoStore } from "./store.js";
import { ImplementationPlans } from "./implementation-plans.js";
const stores:MissionGoStore[]=[];
afterEach(()=>{for(const store of stores.splice(0)) store.close();});
function fixture(path=":memory:") {
 const store=new MissionGoStore(path);stores.push(store);
 const product=store.createProduct({name:"Plans",keyPrefix:"PLAN"});
 const item=store.createWorkItem({productId:product.id,status:"ready",type:"task",title:"Implement scoped work",description:"Current scope",priority:"normal",environment:{platform:"shared"}});
 return {store,item,plans:new ImplementationPlans(store.database)};
}
it("denies unapproved claims, wrong owners, other sessions and a widened batch",()=>{
 const {plans,item}=fixture();
 expect(()=>plans.assertClaim("owner","conversation",item.key)).toThrow(/approve/);
 plans.record({accountId:"owner",identity:"conversation",revision:"v1",planHash:"plan",keys:[item.key],source:"native"});
 expect(()=>plans.assertClaim("owner","conversation",item.key)).not.toThrow();
 expect(()=>plans.assertClaim("other","conversation",item.key)).toThrow();
 expect(()=>plans.assertClaim("owner","other-session",item.key)).toThrow();
 expect(()=>plans.assertClaim("owner","conversation","PLAN-999")).toThrow();
});
it("invalidates changed requirements and superseded proposals without treating chat or mode changes as approval",()=>{
 const {plans,item,store}=fixture();
 plans.record({accountId:"owner",identity:"conversation",revision:"v1",planHash:"plan",keys:[item.key],source:"web"});
 plans.request("owner","conversation","v2");
 expect(()=>plans.assertClaim("owner","conversation",item.key)).toThrow();
 expect(()=>plans.assertRequest("owner","conversation","v1")).toThrow(/newer/);
 plans.record({accountId:"owner",identity:"conversation",revision:"v2",planHash:"new plan",keys:[item.key],source:"web"});
 store.database.connection.prepare("UPDATE work_items SET content_version=content_version+1 WHERE id=?").run(item.id);
 expect(()=>plans.assertClaim("owner","conversation",item.key)).toThrow();
});
it("retains the approval after a real database restart and keeps its original human provenance",()=>{
 const root=mkdtempSync(join(tmpdir(),"implementation-plan-"));
 const path=join(root,"plans.sqlite");
 try {
  const {plans,item,store}=fixture(path);
  plans.record({accountId:"owner",identity:"conversation",revision:"v1",planHash:"plan",keys:[item.key],source:"web",commandId:"approved-command"});
  store.close();stores.splice(stores.indexOf(store),1);
  const reopened=new MissionGoStore(path);stores.push(reopened);
  const next=new ImplementationPlans(reopened.database);
  expect(()=>next.assertClaim("owner","conversation",item.key)).not.toThrow();
  expect(next.commandRevision("approved-command")).toBe("v1");
  expect(reopened.database.connection.prepare("SELECT source FROM implementation_plan_approvals").get()).toMatchObject({source:"web"});
  reopened.close();stores.splice(stores.indexOf(reopened),1);
 } finally {rmSync(root,{recursive:true,force:true});}
});

it.each(["accept","decline","cancel"] as const)("native approval uses the source elicitation result (%s)",async action=>{
 const {requestNativePlanApproval}=await import("./implementation-plans.js");
 const {vi}=await import("vitest");
 const elicitInput=vi.fn(async()=>({action,content:{}}));
 const ctx={mcpReq:{elicitInput}} as unknown as import("@modelcontextprotocol/server").ServerContext;
 expect(await requestNativePlanApproval(ctx,"Exact plan and validation goals","version-1")).toBe(action==="accept");
 expect(elicitInput).toHaveBeenCalledWith(expect.objectContaining({message:"Exact plan and validation goals",_meta:{"missiongo/planApproval":"version-1"}}));
});
