import { useEffect } from "react";
import { emitPerformance, performanceNow } from "./console-performance";
import type { QueryClient } from "@tanstack/react-query";

/** No business requests: observe the exact query generation, then a paint opportunity. */
export function useConsolePerformance(client:QueryClient,productId:string|undefined,sessionId?:string|null){
 useEffect(()=>{
  if(!productId&&!sessionId)return;
  const context=sessionId?{sessionId}:{productId:productId!};
  const key=sessionId?["agent-session",sessionId]:["agent-sessions"];
  const hash=JSON.stringify(key);
  const cacheStage=sessionId?"detail_cache_visible":"cache_visible",freshStage=sessionId?"detail_fresh_visible":"fresh_visible";
  let current:{at:number;id:string;fetching:boolean;fresh:boolean}|undefined;
  let timeout:ReturnType<typeof setTimeout>|undefined;
  let frames:number[]=[];
  const paint=(id:string,stage:typeof cacheStage|typeof freshStage,at:number)=>{
   frames.push(requestAnimationFrame(()=>{if(document.visibilityState==="visible")emitPerformance(context,id,stage,"success",performanceNow()-at);else emitPerformance(context,id,stage,"hidden");}));
  };
  const reset=()=>{
   if(timeout)clearTimeout(timeout);frames.forEach(cancelAnimationFrame);frames=[];
   current={at:performanceNow(),id:crypto.randomUUID(),fetching:false,fresh:false};
   const p=current,state=client.getQueryState(key);
   if(state?.data)paint(`${p.id}:cache`,cacheStage,p.at);else emitPerformance(context,`${p.id}:cache`,cacheStage,"no_cache");
   timeout=setTimeout(()=>{if(current===p&&!p.fresh){p.fresh=true;emitPerformance(context,`${p.id}:fresh`,freshStage,"timeout",performanceNow()-p.at);}},30000);
  };
  if(document.visibilityState==="visible")reset();
  const unsubscribe=client.getQueryCache().subscribe(event=>{
   if(event.type!=="updated"||JSON.stringify(event.query.queryKey)!==hash||!current||document.visibilityState!=="visible")return;
   const p=current;
   if(event.action.type==="fetch")p.fetching=true;
   if(!p.fetching||p.fresh)return;
   if(event.action.type==="success"&&!event.action.manual){p.fresh=true;paint(`${p.id}:fresh`,freshStage,p.at);}
   if(event.action.type==="error"){p.fresh=true;emitPerformance(context,`${p.id}:fresh`,freshStage,"network_failure",performanceNow()-p.at);}
  });
  const visibility=()=>{if(document.visibilityState==="visible")reset();else if(current&&!current.fresh){current.fresh=true;emitPerformance(context,`${current.id}:fresh`,freshStage,"hidden",performanceNow()-current.at);}};
  document.addEventListener("visibilitychange",visibility);
  return()=>{unsubscribe();document.removeEventListener("visibilitychange",visibility);if(timeout)clearTimeout(timeout);frames.forEach(cancelAnimationFrame);if(current&&!current.fresh)emitPerformance(context,`${current.id}:fresh`,freshStage,"cancelled",performanceNow()-current.at);};
 },[client,productId,sessionId]);
}
