import XCTest
import Darwin
@testable import MissionGoNodeCore

final class ClaudeExternalBridgeTests: XCTestCase {
    private func directory() throws -> String {
        let path = FileManager.default.temporaryDirectory.appendingPathComponent("mg-external-\(UUID().uuidString)").path
        try ClaudeExternalBridge.privateDirectory(path)
        addTeardownBlock { try? FileManager.default.removeItem(atPath: path) }
        return path
    }

    func testUUIDIdentityCannotTraverseDirectories() throws {
        XCTAssertEqual(try ClaudeExternalBridge.normalizedRef("DDCCBBAA-0000-4000-8000-001122334455"), "ddccbbaa-0000-4000-8000-001122334455")
        XCTAssertThrowsError(try ClaudeExternalBridge.normalizedRef("../other"))
    }

    func testPrivateIPCRejectsSymlinksAndWorldReadableDirectories() throws {
        let path = try directory()
        try FileManager.default.createSymbolicLink(atPath: path + "/link", withDestinationPath: path)
        XCTAssertThrowsError(try ClaudeExternalBridge.privateDirectory(path + "/link"))
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: path)
        XCTAssertThrowsError(try ClaudeExternalBridge.privateDirectory(path))
    }

    func testKernelLeasePreventsTwoHostsAndCanBeReacquiredAfterRelease() throws {
        let path = try directory()
        var lease: ClaudeExternalBridge.Lease? = try ClaudeExternalBridge.Lease(directory: path)
        XCTAssertThrowsError(try ClaudeExternalBridge.Lease(directory: path))
        withExtendedLifetime(lease) {}
        lease = nil
        XCTAssertNoThrow(try ClaudeExternalBridge.Lease(directory: path))
    }

    func testExternalArgvKeepsUserConfigurationAndDoesNotRequireRemoteControlOrOfficialModel() throws {
        let config = ClaudeHostConfiguration(claudeExecutable: "claude", cwd: "example", mode: "default", sessionName: "External",
            sessionRef: UUID().uuidString, prompt: "Handle", statePath: "state", commandsDirectory: "commands", logPath: "log",
            externalArguments: ["--model", "company-alias", "--settings", "settings.json"], externalResume: true)
        let argv = try ClaudeExternalBridge.arguments(config: config)
        XCTAssertTrue(argv.contains("company-alias"))
        XCTAssertTrue(argv.contains("settings.json"))
        XCTAssertTrue(argv.contains("--resume"))
        XCTAssertFalse(argv.contains("--remote-control"))
        XCTAssertFalse(argv.contains("--permission-mode"))
        XCTAssertThrowsError(try ClaudeExternalBridge.validateArguments(["--session-id", "other"]))
        XCTAssertThrowsError(try ClaudeExternalBridge.validateArguments(["--settings", "{\"env\":{\"TOKEN\":\"secret\"}}"] ))
    }

    func testEnvironmentDriftDetectionAllowsRotatedTokensButDetectsMissingProviderConfiguration() {
        let env = ["ANTHROPIC_BASE_URL": "https://gateway.invalid", "ANTHROPIC_MODEL": "custom", "ANTHROPIC_AUTH_TOKEN": "synthetic-one"]
        var rotated = env; rotated["ANTHROPIC_AUTH_TOKEN"] = "synthetic-two"
        XCTAssertEqual(ClaudeExternalBridge.environmentFingerprint(env), ClaudeExternalBridge.environmentFingerprint(rotated))
        XCTAssertNotEqual(ClaudeExternalBridge.environmentFingerprint(env), ClaudeExternalBridge.environmentFingerprint([:]))
    }

    func testSecretsAndEndpointAreRemovedFromNativeSnapshotStrings() {
        let env = ["ANTHROPIC_BASE_URL": "https://gateway.invalid", "ANTHROPIC_AUTH_TOKEN": "synthetic-secret"]
        let event: [String: Any] = ["message": ["content": [["text": "synthetic-secret at https://gateway.invalid"]]], "session_id": "native-id"]
        let sanitized = ClaudeExternalBridge.redact(event, environment: env)
        let content = ((sanitized["message"] as! [String: Any])["content"] as! [[String: String]])[0]["text"]!
        XCTAssertFalse(content.contains("synthetic-secret"))
        XCTAssertFalse(content.contains("gateway.invalid"))
        XCTAssertEqual(sanitized["session_id"] as? String, "native-id")
    }

    func testCrashConvertsOnlyUnacknowledgedWritesToUncertainWithoutResending() {
        let state = ClaudeHostState(status: "idle", sessionRef: "native", commandResults: [
            "received": ClaudeHostCommandResult(status: "delivered"), "sent": ClaudeHostCommandResult(status: "delivering")])
        let recovered = ClaudeExternalBridge.uncertainWrites(state)
        XCTAssertEqual(recovered.commandResults["received"]?.status, "delivered")
        XCTAssertEqual(recovered.commandResults["sent"]?.status, "delivery_unknown")
    }

    func testHistoryIsExactAndRequiresMatchingWorkingDirectory() throws {
        let path = try directory()
        let ref = UUID().uuidString.lowercased()
        let file = path + "/history.jsonl"
        let event: [String: Any] = ["sessionId": ref, "cwd": path, "type": "assistant", "uuid": "a1",
            "message": ["content": [["type": "text", "text": "Earlier answer"]]]]
        try JSONSerialization.data(withJSONObject: event).write(to: URL(fileURLWithPath: file))
        XCTAssertEqual(try ClaudeExternalBridge.history(path: file, sessionRef: ref, cwd: path).map(\.text), ["Earlier answer"])
        XCTAssertThrowsError(try ClaudeExternalBridge.history(path: file, sessionRef: UUID().uuidString, cwd: path))
        XCTAssertThrowsError(try ClaudeExternalBridge.history(path: file, sessionRef: ref, cwd: path + "/other"))
    }

    func testMissingExternalBridgeDoesNotAdoptDispatchOrStartAHost() async throws {
        let root = try directory()
        let launcher = SessionLauncher(environment: ShellEnvironment(path: "/usr/bin:/bin"), sessionsDirectory: root)
        let ref = UUID().uuidString.lowercased()
        let session = NodeAgentSession(id: "external", agentKind: "claude_code", sessionRef: ref, status: "idle", externalBindingGeneration: 1)
        do { _ = try await launcher.synchronize(session); XCTFail("A progress identity is not a control channel") }
        catch { XCTAssertTrue(error.localizedDescription.contains("尚未接入本机桥接")) }
        XCTAssertFalse(FileManager.default.fileExists(atPath: root + "/external/" + ref))
    }

    func testExternalPermissionCardRequiresAnExplicitLocalRequestId() {
        var snapshot = ClaudeStreamSnapshot(sessionRef: "native")
        snapshot.showExternalPermissionRequest(ClaudePermissionRequest(requestId: "approval-1", toolName: "Bash", input: ["command": "test command"]))
        XCTAssertTrue(snapshot.state.messages[0].text.contains("/answer approval-1"))
        XCTAssertNil(snapshot.state.messages[0].questions)
    }

    private func hostFixture(scenario: String = "normal") throws -> (Process, ClaudeHostConfiguration, String) {
        let root = try directory()
        let ref = UUID().uuidString.lowercased()
        let directory = ClaudeHostStore.sessionDirectory(root: root + "/external", sessionRef: ref)
        try ClaudeExternalBridge.privateDirectory(directory + "/commands")
        let fixture = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().appendingPathComponent("Fixtures/claude-external-protocol.py")
        let executable = directory + "/claude"
        try FileManager.default.copyItem(at: fixture, to: URL(fileURLWithPath: executable))
        try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: executable)
        let config = ClaudeHostConfiguration(claudeExecutable: executable, cwd: directory, mode: "default", sessionName: "Fixture",
            sessionRef: ref, prompt: "Handle the item", statePath: directory + "/state.json", commandsDirectory: directory + "/commands",
            logPath: directory + "/host.log", externalArguments: ["--model", "company-alias"], externalResume: false)
        let configPath = directory + "/config.json"
        try ClaudeHostFiles.write(config, to: configPath)
        let candidate = Bundle(for: ClaudeExternalBridgeTests.self).bundleURL.deletingLastPathComponent().appendingPathComponent("MissionGoClaudeHost")
        let binary = try XCTUnwrap(ClaudeHostLocation.executable(mainExecutable: candidate.deletingLastPathComponent().appendingPathComponent("MissionGo")))
        let process = Process()
        process.executableURL = URL(fileURLWithPath: binary)
        process.arguments = [configPath]
        var env = ProcessInfo.processInfo.environment
        env["ANTHROPIC_BASE_URL"] = "https://gateway.invalid"
        env["ANTHROPIC_AUTH_TOKEN"] = "synthetic-secret"
        env["MOCK_CLAUDE_CASE"] = scenario
        process.environment = env
        process.standardInput = FileHandle.nullDevice
        process.standardOutput = FileHandle.nullDevice
        process.standardError = FileHandle.nullDevice
        try process.run()
        addTeardownBlock {
            if process.isRunning { process.terminate(); process.waitUntilExit() }
            if let state = try? ClaudeHostFiles.readState(config.statePath), let child = state.externalChildPid, ClaudeHostProcess.isRunning(child) {
                kill(child, SIGKILL)
            }
        }
        return (process, config, root)
    }

    private func waitState(_ path: String, _ condition: (ClaudeHostState) -> Bool) throws -> ClaudeHostState {
        let deadline = Date().addingTimeInterval(5)
        while Date() < deadline {
            if let state = try? ClaudeHostFiles.readState(path), condition(state) { return state }
            usleep(20_000)
        }
        XCTFail("Timed out waiting for local protocol fixture")
        return try ClaudeHostFiles.readState(path)
    }

    func testThirdPartyProtocolRoundTripThroughNodeAdapterWithNoRemoteControl() async throws {
        let (_, config, root) = try hostFixture()
        let first = try waitState(config.statePath) { $0.launchReady && $0.status == "idle" }
        XCTAssertNil(first.sessionUrl)
        XCTAssertTrue(first.messages.contains { $0.text.contains("Result:") })
        let launcher = SessionLauncher(environment: ShellEnvironment(path: "/usr/bin:/bin"), sessionsDirectory: root)
        let id = UUID().uuidString.lowercased()
        let command = AgentSessionCommand(id: id, text: "Web reply", status: "queued")
        let session = NodeAgentSession(id: "external", agentKind: "claude_code", sessionRef: config.sessionRef, status: "idle",
            lifecycle: "close", command: command, externalBindingGeneration: 1)
        let reservation = try await launcher.synchronize(session)
        XCTAssertEqual(reservation.commandStatus, "delivering")
        let delivering = NodeAgentSession(id: "external", agentKind: "claude_code", sessionRef: config.sessionRef, status: "idle",
            command: AgentSessionCommand(id: id, text: "Web reply", status: "delivering"), externalBindingGeneration: 1)
        _ = try await launcher.synchronize(delivering)
        let received = try waitState(config.statePath) { $0.commandResults[id]?.status == "delivered" && $0.status == "idle" }
        let result = try await launcher.synchronize(delivering)
        XCTAssertEqual(result.commandStatus, "delivered")
        XCTAssertEqual(received.messages.filter { $0.sourceId == id }.count, 1)
        _ = try await launcher.synchronize(delivering)
        let payload = String(data: try JSONEncoder().encode(received), encoding: .utf8)!
        XCTAssertFalse(payload.contains("synthetic-secret"))
        XCTAssertFalse(payload.contains("gateway.invalid"))
        XCTAssertFalse(try String(contentsOfFile: config.logPath).contains("synthetic-secret"))
    }

    func testUnacknowledgedWriteIsNotReportedAsDeliveredAndOrdinaryTextCannotApprove() throws {
        let (_, config, _) = try hostFixture()
        _ = try waitState(config.statePath) { $0.launchReady && $0.status == "idle" }
        func send(_ text: String, request: String? = nil) throws -> String {
            let id = UUID().uuidString.lowercased()
            try ClaudeHostFiles.write(ClaudeHostCommand(id: id, kind: request == nil ? "message" : "permission_response", text: text, permissionRequestId: request),
                to: config.commandsDirectory + "/" + id + ".json")
            return id
        }
        let uncertain = try send("unacknowledged")
        let written = try waitState(config.statePath) { $0.commandResults[uncertain]?.status == "delivering" && $0.status == "idle" }
        XCTAssertEqual(written.commandResults[uncertain]?.status, "delivering")
        let request = try send("permission")
        _ = try waitState(config.statePath) { $0.commandResults[request]?.status == "delivered" && $0.waitingForInput }
        let text = try send("批准")
        _ = try waitState(config.statePath) { $0.commandResults[text]?.status == "failed" }
        let mismatched = try send("批准", request: "old-request")
        _ = try waitState(config.statePath) { $0.commandResults[mismatched]?.status == "failed" }
        let explicit = try send("拒绝", request: "permission-1")
        _ = try waitState(config.statePath) { $0.commandResults[explicit]?.status == "delivered" && !$0.waitingForInput }
        let earlyRelease = UUID().uuidString.lowercased()
        try ClaudeHostFiles.write(ClaudeHostCommand(id: earlyRelease, kind: "release", text: ""), to: config.commandsDirectory + "/" + earlyRelease + ".json")
        _ = try waitState(config.statePath) { $0.commandResults[earlyRelease]?.status == "failed" }
        let confirmation = UUID().uuidString.lowercased()
        try ClaudeHostFiles.write(ClaudeHostCommand(id: confirmation, kind: "delivery_resolution", text: "not_received", permissionRequestId: uncertain),
                                 to: config.commandsDirectory + "/" + confirmation + ".json")
        _ = try waitState(config.statePath) { $0.commandResults[uncertain]?.status == "failed" }
        let release = UUID().uuidString.lowercased()
        try ClaudeHostFiles.write(ClaudeHostCommand(id: release, kind: "release", text: ""), to: config.commandsDirectory + "/" + release + ".json")
        _ = try waitState(config.statePath) { $0.status == "suspended" }

    }

    func testWrongNativeIDStopsBridgeBeforeItBecomesReplyable() throws {
        let (_, config, _) = try hostFixture(scenario: "wrong-id")
        let failed = try waitState(config.statePath) { $0.status == "failed" }
        XCTAssertFalse(failed.launchReady)
        XCTAssertTrue(failed.error?.contains("ID 不匹配") == true)
    }
}
