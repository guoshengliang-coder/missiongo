import {afterEach,beforeEach,describe,expect,it,vi} from "vitest";
import {MissionGoStore} from "./store.js";
import {insightPeriod,projectInsights} from "./project-insights.js";
let store:MissionGoStore;
beforeEach(()=>{vi.useFakeTimers({toFake:["Date"]});vi.setSystemTime(new Date("2026-10-25T00:00:00Z"));store=new MissionGoStore(":memory:");});
afterEach(()=>{store.close();vi.useRealTimers();});
const at=(value:string)=>vi.setSystemTime(new Date(value));
const now=new Date("2026-10-27T02:00:00Z");
function seed() {
 const product=store.createProduct({name:"Project",keyPrefix:"PRJ"});
 const item=store.createWorkItem({productId:product.id,title:"Flow",description:"A requirement",type:"requirement",priority:"normal",environment:{platform:"web"}});
 const move=(to:"ready"|"in_progress"|"development_complete"|"pending_verification"|"done",reason:"triaged"|"claim"|"resolution_submitted"|"release_verified"|"verification_passed"|"verification_failed"|"reopened",note?:string)=>
   store.transitionWorkItem({itemKey:item.key,to,reason,actor:"human",...(note ? {note}: {})});
 return {product,item,move};
}
function summary(id:string) {const result=projectInsights(store,[id],{},now);if (!("projects" in result)) throw Error();return result.projects![0]!;}
describe("project flow metrics",()=>{
 it("uses local calendar boundaries including DST and validates impossible or future dates",()=>{
  expect(insightPeriod({},now)).toMatchObject({startDate:"2026-10-26",endDate:"2026-10-26",start:"2026-10-25T16:00:00.000Z",endExclusive:"2026-10-26T16:00:00.000Z"});
  const dst=insightPeriod({period:"custom",startDate:"2026-03-08",endDate:"2026-03-08",timezone:"America/New_York"},now);
  expect(Date.parse(dst.endExclusive)-Date.parse(dst.start)).toBe(23*3600000);
  expect(()=>insightPeriod({period:"custom",startDate:"2026-02-30",endDate:"2026-03-01"},now)).toThrow();
  expect(()=>insightPeriod({period:"custom",startDate:"2027-01-01",endDate:"2027-01-01"},now)).toThrow();
 });
 it("counts human completions once, preserves yesterday's completion when reopened today and separates current backlog",()=>{
  const {product,move,item}=seed();move("ready","triaged");move("in_progress","claim");
  at("2026-10-26T00:00:00Z");move("development_complete","resolution_submitted");move("pending_verification","release_verified");
  at("2026-10-26T04:00:00Z");move("done","verification_passed");
  at("2026-10-27T00:00:00Z");move("ready","reopened","Regression");
  const result=summary(product.id);
  expect(result.counts).toMatchObject({created:0,completed:1,development_complete:1,pending_verification:1,backlog:1});
  expect(result.periodEndByStatus.done).toBe(1);expect(result.currentByStatus.ready).toBe(1);
  expect(result.deliveryCycle).toMatchObject({sampleCount:1,medianHours:28,p90Hours:null});
  const details=projectInsights(store,[product.id],{},now,{metric:"completed"});
  expect("items" in details && details.items?.[0]).toMatchObject({itemKey:item.key,currentStatus:"ready",periodEndStatus:"done"});
 });
 it("counts decided verification rounds, excluding pending verification and manual returns",()=>{
  const {product,move}=seed();move("ready","triaged");move("in_progress","claim");
  at("2026-10-26T00:00:00Z");move("development_complete","resolution_submitted");move("pending_verification","release_verified");
  move("ready","verification_failed","Still fails");move("in_progress","claim");move("development_complete","resolution_submitted");move("pending_verification","release_verified");
  move("ready","verification_failed","Again");move("in_progress","claim");move("development_complete","resolution_submitted");move("pending_verification","release_verified");move("done","verification_passed");
  expect(summary(product.id).verificationReturnRate).toEqual({failedRounds:2,passedRounds:1,decidedRounds:3,rate:2/3});
  expect(summary(product.id).counts.returned).toBe(1);
 });
 it("reports missing historical timestamps instead of inventing a cycle",()=>{
  const {product,item,move}=seed();move("ready","triaged");move("in_progress","claim");
  at("2026-10-26T00:00:00Z");move("development_complete","resolution_submitted");move("pending_verification","release_verified");move("done","verification_passed");
  store.database.connection.prepare("DELETE FROM work_item_events WHERE item_id=? AND event_type='item_created'").run(item.id);
  expect(summary(product.id).deliveryCycle).toMatchObject({sampleCount:0,eligibleCount:1,missingCount:1,medianHours:null});
  expect(summary(product.id).quality.estimatedEventTimes).toBe(2);
 });
 it("separates projects, applies filters and paginates drilldowns without reading attachments",()=>{
  const {product}=seed();at("2026-10-26T00:00:00Z");
  for(let i=0;i<3;i++)store.createWorkItem({productId:product.id,title:`Bug ${i}`,description:"x",type:"bug",priority:"normal",environment:{platform:"web"}});
  const other=store.createProduct({name:"Other",keyPrefix:"OTH"});store.createWorkItem({productId:other.id,title:"Private",description:"x",type:"bug",priority:"normal",environment:{platform:"web"}});
  const result=projectInsights(store,[product.id],{types:["bug"]},now,{metric:"created",limit:2});
  expect(result).toMatchObject({total:3,nextOffset:2});
  expect("items" in result && result.items?.every(r=>r.productId===product.id)).toBe(true);
  expect(projectInsights(store,[],{},now)).toMatchObject({projects:[]});
 });
});

describe("Web statistics and shared aggregates (AND-297)",()=>{
 it("reconstructs daily backlog and keeps daily completion dedup separate from period dedup",()=>{
  const {product,move}=seed();move("ready","triaged");move("in_progress","claim");
  at("2026-10-25T16:30:00Z");move("development_complete","resolution_submitted");move("pending_verification","release_verified");move("done","verification_passed");
  at("2026-10-26T16:15:00Z");move("ready","reopened","Regression");move("in_progress","claim");move("development_complete","resolution_submitted");move("pending_verification","release_verified");move("done","verification_passed");
  const query={period:"custom" as const,startDate:"2026-10-25",endDate:"2026-10-27",includeTrend:true};
  const result=projectInsights(store,[product.id],query,now);
  expect(result.aggregate.counts).toMatchObject({created:1,completed:1,backlog:0,period_end_backlog:0});
  expect(result.aggregate.trend).toEqual([
   {date:"2026-10-25",created:1,completed:0,backlog:1,unknownStatusCount:0},
   {date:"2026-10-26",created:0,completed:1,backlog:0,unknownStatusCount:0},
   {date:"2026-10-27",created:0,completed:1,backlog:0,unknownStatusCount:0},
  ]);
  expect(projectInsights(store,[product.id],{period:"custom",startDate:"2026-10-25",endDate:"2026-10-25"},now,{metric:"period_end_backlog"})).toMatchObject({total:1});
  expect(projectInsights(store,[product.id],{},now,{metric:"backlog"})).toMatchObject({total:0});
 });
 it("computes aggregate percentiles from the combined samples, never the project medians",()=>{
  const first=store.createProduct({name:"One large sample",keyPrefix:"ONE"});
  const second=store.createProduct({name:"Several samples",keyPrefix:"MNY"});
  const finish=(productId:string,hours:number)=>{
   at(new Date(Date.parse("2026-10-26T12:00:00Z")-hours*3600000).toISOString());
   const item=store.createWorkItem({productId,title:`${hours} hours`,description:"Timing",type:"task",priority:"normal",environment:{platform:"web"}});
   store.transitionWorkItem({itemKey:item.key,to:"ready",reason:"triaged",actor:"human"});store.claimWorkItem({itemKey:item.key,agentId:"test",idempotencyKey:`claim-${item.key}`});
   at("2026-10-26T12:00:00Z");
   for(const [to,reason] of [["development_complete","resolution_submitted"],["pending_verification","release_verified"],["done","verification_passed"]] as const)store.transitionWorkItem({itemKey:item.key,to,reason,actor:"human"});
  };
  finish(first.id,100);for(const hours of [1,2,3])finish(second.id,hours);
  const summary=projectInsights(store,[first.id,second.id],{},now);
  expect(summary.aggregate.deliveryCycle).toMatchObject({sampleCount:4,medianHours:2.5,p90Hours:null});
  for(const hours of [4,5,6,7,8,9])finish(second.id,hours);
  const combined=projectInsights(store,[first.id,second.id],{},now);
  expect(combined.aggregate.deliveryCycle.sampleCount).toBe(10);expect(combined.aggregate.deliveryCycle.p90Hours).toBeCloseTo(18.1);
  expect(combined.aggregate.verificationReturnRate).toEqual({failedRounds:0,passedRounds:10,decidedRounds:10,rate:0});
 });
 it("expands repeated returns and exposes both cycle samples in the same item rows",()=>{
  const {product,move,item}=seed();move("ready","triaged");move("in_progress","claim");
  at("2026-10-26T00:00:00Z");
  for(let i=0;i<2;i++){move("development_complete","resolution_submitted");move("pending_verification","release_verified");move("ready","verification_failed","Still failing");move("in_progress","claim");}
  at("2026-10-26T04:00:00Z");move("development_complete","resolution_submitted");move("pending_verification","release_verified");move("done","verification_passed");
  const result=projectInsights(store,[product.id],{},now,{metric:"repeat_returned"});
  expect(result.total).toBe(1);expect(result.items[0]).toMatchObject({itemKey:item.key,verificationFailuresInPeriod:2,verificationFailuresTotal:2,developmentHours:4,deliveryHours:28});
  expect(projectInsights(store,[product.id],{},now).aggregate.counts.repeat_returned).toBe(1);
 });
 it("keeps unknown historical state visible in trends instead of treating missing history as zero coverage",()=>{
  const {product,item}=seed();
  store.database.connection.prepare("DELETE FROM work_item_events WHERE item_id=?").run(item.id);
  const result=projectInsights(store,[product.id],{includeTrend:true},now);
  expect(result.aggregate.trend).toMatchObject([{date:"2026-10-26",backlog:0,unknownStatusCount:1}]);
  expect(result.aggregate.quality).toMatchObject({missingCreationEvents:1,unknownPeriodEnd:1});
  expect(result.aggregate.counts).toMatchObject({backlog:1,period_end_backlog:0});
  const empty=projectInsights(store,[],{includeTrend:true},now);
  expect(empty.aggregate.counts.completed).toBe(0);expect(empty.aggregate.deliveryCycle.medianHours).toBeNull();
 });
});
