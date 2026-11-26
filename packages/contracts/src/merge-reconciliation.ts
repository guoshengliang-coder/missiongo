import type { PublicationScope } from "./merge-presentation.js";
import type { WorkItemStatus } from "@missiongo/domain";
/** Append-only reconciliation; observations are supplied by the authorized executor. */
export interface MergedObservation {
  head:string;commit:string;targetHead:string;checkedAt:string;source:string;
  checks:"passed"|"not_applicable";local:"passed"|"not_applicable";verification?:import("./project-verification.js").ProjectVerification|undefined;originalIncluded:true;targetIncludesMerge:true;validation:string;
}
export type MergeRecoveryAction =
  | {kind:"accept_merge";deliveryId:string;evidence:MergedObservation}
  | {kind:"retry_handover";deliveryId:string}
  | {kind:"retry_blocked";deliveryId:string;reason:string}
  | {kind:"defer_publication";reason:string}
  | {kind:"allow_partial_publication";reason:string;publicationRefresh?:{scopeDigest:string;historicalGaps:{identity:string;reason:string}[]}|undefined};
export interface MergeReconciliationState {
  transportReceipts?:Record<string,{digest:string}>;
  requests:{id:string;digest:string;snapshot:string;action:MergeRecoveryAction;at:string;publicationScope?:PublicationScope;
    review?:{accountId:string;sessionId:string;activity:string;at:string};
    reusesBatchAuthority?:boolean;
    decisionSource?:{kind:"conversation";commandId:string}|{kind:"native_history";sourceId:string};
    reviewText?:string;
    decision?:"approved"|"rejected";decidedAt?:string;decidedBy?:string;appliedAt?:string}[];
  history:{at:string;action:string;requestId?:string;deliveryId?:string;previous?:unknown;detail:string}[];
  handoffs:Record<string,{status:"completed"|"blocked";detail:string;at:string}>;
  publication?:{decision:"defer_publication"|"allow_partial_publication";reason:string;requestId:string;resultsDigest:string;batchScopeDigest?:string};
  finalValidation?:{head:string;checkedAt:string;source:string;validation:string;resultsDigest:string};
}
export interface MergeContinuation {
  state: "not_sent" | "queued" | "delivering" | "delivery_unknown" | "delivered" | "failed" | "cancelled";
  commandId?: string;
  reason?: "pending" | "archived" | "revoked" | "finished" | "managed" | "not_ready" | "unavailable" | "send_failed" | "delivery_failed" | "scope_changed";
}
/** Proven record-identity succession; never an additional human approval or release receipt. */
export interface PublicationIdentityTransition {
  fromIdentity:string; toIdentity:string; deliveryId:string; revision:string;
  itemKey?:string; developmentEventId?:string; roundKey?:string|null; itemScope?:string;
  head:string; commit:string;
}
export interface MergeReconciliationPreview {
  continuations?: Record<string, MergeContinuation>;

  batchId:string;state:"active"|"finished";publish:boolean;snapshot:string;sessionId:string;
  publicationRefresh?:PublicationScope;
  publicationIdentity?:{unchanged:boolean; transitions:PublicationIdentityTransition[]; reason?:string};
  reconciliation?:MergeReconciliationState | undefined;
  entries:{deliveryId:string;itemKeys:string[];originalHead:string;executionHead:string;
    repository:string;pullRequest:number;targetBranch:string;requiredArtifacts:string[];noReleaseReason?:string | undefined;
    result?:{status:"merged"|"blocked";head:string;commit?:string;detail:string} | undefined;
    repair?:{id:string;fromHead:string;base:string;reason:string} | undefined;
    items:{itemKey:string;status:WorkItemStatus;revision:number | undefined;blocker?:string | undefined;missingEvidence:boolean;next:string;
      developmentEventId?:string|undefined;roundKey?:string|undefined;missingPublicationEvidence?:boolean;
      requiredArtifacts?:readonly string[]|null;
      handoff?:{status:"completed"|"blocked";detail:string;at:string} | undefined}[];
  }[];
}
