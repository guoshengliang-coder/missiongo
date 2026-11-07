import { z } from "zod";
import { reconciliationActionSchema } from "./merge-reconciliation.js";

// A bounded transport for clients whose tool catalogue predates reconciliation.
// This carries requests, never human approval or arbitrary server operations.
export const recoveryDetailPrefix = "missiongo.merge-recovery.v1\n";
export const recoveryTransportSchema = z.discriminatedUnion("operation", [
  z.object({operation:z.literal("request"),snapshot:z.string().length(64),action:reconciliationActionSchema}).strict(),
  z.object({operation:z.literal("apply"),requestId:z.string().min(1).max(200)}).strict(),
]);
export function readRecoveryTransport(detail:string) {
  if (!detail.startsWith(recoveryDetailPrefix)) return undefined;
  return recoveryTransportSchema.parse(JSON.parse(detail.slice(recoveryDetailPrefix.length)));
}
export const recoveryTransportHelp = {
  protocol:"missiongo.merge-recovery.v1", tool:"record_merge_integration", detailPrefix:recoveryDetailPrefix,
  instructions:"Use action.kind=progress, phase=investigating, an original batch deliveryId and its executionHead as expectedHead. detail is detailPrefix plus strict JSON: {operation:request,snapshot,action} or {operation:apply,requestId}. Use the current expectedRevision and a stable idempotencyKey. Request uses the same action schema as request_merge_reconciliation. No approval operation exists: a signed-in human must approve the exact request in the console. Read recovery after each action. After recovery, use final_validation on the actual target head before finish. Ordinary progress text never runs recovery.",
};
