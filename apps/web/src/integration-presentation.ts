import type { IntegrationPublication } from "@missiongo/contracts";
import type { Batch } from "./merge-console";

export function integrationOrder(batch:Batch) {
  return [...new Set([...(batch.integration?.plans.at(-1)?.entries.map(e=>e.deliveryId)??[]),...batch.deliveries,...Object.keys(batch.integration?.entries??{})])];
}
export function integrationStage(batch:Batch,id:string) {
  const result=batch.results[id]?.status;
  return result==="merged"||result==="blocked"?result:batch.integration?.entries[id]?.progress??"queued";
}
export function integrationPublication(batch:Batch,id?:string):IntegrationPublication {
  if(id)return batch.presentation?.entries[id]?.publication??"unknown";
  const states=[...integrationOrder(batch).map(key=>integrationPublication(batch,key)),...(batch.presentation?.ownedExtras?.map(row=>row.publication)??[])];
  if(!states.length)return "unknown";
  if(states.every(s=>s==="not_required"))return "not_required";
  if(states.every(s=>s==="published"||s==="not_required"))return "published";
  if(states.some(s=>s==="published"||s==="partial"))return "partial";
  return states.some(s=>s==="unknown")?"unknown":"pending";
}
export const integrationStageLabels={queued:"integrationQueued",investigating:"integrationInvestigating",repairing:"integrationRepairing",waiting_ci:"integrationWaiting",ready:"integrationReady",merged:"integrationMerged",blocked:"integrationBlocked"} as const;
export const integrationPublicationLabels={not_required:"integrationNoPublication",pending:"integrationPublicationPending",partial:"integrationPublicationPartial",published:"integrationPublished",unknown:"integrationPublicationUnknown"} as const;
