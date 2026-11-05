/// The modes a MissionGo dispatch may start in OpenCode.
/// Keep this list in step with OPENCODE_MODES in packages/domain/src/dispatch.ts.
public enum OpenCodeModes {
    public static let allowed: [String] = ["plan", "build"]

    public static func isAllowed(_ mode: String) -> Bool {
        allowed.contains(mode == "default" ? "build" : mode)
    }
}
