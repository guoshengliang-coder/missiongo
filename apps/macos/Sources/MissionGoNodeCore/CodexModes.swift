/// The modes a dispatch may start a Codex thread in, and what each one means.
///
/// Codex has no permission modes to pass through by name, so each mode is a
/// fixed set of thread settings chosen here. The mode arrives over the wire, so
/// the machine checks it itself rather than trusting the server to have checked.
/// Every mode keeps the `workspace-write` sandbox and `on-request` approvals.
/// Auto-review changes who reviews an escalation, not the sandbox boundary;
/// neither `never` nor `danger-full-access` is offered by dispatch.
///
/// This list mirrors `CODEX_MODES` in `packages/domain/src/dispatch.ts`. A
/// repository check compares the array literal below against the TypeScript
/// one — keep it on one line, in the same order, or that check fails.
public enum CodexModes {
    public static let allowed: [String] = ["plan", "default", "auto"]

    public static func isAllowed(_ mode: String) -> Bool {
        return allowed.contains(mode)
    }

    /// `nil` for a mode outside the list.
    ///
    /// Plan confirmation is a workflow gate, separate from sandbox approvals.
    /// `plan` and `auto` use auto-review; `default` keeps manual approvals.
    public static func threadSettings(for mode: String) -> CodexThreadSettings? {
        guard isAllowed(mode) else { return nil }
        let reviewer: String
        switch mode {
        case "plan", "auto": reviewer = "auto_review"
        case "default": reviewer = "user"
        default: return nil
        }
        return CodexThreadSettings(
            sandbox: "workspace-write",
            approvalPolicy: "on-request",
            approvalsReviewer: reviewer
        )
    }
}

/// What `thread/start` is told, beyond the working directory.
public struct CodexThreadSettings: Equatable, Sendable {
    public let sandbox: String
    public let approvalPolicy: String
    public let approvalsReviewer: String
}
