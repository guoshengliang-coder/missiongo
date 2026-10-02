/** Stable MissionGo identifiers. Only structured Codex error types select them. */
export const CODEX_SESSION_FAILURE_CODES = [
  "codex_context_window_exceeded", "codex_session_budget_exceeded", "codex_usage_limit_exceeded",
  "codex_rate_limit_exceeded", "codex_unauthorized", "codex_server_error", "codex_connection_failed",
  "codex_bad_request", "codex_sandbox_error", "codex_policy_denied", "codex_turn_failed",
] as const;
export type CodexSessionFailureCode = (typeof CODEX_SESSION_FAILURE_CODES)[number];
export interface CodexSessionFailure {
  readonly code: CodexSessionFailureCode;
  readonly detail?: string;
  readonly turnId?: string;
  readonly httpStatusCode?: number;
}

/** Defence in depth: nodes redact before upload; storage and copy also redact. */
export function redactSessionDiagnostic(value: string): string {
  return value
    .replace(/-----BEGIN [\s\S]*?-----END [^-]*-----/g, "[redacted]")
    .replace(/\b(?:authorization|cookie|set-cookie)[\s"']*:[^\r\n]+/gi, "[redacted]")
    .replace(/\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|password|secret)\b[\s"']*[:=]\s*(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;]+)/gi, "[redacted]")
    .replace(/\bBearer\s+[^\s,;"']+/gi, "Bearer [redacted]")
    .replace(/\b(?:sk-[A-Za-z0-9_-]+|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)\b/g, "[redacted]")
    .replace(/\b(?:https?|wss?|file):\/\/[^\s"'<>]+/gi, "[address]")
    .replace(/(?:\/[A-Za-z0-9_.~-]+){2,}(?:[^\s"'<>]*)|[A-Za-z]:\\[^\r\n"']+/g, "[path]")
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "[email]")
    .replace(/\b(?:\d{1,3}\.){3}\d{1,3}(?::\d+)?\b/g, "[address]")
    // eslint-disable-next-line no-control-regex -- Remove unprintable diagnostic characters, preserving line breaks and tabs.
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .trim().slice(0, 2_000);
}

export function parseCodexSessionFailure(value: unknown): CodexSessionFailure | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const entry = value as Record<string, unknown>;
  if (!CODEX_SESSION_FAILURE_CODES.includes(entry.code as CodexSessionFailureCode)) return undefined;
  if (entry.detail !== undefined && typeof entry.detail !== "string") return undefined;
  const detail = typeof entry.detail === "string" ? redactSessionDiagnostic(entry.detail) : "";
  const turnId = typeof entry.turnId === "string" && /^[A-Za-z0-9_-]{1,100}$/.test(entry.turnId) ? entry.turnId : undefined;
  const httpStatusCode = typeof entry.httpStatusCode === "number" && Number.isInteger(entry.httpStatusCode)
    && entry.httpStatusCode >= 400 && entry.httpStatusCode <= 599 ? entry.httpStatusCode : undefined;
  return { code: entry.code as CodexSessionFailureCode, ...(detail ? { detail } : {}),
    ...(turnId ? { turnId } : {}), ...(httpStatusCode ? { httpStatusCode } : {}) };
}

/** Uses the existing nullable error slot; old plain-text rows remain readable. */
export function storedSessionError(error?: string, failure?: CodexSessionFailure): string | null {
  const safe = parseCodexSessionFailure(failure);
  return safe ? JSON.stringify({ kind: "codex_turn_failure", version: 1, failure: safe })
    : error ? redactSessionDiagnostic(error) || null : null;
}

export function sessionErrorFields(value: string | null | undefined): { lastError?: string; failure?: CodexSessionFailure } {
  if (!value) return {};
  try {
    const stored = JSON.parse(value) as Record<string, unknown>;
    if (stored?.kind === "codex_turn_failure" && stored.version === 1) {
      const failure = parseCodexSessionFailure(stored.failure);
      if (failure) return { failure, lastError: failure.detail ?? failure.code };
    }
  } catch { /* Pre-existing plain-text rows. */ }
  return { lastError: redactSessionDiagnostic(value) };
}
