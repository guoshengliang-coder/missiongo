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
    if (error.status === 401 || error.code === "authentication_required") return "errorSignedOut";
    if (error.status === 403) return "errorForbidden";
    if (error.status === 404) return "errorNotFound";
    if (error.status === 429 || error.code === "rate_limit_exceeded") return "errorRateLimited";
    if (error.status >= 500) return "errorServer";
    // Conflict codes the reader can act on get a sentence of our own; the
    // server's English titles are written for logs and used to land in a
    // Chinese console as-is (AND-224).
    const conflictKeys: Readonly<Record<string, MessageKey>> = {
      agent_stop_pending: "agentSessionStopQueued",
      agent_reply_pending: "errorAgentReplyPending",
      agent_not_running: "errorAgentNotRunning",
      agent_turn_unavailable: "errorAgentTurnUnavailable",
      agent_command_pending: "errorAgentCommandPending",
      agent_reply_changed: "errorAgentReplyChanged",
      agent_attention_changed: "errorAgentAttentionChanged",
      dispatch_not_retryable: "errorDispatchNotRetryable",
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
