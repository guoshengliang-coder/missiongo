import { z } from "zod";
import { createHash } from "node:crypto";
import type { MergeReconciliationState } from "@missiongo/contracts";
const sha = z.string().regex(/^[a-f0-9]{40}$/);
const text = z.string().trim().min(1).max(4000);
/** Observations are executor evidence, never a server assertion of GitHub truth. */
export const mergedObservationSchema = z.object({
  head: sha, commit: sha, targetHead: sha, checkedAt: z.string().datetime(),
  source: z.string().url().max(500), checks: z.literal("passed"), local: z.literal("passed"),
  originalIncluded: z.literal(true), targetIncludesMerge: z.literal(true), validation: text,
}).strict();
export const reconciliationActionSchema = z.discriminatedUnion("kind", [
  z.object({kind:z.literal("accept_merge"),deliveryId:z.string().min(1),evidence:mergedObservationSchema}).strict(),
  z.object({kind:z.literal("retry_handover"),deliveryId:z.string().min(1)}).strict(),
  z.object({kind:z.literal("retry_blocked"),deliveryId:z.string().min(1),reason:text}).strict(),
  z.object({kind:z.literal("defer_publication"),reason:text}).strict(),
  z.object({kind:z.literal("allow_partial_publication"),reason:text,publicationRefresh:z.object({
    scopeDigest:z.string().regex(/^[a-f0-9]{64}$/),
    historicalGaps:z.array(z.object({identity:z.string().trim().min(1).max(300),reason:text}).strict()).max(200),
  }).strict().optional()}).strict(),
]);
export type ReconciliationAction = z.infer<typeof reconciliationActionSchema>;
export type { MergeReconciliationState as ReconciliationState } from "@missiongo/contracts";
export const combinedValidationSchema = z.object({head:sha,checkedAt:z.string().datetime(),source:text,validation:text}).strict();

interface PublicationDecisionBatch {
  id:string;publish:boolean;operation?:string;
  selection:{id:string;revision:string}[];deliveries:string[];
  publicationScope?:{digest:string}|undefined;
  references?:Record<string,unknown>;
  reconciliation?:MergeReconciliationState;
}
/** Bind a whole-batch deferral to immutable selected scope, not mutable merge
 * results. Authorized additive repairs still use their existing head gates. */
export function deferredPublicationScope(batch:PublicationDecisionBatch):string {
  return createHash("sha256").update(JSON.stringify([batch.id,batch.selection,batch.deliveries,batch.publish,
    batch.operation??null,batch.publicationScope?.digest??null,batch.references??null])).digest("hex");
}
export function batchPublicationDeferred(batch:PublicationDecisionBatch):boolean {
  const publication=batch.reconciliation?.publication;
  if(publication?.decision!=="defer_publication" || publication.batchScopeDigest!==deferredPublicationScope(batch))return false;
  const request=batch.reconciliation?.requests.find(row=>row.id===publication.requestId);
  return request?.action.kind==="defer_publication" && request.action.reason===publication.reason
    && request.decision==="approved" && Boolean(request.decidedAt&&request.decidedBy&&request.appliedAt);
}
