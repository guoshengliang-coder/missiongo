import Foundation

/// Only public turn error metadata. Never upload additionalDetails, request bodies,
/// encrypted reasoning, or arbitrary error-object fields.
public struct CodexSessionFailure: Codable, Equatable, Sendable {
    public let code: String
    public let detail: String?
    public let turnId: String?
    public let httpStatusCode: Int?

    public static func fromTurn(_ turn: [String: Any]?) -> CodexSessionFailure {
        let error = turn?["error"] as? [String: Any]
        let info = error?["codexErrorInfo"]
        let variant = (info as? [String: Any])?.keys.first
        let type = (info as? String) ?? variant
        let metadata = variant.flatMap { (info as? [String: Any])?[$0] as? [String: Any] }
        let rawStatus = metadata?["httpStatusCode"] as? Int
        let status = rawStatus.flatMap { (400...599).contains($0) ? $0 : nil }
        let code: String
        if type == "unauthorized" || status == 401 || status == 403 { code = "codex_unauthorized" }
        else if type == "rateLimitExceeded" || status == 429 { code = "codex_rate_limit_exceeded" }
        else {
            switch type {
            case "contextWindowExceeded": code = "codex_context_window_exceeded"
            case "sessionBudgetExceeded": code = "codex_session_budget_exceeded"
            case "usageLimitExceeded": code = "codex_usage_limit_exceeded"
            case "internalServerError", "serverOverloaded", "flexUnavailable": code = "codex_server_error"
            case "httpConnectionFailed", "responseStreamConnectionFailed", "responseStreamDisconnected", "responseTooManyFailedAttempts":
                code = status.map { $0 >= 500 } == true ? "codex_server_error" : "codex_connection_failed"
            case "badRequest": code = "codex_bad_request"
            case "sandboxError": code = "codex_sandbox_error"
            case "cyberPolicy", "misalignmentPolicyViolation", "tooManyDenials": code = "codex_policy_denied"
            default: code = "codex_turn_failed"
            }
        }
        let detail = (error?["message"] as? String).map(Self.redact)
        let id = turn?["id"] as? String
        let safeId = id.flatMap { $0.range(of: #"^[A-Za-z0-9_-]{1,100}$"#, options: .regularExpression) != nil ? $0 : nil }
        return CodexSessionFailure(code: code, detail: detail?.isEmpty == false ? detail : nil,
                                   turnId: safeId, httpStatusCode: status)
    }

    public static func redact(_ value: String) -> String {
        let rules: [(String, String)] = [
            (#"-----BEGIN [\s\S]*?-----END [^-]*-----"#, "[redacted]"),
            (#"(?i)\b(?:authorization|cookie|set-cookie)[\s"']*:[^\r\n]+"#, "[redacted]"),
            (#"(?i)\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|password|secret)\b[\s"']*[:=]\s*(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;]+)"#, "[redacted]"),
            (#"(?i)\bBearer\s+[^\s,;"']+"#, "Bearer [redacted]"),
            (#"\b(?:sk-[A-Za-z0-9_-]+|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)\b"#, "[redacted]"),
            (#"(?i)\b(?:https?|wss?|file)://[^\s"'<>]+"#, "[address]"),
            (#"(?:/[A-Za-z0-9_.~-]+){2,}(?:[^\s"'<>]*)|[A-Za-z]:\\[^\r\n"']+"#, "[path]"),
            (#"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}"#, "[email]"),
            (#"\b(?:\d{1,3}\.){3}\d{1,3}(?::\d+)?\b"#, "[address]"),
            (#"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]"#, "")
        ]
        var safe = value
        for (pattern, replacement) in rules {
            safe = safe.replacingOccurrences(of: pattern, with: replacement, options: .regularExpression)
        }
        return String(safe.trimmingCharacters(in: .whitespacesAndNewlines).prefix(2_000))
    }
}
