import type { DeliveryExplanation } from "@missiongo/contracts";
import type { MissionGoStore } from "./store.js";

/** Explain the latest evidence inside existing records, without making it current. */
export function deliveryExplanation(store: MissionGoStore, itemKey: string): DeliveryExplanation | undefined {
  const events = store.getTimeline(itemKey).filter(event => !event.historySourceKey);
  return explain(store,itemKey,events,store.getWorkItem(itemKey));
}

/** Keep every current delivery's gaps visible, plus the latest historical context. */
export function deliveryExplanations(store: MissionGoStore, itemKey: string, deliveries: ReturnType<MissionGoStore["getDeliveryRecords"]>): DeliveryExplanation[] {
  const events = store.getTimeline(itemKey).filter(event => !event.historySourceKey);
  const latest = store.getDevelopmentEvidence(itemKey,undefined,events).handover;
  const ids = deliveries.map(delivery=>delivery.id);
  if (latest && !ids.includes(latest.id)) ids.push(latest.id);
  const item = store.getWorkItem(itemKey);
  return ids.flatMap(id=>{
    const explanation=explain(store,itemKey,events,item,id);
    return explanation ? [explanation] : [];
  });
}

function explain(store:MissionGoStore,itemKey:string,events:ReturnType<MissionGoStore["getTimeline"]>,item:ReturnType<MissionGoStore["getWorkItem"]>,deliveryId?:string):DeliveryExplanation|undefined {
  const evidence = store.getDevelopmentEvidence(itemKey, deliveryId, events);
  const event = evidence.handover;
  if (!event) return undefined;
  const after = events.slice(events.findIndex(row => row.id === event.id) + 1);
  const boundary = after.slice().reverse().flatMap(row => {
    if (row.eventType === "status_changed") {
      if (row.payload.reason === "verification_failed") return ["verification_failed" as const];
      if (row.fromStatus === "done") return ["reopened" as const];
      if (row.toStatus === "cancelled") return ["cancelled" as const];
    }
    if (row.eventType === "builder_changed") return ["builder_changed" as const];
    if (row.eventType === "execution_taken_over") return ["round_changed" as const];
    if (row.eventType === "item_updated" && (row.payload.deliveryScopeChanged === true || row.payload.deliveryScopeChanged === 1 || row.payload.deliveryScopeChanged === undefined)) return ["scope_changed" as const];
    return [];
  })[0];
  const current = Boolean(evidence.roundKey && event.payload.roundKey === evidence.roundKey
    && event.payload.contentVersion === item.contentVersion && !boundary);
  if (!current) return {developmentEventId:event.id,roundKey:evidence.roundKey,applicability:"historical",
    reason:boundary ?? (typeof event.payload.roundKey === "string" && typeof event.payload.contentVersion === "number" ? "round_changed" : "evidence_missing"),missing:[],missingArtifacts:[]};
  const scope = store.getDevelopmentReleaseDecision(itemKey, event.id, events);
  const missing: Array<DeliveryExplanation["missing"][number]> = [];
  if (!evidence.completion) missing.push("integration");
  if (scope.requiredArtifacts === null) missing.push("release_scope");
  const receipts = after.filter(row => row.payload.developmentEventId === event.id ||
    row.toStatus === "pending_verification" && !row.payload.developmentEventId && row.payload.roundKey === evidence.roundKey);
  const published = new Set(receipts.filter(row => row.eventType === "release_evidence_added" || row.toStatus === "pending_verification")
    .flatMap(row => Array.isArray(row.payload.releases) ? row.payload.releases : []).map(row => row.artifact));
  if (scope.requiredArtifacts?.length === 0 && !receipts.some(row => row.payload.reason === "non_release_submitted")) missing.push("no_release_verification");
  return {developmentEventId:event.id,roundKey:evidence.roundKey,applicability:"current",missing,
    missingArtifacts:(scope.requiredArtifacts ?? []).filter(artifact => !published.has(artifact))};
}
