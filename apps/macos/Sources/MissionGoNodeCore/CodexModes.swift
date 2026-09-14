/// The modes a dispatch may start a Codex thread in, and what each one means.
///
/// Codex has no permission modes to pass through by name, so each mode is a
/// fixed set of thread settings chosen here. The mode arrives over the wire, so
/// the machine checks it itself rather than trusting the server to have checked.
/// Every mode keeps the `workspace-write` sandbox and `on-request` approvals:
/// the approval policy `never` and the `danger-full-access` sandbox are exactly
/// the settings that take the human out of the loop, and a dispatched session
/// has no human at the machine.
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
    /// - `plan` and `default` send sandbox escapes to a person, in the Codex app.
    ///   Plan mode differs only in the launch prompt: Codex has no enforced plan
    ///   mode, so the session is told to write a plan and wait.
    /// - `auto` sends them to Codex's auto-review instead.
    public static func threadSettings(for mode: String) -> CodexThreadSettings? {
        guard isAllowed(mode) else { return nil }
        return CodexThreadSettings(
            sandbox: "workspace-write",
            approvalPolicy: "on-request",
            approvalsReviewer: mode == "auto" ? "auto_review" : "user"
        )
    }
}

/// What `thread/start` is told, beyond the working directory.
public struct CodexThreadSettings: Equatable, Sendable {
    public let sandbox: String
    public let approvalPolicy: String
    public let approvalsReviewer: String
}
