import AppKit
import MissionGoNodeCore

/// Injectable I/O boundaries let the real UI lifecycle be verified without
/// replacing this machine's app or terminating the test process.
protocol ClientUpdateService: Sendable {
    func check(serverUrl: String, currentVersion: String) async throws -> AppUpdater.Available?
    func download(_ manifest: AppUpdater.Manifest, serverUrl: String,
                  progress: @escaping @Sendable (Int, Int, TimeInterval) -> Void,
                  stage: @escaping @Sendable (UpdateActivity.Stage) async -> Void,
                  metrics: @escaping @Sendable (String) -> Void) async throws -> Data
    func install(zip: Data, manifest: AppUpdater.Manifest,
                 stage: @escaping @Sendable (UpdateActivity.Stage) async -> Void) async throws -> URL
    @MainActor func relaunch(_ bundle: URL) throws
}

struct LiveClientUpdateService: ClientUpdateService {
    func check(serverUrl: String, currentVersion: String) async throws -> AppUpdater.Available? {
        try await AppUpdater.check(serverUrl: serverUrl, currentVersion: currentVersion)
    }
    func download(_ manifest: AppUpdater.Manifest, serverUrl: String,
                  progress: @escaping @Sendable (Int, Int, TimeInterval) -> Void,
                  stage: @escaping @Sendable (UpdateActivity.Stage) async -> Void,
                  metrics: @escaping @Sendable (String) -> Void) async throws -> Data {
        try await AppUpdater.download(manifest, serverUrl: serverUrl, progress: progress, stage: stage, metrics: metrics)
    }
    func install(zip: Data, manifest: AppUpdater.Manifest,
                 stage: @escaping @Sendable (UpdateActivity.Stage) async -> Void) async throws -> URL {
        try await AppUpdater.install(zip: zip, manifest: manifest, replacing: Bundle.main.bundleURL,
            expectedIdentifier: Bundle.main.bundleIdentifier, stage: stage)
    }
    @MainActor func relaunch(_ bundle: URL) throws {
        let command = AppUpdater.relaunchCommand(bundle: bundle, pid: ProcessInfo.processInfo.processIdentifier)
        let process = Process()
        process.executableURL = URL(fileURLWithPath: command.file)
        process.arguments = command.args
        process.standardInput = FileHandle.nullDevice
        try process.run()
        NSApp.terminate(nil)
    }
}
