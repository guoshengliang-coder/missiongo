import { Worker } from "node:worker_threads";
import { createHash, randomUUID } from "node:crypto";
import { PERFORMANCE_BUCKETS, validPerformanceEvent, type ConsolePerformanceEvent } from "@missiongo/domain";

export interface PerformanceScope { account: string; products: readonly string[]; agent?: string; kind?: string }
export interface PerformanceRecord extends ConsolePerformanceEvent { scope: PerformanceScope; source: "web" | "server" | "macos" | "linux"; version: string; operation?: string }
export const performanceKey = (...parts: string[]) => createHash("sha256").update(JSON.stringify(parts)).digest("hex");
/** No filesystem or SQLite work runs on the request thread. All failure paths are fail-open. */
export class ConsolePerformance {
 private worker?: Worker;
 private outstanding=0;
 private ready=false;
 private stopped=false;
 private failed=false;
 private dropped=0;
 private accepted=0;
 private duplicates=0;
 private persistedDrops=0;
 private waiting = new Map<string,{resolve:(v:any)=>void;timer:ReturnType<typeof setTimeout>}>();
 private heartbeat?: ReturnType<typeof setInterval>;
 private watchdog?: ReturnType<typeof setInterval>;
 private lastAck=Date.now();
 private ownDrops=new Map<string,{account:string;products:string[];n:number}>();
 constructor(path: string, readonly version="unknown", enabled=true, maxBytes?: number, readonly sampleKind:"production"|"synthetic"="synthetic") {
  if(!enabled){this.stopped=true;return;}
  try {
   const extension=import.meta.url.endsWith(".ts")?"ts":"js";
   this.worker=new Worker(new URL(`./console-performance-worker.${extension}`,import.meta.url),{
    workerData:{path,...(maxBytes?{maxBytes}:{})},...(extension==="ts"?{execArgv:["--experimental-strip-types"]}:{})});
   this.worker.unref();
   this.worker.on("message",m=>{
    if(m.kind==="ready"){this.ready=true;this.pulse();}
    if(m.kind==="ack"){this.lastAck=Date.now();this.outstanding=Math.max(0,this.outstanding-m.count);this.accepted=m.accepted;this.duplicates=m.duplicates;this.persistedDrops=m.dropped;}
    if(m.kind==="fault"){this.dropped+=m.count;this.outstanding=Math.max(0,this.outstanding-m.count);this.fail();}
    if(m.kind==="report"){const entry=this.waiting.get(m.request);if(entry){clearTimeout(entry.timer);this.waiting.delete(m.request);entry.resolve(m);}}
   });
   this.worker.on("error",()=>this.fail());this.worker.on("exit",()=>{if(!this.stopped)this.fail();});
   this.heartbeat=setInterval(()=>this.pulse(),60000);this.heartbeat.unref();
   this.watchdog=setInterval(()=>{if((!this.ready||this.outstanding>0)&&Date.now()-this.lastAck>5000)this.fail();},1000);this.watchdog.unref();
  }catch{this.fail();}
 }
 private pulse(){if(this.ready&&!this.failed&&!this.stopped)this.worker?.postMessage({kind:"heartbeat",version:this.version},[]);}
 private fail(){this.failed=true;this.ready=false;this.dropped+=this.outstanding;this.outstanding=0;void this.worker?.terminate();for(const w of this.waiting.values()){clearTimeout(w.timer);w.resolve(null);}this.waiting.clear();}
 status(){return {enabled:!this.stopped,ready:this.ready,degraded:this.failed,queued:this.outstanding,accepted:this.accepted,knownDropped:this.dropped+this.persistedDrops,duplicates:this.duplicates,
  limitations:["Client shutdown loss is not fully observable","Agent output includes host/provider/model waiting; model internals are unavailable","Durations from different clocks are never subtracted"]};}
 record(record:PerformanceRecord):boolean {
  if(!this.ready||this.stopped||this.failed||this.outstanding>=2048){if(!this.stopped){this.dropped++;const key=JSON.stringify([record.scope.account,[...new Set(record.scope.products)].sort()]);const prior=this.ownDrops.get(key);if(prior)prior.n++;else if(this.ownDrops.size<10000)this.ownDrops.set(key,{account:record.scope.account,products:[...record.scope.products],n:1});}return false;}
  if(!validPerformanceEvent({id:record.id,stage:record.stage,result:record.result,...(record.durationMs===undefined?{}:{durationMs:record.durationMs})}))return false;
  const {scope,operation,...event}=record;
  if(scope.products.length>64)return false;
  const payload={...event,id:performanceKey(scope.account,record.id),operation:performanceKey(scope.account,operation??record.id),
   account:scope.account,agent:["codex","claude_code","opencode","hermes"].includes(scope.agent??"")?scope.agent:"unknown",kind:["new_send","existing_send","refresh"].includes(scope.kind??"")?scope.kind:"existing_send",scope:JSON.stringify([...new Set(scope.products)].sort()),version:/^[a-zA-Z0-9._-]{1,80}$/.test(record.version)?record.version:"unknown"};
  this.outstanding++;try{this.worker!.postMessage({kind:"events",events:[payload]},[]);return true;}catch{this.outstanding--;this.dropped++;return false;}
 }
 async report(account:string,canRead:(products:string[])=>boolean,from:number,to:number){
  if(!this.ready||this.failed)return {status:{enabled:!this.stopped,ready:this.ready,degraded:this.failed},rows:[],coverage:[],complete:false};
  if(this.waiting.size>=8)throw new Error("Performance report busy");
  const request=randomUUID();
  const data:any=await new Promise(resolve=>{const timer=setTimeout(()=>{this.waiting.delete(request);resolve(null);},2000);this.waiting.set(request,{resolve,timer});this.worker!.postMessage({kind:"report",request,account,from,to},[]);});
  if(!data)return {status:{enabled:!this.stopped,ready:this.ready,degraded:this.failed},rows:[],coverage:[],complete:false};
  const grouped=new Map<string,any>();
  const visible=data.rows.filter((r:any)=>canRead(JSON.parse(r.scope)));
  for(const r of visible){
   const key=JSON.stringify([r.scope,r.source,r.version,r.agent,r.kind,r.stage,r.result]);const h:number[]=JSON.parse(r.histogram),prior=grouped.get(key);
   if(prior){prior.n+=r.n;prior.timed+=r.timed;prior.total+=r.total;if(r.lo!==null)prior.lo=prior.lo===null?r.lo:Math.min(prior.lo,r.lo);if(r.hi!==null)prior.hi=prior.hi===null?r.hi:Math.max(prior.hi,r.hi);h.forEach((v,i)=>prior.histogram[i]+=v);}
   else {const {account:_account,histogram:_histogram,bucket:_bucket,...rest}=r;grouped.set(key,{...rest,products:JSON.parse(r.scope),histogram:h});}
  }
  const rows=[...grouped.values()].map(r=>{
   const quantile=(p:number)=>{let n=0;const i=r.histogram.findIndex((v:number)=>(n+=v)>=Math.ceil(r.timed*p));return r.timed?PERFORMANCE_BUCKETS[i]:null;};
   return {...r,p50UpperBoundMs:quantile(.5),p95UpperBoundMs:r.timed>=100?quantile(.95):null,p95Stable:false};
  });
  const covered=new Set(data.coverage.map((c:any)=>c.minute));let gaps=0;for(let minute=Math.ceil(from/60000)*60000;minute<to;minute+=60000)if(!covered.has(minute))gaps++;
  const persistedHealth=data.health.filter((r:any)=>canRead(JSON.parse(r.scope))).reduce((n:any,r:any)=>({accepted:n.accepted+r.accepted,dropped:n.dropped+r.dropped,duplicates:n.duplicates+r.duplicates}),{accepted:0,dropped:0,duplicates:0});
  const ownStatus={enabled:!this.stopped,ready:this.ready,degraded:this.failed,knownDroppedSinceProcessStart:[...this.ownDrops.values()].filter(v=>v.account===account&&canRead(v.products)).reduce((n,v)=>n+v.n,0),persistenceLossUnknown:this.failed};
  return {from,to,source:this.sampleKind,status:ownStatus,rows,coverage:data.coverage,gapMinutes:gaps,truncated:data.rows.length>30000,
   coverageComplete:to-from===86400000&&from%300000===0&&to%300000===0&&gaps===0,
   complete:false, baselineStatus:"requires scoped client/node completeness review",
   collectionEvents:persistedHealth,pendingObservations:data.pending.filter((r:any)=>canRead(JSON.parse(r.scope))).reduce((n:number,r:any)=>n+r.n,0),businessSampleBuckets:[...new Set(visible.map((r:any)=>r.bucket))], knownDropRate:{numerator:persistedHealth.dropped,denominator:persistedHealth.accepted+persistedHealth.dropped+persistedHealth.duplicates,reason:"Persisted worker ingress attempts in this window only; upstream process drops and unknown client loss are separate"},
   bucketBoundaryApproximation:from%300000!==0||to%300000!==0,unknownClientLoss:true,quantiles:"fixed histogram upper bounds; P95 is withheld below 100 timed samples per identical reporting window and dimensions",modelInternalTiming:"unavailable"};
 }
 async close(){this.stopped=true;if(this.heartbeat)clearInterval(this.heartbeat);if(this.watchdog)clearInterval(this.watchdog);for(const w of this.waiting.values()){clearTimeout(w.timer);w.resolve(null);}this.waiting.clear();const deadline=Date.now()+1000;while(this.outstanding>0&&!this.failed&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,10));await this.worker?.terminate();}
}
