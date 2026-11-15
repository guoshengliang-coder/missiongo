import { useEffect, useRef } from "react";
import { replaceEqualDeep, type QueryClient } from "@tanstack/react-query";
import type { ListObservation, PerformanceResult, PerformanceStage } from "@missiongo/domain";
import { emitPerformance, performanceGeneration, performanceNow, performanceResult } from "./console-performance";

// Page-local visit identity, never storage, cookies, UA upload or device fingerprinting.
type Visit = { id:string; at:number; list:ListObservation; requests:number; refreshes:number; joined:boolean; hasData:boolean; entrySettled:boolean; data:readonly unknown[]|undefined; lastRead?:string; sequence:number; lastView?:string };
type Read = { at:number; id:string; generation:number; visit:Visit|undefined; list:ListObservation; rows:number };
let current:Visit|undefined, entered=false, observers=0, intentActive=false;
let intentAt:number|undefined;
const reads=new WeakMap<readonly unknown[],Read>();
export function listDevice():ListObservation["device"]{
 if(typeof navigator==="undefined")return "unknown";
 const mobile=(navigator as Navigator & {userAgentData?:{mobile?:boolean}}).userAgentData?.mobile;
 // Inspect only in memory; tablets/ambiguous touch Macs are explicitly unknown.
 const ua=navigator.userAgent;
 if((/Android/i.test(ua)&&!/Mobile/i.test(ua))||/iPad|Tablet/i.test(ua)||(/Macintosh/i.test(ua)&&navigator.maxTouchPoints>1))return "unknown";
 if(mobile===true||/iPhone|iPod|Android.*Mobile/i.test(ua))return "phone";
 if(mobile===false||/Windows NT|Macintosh|X11|CrOS/i.test(ua))return "pc";
 return "unknown";
}
function emit(v:Visit,id:string,stage:PerformanceStage,result:PerformanceResult="success",durationMs?:number,extra:Partial<ListObservation>={}){
 emitPerformance({list:true},`${v.id}:${id}`,stage,result,durationMs,{...v.list,...extra});
}
function paint(v:Visit,id:string,stage:PerformanceStage,at:number,result:PerformanceResult="success",extra:Partial<ListObservation>={}){
 const epoch=performanceGeneration();
 requestAnimationFrame(()=>{if(current!==v||epoch!==performanceGeneration())return;
  emit(v,id,stage,document.visibilityState==="visible"?result:"hidden",document.visibilityState==="visible"?performanceNow()-at:undefined,extra);
  if(stage==="list_cache_visible"&&document.visibilityState==="visible"&&!v.joined&&v.requests===0&&!v.entrySettled){v.entrySettled=true;emit(v,"cache-policy","list_entry_fresh_visible","no_refresh");}});
}
export function startListVisit(data:readonly unknown[]|undefined,joined:boolean,resume=false){
 if(typeof document==="undefined"||document.visibilityState!=="visible")return;
 if(current)return;
 const id=crypto.randomUUID(),scenario=resume?"background_resume":!entered?"first_entry":data?"cache_return":"unknown";
 entered=true;
 const list:ListObservation={protocol:1,device:listDevice(),scenario,dataset:"account_feed",visitId:id,...(data?{rows:Math.min(data.length,1000000)}:{})};
 const v:Visit={id,at:resume?performanceNow():intentAt??performanceNow(),list,requests:0,refreshes:0,joined,hasData:data!==undefined,entrySettled:false,data,sequence:0};intentAt=undefined;current=v;
 emit(v,"begin","list_visit");
 if(data)paint(v,"cache","list_cache_visible",v.at,"success",{rows:Math.min(data.length,1000000)});
 else emit(v,"cache","list_cache_visible","no_cache");
 // Absence of a refresh is not a timeout. Only an actual request can time out.

}
export function endListVisit(result:PerformanceResult="success"){
 const v=current;if(!v)return;current=undefined;
 emit(v,"end","list_visit_end",result,performanceNow()-v.at,{requests:Math.min(v.requests,1000000),refreshes:Math.min(v.refreshes,1000000)});
}
export function clearSessionListPerformance(){endListVisit("cancelled");entered=false;intentAt=undefined;}
if(typeof window!=="undefined")window.addEventListener("missiongo:performance-clear",clearSessionListPerformance);

/** Wrap the existing operation exactly once; collection never issues a business request. */
export async function measureSessionListRequest<T extends {sessions:readonly unknown[]}>(operation:(headers:Record<string,string>)=>Promise<T>,productId?:string):Promise<T>{
 if(typeof window==="undefined")return operation({});
 if(!productId&&!current&&intentActive&&intentAt!==undefined)startListVisit(undefined,false);
 const epoch=performanceGeneration(),v=!productId?current:undefined,at=performanceNow(),id=crypto.randomUUID();
 const list:ListObservation={protocol:1,device:v?.list.device??listDevice(),scenario:v?.list.scenario??"unknown",dataset:productId?"project_view":"account_feed",...(v?{visitId:v.id}:{})};
 if(v){v.requests++;if(v.hasData||v.requests>1)v.refreshes++;}
 try{
  const value=await operation({"x-missiongo-list-observation":JSON.stringify(list)});
  if(epoch!==performanceGeneration())return value;
  try{
  const observation={...list,rows:Math.min(value.sessions.length,1000000)};
  // Resource Timing is optional; no retained URL or misleading JSON/network equivalence.
  const url=new URL(`/api/v1/agent-sessions${productId?`?productId=${encodeURIComponent(productId)}`:""}`,location.origin).href;
  const entry=performance.getEntriesByName?.(url,"resource").slice().reverse().find(e=>e.startTime>=at) as PerformanceResourceTiming|undefined;
  if(entry&&entry.transferSize>0&&entry.transferSize<=67108864)observation.transferBytes=Math.round(entry.transferSize);
  emitPerformance(productId?{productId}:{list:true},`${id}:request`,"list_request","success",performanceNow()-at,observation);
  reads.set(value.sessions,{at,id,generation:epoch,visit:v,list:observation,rows:value.sessions.length});
  }catch{/* Instrumentation must not fail a successful read. */}
  return value;
 }catch(error){
  const result=error instanceof DOMException&&error.name==="AbortError"?"cancelled":performanceResult(error);
  if(epoch===performanceGeneration())emitPerformance(productId?{productId}:{list:true},`${id}:request`,"list_request",result,performanceNow()-at,list);
  throw error;
 }
}
/** Called by a React effect after the list committed, not by the query-cache notification. */
export function shareSessionListData(previous:unknown,next:unknown):unknown{
 const shared=replaceEqualDeep(previous,next) as {sessions?:readonly unknown[]};
 const raw=next as {sessions?:readonly unknown[]};
 if(raw?.sessions&&shared?.sessions){const read=reads.get(raw.sessions);if(read)reads.set(shared.sessions,read);}
 return shared;
}
export function commitList(data:readonly unknown[],productId:string,renderedRows:number,loaded:boolean){
 const v=current;if(!v||!loaded)return;
 const view=JSON.stringify([productId,renderedRows,data.length]);
 if(v.lastView!==view){v.lastView=view;emitPerformance({productId},`${v.id}:view:${v.sequence++}`,"list_view","success",undefined,{protocol:1,device:v.list.device,scenario:v.list.scenario,dataset:"project_view",visitId:v.id,renderedRows:Math.min(renderedRows,1000000)});}
 v.data=data;v.hasData=true;
 const read=reads.get(data);
 if(read?.generation!==performanceGeneration()||read.id===v.lastRead)return;
 v.lastRead=read.id;
 if(read.visit===v){
  paint(v,`${read.id}:fresh`,"list_fresh_visible",read.at,"success",{rows:Math.min(read.rows,1000000)});
  if(!v.entrySettled){v.entrySettled=true;paint(v,`${read.id}:entry`,"list_entry_fresh_visible",v.at,"success",{rows:Math.min(read.rows,1000000)});}
 }else if(v.joined){
  v.joined=false;v.entrySettled=true;paint(v,`${read.id}:joined`,"list_entry_fresh_visible",v.at,"inflight_at_entry",{rows:Math.min(read.rows,1000000)});
 }
}
export function useSessionListPerformance(client:QueryClient,productId:string,data:readonly unknown[],renderedRows:number,loaded:boolean,enabled:boolean){
 const latest=useRef({data,loaded});latest.current={data,loaded};
 useEffect(()=>{
  if(!enabled)return;
  observers++;
  const start=(resume=false)=>startListVisit(latest.current.loaded?latest.current.data:undefined,client.getQueryState(["agent-sessions"])?.fetchStatus==="fetching",resume);
  start();const visibility=()=>{if(document.visibilityState==="visible")start(true);else endListVisit("hidden");};
  document.addEventListener("visibilitychange",visibility);
  return()=>{document.removeEventListener("visibilitychange",visibility);observers--;const v=current;queueMicrotask(()=>{if(observers===0&&current===v)endListVisit("cancelled");});};
 },[client,enabled]);
 useEffect(()=>{if(enabled)commitList(data,productId,renderedRows,loaded);});
}

/** Record navigation intent before bootstrap/list prefetch, but upload only once
 * an authenticated list operation or the actual list component confirms entry. */
export function noteListIntent(){intentActive=true;if(!current)intentAt??=performanceNow();}
export function useSessionListIntent(enabled:boolean){
 useEffect(()=>{
  if(!enabled)return;
  noteListIntent();
  return()=>{intentActive=false;queueMicrotask(()=>{if(!intentActive){intentAt=undefined;endListVisit("cancelled");}});};
 },[enabled]);
}
