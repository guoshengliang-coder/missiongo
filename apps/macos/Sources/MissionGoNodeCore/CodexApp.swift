import AppKit
import Foundation

/// Whether the app that runs the Codex app-server is up on this machine.
///
/// This exists only to tell two failures apart — "the app is not running" and
/// "the app is running but its control channel cannot be reached" — because
/// they need different things from the operator, and until now both were
/// reported as the first one.
///
/// It is not the readiness check: a running app whose app-server never came up
/// still cannot take a dispatch. `CodexLocation.controlChannelIsUp` decides
/// that, by connecting.
public enum CodexApp {
    /// The app has shipped under both identifiers — Codex and the ChatGPT app
    /// are now one app — so both count, and the bundle name is the last resort
    /// for a build using a third.
    public static let bundleIdentifiers: Set<String> = ["com.openai.codex", "com.openai.chat"]
    public static let bundleName = "ChatGPT.app"

    public static func matches(bundleIdentifier: String?, bundleName name: String?) -> Bool {
        if let bundleIdentifier, bundleIdentifiers.contains(bundleIdentifier) { return true }
        return name == bundleName
    }

    public static func isRunning() -> Bool {
        return NSWorkspace.shared.runningApplications.contains { app in
            matches(bundleIdentifier: app.bundleIdentifier, bundleName: app.bundleURL?.lastPathComponent)
        }
    }
}
