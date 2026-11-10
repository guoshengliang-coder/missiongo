import { ApiError } from "./api";
import type { MessageKey } from "./i18n";

/**
 * The words to show for a failed request, in the reader's language.
 *
 * The server's problem titles are English sentences written for logs, and
 * printing them as-is put "A signed-in account is required." into a Chinese
 * console. The failures a person can act on -- signed out, no access, gone,
 * slow down, server down, offline -- get a sentence of our own. A few
 * conflict codes whose wording the reader cannot act on also map to a
 * sentence of our own. Anything else keeps the server's text, because it is
 * usually a specific validation message and a generic "something went
 * wrong" would throw that detail away.
 */
export function localizedErrorText(error: unknown, t: (key: MessageKey) => string): string {
  const key = errorMessageKey(error);
  if (key) return t(key);
  if (error instanceof Error && error.message) return error.message;
  return t("somethingWentWrong");
}

export function errorMessageKey(error: unknown): MessageKey | null {
  if (error instanceof ApiError) {
    if (error.code === "deployment_in_progress") return "releaseWait";
    if (error.status === 401 || error.code === "authentication_required") return "errorSignedOut";
    if (error.code === "product_operation_not_permitted") return "captureReadOnly";
    if (error.code === "verification_not_permitted") return "verificationNotPermitted";
    if (error.code === "collaboration_stale" || error.code === "collaboration_evidence_changed") return "collaborationStale";
    if (error.code === "collaboration_delivery_required") return "collaborationDeliveryRequired";
    if (error.code === "collaboration_blocked") return "collaborationBlocked";
    if (error.code === "collaboration_cycle") return "collaborationCycle";
    if (error.code === "collaboration_disposition_required") return "collaborationCancelHelp";
    if (error.code.startsWith("collaboration_")) return "collaborationError";
    if (error.status === 403) return "errorForbidden";
    if (error.status === 404) return "errorNotFound";
    if (error.status === 429 || error.code === "rate_limit_exceeded") return "errorRateLimited";
    if (error.status >= 500) return "errorServer";
    // Conflict codes the reader can act on get a sentence of our own; the
    // server's English titles are written for logs and used to land in a
    // Chinese console as-is (AND-224).
    const conflictKeys: Readonly<Record<string, MessageKey>> = {
      approval_stale: "errorApprovalChanged",
      approval_decided: "errorApprovalChanged",
      approval_retry_stale: "errorApprovalChanged",
      approval_retry_unavailable: "errorApprovalRetryUnavailable",
      approval_retry_in_progress: "errorApprovalRetryPending",
      discovery_stale: "completionDiscoveryChanged",
      discovery_source_changed: "completionDiscoveryChanged",
      execution_stop_unconfirmed: "executionStopBlocked",
      agent_handoff_changed: "agentHandoffChanged",
      agent_handoff_key_reused: "agentHandoffChanged",
      agent_handoff_required: "agentHandoffRequired",
      execution_observation_changed: "executionObservationChanged",
      execution_confirmation_required: "executionStopAttestation",
      item_transferred: "transferReadOnly",
      transfer_active_execution: "transferActiveExecution",
      transfer_same_product: "transferSameProduct",
      transfer_target_archived: "transferArchivedTarget",
      agent_stop_pending: "agentSessionStopQueued",
      agent_reply_pending: "errorAgentReplyPending",
      agent_not_running: "errorAgentNotRunning",
      agent_turn_unavailable: "errorAgentTurnUnavailable",
      agent_command_pending: "errorAgentCommandPending",
      agent_reply_not_pending: "errorAgentReplyNotQueued",
      agent_reply_not_cancellable: "errorAgentReplyNotQueued",
      agent_reply_changed: "errorAgentReplyChanged",
      agent_send_request_changed: "agentSendChanged",
      agent_attention_changed: "errorAgentAttentionChanged",
      agent_plan_approval_changed: "errorAgentPlanApprovalChanged",
      free_sessions_unsupported: "newSessionNodeUpdate",
      free_session_changed: "errorFreeSessionChanged",
      agent_session_starting: "errorFreeSessionStarting",
      dispatch_not_retryable: "errorDispatchNotRetryable",
      agent_model_unavailable: "errorAgentModelUnavailable",
      agent_effort_unavailable: "errorAgentEffortUnavailable",
    };
    if (Object.hasOwn(conflictKeys, error.code)) return conflictKeys[error.code]!;
    return null;
  }
  // fetch() rejects with a TypeError, and only a TypeError, when the request
  // never got a response: offline, DNS, a dropped connection.
  if (error instanceof TypeError) return "errorNetwork";
  // AbortSignal.timeout() rejects with a DOMException named TimeoutError.
  if (error instanceof DOMException && error.name === "TimeoutError") return "errorTimeout";
  return null;
}
