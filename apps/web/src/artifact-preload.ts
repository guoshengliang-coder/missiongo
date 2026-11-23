import { registerArtifactPreloader } from "./artifact-cache";
import { useEffect } from "react";
import { useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { api } from "./api";

export const ARTIFACT_PRELOAD_MAX_IMAGE = 2 * 1024 * 1024;
export const ARTIFACT_PRELOAD_MAX_BYTES = 8 * 1024 * 1024;
export const ARTIFACT_PRELOAD_MAX_COUNT = 12;
export const ARTIFACT_PRELOAD_CONCURRENCY = 2;
export interface PreloadImage { id:string;sessionId:string;sizeBytes:number }

/** Reserve the entire response size before I/O. Large originals remain available on demand. */
export function selectPreloadImages(images:readonly PreloadImage[]):PreloadImage[] {
  const result:PreloadImage[]=[],seen=new Set<string>();let bytes=0;
  for(const image of images) {
    if(seen.has(image.id) || !Number.isSafeInteger(image.sizeBytes) || image.sizeBytes<=0
      || image.sizeBytes>ARTIFACT_PRELOAD_MAX_IMAGE || bytes+image.sizeBytes>ARTIFACT_PRELOAD_MAX_BYTES) continue;
    seen.add(image.id);bytes+=image.sizeBytes;result.push(image);
    if(result.length===ARTIFACT_PRELOAD_MAX_COUNT)break;
  }
  return result;
}

/** Uses the exact viewer cache. Cancelling background work must not cancel an opened image. */
export function preloadArtifacts(client:QueryClient, images:readonly PreloadImage[]) {
  const pending=selectPreloadImages(images),keys:unknown[][]=[];
  let stopped=false,active=0;
  const pump=()=>{
    if(stopped)return;
    while(active<ARTIFACT_PRELOAD_CONCURRENCY && pending.length) {
      const image=pending.shift()!,key=["artifact-bundle",image.sessionId,image.id];
      if(client.getQueryState(key)?.status==="success")continue;
      keys.push(key);active++;
      void client.fetchQuery({queryKey:key,queryFn:({signal})=>api.agentArtifactBundle(image.sessionId,image.id,signal),
        staleTime:Infinity,retry:false,gcTime:5*60_000})
        .catch(()=>undefined).finally(()=>{active--;pump();});
    }
  };
  // Leave the foreground detail/first paint ahead of this low-priority queue.
  const timer=setTimeout(pump,300);
  const stop=()=>{
    if(stopped)return;
    stopped=true;clearTimeout(timer);unregister();
    for(const key of keys) if(client.getQueryCache().find({queryKey:key,exact:true})?.getObserversCount()===0)
      void client.cancelQueries({queryKey:key,exact:true});
  };
  const unregister=registerArtifactPreloader(client,stop);
  return stop;
}

export function useArtifactPreload(sessions:readonly {id:string;agentSessionId?:string;activityAt?:string;updatedAt:string;archivedAt?:string}[],visible:boolean) {
  const client=useQueryClient();
  const ids=[...sessions].filter(s=>!s.archivedAt && s.agentSessionId).sort((a,b)=>(b.activityAt ?? b.updatedAt).localeCompare(a.activityAt ?? a.updatedAt))
    .slice(0,8).map(s=>s.agentSessionId!);
  const idsKey=JSON.stringify(ids);
  const query=useQuery({queryKey:["artifact-preloads",idsKey],queryFn:({signal})=>api.agentArtifactPreloads(ids,signal),
    enabled:visible && ids.length>0,staleTime:30_000,gcTime:30_000,retry:false});
  const imageKey=JSON.stringify(query.isError ? [] : query.data?.images ?? []);
  useEffect(()=>{
    if(!visible)void client.cancelQueries({queryKey:["artifact-preloads",idsKey],exact:true});
  },[client,visible,idsKey]);
  useEffect(()=>{
    if(!visible)return;
    return preloadArtifacts(client,JSON.parse(imageKey) as PreloadImage[]);
  },[client,visible,imageKey]);
}
