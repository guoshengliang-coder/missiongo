import { QueryObserver, type QueryClient } from "@tanstack/react-query";
import { api } from "./api";
import type { AgentHistoryPage } from "./types";

/** Observe the pending task while SSE invalidates it; no periodic GET loop. */
export function waitForAgentHistory(client:QueryClient,sessionId:string,cursor:string,initial:AgentHistoryPage):Promise<AgentHistoryPage> {
 const queryKey=["agent-history-result",sessionId,cursor];
 client.setQueryData(queryKey,initial);
 return new Promise((resolve,reject)=>{
  const observer=new QueryObserver(client,{queryKey,queryFn:()=>api.getAgentHistory(sessionId,cursor),staleTime:Infinity,retry:false});
  let unsubscribe=()=>{};
  const timer=setTimeout(()=>{unsubscribe();reject(new Error("History result timed out"));},30_000);
  unsubscribe=observer.subscribe(result=>{
   if(result.isError){clearTimeout(timer);unsubscribe();reject(result.error);}
   else if(result.data && result.data.status!=="pending"){clearTimeout(timer);unsubscribe();resolve(result.data);}
  });
  // One catch-up read closes the POST-to-subscription race.
  void observer.refetch();
 });
}
