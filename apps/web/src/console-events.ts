import type { ConsoleChangeResource } from "@missiongo/contracts";
import { useEffect, useRef, useSyncExternalStore } from "react";
import type { QueryClient, QueryKey } from "@tanstack/react-query";
import { consoleRefresh } from "./console-refresh";
import { changedSessionIdentities, type SessionIdentityPage } from "./session-identities";
import { FOREGROUND_SYNC_STALE_MS, foregroundSyncTargets } from "./foreground-sync";
import { checkReleaseStatus } from "./release-status";

export type ChangeResource = ConsoleChangeResource;
const itemRoots = new Set(["item","timeline","delivery","collaboration","dingtalk-notifications","comment-dingtalk-notifications","dispatches"]);
const sessionRoots = new Set(["agent-sessions","agent-session","dispatches","merge-deliveries","delivery","personal-todos","personal-attention","personal-notifications"]);
const allConfig = new Set(["common-commands","products","components","builders","accounts","account-permissions","dingtalk-bindings","dingtalk-settings","dingtalk-project","dispatch-defaults","integration-defaults","insight-batches","insight-batch","insight-batch-candidates","ai-authorizations","ai-title-settings","product-accounts","sdk-tokens"]);
export function changeAffects(key: QueryKey, change: ChangeResource, relatedIds?: readonly string[]): boolean {
 const root=String(key[0]);
 switch(change.kind) {
  case "item":
   if(root === "items")return !change.productId || key[1]===change.productId;
   if(itemRoots.has(root))return root === "dispatches" && key[1] === "active" || !change.itemKey || key[1]===change.itemKey;
   return ["agent-sessions","agent-session","personal-todos","personal-attention","personal-notifications","project-insights","project-insight-items","merge-deliveries","collaboration-detail"].includes(root);
  case "sessions":
   if(!sessionRoots.has(root))return false;
   if(root==="merge-deliveries" && change.productId && key[1]!==change.productId)return false;
   if(root==="merge-deliveries" && ["queue","preview"].includes(String(key[2])))return true;
   if(change.resourceId && relatedIds && (root==="agent-session" || root==="merge-deliveries" && key.length>2))
    return relatedIds.includes(String(key[root==="agent-session" ? 1 : 2]));
   return true;
  case "nodes": return ["nodes","agent-sessions","agent-session","dispatches"].includes(root);
  case "merge": return ["merge-deliveries","merge-reconciliation","agent-sessions","agent-session","items","item","delivery"].includes(root)
   && (root!=="merge-deliveries" || !change.productId || key[1]===change.productId);
  case "products": return ["products","components","builders","items","item","item-filter-options","collaboration-targets","collaboration-grants","collaboration-directory"].includes(root);
  case "personal": return ["personal-todos","personal-attention","personal-notifications"].includes(root);
  case "plan": return ["agent-plan-records","agent-plan-record","plan-records","plan-record","plan-overview","agent-sessions","agent-session"].includes(root);
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
export const consoleConnectionSnapshot=()=>connection;
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
 let generation=0,connected=false,connecting=false;
 let cursor=initialCursor,pendingCursor=initialCursor,retry=0;
 const refresh=consoleRefresh(client,()=>{if(pendingCursor)cursor=pendingCursor;});
 const identityPages=new Map(client.getQueryCache().findAll({queryKey:["agent-sessions"]}).map(q=>[q.queryHash,q.state.data as SessionIdentityPage | undefined]));
 const unsubscribeIdentities=client.getQueryCache().subscribe(event=>{
  if(stopped || event.query.queryKey[0]!=="agent-sessions")return;
  if(event.type==="added"){identityPages.set(event.query.queryHash,event.query.state.data as SessionIdentityPage | undefined);return;}
  if(event.type==="removed"){identityPages.delete(event.query.queryHash);return;}
  if(event.type!=="updated" || event.action.type!=="success")return;
  const next=event.query.state.data as SessionIdentityPage | undefined;
  const changed=changedSessionIdentities(identityPages.get(event.query.queryHash),next);
  identityPages.set(event.query.queryHash,next);
  if(changed.size)refresh.add(client.getQueryCache().findAll({predicate:q=>
   q.queryKey[0]==="agent-session" && changed.has(String(q.queryKey[1])) ||
   q.queryKey[0]==="merge-deliveries" && q.queryKey.length>2 && changed.has(String(q.queryKey[2]))}));
 });
 const enqueue=(resources:ChangeResource[],id:string,full=false)=>{
  const previous=pendingCursor.split(":"),incoming=id.split(":");
  if(!full && previous[0]===incoming[0] && Number(incoming[1])<=Number(previous[1]))return;
  pendingCursor=id||pendingCursor;
  if(full || resources.some(r=>r.kind==="access")) { void refresh.reset(); return; }
  const summaries=client.getQueriesData<{sessions?:{id:string;agentSessionId?:string;relatedSessionIds?:string[]}[]}>({queryKey:["agent-sessions"]}).flatMap(([,data])=>data?.sessions??[]);
  const aliases=new Map(resources.map(r=>{
   const group=summaries.find(s=>[s.id,s.agentSessionId,...(s.relatedSessionIds??[])].includes(r.resourceId));
   return [r,group ? [group.id,...(group.agentSessionId?[group.agentSessionId]:[]),...(group.relatedSessionIds??[])] : undefined];
  }));
  refresh.add(client.getQueryCache().findAll({predicate:q=>q.queryKey[0]!=="bootstrap" && resources.some(r=>changeAffects(q.queryKey,r,aliases.get(r)))}));
 };
 const connect=async()=>{
  if(stopped||String(document.visibilityState)==="hidden"||navigator.onLine===false)return;
  const attempt=++generation;connecting=true;
  controller?.abort();controller=new AbortController();const activeController=controller;setConnection("connecting");
  // Server heartbeat is 25s. Bound both the handshake and a silent open stream.
  let watchdog=setTimeout(()=>activeController.abort(),15_000);
  const heartbeat=()=>{clearTimeout(watchdog);watchdog=setTimeout(()=>activeController.abort(),60_000);};
  try {
   const response=await fetcher(`/api/v1/console/events${cursor?`?cursor=${encodeURIComponent(cursor)}`:""}`,{
    credentials:"same-origin",cache:"no-store",signal:controller.signal,headers:{accept:"text/event-stream"}});
   if(attempt!==generation||stopped){await response.body?.cancel();return;}
   if(activeController.signal.aborted){await response.body?.cancel();throw new Error("Console handshake cancelled");}
   if(response.status===401||response.status===403){stopped=true;refresh.stop();void client.cancelQueries().then(()=>{if(attempt!==generation)return;client.removeQueries({predicate:q=>q.queryKey[0]!=="bootstrap"});return client.resetQueries({queryKey:["bootstrap"]});});setConnection("disconnected");return;}
   if(!response.ok||!response.body||!response.headers.get("content-type")?.includes("text/event-stream"))throw new Error("Console stream unavailable");
   if(attempt!==generation||stopped){await response.body.cancel();return;}
   connecting=false;connected=true;heartbeat();setConnection("connected");retry=0;window.dispatchEvent(new Event("missiongo:console-connected"));
   const reader=response.body.getReader(),decoder=new TextDecoder(),frames=new EventFrames();
   try {
    while(!stopped) {
     const chunk=await reader.read();if(chunk.done)break;heartbeat();
     if(attempt!==generation||stopped)break;
     for(const frame of frames.push(decoder.decode(chunk.value,{stream:true}))) {
      const data=JSON.parse(frame.data) as {epoch?:string;version?:number;resources?:ChangeResource[]};
      if(frame.event==="unauthorized"){stopped=true;refresh.stop();void client.cancelQueries().then(()=>{if(attempt!==generation)return;client.removeQueries({predicate:q=>q.queryKey[0]!=="bootstrap"});return client.resetQueries({queryKey:["bootstrap"]});});setConnection("disconnected");controller.abort();break;}
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
   connecting=false;connected=false;setConnection("disconnected");void checkReleaseStatus();
   timer=setTimeout(()=>{timer=undefined;void connect();},Math.min(30_000,1000*2**Math.min(retry++,5)));
  } finally {clearTimeout(watchdog);}
 };
 const foreground=()=>{
  if(stopped)return;
  if(String(document.visibilityState)==="hidden"){generation++;connected=false;connecting=false;controller?.abort();if(timer)clearTimeout(timer);timer=undefined;return;}
  if(timer)clearTimeout(timer);timer=undefined;
  refresh.resume();
  // Replayed SSE changes and foreground reads share the same key scheduler.
  const targets=foregroundSyncTargets(client.getQueryCache().getAll().map(q=>({queryKey:q.queryKey,active:q.isActive(),updatedAt:q.state.dataUpdatedAt})),Date.now());
  refresh.add(client.getQueryCache().findAll({predicate:q=>targets.includes(q.queryKey)}),true);
  if(!connected&&!connecting)void connect();
 };
 const offline=()=>{generation++;connecting=false;connected=false;if(timer)clearTimeout(timer);timer=undefined;controller?.abort();setConnection("disconnected");};
 const listReturn=()=>refresh.add(client.getQueryCache().findAll({predicate:q=>q.queryKey[0]==="agent-sessions" && q.isActive()
  && (q.state.isInvalidated || q.state.dataUpdatedAt>0 && Date.now()-q.state.dataUpdatedAt>=FOREGROUND_SYNC_STALE_MS)}),true);
 document.addEventListener("visibilitychange",foreground);window.addEventListener("online",foreground);window.addEventListener("offline",offline);window.addEventListener("focus",foreground);
 window.addEventListener("missiongo:console-list-return",listReturn);
 void connect();
 return ()=>{stopped=true;unsubscribeIdentities();generation++;controller?.abort();if(timer)clearTimeout(timer);refresh.stop();
  document.removeEventListener("visibilitychange",foreground);window.removeEventListener("online",foreground);window.removeEventListener("offline",offline);window.removeEventListener("focus",foreground);
  window.removeEventListener("missiongo:console-list-return",listReturn);};
}
export function useConsoleEvents(client:QueryClient,accountId:string|undefined,initialCursor?:string) {
 const seed=useRef(initialCursor);seed.current=initialCursor;
 const previousAccount=useRef(accountId);
 useEffect(()=>{
  if(previousAccount.current && previousAccount.current!==accountId){
   const predicate=(q:{queryKey:QueryKey})=>["agent-session","agent-sessions","agent-history-result","merge-deliveries"].includes(String(q.queryKey[0]));
   void client.cancelQueries({predicate});client.removeQueries({predicate});
  }
  previousAccount.current=accountId;
  if(accountId)return startConsoleEvents(client,undefined,seed.current);
 },[client,accountId]);
}
