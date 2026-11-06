import Foundation
import XCTest
@testable import MissionGoNodeCore

/// Exercise the shipped host's command loop with an isolated protocol fixture.
/// No real provider, hook, model request or user conversation is involved.
final class SettingsHostFixture {
    let root: URL
    let commands: URL
    let statePath: String
    let eventsPath: String
    let process = Process()

    init(delay: Int = 0, reject: String? = nil, prompt: String = "fixture start") throws {
        root = FileManager.default.temporaryDirectory.appendingPathComponent("mg-settings-\(UUID().uuidString)")
        commands = root.appendingPathComponent("commands")
        statePath = root.appendingPathComponent("state.json").path
        eventsPath = root.appendingPathComponent("events.jsonl").path
        try FileManager.default.createDirectory(at: commands, withIntermediateDirectories: true)
        let package = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        let executable = package.deletingLastPathComponent().appendingPathComponent("node/src/fixtures/agent.cjs").path
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: executable)
        let configuration = ClaudeHostConfiguration(claudeExecutable: executable, cwd: root.path, mode: "acceptEdits",
            sessionName: "Isolated settings fixture", sessionRef: UUID().uuidString, prompt: prompt,
            statePath: statePath, commandsDirectory: commands.path, logPath: root.appendingPathComponent("host.log").path)
        let configPath = root.appendingPathComponent("config.json").path
        try ClaudeHostFiles.write(configuration, to: configPath)
        process.executableURL = package.appendingPathComponent(".build/debug/MissionGoClaudeHost")
        process.arguments = [configPath]
        var environment = ProcessInfo.processInfo.environment
        environment["TEST_AGENT_EVENTS"] = eventsPath
        environment["FAKE_CLAUDE_ACK_DELAY"] = String(delay)
        environment["FAKE_CLAUDE_REJECT_MODE"] = reject
        process.environment = environment
        process.standardOutput = FileHandle.nullDevice
        process.standardError = FileHandle.nullDevice
        try process.run()
    }

    func state() throws -> ClaudeHostState { try ClaudeHostFiles.readState(statePath) }
    func events() -> [[String: Any]] {
        guard let data = try? String(contentsOfFile: eventsPath, encoding: .utf8) else { return [] }
        return data.split(separator: "\n").compactMap { JSONValues.parse(String($0)) as? [String: Any] }
    }
    func put(_ command: ClaudeHostCommand) throws {
        try ClaudeHostFiles.write(command, to: commands.appendingPathComponent("\(command.id).json").path)
    }
    func until(_ condition: () throws -> Bool) async throws {
        let deadline = Date().addingTimeInterval(8)
        while Date() < deadline {
            if (try? condition()) == true { return }
            try await Task.sleep(nanoseconds: 10_000_000)
        }
        throw LaunchError("Timed out waiting for isolated host settings")
    }
    func stop() {
        if process.isRunning {
            process.resume()
            process.terminate()
            let deadline = Date().addingTimeInterval(3)
            while process.isRunning && Date() < deadline { usleep(10_000) }
            if process.isRunning {
                // A fixture may not have established its own process group.
                // Terminate the owned PID too; never block the test runner in
                // Foundation's unbounded waitUntilExit during teardown.
                kill(-process.processIdentifier, SIGKILL)
                kill(process.processIdentifier, SIGKILL)
                let killDeadline = Date().addingTimeInterval(2)
                while process.isRunning && Date() < killDeadline { usleep(10_000) }
                XCTAssertFalse(process.isRunning, "Fixture process did not exit after SIGKILL")
            }
        }
        try? FileManager.default.removeItem(at: root)
    }
}

final class ClaudeHostSettingsIntegrationTests: XCTestCase {
    func testQueuedPromptWaitsForTheModeAcknowledgementRegardlessOfFilenameOrder() async throws {
        let host = try SettingsHostFixture(delay: 400)
        defer { host.stop() }
        try await host.until { try host.state().status == "idle" }
        XCTAssertTrue(host.process.suspend())
        do {
            try host.put(ClaudeHostCommand(id: "settings-1", kind: "settings", text: "", settings: AgentSessionSettings(revision: 1, mode: "plan")))
            try host.put(ClaudeHostCommand(id: "000-message", kind: "message", text: "after settings"))
        } catch { host.process.resume(); throw error }
        host.process.resume()
        try await host.until { host.events().contains { ($0["request"] as? [String: Any])?["subtype"] as? String == "set_permission_mode" } }
        XCTAssertFalse(host.events().contains { $0["fixture"] as? String == "received_user" && $0["uuid"] as? String == "000-message" })
        try await host.until { try host.state().commandResults["000-message"]?.status == "delivered" }
        try await host.until { host.events().contains { $0["fixture"] as? String == "received_user" && $0["uuid"] as? String == "000-message" } }
        let delivered = host.events().filter { $0["fixture"] as? String == "received_user" && $0["uuid"] as? String == "000-message" }
        XCTAssertEqual(delivered.count, 1)
        XCTAssertEqual(delivered.first?["mode"] as? String, "plan")
    }

    func testFailedModeBlocksPromptsAcrossPollsButAllowsStopAndANewerRevision() async throws {
        let host = try SettingsHostFixture(reject: "plan")
        defer { host.stop() }
        try await host.until { try host.state().status == "idle" }
        try host.put(ClaudeHostCommand(id: "settings-1", kind: "settings", text: "", settings: AgentSessionSettings(revision: 1, mode: "plan")))
        try await host.until { try host.state().settingsError != nil }
        for id in ["first-message", "later-message"] {
            try host.put(ClaudeHostCommand(id: id, kind: "message", text: "must not arrive"))
            try await host.until { try host.state().commandResults[id]?.status == "failed" }
        }
        XCTAssertFalse(host.events().contains { $0["fixture"] as? String == "received_user" && ["first-message", "later-message"].contains($0["uuid"] as? String ?? "") })
        let turn = try XCTUnwrap(host.state().initialTurnId)
        try host.put(ClaudeHostCommand(id: "stop", kind: "interrupt", text: "", turnId: turn))
        try await host.until { try host.state().commandResults["stop"]?.status == "delivered" }
        try host.put(ClaudeHostCommand(id: "settings-2", kind: "settings", text: "", settings: AgentSessionSettings(revision: 2, mode: "default")))
        try await host.until { try host.state().settingsRevision == 2 && host.state().settingsError == nil }
        try host.put(ClaudeHostCommand(id: "new-message", kind: "message", text: "new explicit reply"))
        try await host.until { host.events().contains { $0["fixture"] as? String == "received_user" && $0["uuid"] as? String == "new-message" } }
    }

    func testNativePermissionDenialRemainsUsableAfterSettingsFailure() async throws {
        let host = try SettingsHostFixture(reject: "plan", prompt: "approval requested")
        defer { host.stop() }
        try await host.until { try host.state().waitingForInput }
        try host.put(ClaudeHostCommand(id: "settings-1", kind: "settings", text: "", settings: AgentSessionSettings(revision: 1, mode: "plan")))
        try await host.until { try host.state().settingsError != nil }
        try host.put(ClaudeHostCommand(id: "deny", kind: "message", text: "授权请求 claude-native-1: 拒绝"))
        try await host.until { try host.state().commandResults["deny"]?.status == "delivered" }
        try await host.until {
            host.events().contains { (($0["response"] as? [String: Any])?["response"] as? [String: Any])?["behavior"] as? String == "deny" }
        }
        XCTAssertTrue(host.events().contains {
            let response = ($0["response"] as? [String: Any])?["response"] as? [String: Any]
            return response?["behavior"] as? String == "deny"
        })
    }
}
