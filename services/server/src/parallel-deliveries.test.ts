import {afterEach,expect,it} from "vitest";
import {randomUUID} from "node:crypto";
import {MissionGoStore} from "./store.js";
import {seedStoreActors} from "./testing-fixtures.js";
import {deliveryRound} from "./delivery-round.js";
const stores:MissionGoStore[]=[];
afterEach(()=>stores.splice(0).forEach(s=>s.close()));
function fixture(){
 const store=new MissionGoStore(":memory:");stores.push(store);seedStoreActors(store,["owner"]);
 const product=store.createProduct({name:"Parallel",keyPrefix:"PAR"});
 const item=store.createWorkItem({productId:product.id,title:"Parallel",description:"Test",type:"task",priority:"normal",status:"ready",environment:{platform:"web"}});
 const claim=(identity:string)=>store.claimWorkItem({itemKey:item.key,agentId:"Codex",executionIdentity:identity,attribution:{accountId:"owner"},idempotencyKey:randomUUID()});
 const complete=(n:number, scoped=true)=>store.submitDevelopmentComplete({itemKey:item.key,completion:{kind:"commit",commit:String(n).repeat(40),targetBranch:"main"},...(scoped ? {requiredArtifacts:["web","macosApp"]} : {}),attribution:{accountId:"owner"},idempotencyKey:randomUUID()});
 const publish=(id:string,n:number,artifacts=["web","macosApp"])=>store.submitForVerification({itemKey:item.key,developmentEventId:id,completion:{kind:"commit",commit:String(n).repeat(40),targetBranch:"main"},releases:artifacts.map(artifact=>({artifact,version:`1.${n}`,sourceCommit:String(n).repeat(40)})),deployedCommit:String(n).repeat(40),receiptDigest:String(n).repeat(64),attribution:{accountId:"owner"},idempotencyKey:randomUUID()});
 return {store,item,claim,complete,publish};
}
it("joins without changing Builder/round or revoking an earlier credential",()=>{
 const f=fixture();f.claim("native:a");const round=deliveryRound(f.store.database,f.item.id,true);
 f.store.database.connection.prepare("INSERT INTO builder_execution_authorizations(id,item_id,account_id,client_id,created_at,round_key) VALUES ('credential',?,'owner','client',?,?)").run(f.item.id,new Date().toISOString(),round);
 f.claim("native:b");
 expect(deliveryRound(f.store.database,f.item.id,true)).toBe(round);
 expect(f.store.getWorkItem(f.item.key).builderAccountId).toBe("owner");
 expect(f.store.database.connection.prepare("SELECT revoked FROM builder_execution_authorizations WHERE id='credential'").get()).toMatchObject({revoked:0});
 expect(f.store.getTimeline(f.item.key).filter(e=>e.eventType==="execution_joined")).toHaveLength(1);
});
it("appends integrations and partial publication without rewinding verification or applying stale acceptance",()=>{
 const f=fixture();f.claim("native:a");f.claim("native:b");f.complete(1);
 const first=f.store.getDeliveryRecords(f.item.key)[0]!;f.publish(first.id,1);
 const revision=f.store.getWorkItem(f.item.key).revision;
 expect(f.store.getWorkItem(f.item.key).status).toBe("pending_verification");
 expect(()=>f.claim("native:c")).toThrow();
 f.complete(2);const second=f.store.getDeliveryRecords(f.item.key)[1]!;
 expect(f.store.getWorkItem(f.item.key).status).toBe("pending_verification");
 expect(()=>f.store.transitionWorkItem({itemKey:f.item.key,to:"done",actor:"human",reason:"verification_passed",expectedRevision:revision,attribution:{accountId:"owner"}})).toThrow();
 f.publish(second.id,2,["web"]);
 expect(f.store.getDeliveryRecords(f.item.key)[1]).toMatchObject({status:"partial",published:false});
 const partialRevision=f.store.getWorkItem(f.item.key).revision;
 f.publish(second.id,2,["web"]);expect(f.store.getWorkItem(f.item.key).revision).toBe(partialRevision);
 expect(()=>f.store.submitForVerification({itemKey:f.item.key,developmentEventId:second.id,completion:second.completion!,releases:[{artifact:"web",version:"older",sourceCommit:"1".repeat(40)}],deployedCommit:"1".repeat(40),receiptDigest:"1".repeat(64),attribution:{accountId:"owner"},idempotencyKey:randomUUID()})).toThrow(/Conflicting/);
 const accept = () => f.store.transitionWorkItem({itemKey:f.item.key,to:"done",actor:"human",reason:"verification_passed",
   expectedRevision:partialRevision,attribution:{accountId:"owner"},idempotencyKey:"accept-partial"});
 expect(accept().status).toBe("done");
 expect(accept().status).toBe("done");
 const decision=f.store.getTimeline(f.item.key).at(-1);
 expect(decision?.payload).toMatchObject({acceptedRevision:partialRevision,verificationDeliveryGaps:[
   {developmentEventId:second.id,missingScope:false,missingArtifacts:["macosApp"]},
 ]});
 expect(f.store.listWorkItems({productId:f.item.productId,releaseCandidates:true}).map(item=>item.key)).toContain(f.item.key);
 f.publish(second.id,2,["macosApp"]);
 expect(f.store.getDeliveryRecords(f.item.key).map(d=>d.published)).toEqual([true,true]);
 expect(f.store.getWorkItem(f.item.key).status).toBe("done");
 expect(f.store.getTimeline(f.item.key).find(event=>event.id===decision?.id)).toEqual(decision);
});
it("publishes two frozen candidates of one item in a batch without dropping either",()=>{
 const f=fixture();f.claim("native:a");f.complete(1);f.complete(2);
 const revision=f.store.getWorkItem(f.item.key).revision;
 const records=f.store.getDeliveryRecords(f.item.key);
 const input={productId:f.item.productId,deployedCommit:"2".repeat(40),receiptDigest:"2".repeat(64),idempotencyKey:randomUUID(),attribution:{accountId:"owner"},items:records.map((record,i)=>({itemKey:f.item.key,expectedRevision:revision,developmentEventId:record.id,roundKey:record.roundKey!,completion:record.completion!,releases:["web","macosApp"].map(artifact=>({artifact,version:`1.${i+1}`,sourceCommit:"2".repeat(40)}))}))};
 const result=f.store.submitReleaseBatch(input);
 expect(result.results.map(row=>row.outcome)).toEqual(["submitted","submitted"]);
 expect(f.store.getDeliveryRecords(f.item.key).map(row=>row.published)).toEqual([true,true]);
 expect(f.store.submitReleaseBatch(input).results.map(row=>row.outcome)).toEqual(["already_submitted","already_submitted"]);
});


it.each([false,true])("preserves exact evidence repair in either batch order (unscoped first: %s)", (unscopedFirst) => {
 const f=fixture();
 f.claim("native:a");
 f.complete(1,false);
 f.complete(2);
 f.complete(3);
 const [unscoped,formal,additional]=f.store.getDeliveryRecords(f.item.key);
 f.publish(formal!.id,2);
 const accept=f.store.getWorkItem(f.item.key);
 expect(f.store.transitionWorkItem({itemKey:f.item.key,to:"done",actor:"human",reason:"verification_passed",
   expectedRevision:accept.revision,attribution:{accountId:"owner"}}).status).toBe("done");
 const current=f.store.getWorkItem(f.item.key);
 const items=[{
     itemKey:f.item.key,expectedRevision:current.revision!,developmentEventId:additional!.id,roundKey:additional!.roundKey!,
     completion:additional!.completion!,releases:["web","macosApp"].map(artifact=>({artifact,version:"1.3",sourceCommit:"a".repeat(40)})),
   },{
     itemKey:f.item.key,expectedRevision:current.revision!,developmentEventId:unscoped!.id,roundKey:unscoped!.roundKey!,
     completion:unscoped!.completion!,releases:[{artifact:"web",version:"1.3",sourceCommit:"a".repeat(40)}],
   }];
 const result=f.store.submitReleaseBatch({productId:f.item.productId,idempotencyKey:"repair-after-acceptance",
   deployedCommit:"a".repeat(40),receiptDigest:"b".repeat(64),attribution:{accountId:"owner"},items:unscopedFirst ? items.reverse() : items});
 expect(result.results).toEqual(items.map(() => ({itemKey:f.item.key,outcome:"submitted",currentStatus:"done"})));
 expect(f.store.getDeliveryRecords(f.item.key)).toMatchObject([
   {id:unscoped!.id,requiredArtifacts:["web"],published:true},
   {id:formal!.id,requiredArtifacts:["macosApp","web"],published:true},
   {id:additional!.id,requiredArtifacts:["macosApp","web"],published:true},
 ]);
});


it("records late no-release evidence without repeating the human decision", () => {
 const f=fixture();
 f.claim("native:a");
 const completion={kind:"commit" as const,commit:"a".repeat(40),targetBranch:"main"};
 f.store.submitDevelopmentComplete({itemKey:f.item.key,completion,requiredArtifacts:[],noReleaseReason:"Local verification only",
   idempotencyKey:"complete-without-release",attribution:{accountId:"owner"}});
 f.store.transitionWorkItem({itemKey:f.item.key,to:"pending_verification",actor:"human",reason:"release_verified",attribution:{accountId:"owner"}});
 f.store.transitionWorkItem({itemKey:f.item.key,to:"done",actor:"human",reason:"verification_passed",
   expectedRevision:f.store.getWorkItem(f.item.key).revision,attribution:{accountId:"owner"}});
 const evidence=f.store.getDevelopmentEvidence(f.item.key);
 const result=f.store.submitNonReleaseForVerification({itemKey:f.item.key,completion,
   expectedRevision:f.store.getWorkItem(f.item.key).revision,developmentEventId:evidence.handover!.id,roundKey:evidence.roundKey!,
   evidenceDigest:evidence.handover!.payload.evidenceDigest as string,
   validation:{checks:[{name:"Local check",method:"Fixture",result:"passed",evidence:"Exact commit"}],remainingVerification:[],limitations:[]},
   idempotencyKey:"late-no-release-proof",attribution:{accountId:"owner"}});
 expect(result.status).toBe("done");
 expect(f.store.getDeliveryRecords(f.item.key)[0]).toMatchObject({published:true,releases:[]});
 expect(f.store.getTimeline(f.item.key).filter(event=>event.toStatus==="done")).toHaveLength(1);
});


it("keeps publication candidates after a direct human status correction to done", () => {
 const f=fixture();
 f.claim("native:a");
 f.complete(1);
 const before=f.store.getWorkItem(f.item.key);
 expect(f.store.transitionWorkItem({itemKey:f.item.key,to:"done",actor:"human",reason:"manual_override",
   note:"Acceptance recorded by the project administrator",expectedRevision:before.revision,attribution:{accountId:"owner"}}).status).toBe("done");
 expect(f.store.listWorkItems({productId:f.item.productId, releaseCandidates:true}).map(item=>item.key)).toContain(f.item.key);
 expect(f.store.getTimeline(f.item.key).at(-1)?.payload.verificationDeliveryGaps).toHaveLength(1);
});
