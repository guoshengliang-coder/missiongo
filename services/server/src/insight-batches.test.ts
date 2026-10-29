import { beforeEach,afterEach,describe,it,expect,vi } from "vitest";
import { MissionGoStore } from "./store.js";
import { createInsightBatch,insightBatchProgress,listInsightBatches,listInsightBatchSummaries,deleteInsightBatch } from "./insight-batches.js";
let store: MissionGoStore;
beforeEach(()=>{vi.useFakeTimers({toFake:["Date"]});vi.setSystemTime(new Date("2026-10-01T00:00:00Z"));store=new MissionGoStore(":memory:");});
afterEach(()=>{store.close();vi.useRealTimers();});
const at=(value:string)=>vi.setSystemTime(new Date(value));
function fixture(count=10){
 const product=store.createProduct({name:"Batch project",keyPrefix:"BCH"});
 const items=Array.from({length:count},(_,index)=>store.createWorkItem({productId:product.id,title:`Request ${index+1}`,description:"Batch fixture",type:"task",priority:"normal",status:"ready",environment:{platform:"web"}}));
 const batch=createInsightBatch(store,"owner","First delivery",items.map(item=>({itemId:item.id,itemKey:item.key})));
 const deliver=(itemKey:string)=>{store.transitionWorkItem({itemKey,to:"in_progress",reason:"claim",actor:"human"});store.transitionWorkItem({itemKey,to:"development_complete",reason:"resolution_submitted",actor:"human"});store.transitionWorkItem({itemKey,to:"pending_verification",reason:"release_verified",actor:"human"});};
 return {product,items,batch,deliver};
}
describe("fixed delivery batches",()=>{
 it("keeps fixed membership and counts delivered, processing, waiting and paused with cancellation separate",()=>{
  const {product,items,batch,deliver}=fixture();at("2026-10-03T00:00:00Z");items.slice(0,6).forEach(item=>deliver(item.key));
  store.transitionWorkItem({itemKey:items[6]!.key,to:"in_progress",reason:"claim",actor:"human"});
  store.transitionWorkItem({itemKey:items[7]!.key,to:"on_hold",reason:"request_human_input",actor:"human",note:"Later"});
  let progress=insightBatchProgress(store,"owner",batch.id,[product.id]);
  expect(progress).toMatchObject({total:10,effective:10,delivered:6,processing:1,waiting:2,paused:1,cancelled:0,deliveryRate:0.6});
  store.createWorkItem({productId:product.id,title:"Not in batch",description:"Later",type:"task",priority:"low",environment:{platform:"web"}});
  store.transitionWorkItem({itemKey:items[8]!.key,to:"cancelled",reason:"cancelled",actor:"human",note:"Duplicate"});
  store.transitionWorkItem({itemKey:items[0]!.key,to:"ready",reason:"verification_failed",actor:"human",note:"Returned"});
  progress=insightBatchProgress(store,"owner",batch.id,[product.id]);
  expect(progress).toMatchObject({total:10,effective:9,delivered:5,waiting:2,cancelled:1});expect(progress.deliveryRate).toBeCloseTo(5/9);
  expect(progress.items).toHaveLength(10);
  expect(listInsightBatchSummaries(store,"owner",[product.id])[0]).toMatchObject({id:batch.id,itemCount:10,effective:9,delivered:5,unavailable:0,deliveryRate:progress.deliveryRate});
 });
 it("uses status at each receipt deadline; later returns or cancellations do not rewrite observed history",()=>{
  const {product,items,batch,deliver}=fixture(3);at("2026-10-03T00:00:00Z");deliver(items[0]!.key);
  store.transitionWorkItem({itemKey:items[1]!.key,to:"cancelled",reason:"cancelled",actor:"human",note:"Duplicate"});
  at("2026-10-10T00:00:00Z");store.transitionWorkItem({itemKey:items[0]!.key,to:"ready",reason:"verification_failed",actor:"human",note:"Returned"});
  at("2026-10-20T00:00:00Z");const progress=insightBatchProgress(store,"owner",batch.id,[product.id]);
  expect(progress.milestones).toEqual([
   {days:7,delivered:1,eligible:2,immature:0,cancelled:1,unknown:0,rate:0.5},
   {days:14,delivered:0,eligible:2,immature:0,cancelled:1,unknown:0,rate:0},
  ]);
 });
 it("distinguishes immature, unavailable and missing history without shrinking the saved batch",()=>{
  const {product,items,batch}=fixture(2);
  expect(insightBatchProgress(store,"owner",batch.id,[product.id]).milestones[0]).toMatchObject({eligible:0,immature:2,rate:null});
  at("2026-10-20T00:00:00Z");store.database.connection.prepare("DELETE FROM work_item_events WHERE item_id=?").run(items[0]!.id);
  expect(insightBatchProgress(store,"owner",batch.id,[product.id]).milestones[0]).toMatchObject({eligible:1,unknown:1,rate:null});
  expect(insightBatchProgress(store,"owner",batch.id,[])).toMatchObject({total:2,effective:2,unavailable:2,deliveryRate:null,items:[]});
  expect(listInsightBatchSummaries(store,"owner",[])).toEqual([{...batch,effective:2,delivered:0,unavailable:2,deliveryRate:null}]);
 });
 it("isolates account ownership and removes only the saved report",()=>{
  const {product,items,batch}=fixture(1);
  expect(listInsightBatches(store,"other")).toEqual([]);
  expect(listInsightBatchSummaries(store,"other",[product.id])).toEqual([]);
  expect(()=>insightBatchProgress(store,"other",batch.id,[product.id])).toThrow();
  expect(()=>deleteInsightBatch(store,"other",batch.id)).toThrow();
  deleteInsightBatch(store,"owner",batch.id);expect(listInsightBatches(store,"owner")).toEqual([]);
  expect(store.getWorkItem(items[0]!.key).id).toBe(items[0]!.id);
 });
});
