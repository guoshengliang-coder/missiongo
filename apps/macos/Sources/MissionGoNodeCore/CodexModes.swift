/// Native permission profiles. Plan approval is a separate, persisted workflow.
public enum CodexModes {
    public static let allowed: [String] = ["default", "auto", "read-only", "full-access"]
    public static func normalized(_ mode: String) -> String { mode == "plan" ? "auto" : mode }
    public static func isAllowed(_ mode: String) -> Bool { allowed.contains(normalized(mode)) && mode != "full-access" }
    public static func threadSettings(for mode: String, planning: Bool = false) -> CodexThreadSettings? {
        guard isAllowed(mode) else { return nil }
        let mode = normalized(mode)
        return CodexThreadSettings(sandbox: planning || mode == "read-only" ? "read-only" : "workspace-write",
            approvalPolicy: "on-request", approvalsReviewer: !planning && mode == "auto" ? "auto_review" : "user",
            planning: planning)
    }
}
public struct CodexThreadSettings: Equatable, Sendable {
    public let sandbox: String
    public let approvalPolicy: String
    public let approvalsReviewer: String
    public var planning: Bool = false
}
