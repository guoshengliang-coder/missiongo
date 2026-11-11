import { parseCodexSessionFailure, type CodexSessionFailureCode } from "@missiongo/domain";

const codes: Record<string, CodexSessionFailureCode> = {
  contextWindowExceeded: "codex_context_window_exceeded",
  sessionBudgetExceeded: "codex_session_budget_exceeded",
  usageLimitExceeded: "codex_usage_limit_exceeded",
  rateLimitExceeded: "codex_rate_limit_exceeded",
  unauthorized: "codex_unauthorized",
  internalServerError: "codex_server_error",
  serverOverloaded: "codex_server_error",
  flexUnavailable: "codex_server_error",
  badRequest: "codex_bad_request",
  sandboxError: "codex_sandbox_error",
  cyberPolicy: "codex_policy_denied",
  misalignmentPolicyViolation: "codex_policy_denied",
  tooManyDenials: "codex_policy_denied",
};
const connections = new Set(["httpConnectionFailed", "responseStreamConnectionFailed", "responseStreamDisconnected", "responseTooManyFailedAttempts"]);
function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

/** Only public TurnError fields, never additionalDetails or raw protocol objects. */
export function codexTurnFailure(turn: unknown) {
  const source = record(turn);
  const error = record(source?.error);
  if (!error) return undefined;
  const info = record(error.codexErrorInfo);
  const keys = info ? Object.keys(info) : [];
  const type = typeof error.codexErrorInfo === "string" ? error.codexErrorInfo : keys.length === 1 ? keys[0] : undefined;
  const detail = typeof error.message === "string" ? error.message : undefined;
  if (!type && !detail?.trim()) return undefined;
  const metadata = type && connections.has(type) ? record(info?.[type]) : undefined;
  const rawStatus = metadata?.httpStatusCode;
  const status = typeof rawStatus === "number" && Number.isInteger(rawStatus) && rawStatus >= 400 && rawStatus <= 599 ? rawStatus : undefined;
  const code = type === "unauthorized" || status === 401 || status === 403 ? "codex_unauthorized"
    : type === "rateLimitExceeded" || status === 429 ? "codex_rate_limit_exceeded"
    : type && connections.has(type) ? status && status >= 500 ? "codex_server_error" : "codex_connection_failed"
    : type && Object.hasOwn(codes, type) ? codes[type] : "codex_turn_failed";
  return parseCodexSessionFailure({ code, detail, turnId: source?.id, httpStatusCode: status });
}
