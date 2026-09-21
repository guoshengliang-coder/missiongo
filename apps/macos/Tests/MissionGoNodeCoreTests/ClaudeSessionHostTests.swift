import XCTest
@testable import MissionGoNodeCore

final class ClaudeStreamSnapshotTests: XCTestCase {
    func testBuildsAStableConversationFromStreamJson() {
        var snapshot = ClaudeStreamSnapshot(sessionRef: "session-1")
        snapshot.consume(["type": "system", "subtype": "init", "session_id": "session-1"])
        snapshot.consume([
            "type": "user",
            "uuid": "user-1",
            "parent_tool_use_id": NSNull(),
            "message": ["role": "user", "content": [["type": "text", "text": "Inspect this."]]],
        ])
        snapshot.consume([
            "type": "assistant",
            "uuid": "frame-1",
            "user_message_uuid": "user-1",
            "parent_tool_use_id": NSNull(),
            "message": ["id": "message-1", "content": [["type": "text", "text": "First finding."]]],
        ])
        snapshot.consume([
            "type": "assistant",
            "uuid": "frame-2",
            "user_message_uuid": "user-1",
            "parent_tool_use_id": NSNull(),
            "message": ["id": "message-1", "content": [["type": "text", "text": "Second finding."]]],
        ])
        snapshot.consume([
            "type": "assistant",
            "uuid": "frame-3",
            "user_message_uuid": "user-1",
            "parent_tool_use_id": NSNull(),
            "message": ["id": "message-2", "content": [[
                "type": "tool_use",
                "name": "AskUserQuestion",
                "input": ["questions": [[
                    "question": "Ship it?",
                    "options": [["label": "Yes"], ["label": "No"]],
                ]]],
            ]]],
        ])
        snapshot.consume([
            "type": "result",
            "subtype": "error_during_execution",
            "terminal_reason": "aborted_streaming",
        ])

        XCTAssertTrue(snapshot.initialized)
        XCTAssertEqual(snapshot.state.status, "idle")
        XCTAssertNil(snapshot.state.error)
        XCTAssertEqual(snapshot.state.messages.count, 3)
        XCTAssertEqual(snapshot.state.messages[0].role, "user")
        XCTAssertEqual(snapshot.state.messages[1].text, "First finding.\nSecond finding.")
        XCTAssertEqual(snapshot.state.messages[1].turnId, "user-1")
        XCTAssertEqual(snapshot.state.messages[2].questions, [AgentSessionQuestion(title: "Ship it?", options: ["Yes", "No"])])
    }

    func testIgnoresToolResultsAndSubagentMessages() {
        var snapshot = ClaudeStreamSnapshot(sessionRef: "session-1")
        snapshot.consume([
            "type": "user",
            "uuid": "tool-result",
            "parent_tool_use_id": "tool-1",
            "message": ["role": "user", "content": "internal"],
        ])
        snapshot.consume([
            "type": "assistant",
            "uuid": "subagent",
            "parent_tool_use_id": "task-1",
            "message": ["id": "message-1", "content": [["type": "text", "text": "internal"]]],
        ])
        XCTAssertTrue(snapshot.state.messages.isEmpty)
    }
}

final class ClaudeSessionSynchronizationTests: XCTestCase {
    private func fixture(status: String = "idle") throws -> (SessionLauncher, String, String) {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("missiongo-claude-sync-\(UUID().uuidString)").path
        let sessionRef = UUID().uuidString.lowercased()
        let directory = ClaudeHostStore.sessionDirectory(root: root, sessionRef: sessionRef)
        try FileManager.default.createDirectory(
            atPath: "\(directory)/commands",
            withIntermediateDirectories: true
        )
        try ClaudeHostFiles.write(
            ClaudeHostState(status: status, sessionRef: sessionRef),
            to: ClaudeHostStore.statePath(root: root, sessionRef: sessionRef)
        )
        return (SessionLauncher(
            environment: ShellEnvironment(path: "/usr/bin:/bin"),
            hostExecutable: nil,
            sessionsDirectory: root
        ), root, sessionRef)
    }

    func testReservesThenQueuesAnIdleReplyForTheDetachedHost() async throws {
        let (launcher, root, sessionRef) = try fixture()
        defer { try? FileManager.default.removeItem(atPath: root) }
        let queued = NodeAgentSession(
            id: "server-session",
            agentKind: "claude_code",
            sessionRef: sessionRef,
            status: "idle",
            command: AgentSessionCommand(id: "command-1", kind: "message", text: "Continue")
        )
        let reservation = try await launcher.synchronize(queued)
        XCTAssertEqual(reservation.commandStatus, "delivering")

        let delivering = NodeAgentSession(
            id: queued.id,
            agentKind: queued.agentKind,
            sessionRef: sessionRef,
            status: "idle",
            command: AgentSessionCommand(id: "command-1", kind: "message", text: "Continue", status: "delivering")
        )
        let pending = try await launcher.synchronize(delivering)
        XCTAssertNil(pending.commandStatus)
        let path = ClaudeHostStore.commandPath(root: root, sessionRef: sessionRef, commandId: "command-1")
        let command = try JSONDecoder().decode(ClaudeHostCommand.self, from: Data(contentsOf: URL(fileURLWithPath: path)))
        XCTAssertEqual(command, ClaudeHostCommand(id: "command-1", kind: "message", text: "Continue"))

        try ClaudeHostFiles.write(
            ClaudeHostState(
                status: "active",
                sessionRef: sessionRef,
                commandResults: ["command-1": ClaudeHostCommandResult(status: "delivered")]
            ),
            to: ClaudeHostStore.statePath(root: root, sessionRef: sessionRef)
        )
        let acknowledged = try await launcher.synchronize(delivering)
        XCTAssertEqual(acknowledged.commandStatus, "delivered")
        XCTAssertEqual(acknowledged.status, "active")
    }

    func testQueuesAnInterruptOnlyWhileClaudeIsActive() async throws {
        let (launcher, root, sessionRef) = try fixture(status: "active")
        defer { try? FileManager.default.removeItem(atPath: root) }
        let interrupt = NodeAgentSession(
            id: "server-session",
            agentKind: "claude_code",
            sessionRef: sessionRef,
            status: "active",
            command: AgentSessionCommand(id: "stop-1", kind: "interrupt", text: "停止当前任务", turnId: "turn-1")
        )
        let queued = try await launcher.synchronize(interrupt)
        XCTAssertNil(queued.commandStatus)
        let path = ClaudeHostStore.commandPath(root: root, sessionRef: sessionRef, commandId: "stop-1")
        XCTAssertTrue(FileManager.default.fileExists(atPath: path))

        try ClaudeHostFiles.write(
            ClaudeHostState(status: "idle", sessionRef: sessionRef),
            to: ClaudeHostStore.statePath(root: root, sessionRef: sessionRef)
        )
        let acknowledged = try await launcher.synchronize(interrupt)
        XCTAssertEqual(acknowledged.commandStatus, "delivered")
    }

    func testAStoppedDetachedHostBecomesUnavailable() async throws {
        let (launcher, root, sessionRef) = try fixture(status: "idle")
        defer { try? FileManager.default.removeItem(atPath: root) }
        try ClaudeHostFiles.write(
            ClaudeHostState(status: "idle", sessionRef: sessionRef, hostPid: Int32.max),
            to: ClaudeHostStore.statePath(root: root, sessionRef: sessionRef)
        )
        let report = try await launcher.synchronize(NodeAgentSession(
            id: "server-session",
            agentKind: "claude_code",
            sessionRef: sessionRef,
            status: "idle"
        ))
        XCTAssertEqual(report.status, "unavailable")
        XCTAssertTrue(report.error?.contains("宿主已停止") == true)
    }
}
