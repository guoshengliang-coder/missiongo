import type { WorkItemStatus } from "@missiongo/domain";
/** Append-only reconciliation; observations are supplied by the authorized executor. */
export interface MergedObservation {
  head:string;commit:string;targetHead:string;checkedAt:string;source:string;
  checks:"passed";local:"passed";originalIncluded:true;targetIncludesMerge:true;validation:string;
}
export type MergeRecoveryAction =
  | {kind:"accept_merge";deliveryId:string;evidence:MergedObservation}
  | {kind:"retry_handover";deliveryId:string}
  | {kind:"retry_blocked";deliveryId:string;reason:string}
  | {kind:"defer_publication"|"allow_partial_publication";reason:string};
export interface MergeReconciliationState {
  transportReceipts?:Record<string,{digest:string}>;
  requests:{id:string;digest:string;snapshot:string;action:MergeRecoveryAction;at:string;
    decision?:"approved"|"rejected";decidedAt?:string;decidedBy?:string;appliedAt?:string}[];
  history:{at:string;action:string;requestId?:string;deliveryId?:string;previous?:unknown;detail:string}[];
  handoffs:Record<string,{status:"completed"|"blocked";detail:string;at:string}>;
  publication?:{decision:"defer_publication"|"allow_partial_publication";reason:string;requestId:string;resultsDigest:string};
  finalValidation?:{head:string;checkedAt:string;source:string;validation:string;resultsDigest:string};
}
export interface MergeReconciliationPreview {
  batchId:string;state:"active"|"finished";publish:boolean;snapshot:string;sessionId:string;
  reconciliation?:MergeReconciliationState | undefined;
  entries:{deliveryId:string;itemKeys:string[];originalHead:string;executionHead:string;
    repository:string;pullRequest:number;targetBranch:string;requiredArtifacts:string[];noReleaseReason?:string | undefined;
    result?:{status:"merged"|"blocked";head:string;commit?:string;detail:string} | undefined;
    repair?:{id:string;fromHead:string;base:string;reason:string} | undefined;
    items:{itemKey:string;status:WorkItemStatus;revision:number | undefined;blocker?:string | undefined;missingEvidence:boolean;next:string;
      developmentEventId?:string|undefined;roundKey?:string|undefined;missingPublicationEvidence?:boolean;
      handoff?:{status:"completed"|"blocked";detail:string;at:string} | undefined}[];
  }[];
}
