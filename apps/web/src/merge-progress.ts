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
  return {items,sessions,sessionItems:deriveSessionItemKeys(productId,deliveries,batches)};
}

/**
 * The work items one integration session runs (AND-449). Read from the batch
 * itself rather than the delivery state: a finished batch keeps its items in
 * its entries after every delivery has been merged or withdrawn.
 */
export function deriveSessionItemKeys(productId:string, deliveries:ProgressDelivery[], batches:ProgressBatch[]) {
  const byId=new Map(deliveries.filter(d=>d.productId===productId).map(d=>[d.id,d]));
  const result=new Map<string,string[]>();
  for(const batch of batches)for(const id of batch.deliveries) {
    const delivery=byId.get(id);
    if(!delivery)continue;
    const keys=result.get(delivery.sessionId)??[];
    for(const key of delivery.itemKeys)if(!keys.includes(key))keys.push(key);
    result.set(delivery.sessionId,keys);
  }
  return result;
}
