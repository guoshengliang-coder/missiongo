import type { ConsoleChangeResource } from "@missiongo/contracts";
import { useEffect, useSyncExternalStore } from "react";
import type { QueryClient, QueryKey } from "@tanstack/react-query";
import { checkReleaseStatus } from "./release-status";

export type ChangeResource = ConsoleChangeResource;
const itemRoots = new Set(["item","timeline","delivery","collaboration","dingtalk-notifications","comment-dingtalk-notifications","dispatches"]);
const sessionRoots = new Set(["agent-sessions","agent-session","dispatches","merge-deliveries","delivery","personal-todos","personal-attention","personal-notifications"]);
const allConfig = new Set(["products","components","builders","accounts","account-permissions","dingtalk-bindings","dingtalk-settings","dingtalk-project","dispatch-defaults","integration-defaults","insight-batches","insight-batch","insight-batch-candidates","ai-authorizations","ai-title-settings","product-accounts","sdk-tokens"]);
export function changeAffects(key: QueryKey, change: ChangeResource): boolean {
 const root=String(key[0]);
 switch(change.kind) {
  case "item":
   if(root === "items")return !change.productId || key[1]===change.productId;
   if(itemRoots.has(root))return root === "dispatches" && key[1] === "active" || !change.itemKey || key[1]===change.itemKey;
   return ["agent-sessions","agent-session","personal-todos","personal-attention","personal-notifications","project-insights","project-insight-items","merge-deliveries","collaboration-detail"].includes(root);
  case "sessions": return sessionRoots.has(root);
  case "nodes": return ["nodes","agent-sessions","agent-session","dispatches"].includes(root);
  case "merge": return ["merge-deliveries","merge-reconciliation","agent-sessions","agent-session","items","item","delivery"].includes(root)
   && (root!=="merge-deliveries" || !change.productId || key[1]===change.productId);
  case "products": return ["products","components","builders","items","item","item-filter-options","collaboration-targets","collaboration-grants","collaboration-directory"].includes(root);
  case "personal": return ["personal-todos","personal-attention","personal-notifications"].includes(root);
  case "plan": return ["agent-plan-records","agent-plan-record","plan-records","plan-record","agent-sessions","agent-session"].includes(root);
  case "artifact": return ["artifact-state","artifact-bundle"].includes(root) && key[1]===change.resourceId;
  case "history": return ["agent-session","agent-history-result"].includes(root) && key[1]===change.resourceId;
  case "admin": return allConfig.has(root);
  case "config": return allConfig.has(root);
  case "access": return true;
  default: return false;
 }
}
export type ConnectionState = "connecting" | "connected" | "disconnected";
let connection: ConnectionState="connecting";
const subscribers=new Set<()=>void>();
const setConnection=(state:ConnectionState)=>{if(connection!==state){connection=state;subscribers.forEach(fn=>fn());}};
export function useConsoleConnection() {
 return useSyncExternalStore(listener=>{subscribers.add(listener);return()=>{subscribers.delete(listener);};},()=>connection,()=>"connecting" as const);
}
/** SSE frames can cross arbitrary UTF-8/network boundaries. */
export class EventFrames {
 private buffer="";
 push(text:string) {
  this.buffer+=text;
  if(this.buffer.length>2*1024*1024)throw new Error("Console event frame exceeds limit");
  const frames: {event:string;data:string;id:string}[]=[];
  let match:RegExpExecArray|null;
  while((match=/\r?\n\r?\n/.exec(this.buffer))) {
   const block=this.buffer.slice(0,match.index);this.buffer=this.buffer.slice(match.index+match[0].length);
   let event="message",id="";const data:string[]=[];
   for(const line of block.split(/\r?\n/)) {
    const colon=line.indexOf(":");if(colon<1)continue;
    const field=line.slice(0,colon),value=line.slice(colon+1).replace(/^ /,"");
    if(field==="event")event=value;else if(field==="id")id=value;else if(field==="data")data.push(value);
   }
   if(data.length)frames.push({event,id,data:data.join("\n")});
  }
  return frames;
 }
}

/** One stream per authenticated page; only processed cursors survive reconnect.
 * Retries are caused by a failed connection/read, never an idle polling timer. */
export function startConsoleEvents(client:QueryClient, fetcher:typeof fetch=(input,init)=>fetch(input,init), initialCursor="") {
 let stopped=false,controller:AbortController|undefined,timer:ReturnType<typeof setTimeout>|undefined;
 let generation=0,connected=false;
 let cursor=initialCursor,pendingCursor=initialCursor,pending:ChangeResource[]=[],reset=false,running=false,retry=0,readRetry=0;
 let retryRead:ReturnType<typeof setTimeout>|undefined;
 const pump=async()=>{
  if(running||stopped||String(document.visibilityState)==="hidden")return;
  running=true;
  const resources=pending;pending=[];const full=reset;reset=false;const next=pendingCursor;
  try {
   const affected=client.getQueryCache().findAll({predicate:q=>q.queryKey[0]!=="bootstrap" && (full||resources.some(r=>changeAffects(q.queryKey,r)))});
   // A formerly-authorized snapshot must not remain readable after revocation.
   // Observed queries (e.g. the embedded item conversation) revalidate in
   // place; eviction alone would leave their mounted observers pointing at a
   // removed query that never refetches. Only unobserved caches are dropped.
   if(full || resources.some(r=>r.kind==="access")) {
    await client.cancelQueries();
    if(stopped)return;
    client.removeQueries({predicate:q=>q.queryKey[0]!=="bootstrap" && q.getObserversCount()===0});
    await client.invalidateQueries({predicate:q=>q.queryKey[0]!=="bootstrap"},{throwOnError:true});
    // Revalidate bootstrap in place: clearing it would unmount every consumer
    // (losing e.g. a just-saved settings notice) for changes that merely
    // touch the account. Revocation still lands through the refetch, the
    // stream's unauthorized handling and the eviction above.
    await client.invalidateQueries({queryKey:["bootstrap"]},{throwOnError:true});
   } else {
    await Promise.all(affected.map(async q=>{
     await client.cancelQueries({queryKey:q.queryKey,exact:true});
     await client.invalidateQueries({queryKey:q.queryKey,exact:true},{throwOnError:true});
    }));
   }
   if(next)cursor=next;readRetry=0;if(connected&&!stopped)setConnection("connected");
  } catch {
   if(stopped)return;
   pending.push(...resources);reset ||= full;
   setConnection("disconnected");
   retryRead=setTimeout(()=>{retryRead=undefined;void pump();},Math.min(30_000,1000*2**Math.min(readRetry++,5)));
  } finally {
   running=false;
   if((pending.length||reset)&&!retryRead)void pump();
  }
 };
 const enqueue=(resources:ChangeResource[],id:string,full=false)=>{
  const previous=pendingCursor.split(":"),incoming=id.split(":");
  if(!full && previous[0]===incoming[0] && Number(incoming[1])<=Number(previous[1]))return;
  pending.push(...resources);pendingCursor=id||pendingCursor;reset ||= full;
  queueMicrotask(()=>void pump());
 };
 const connect=async()=>{
  if(stopped||String(document.visibilityState)==="hidden"||navigator.onLine===false)return;
  const attempt=++generation;
  controller?.abort();controller=new AbortController();setConnection("connecting");
  try {
   const response=await fetcher(`/api/v1/console/events${cursor?`?cursor=${encodeURIComponent(cursor)}`:""}`,{
    credentials:"same-origin",cache:"no-store",signal:controller.signal,headers:{accept:"text/event-stream"}});
   if(attempt!==generation||stopped){await response.body?.cancel();return;}
   if(response.status===401||response.status===403){stopped=true;void client.cancelQueries().then(()=>{if(attempt!==generation)return;client.removeQueries({predicate:q=>q.queryKey[0]!=="bootstrap"});return client.resetQueries({queryKey:["bootstrap"]});});setConnection("disconnected");return;}
   if(!response.ok||!response.body||!response.headers.get("content-type")?.includes("text/event-stream"))throw new Error("Console stream unavailable");
   if(attempt!==generation||stopped){await response.body.cancel();return;}
   connected=true;setConnection("connected");retry=0;window.dispatchEvent(new Event("missiongo:console-connected"));
   const reader=response.body.getReader(),decoder=new TextDecoder(),frames=new EventFrames();
   try {
    while(!stopped) {
     const chunk=await reader.read();if(chunk.done)break;
     if(attempt!==generation||stopped)break;
     for(const frame of frames.push(decoder.decode(chunk.value,{stream:true}))) {
      const data=JSON.parse(frame.data) as {epoch?:string;version?:number;resources?:ChangeResource[]};
      if(frame.event==="unauthorized"){stopped=true;void client.cancelQueries().then(()=>{if(attempt!==generation)return;client.removeQueries({predicate:q=>q.queryKey[0]!=="bootstrap"});return client.resetQueries({queryKey:["bootstrap"]});});controller.abort();break;}
      if(frame.event==="hello") {
       if(!cursor)enqueue([],`${data.epoch}:${data.version}`,true);
      } else if(frame.event==="reset") enqueue([],frame.id,true);
      else if(frame.event==="change") enqueue(data.resources??[],frame.id);
     }
    }
   } finally {reader.releaseLock();}
   if(!stopped)throw new Error("Console stream ended");
  } catch {
   if(stopped||attempt!==generation||String(document.visibilityState)==="hidden")return;
   connected=false;setConnection("disconnected");void checkReleaseStatus();
   timer=setTimeout(()=>{timer=undefined;void connect();},Math.min(30_000,1000*2**Math.min(retry++,5)));
  }
 };
 const foreground=()=>{
  if(String(document.visibilityState)==="hidden"){controller?.abort();if(timer)clearTimeout(timer);timer=undefined;return;}
  if(timer)clearTimeout(timer);timer=undefined;
  void pump();void connect();
 };
 const offline=()=>{connected=false;controller?.abort();setConnection("disconnected");};
 document.addEventListener("visibilitychange",foreground);window.addEventListener("online",foreground);window.addEventListener("offline",offline);
 void connect();
 return ()=>{stopped=true;generation++;controller?.abort();if(timer)clearTimeout(timer);if(retryRead)clearTimeout(retryRead);
  document.removeEventListener("visibilitychange",foreground);window.removeEventListener("online",foreground);window.removeEventListener("offline",offline);};
}
export function useConsoleEvents(client:QueryClient,accountId:string|undefined,initialCursor?:string) {
 useEffect(()=>{if(accountId)return startConsoleEvents(client,undefined,initialCursor);},[client,accountId,initialCursor]);
}
