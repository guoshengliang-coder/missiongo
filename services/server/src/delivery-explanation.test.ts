import {afterEach,expect,it} from "vitest";
import {randomUUID} from "node:crypto";
import {MissionGoStore} from "./store.js";
import {seedStoreActors} from "./testing-fixtures.js";
import {deliveryExplanation} from "./delivery-explanation.js";

const stores:MissionGoStore[]=[];
afterEach(()=>stores.splice(0).forEach(store=>store.close()));
function fixture(artifacts?:string[]) {
  const store=new MissionGoStore(":memory:");stores.push(store);seedStoreActors(store,["owner"]);
  const product=store.createProduct({name:"Delivery explanation",keyPrefix:"EXP"});
  const item=store.createWorkItem({productId:product.id,title:"Explain evidence",description:"Scope",type:"task",priority:"normal",status:"ready",environment:{platform:"web"}});
  store.claimWorkItem({itemKey:item.key,agentId:"Codex",executionIdentity:"native:original",attribution:{accountId:"owner"},idempotencyKey:randomUUID()});
  const completion={kind:"commit" as const,commit:"a".repeat(40),targetBranch:"main"};
  const complete=()=>store.submitDevelopmentComplete({itemKey:item.key,completion,...(artifacts?{requiredArtifacts:artifacts}:{}),
    ...(artifacts?.length===0?{noReleaseReason:"Only documentation"}:{}),attribution:{accountId:"owner"},idempotencyKey:randomUUID()});
  const move=(to:"pending_verification"|"ready"|"done"|"cancelled",reason:"manual_override"|"verification_failed"|"verification_passed"|"reopened"|"released")=>
    store.transitionWorkItem({itemKey:item.key,to,reason,actor:"human",note:"Synthetic decision",attribution:{accountId:"owner"}});
  return {store,item,completion,complete,move};
}
it("does not create empty history and explains unknown or no-release scope separately",()=>{
  const f=fixture();expect(deliveryExplanation(f.store,f.item.key)).toBeUndefined();
  f.complete();expect(deliveryExplanation(f.store,f.item.key)).toMatchObject({applicability:"current",missing:["release_scope"],missingArtifacts:[]});
  const noRelease=fixture([]);noRelease.complete();
  expect(deliveryExplanation(noRelease.store,noRelease.item.key)).toMatchObject({missing:["no_release_verification"],missingArtifacts:[]});
});
it("reports remaining artifacts after partial publication without changing any evidence",()=>{
  const f=fixture(["web","macosApp"]);f.complete();
  const event=f.store.getDevelopmentEvidence(f.item.key).handover!;
  f.store.submitForVerification({itemKey:f.item.key,developmentEventId:event.id,completion:f.completion,releases:[{artifact:"web",version:"1",sourceCommit:"a".repeat(40)}],
    deployedCommit:"a".repeat(40),receiptDigest:"a".repeat(64),attribution:{accountId:"owner"},idempotencyKey:randomUUID()});
  const before=f.store.getTimeline(f.item.key);
  expect(deliveryExplanation(f.store,f.item.key)).toMatchObject({developmentEventId:event.id,applicability:"current",missing:[],missingArtifacts:["macosApp"]});
  expect(f.store.getTimeline(f.item.key)).toEqual(before);
  expect(f.store.getWorkItem(f.item.key).status).toBe("development_complete");
});
it.each(["verification_failed","reopened","cancelled","scope_changed","builder_changed"] as const)("explains %s without restoring an old delivery",reason=>{
  const f=fixture(["web"]);f.complete();const old=f.store.getDevelopmentEvidence(f.item.key).handover!;
  if(reason==="verification_failed"){f.move("pending_verification","manual_override");f.move("ready","verification_failed");}
  if(reason==="reopened"){f.move("pending_verification","manual_override");f.move("done","verification_passed");f.move("ready","reopened");}
  if(reason==="cancelled")f.move("cancelled","manual_override");
  if(reason==="scope_changed")f.store.updateWorkItem(f.item.key,{description:"New scope",attribution:{accountId:"owner"}});
  if(reason==="builder_changed")f.store.recordDeliveryEvent(f.item.key,"owner","builder_changed",{handoverId:randomUUID()});
  const before=f.store.getTimeline(f.item.key);
  expect(deliveryExplanation(f.store,f.item.key)).toMatchObject({developmentEventId:old.id,applicability:"historical",reason,missingArtifacts:[]});
  expect(f.store.getTimeline(f.item.key)).toEqual(before);
  expect(f.store.getTimeline(f.item.key).find(event=>event.id===old.id)).toEqual(old);
});
it("ordinary manual moves keep the evidence current, while a newly claimed round requires new evidence",()=>{
  const f=fixture(["web"]);f.complete();f.move("ready","released");
  expect(deliveryExplanation(f.store,f.item.key)?.applicability).toBe("current");
  f.store.claimWorkItem({itemKey:f.item.key,agentId:"Codex",executionIdentity:"native:new",attribution:{accountId:"owner"},idempotencyKey:randomUUID()});
  expect(deliveryExplanation(f.store,f.item.key)).toMatchObject({applicability:"historical",reason:"round_changed"});
  f.complete();expect(deliveryExplanation(f.store,f.item.key)).toMatchObject({applicability:"current",missingArtifacts:["web"]});
});
