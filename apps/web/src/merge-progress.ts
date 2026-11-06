export type MergeProgress = "pending" | "merging";
interface ProgressDelivery {id:string;productId:string;sessionId:string;itemKeys:string[];state:string;blocker?:string | undefined}
interface ProgressBatch {state:string;deliveries:string[];results:Record<string,{status:string}>}
/** Confirmation expresses intent; old CI evidence does not revoke it. */
export function deriveMergeProgress(productId:string, deliveries:ProgressDelivery[], batches:ProgressBatch[]) {
  const items=new Map<string,MergeProgress>(),sessions=new Map<string,MergeProgress>();
  const active=new Set(batches.filter(b=>b.state==="active").flatMap(b=>b.deliveries.filter(id=>b.results[id]?.status!=="merged")));
  const put=(map:Map<string,MergeProgress>,key:string,state:MergeProgress)=>{if(map.get(key)!=="merging")map.set(key,state);};
  for(const d of deliveries) {
    if(d.productId!==productId)continue;
    const state=d.state==="batched"&&active.has(d.id)?"merging":d.state==="confirmed"&&d.blocker!=="changed"?"pending":undefined;
    if(!state)continue;
    for(const key of d.itemKeys)put(items,key,state);
    put(sessions,d.sessionId,state);
  }
  return {items,sessions};
}
