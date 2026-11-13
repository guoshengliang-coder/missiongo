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
it("keeps approval scope separate from claiming responsibility",()=>{
 const {plans,item}=fixture();
 expect(()=>plans.assertApprovedScope("owner","conversation",item.key)).toThrow(/approval/);
 plans.record({accountId:"owner",identity:"conversation",revision:"v1",planHash:"plan",keys:[item.key],source:"native"});
 expect(()=>plans.assertApprovedScope("owner","conversation",item.key)).not.toThrow();
 expect(()=>plans.assertApprovedScope("other","conversation",item.key)).toThrow();
 expect(()=>plans.assertApprovedScope("owner","other-session",item.key)).toThrow();
 expect(()=>plans.assertApprovedScope("owner","conversation","PLAN-999")).toThrow();
});
it("invalidates changed requirements and superseded proposals without treating chat or mode changes as approval",()=>{
 const {plans,item,store}=fixture();
 plans.record({accountId:"owner",identity:"conversation",revision:"v1",planHash:"plan",keys:[item.key],source:"web"});
 plans.request("owner","conversation","v2");
 expect(()=>plans.assertApprovedScope("owner","conversation",item.key)).toThrow();
 expect(()=>plans.assertRequest("owner","conversation","v1")).toThrow(/newer/);
 plans.record({accountId:"owner",identity:"conversation",revision:"v2",planHash:"new plan",keys:[item.key],source:"web"});
 store.database.connection.prepare("UPDATE work_items SET content_version=content_version+1 WHERE id=?").run(item.id);
 expect(()=>plans.assertApprovedScope("owner","conversation",item.key)).toThrow();
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
  expect(()=>next.assertApprovedScope("owner","conversation",item.key)).not.toThrow();
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

it("keeps each proposal's submission time stable and returns legacy approval time without inventing submission",()=>{
 const {plans,item,store}=fixture();
 const proposal={keys:[item.key],plan:"Reviewed proposal",validation:"Verify chronology"};
 plans.request("owner","conversation","v1",proposal);
 const submitted=plans.proposal("owner","conversation")!.submittedAt;
 expect(Number.isFinite(Date.parse(submitted!))).toBe(true);
 plans.request("owner","conversation","v1",proposal);
 plans.record({accountId:"owner",identity:"conversation",revision:"v1",planHash:"v1",keys:[item.key],source:"web"});
 expect(plans.proposal("owner","conversation")).toMatchObject({submittedAt:submitted,approvedAt:expect.any(String),approved:true});
 // Existing requests predate submission metadata; the persisted approval remains the ordering boundary.
 store.database.connection.prepare("UPDATE implementation_plan_requests SET proposal_json=? WHERE account_id=? AND identity_key=?")
  .run(JSON.stringify(proposal),"owner","conversation");
 expect(plans.proposal("owner","conversation")!.submittedAt).toBeUndefined();
 expect(plans.proposal("owner","conversation")!.approvedAt).toEqual(expect.any(String));
 plans.request("owner","conversation","v2",proposal);
 expect(plans.proposal("owner","conversation")!.approvedAt).toBeUndefined();
});

it("batches metadata with the same live scope, approval and document-round semantics as full proposals",async()=>{
 const {PlanDocuments}=await import("./plan-documents.js");
 const {vi}=await import("vitest");
 const {plans,item,store}=fixture();
 const document=new PlanDocuments(store).prepare({accountId:"owner",identity:"document",keys:[item.key],summary:"Reviewed",markdown:"Reviewed\n"+"正文".repeat(10000),origin:"https://fixture.example.test",requestKey:"doc"});
 const identities=Array.from({length:120},(_,i)=>`session-${i}`);
 for(const identity of identities) plans.request("owner",identity,"r1",{keys:[item.key,item.key],plan:"Long text ".repeat(4000),validation:"",documentId:document.id,origin:"native"});
 plans.record({accountId:"owner",identity:identities[1]!,revision:"r1",planHash:"r1",keys:[item.key],source:"web"});
 // A historical revision approval with a different hash is not current authority.
 plans.record({accountId:"owner",identity:identities[2]!,revision:"r1",planHash:"different-hash",keys:[item.key],source:"native"});
 const fields=(proposal:NonNullable<ReturnType<ImplementationPlans["proposal"]>>)=>({revision:proposal.revision,approved:proposal.approved,valid:proposal.valid,
  ...(proposal.origin?{origin:proposal.origin}:{}),...(proposal.approvedAt?{approvedAt:proposal.approvedAt}:{}),...(proposal.requestedAt?{requestedAt:proposal.requestedAt}:{}),...(proposal.nativeSourceId?{nativeSourceId:proposal.nativeSourceId}:{})});
 const compare=()=>{
  const prepare=vi.spyOn(store.database.connection,"prepare");
  const states=plans.listStates("owner",[...identities,"missing"]);
  expect(prepare.mock.calls.length).toBeLessThanOrEqual(3);prepare.mockRestore();
  expect(states.has("missing")).toBe(false);
  for(const identity of identities)expect(states.get(identity)).toEqual(fields(plans.proposal("owner",identity)!));
  expect(JSON.stringify([...states.values()])).not.toContain("Long text");
  expect(plans.listStates("outsider",identities).size).toBe(0);
  return states;
 };
 expect(compare().get(identities[0]!)?.valid).toBe(true);
 store.database.connection.prepare(`INSERT INTO work_item_events(id,item_id,event_type,actor_kind,from_status,to_status,payload_json,created_at)
  VALUES ('returned',?,'status_changed','human','pending_verification','ready','{"reason":"verification_failed"}',?)`).run(item.id,new Date().toISOString());
 const returned=compare();expect(returned.get(identities[0]!)?.valid).toBe(false);expect(returned.get(identities[1]!)?.approved).toBe(true);
 store.database.connection.prepare("UPDATE work_items SET content_version=content_version+1 WHERE id=?").run(item.id);
 expect(compare().get(identities[1]!)?.approved).toBe(false);
 plans.request("owner",identities[1]!,"r2",{keys:[item.key],plan:"Revised",validation:""});
 expect(compare().get(identities[1]!)?.approved).toBe(false);
});
