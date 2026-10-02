import { parseCodexSessionFailure, redactSessionDiagnostic, type CodexSessionFailure } from "@missiongo/domain";
import type { MessageKey } from "./i18n";

const copyByCode: Record<CodexSessionFailure["code"], readonly [MessageKey, MessageKey]> = {
  codex_context_window_exceeded: ["agentFailureContext", "agentFailureNewSession"],
  codex_session_budget_exceeded: ["agentFailureBudget", "agentFailureNewSession"],
  codex_usage_limit_exceeded: ["agentFailureUsage", "agentFailureUsageRecovery"],
  codex_rate_limit_exceeded: ["agentFailureRateLimit", "agentFailureRetryAtSource"],
  codex_unauthorized: ["agentFailureAuth", "agentFailureAuthRecovery"],
  codex_server_error: ["agentFailureServer", "agentFailureRetryAtSource"],
  codex_connection_failed: ["agentFailureConnection", "agentFailureConnectionRecovery"],
  codex_bad_request: ["agentFailureRequest", "agentFailureSettingsRecovery"],
  codex_sandbox_error: ["agentFailureSandbox", "agentFailureSettingsRecovery"],
  codex_policy_denied: ["agentFailurePolicy", "agentFailurePolicyRecovery"],
  codex_turn_failed: ["agentFailureUnknown", "agentFailureUnknownRecovery"],
};

export function sessionFailureView(status: string, failure?: CodexSessionFailure, legacyError?: string) {
  if (status !== "failed") return undefined;
  const safe = parseCodexSessionFailure(failure);
  const detail = safe?.detail ?? (legacyError ? redactSessionDiagnostic(legacyError) : undefined);
  const code = safe?.code ?? (detail ? "codex_turn_failed" : "codex_failure_detail_unavailable");
  const [summary, recovery] = safe ? copyByCode[safe.code]
    : detail ? copyByCode.codex_turn_failed : ["agentFailureMissing", "agentFailureMissingRecovery"] as const;
  return { code, summary, recovery, detail, turnId: safe?.turnId, httpStatusCode: safe?.httpStatusCode };
}

export function failureDiagnostic(view: NonNullable<ReturnType<typeof sessionFailureView>>, noDetail: string): string {
  return [view.code, view.turnId ? `turn: ${view.turnId}` : undefined,
    view.httpStatusCode ? `HTTP: ${view.httpStatusCode}` : undefined, view.detail || noDetail]
    .filter(Boolean).join("\n");
}
