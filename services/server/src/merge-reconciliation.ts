import { z } from "zod";
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
  z.object({kind:z.literal("allow_partial_publication"),reason:text}).strict(),
]);
export type ReconciliationAction = z.infer<typeof reconciliationActionSchema>;
export type { MergeReconciliationState as ReconciliationState } from "@missiongo/contracts";
export const combinedValidationSchema = z.object({head:sha,checkedAt:z.string().datetime(),source:text,validation:text}).strict();
