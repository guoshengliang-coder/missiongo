/// The permission modes a dispatch may start Claude Code in.
///
/// The mode arrives over the wire and goes straight into argv, so the machine
/// checks it itself rather than trusting the server to have checked.
/// `bypassPermissions` is enabled only for MissionGo dispatches. Its launcher
/// adds an explicit deny list for irreversible Git operations. `dontAsk` is not
/// an offered MissionGo mode.
///
/// This list mirrors `CLAUDE_CODE_MODES` in `packages/domain/src/dispatch.ts`.
/// Two languages cannot share one constant, so a repository check compares the
/// array literal below against the TypeScript one — keep it on one line, in the
/// same order, or that check fails.
public enum ClaudeCodeModes {
    public static let allowed: [String] = ["bypassPermissions", "plan", "default", "acceptEdits", "auto"]

    public static func isAllowed(_ mode: String) -> Bool {
        return allowed.contains(mode)
    }
}
