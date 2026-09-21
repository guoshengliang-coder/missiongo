import XCTest
@testable import MissionGoNodeCore

final class ClaudeStreamSnapshotTests: XCTestCase {
    func testBuildsAStableConversationFromStreamJson() {
        var snapshot = ClaudeStreamSnapshot(sessionRef: "session-1")
        snapshot.consume(["type": "system", "subtype": "init", "session_id": "session-1"])
        snapshot.consume([
            "type": "user",
            "uuid": "user-1",
            "origin": ["kind": "human"],
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

    func testOnlyMirrorsHumanAndExplicitHostMessages() {
        var snapshot = ClaudeStreamSnapshot(sessionRef: "session-1")
        snapshot.consume([
            "type": "user", "uuid": "bootstrap", "parent_tool_use_id": NSNull(),
            "message": ["role": "user", "content": [["type": "text", "text": "dispatch prompt"]]],
        ])
        snapshot.consume([
            "type": "user", "uuid": "skill", "parent_tool_use_id": NSNull(),
            "message": ["role": "user", "content": [["type": "text", "text": "Base directory for this skill"]]],
        ])
        snapshot.consume([
            "type": "user", "uuid": "native", "origin": ["kind": "human"],
            "parent_tool_use_id": NSNull(), "message": ["role": "user", "content": "原生回复"],
        ])
        snapshot.makeUserMessageVisible(id: "web")
        snapshot.consume([
            "type": "user", "uuid": "web", "parent_tool_use_id": NSNull(),
            "message": ["role": "user", "content": [["type": "text", "text": "网页回复"]]],
        ])

        XCTAssertEqual(snapshot.state.messages.map(\.text), ["原生回复", "网页回复"])
    }

    func testBackgroundTasksKeepTheSessionActiveAfterATurnResult() {
        var snapshot = ClaudeStreamSnapshot(sessionRef: "session-1")
        snapshot.consume([
            "type": "system", "subtype": "background_tasks_changed",
            "tasks": [[
                "task_id": "task-1", "task_type": "local_agent",
                "description": "Inspect the synchronization path",
            ]],
        ])
        snapshot.consume(["type": "result", "subtype": "success"])

        XCTAssertEqual(snapshot.state.status, "active")
        XCTAssertEqual(snapshot.state.activities, [
            AgentSessionActivity(id: "task-1", title: "Inspect the synchronization path", detail: "运行中"),
        ])

        snapshot.consume([
            "type": "system", "subtype": "background_tasks_changed", "tasks": [],
        ])
        snapshot.consume(["type": "result", "subtype": "success"])
        XCTAssertEqual(snapshot.state.status, "idle")
        XCTAssertTrue(snapshot.state.activities.isEmpty)
    }

    func testSummarizesShellTasksWithoutExposingTheCommand() {
        var snapshot = ClaudeStreamSnapshot(sessionRef: "session-1")
        snapshot.consume([
            "type": "system", "subtype": "background_tasks_changed",
            "tasks": [[
                "task_id": "task-1", "task_type": "local_bash",
                "description": "cd /private/project; printenv SECRET_TOKEN",
            ]],
        ])
        XCTAssertEqual(snapshot.state.activities.first?.title, "后台命令")
    }

    func testProjectsPlanApprovalAsAVisibleQuestion() {
        var snapshot = ClaudeStreamSnapshot(sessionRef: "session-1")
        snapshot.consume([
            "type": "assistant", "uuid": "frame-1", "parent_tool_use_id": NSNull(),
            "message": ["id": "message-1", "content": [[
                "type": "tool_use", "name": "ExitPlanMode", "input": ["plan": "Do the work"],
            ]]],
        ])
        XCTAssertEqual(snapshot.state.messages.last?.questions, [
            AgentSessionQuestion(
                header: "计划审批",
                title: "是否批准这份计划并开始实施？",
                options: ["批准并实施", "继续修改计划"]
            ),
        ])
    }

    func testOldHostStateDefaultsNewFields() throws {
        let data = Data(#"{"status":"idle","sessionRef":"session-1","messages":[],"commandResults":{}}"#.utf8)
        let state = try JSONDecoder().decode(ClaudeHostState.self, from: data)
        XCTAssertEqual(state.activities, [])
        XCTAssertFalse(state.waitingForInput)
    }

    func testOldHostConfigurationGetsApprovedLifecycleDefaults() throws {
        let data = Data(#"{"version":1,"claudeExecutable":"/usr/bin/claude","cwd":"/repo","mode":"default","sessionName":"M4-AND-111","sessionRef":"session-1","prompt":"work","statePath":"/state","commandsDirectory":"/commands","logPath":"/log"}"#.utf8)
        let configuration = try JSONDecoder().decode(ClaudeHostConfiguration.self, from: data)

        XCTAssertEqual(configuration.idleTimeoutSeconds, 2 * 60 * 60)
        XCTAssertEqual(configuration.stallWarningSeconds, 30 * 60)
    }

    func testRuntimePolicySuspendsOnlyGenuinelyIdleSessions() {
        let now = Date()
        let old = now.addingTimeInterval(-(2 * 60 * 60 + 1))
        let idle = ClaudeHostState(status: "idle", sessionRef: "session-1", idleSince: old)
        XCTAssertTrue(ClaudeRuntimePolicy.shouldSuspend(state: idle, now: now, timeout: 2 * 60 * 60))

        let waiting = ClaudeHostState(
            status: "idle", sessionRef: "session-1", waitingForInput: true, idleSince: old
        )
        XCTAssertFalse(ClaudeRuntimePolicy.shouldSuspend(state: waiting, now: now, timeout: 2 * 60 * 60))
        let active = ClaudeHostState(status: "active", sessionRef: "session-1", idleSince: old)
        XCTAssertFalse(ClaudeRuntimePolicy.shouldSuspend(state: active, now: now, timeout: 2 * 60 * 60))
    }

    func testRuntimePolicyWarnsWithoutKillingOnlyAfterOutputAndCpuBothStop() {
        let now = Date()
        let old = now.addingTimeInterval(-(30 * 60 + 1))
        let recent = now.addingTimeInterval(-60)
        let state = ClaudeHostState(status: "active", sessionRef: "session-1", lastProgressAt: old)

        XCTAssertTrue(ClaudeRuntimePolicy.shouldWarnStalled(
            state: state, now: now, lastCpuProgressAt: old, timeout: 30 * 60
        ))
        XCTAssertFalse(ClaudeRuntimePolicy.shouldWarnStalled(
            state: state, now: now, lastCpuProgressAt: recent, timeout: 30 * 60
        ))
    }

    func testResumingPreservesConversationAndAcknowledgements() {
        let message = AgentSessionMessage(sourceId: "m1", turnId: "m1", role: "agent", text: "done")
        let old = ClaudeHostState(
            status: "suspended",
            sessionRef: "session-1",
            sessionUrl: "https://claude.ai/code/session_old",
            messages: [message],
            commandResults: ["c1": ClaudeHostCommandResult(status: "delivered")],
            error: "idle"
        )

        let resumed = ClaudeStreamSnapshot(resuming: old, hostPid: 42).state
        XCTAssertEqual(resumed.status, "suspended")
        XCTAssertEqual(resumed.hostPid, 42)
        XCTAssertEqual(resumed.messages, [message])
        XCTAssertEqual(resumed.commandResults["c1"]?.status, "delivered")
        XCTAssertNil(resumed.error)
    }

    func testUnattendedClaudeDisablesItsCompetingUpdater() {
        XCTAssertEqual(
            ClaudeProcessEnvironment.unattended(["PATH": "/usr/bin"])["DISABLE_AUTOUPDATER"],
            "1"
        )
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

    func testDeliversAReplyWhileClaudeIsWaitingForInteractiveInput() async throws {
        let (launcher, root, sessionRef) = try fixture(status: "active")
        defer { try? FileManager.default.removeItem(atPath: root) }
        try ClaudeHostFiles.write(
            ClaudeHostState(status: "active", sessionRef: sessionRef, waitingForInput: true),
            to: ClaudeHostStore.statePath(root: root, sessionRef: sessionRef)
        )
        let queued = NodeAgentSession(
            id: "server-session",
            agentKind: "claude_code",
            sessionRef: sessionRef,
            status: "active",
            command: AgentSessionCommand(id: "answer-1", kind: "message", text: "批准并实施")
        )
        let reservation = try await launcher.synchronize(queued)
        XCTAssertEqual(reservation.commandStatus, "delivering")
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

    func testFinishedWorkClosesTheHostButKeepsItsConversation() async throws {
        let (launcher, root, sessionRef) = try fixture(status: "idle")
        defer { try? FileManager.default.removeItem(atPath: root) }
        let report = try await launcher.synchronize(NodeAgentSession(
            id: "server-session",
            agentKind: "claude_code",
            sessionRef: sessionRef,
            status: "idle",
            lifecycle: "close"
        ))

        XCTAssertEqual(report.status, "suspended")
        XCTAssertTrue(report.error?.contains("已全部完成") == true)
        let state = try ClaudeHostFiles.readState(
            ClaudeHostStore.statePath(root: root, sessionRef: sessionRef)
        )
        XCTAssertNil(state.hostPid)
        XCTAssertEqual(state.status, "suspended")
    }
}
