/// The modes a MissionGo dispatch may start in OpenCode.
/// Keep this list in step with OPENCODE_MODES in packages/domain/src/dispatch.ts.
public enum OpenCodeModes {
    public static let allowed: [String] = ["plan", "default"]

    public static func isAllowed(_ mode: String) -> Bool {
        allowed.contains(mode)
    }
}
