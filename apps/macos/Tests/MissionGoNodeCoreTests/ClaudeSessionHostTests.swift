import XCTest
@testable import MissionGoNodeCore

final class ClaudeStreamSnapshotTests: XCTestCase {
    func testGatewayMessageIdReuseDoesNotMoveNewRepliesIntoOldBubbles() {
        var snapshot = ClaudeStreamSnapshot(sessionRef: "session-1")
        func frame(_ uuid: String, _ text: String, _ timestamp: String) -> [String: Any] {
            ["type": "assistant", "uuid": uuid, "timestamp": timestamp,
             "message": ["id": "msg_gateway", "content": [["type": "text", "text": text]]]]
        }
        snapshot.consume(frame("frame-1", "First reply", "2026-09-30T01:00:00.000Z"))
        snapshot.recordUserMessage(id: "user-2", text: "Continue")
        let reply = frame("frame-2", "New reply", "2026-09-30T02:00:00.000Z")
        snapshot.consume(reply)
        snapshot.consume(reply)
        XCTAssertEqual(snapshot.state.messages.map(\.text), ["First reply", "Continue", "New reply"])
        XCTAssertEqual(snapshot.state.messages.last?.occurredAt, "2026-09-30T02:00:00.000Z")
        XCTAssertEqual(snapshot.state.messages.last?.turnId, "user-2")
    }

    func testBlockingLimitCannotBeReportedAsSuccessfulIdleTurn() {
        var snapshot = ClaudeStreamSnapshot(sessionRef: "session-1")
        snapshot.consume(["type": "assistant", "uuid": "error-frame", "error": "invalid_request",
            "message": ["id": "synthetic", "model": "<synthetic>",
                "content": [["type": "text", "text": "Prompt is too long"]]]])
        snapshot.consume(["type": "result", "subtype": "success", "is_error": true,
            "terminal_reason": "blocking_limit"])
        XCTAssertFalse(snapshot.state.turnActive)
        XCTAssertEqual(snapshot.state.status, "idle")
        XCTAssertTrue(snapshot.state.error?.contains("上下文超出模型限制") == true)
        snapshot.recordUserMessage(id: "next", text: "Continue")
        XCTAssertNil(snapshot.state.error)
    }

    func testErrorResultWithoutAssistantErrorHasAVisibleReason() {
        var snapshot = ClaudeStreamSnapshot(sessionRef: "session-1")
        snapshot.consume(["type": "result", "subtype": "success", "is_error": true])
        XCTAssertNotNil(snapshot.state.error)
        snapshot.consume(["type": "result", "subtype": "error_during_execution", "terminal_reason": "aborted_streaming"])
        XCTAssertNil(snapshot.state.error)
    }

    func testCompactionProgressUpdatesOneCardAndReportsFailures() {
        var snapshot = ClaudeStreamSnapshot(sessionRef: "session-1")
        let start: [String: Any] = ["type": "system", "subtype": "status", "status": "compacting"]
        snapshot.consume(start)
        snapshot.consume(start)
        XCTAssertEqual(snapshot.state.messages.count, 1)
        XCTAssertTrue(snapshot.state.messages[0].text.contains("正在自动压缩"))
        snapshot.consume(["type": "system", "subtype": "status", "compact_result": "failed", "compact_error": "too_few_groups"])
        XCTAssertEqual(snapshot.state.messages.count, 1)
        XCTAssertTrue(snapshot.state.messages[0].text.contains("消息分组不足"))
        snapshot.consume(start)
        snapshot.consume(["type": "system", "subtype": "compact_boundary"])
        snapshot.consume(["type": "system", "subtype": "status", "compact_result": "success"])
        XCTAssertEqual(snapshot.state.messages.count, 2)
        XCTAssertEqual(snapshot.state.messages[1].text, "上下文自动压缩完成。")
        XCTAssertTrue(snapshot.state.activities.isEmpty)
    }

    func testEstimatedThinkingTokensCountDeltasRatherThanCumulativeTotals() {
        var snapshot = ClaudeStreamSnapshot(sessionRef: "session-1")
        snapshot.recordUserMessage(id: "u1", text: "Inspect")
        snapshot.consume(["type": "system", "subtype": "thinking_tokens", "estimated_tokens": 4, "estimated_tokens_delta": 4])
        snapshot.consume(["type": "system", "subtype": "thinking_tokens", "estimated_tokens": 9, "estimated_tokens_delta": 5])
        snapshot.consume(["type": "system", "subtype": "thinking_tokens", "estimated_tokens": 2, "estimated_tokens_delta": 2])
        XCTAssertEqual(snapshot.state.thinkingTokens, 11)
        snapshot.consume(["type": "result", "subtype": "success"])
        snapshot.recordUserMessage(id: "u2", text: "Continue")
        snapshot.consume(["type": "system", "subtype": "thinking_tokens", "estimated_tokens": 8])
        XCTAssertEqual(snapshot.state.thinkingTokens, 8)
    }

    func testRestoresHistoricalClaudeChoiceOnResume() {
        let state = ClaudeHostState(status: "idle", sessionRef: "session-1", messages: [
            AgentSessionMessage(sourceId: "q1", role: "agent", text: "Choose",
                questions: [AgentSessionQuestion(title: "Ship?", options: ["Yes", "No"])]),
            AgentSessionMessage(sourceId: "a1", role: "user", text: "Yes"),
        ])
        let snapshot = ClaudeStreamSnapshot(resuming: state, hostPid: 123)
        XCTAssertEqual(snapshot.state.messages[0].questions?.first?.answered, "Yes")
    }

    func testMarksClaudeChoiceWhenVisibleReplyArrives() {
        var snapshot = ClaudeStreamSnapshot(sessionRef: "session-1")
        snapshot.consume(["type": "assistant", "parent_tool_use_id": NSNull(),
            "message": ["id": "q1", "content": [["type": "tool_use", "name": "AskUserQuestion",
                "input": ["questions": [["question": "Ship?", "options": [["label": "Yes"], ["label": "No"]]]]]]]]])
        snapshot.consume(["type": "user", "uuid": "a1", "origin": ["kind": "human"],
            "parent_tool_use_id": NSNull(),
            "message": ["role": "user", "content": [["type": "text", "text": "No"]]]])
        XCTAssertEqual(snapshot.state.messages[0].questions?.first?.answered, "No")
    }

    func testBuildsAStableConversationFromStreamJson() {
        var snapshot = ClaudeStreamSnapshot(sessionRef: "session-1")
        snapshot.consume(["type": "system", "subtype": "init", "session_id": "session-1"])
        snapshot.consume([
            "type": "user",
            "uuid": "user-1",
            "timestamp": "2026-09-22T01:02:03.000Z",
            "origin": ["kind": "human"],
            "parent_tool_use_id": NSNull(),
            "message": ["role": "user", "content": [["type": "text", "text": "Inspect this."]]],
        ])
        snapshot.consume([
            "type": "assistant",
            "uuid": "frame-1",
            "timestamp": "2026-09-22T01:02:04.000Z",
            "user_message_uuid": "user-1",
            "parent_tool_use_id": NSNull(),
            "message": ["id": "message-1", "content": [["type": "text", "text": "First finding."]]],
        ])
        snapshot.consume([
            "type": "assistant",
            "uuid": "frame-2",
            "timestamp": "2026-09-22T01:02:05.000Z",
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
        XCTAssertEqual(snapshot.state.messages.count, 4)
        XCTAssertEqual(snapshot.state.messages[0].role, "user")
        XCTAssertEqual(snapshot.state.messages[0].occurredAt, "2026-09-22T01:02:03.000Z")
        XCTAssertEqual(snapshot.state.messages[1].text, "First finding.")
        XCTAssertEqual(snapshot.state.messages[2].text, "Second finding.")
        XCTAssertEqual(snapshot.state.messages[1].occurredAt, "2026-09-22T01:02:04.000Z")
        XCTAssertEqual(snapshot.state.messages[1].turnId, "user-1")
        XCTAssertEqual(snapshot.state.messages[3].questions, [AgentSessionQuestion(title: "Ship it?", options: ["Yes", "No"])])
    }

    /// AND-210: a text block that is only whitespace used to mirror as a
    /// newline message, which the server refuses ("message text is required"),
    /// failing the whole snapshot and leaving the node offline on every retry.
    func testWhitespaceOnlyTextBlocksNeverBecomeMessages() {
        var snapshot = ClaudeStreamSnapshot(sessionRef: "session-1")
        snapshot.consume([
            "type": "assistant",
            "uuid": "frame-1",
            "parent_tool_use_id": NSNull(),
            "message": ["id": "message-1", "content": [["type": "text", "text": "First finding."]]],
        ])
        snapshot.consume([
            "type": "assistant",
            "uuid": "frame-2",
            "user_message_uuid": "user-1",
            "parent_tool_use_id": NSNull(),
            "message": ["id": "message-1", "content": [["type": "text", "text": "\n "]]],
        ])
        snapshot.consume([
            "type": "assistant",
            "uuid": "frame-3",
            "user_message_uuid": "user-1",
            "parent_tool_use_id": NSNull(),
            "message": ["id": "message-2", "content": [["type": "text", "text": "  \n"]]],
        ])
        XCTAssertEqual(snapshot.state.messages.map(\.text), ["First finding."])
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
        // The turn is over even though the background task keeps the status
        // "active" for display; only the flag may decide whether a reply can
        // be handed over (AND-183).
        XCTAssertFalse(snapshot.state.turnActive)
        XCTAssertEqual(snapshot.state.activities.first?.title, "Inspect the synchronization path")
        XCTAssertNotNil(snapshot.state.activities.first?.startedAt)
        XCTAssertNil(snapshot.state.turnStartedAt)

        snapshot.consume([
            "type": "system", "subtype": "background_tasks_changed", "tasks": [],
        ])
        snapshot.consume(["type": "result", "subtype": "success"])
        XCTAssertEqual(snapshot.state.status, "idle")
        XCTAssertFalse(snapshot.state.turnActive)
        XCTAssertTrue(snapshot.state.activities.isEmpty)
    }

    func testTurnTelemetrySurvivesStateEncodingAndClearsAtResult() throws {
        var snapshot = ClaudeStreamSnapshot(sessionRef: "session-1")
        snapshot.recordUserMessage(id: "user-1", text: "Investigate")
        XCTAssertNotNil(snapshot.state.turnStartedAt)
        snapshot.consume(["type": "system", "subtype": "thinking_tokens", "thinking_tokens": 12])
        snapshot.consume(["type": "system", "subtype": "thinking_tokens", "thinking_tokens": 5])
        XCTAssertEqual(snapshot.state.thinkingTokens, 17)
        XCTAssertNotNil(snapshot.state.thinkingStartedAt)
        let decoded = try JSONDecoder().decode(ClaudeHostState.self, from: JSONEncoder().encode(snapshot.state))
        XCTAssertEqual(decoded.thinkingTokens, 17)
        let report = AgentSessionReport(status: "active", messages: []).reportingTurn(decoded)
        XCTAssertEqual(report.turnActive, true)
        XCTAssertEqual(report.thinkingTokens, 17)
        XCTAssertEqual(report.thinkingDurationSeconds, 0)
        snapshot.consume(["type": "result", "subtype": "success"])
        XCTAssertFalse(snapshot.state.turnActive)
        XCTAssertNil(snapshot.state.turnStartedAt)
        XCTAssertNil(snapshot.state.thinkingStartedAt)
        snapshot.setWaitingForInput(true)
        let waiting = AgentSessionReport(status: snapshot.state.status, messages: []).reportingTurn(snapshot.state)
        XCTAssertEqual(waiting.waitingForInput, true)
    }

    func testATurnMarksItselfRunningAgainWhenWorkStarts() {
        var snapshot = ClaudeStreamSnapshot(sessionRef: "session-1")
        snapshot.consume([
            "type": "system", "subtype": "background_tasks_changed",
            "tasks": [["task_id": "task-1", "task_type": "local_agent", "description": "Poll"]],
        ])
        snapshot.consume(["type": "result", "subtype": "success"])
        XCTAssertFalse(snapshot.state.turnActive)

        snapshot.consume([
            "type": "assistant", "uuid": "frame-1", "parent_tool_use_id": NSNull(),
            "message": ["id": "message-1", "content": [["type": "text", "text": "继续处理"]]],
        ])
        XCTAssertTrue(snapshot.state.turnActive)
        XCTAssertEqual(snapshot.state.status, "active")
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
        // A state without the field is an old host: keep the conservative
        // "a turn may be running" reading rather than assume a free session.
        XCTAssertTrue(state.turnActive)
    }

    func testOldHostConfigurationGetsApprovedLifecycleDefaults() throws {
        let data = Data(#"{"version":1,"claudeExecutable":"/usr/bin/claude","cwd":"/repo","mode":"default","sessionName":"M4-AND-111","sessionRef":"session-1","prompt":"work","statePath":"/state","commandsDirectory":"/commands","logPath":"/log"}"#.utf8)
        let configuration = try JSONDecoder().decode(ClaudeHostConfiguration.self, from: data)

        XCTAssertEqual(configuration.idleTimeoutSeconds, 2 * 60 * 60)
        XCTAssertEqual(configuration.stallWarningSeconds, 30 * 60)
    }

    func testOldHostFilesDefaultTheSettingsFields() throws {
        let state = try JSONDecoder().decode(ClaudeHostState.self, from: Data(#"{"status":"idle","sessionRef":"s"}"#.utf8))
        XCTAssertNil(state.model)
        XCTAssertNil(state.settingsRevision)
        // A host from before settings commands never writes this, so it is
        // never handed one.
        XCTAssertFalse(state.acceptsSettings)
        let data = Data(#"{"version":1,"claudeExecutable":"/usr/bin/claude","cwd":"/repo","mode":"default","sessionName":"M4-AND-111","sessionRef":"session-1","prompt":"work","statePath":"/state","commandsDirectory":"/commands","logPath":"/log"}"#.utf8)
        let configuration = try JSONDecoder().decode(ClaudeHostConfiguration.self, from: data)
        XCTAssertNil(configuration.model)
        XCTAssertNil(configuration.effort)
        XCTAssertNil(configuration.modelsCachePath)
        XCTAssertNil(configuration.settingsRevision)
    }

    func testSettingsLayerOverTheConfigurationFieldByField() {
        let configuration = ClaudeHostConfiguration(
            claudeExecutable: "/c", cwd: "/r", mode: "plan", sessionName: "n", sessionRef: "s", prompt: "p",
            statePath: "/s", commandsDirectory: "/d", logPath: "/l", model: "opus", effort: "high"
        )
        let updated = configuration.applying(AgentSessionSettings(revision: 5, mode: "acceptEdits", effort: "low"))
        XCTAssertEqual(updated.mode, "acceptEdits")
        XCTAssertEqual(updated.model, "opus")
        XCTAssertEqual(updated.effort, "low")
        XCTAssertEqual(updated.settingsRevision, 5)
        XCTAssertEqual(updated.prompt, "p")
    }

    func testRecordsTheModelFromInitAndTheLaunchSettings() {
        var snapshot = ClaudeStreamSnapshot(sessionRef: "s")
        snapshot.adoptConfiguration(ClaudeHostConfiguration(
            claudeExecutable: "/c", cwd: "/r", mode: "plan", sessionName: "n", sessionRef: "s", prompt: "p",
            statePath: "/s", commandsDirectory: "/d", logPath: "/l", model: "sonnet", effort: "low", settingsRevision: 2
        ))
        XCTAssertEqual(snapshot.state.model, "sonnet")
        XCTAssertEqual(snapshot.state.effort, "low")
        XCTAssertEqual(snapshot.state.mode, "plan")
        XCTAssertEqual(snapshot.state.settingsRevision, 2)
        XCTAssertTrue(snapshot.state.acceptsSettings)
        snapshot.consume(["type": "system", "subtype": "init", "model": "claude-sonnet-4-6"])
        XCTAssertEqual(snapshot.state.model, "claude-sonnet-4-6")
    }

    func testMapsTheInitializeModelListAndSkipsDefault() async throws {
        let options = ClaudeModelCatalog.options(fromInitialize: [
            "models": [
                ["value": "default", "resolvedModel": "claude-opus-5", "displayName": "Default (recommended)", "supportsEffort": true,
                 "supportedEffortLevels": ["low", "high"]],
                ["value": "opus[1m]", "displayName": "Opus (1M context)", "supportsEffort": true,
                 "supportedEffortLevels": ["low", "medium", "high", "xhigh", "max"]],
                ["value": "haiku", "displayName": "Haiku", "description": "Fastest"],
            ],
            "current_permission_mode": "plan",
        ])
        XCTAssertEqual(options, [
            AgentModelOption(id: "opus[1m]", label: "Opus (1M context)", efforts: ["low", "medium", "high", "xhigh", "max"]),
            AgentModelOption(id: "haiku", label: "Haiku"),
        ])
        XCTAssertNil(ClaudeModelCatalog.options(fromInitialize: ["current_permission_mode": "plan"]))

        let root = FileManager.default.temporaryDirectory.appendingPathComponent("mg-models-\(UUID().uuidString)").path
        try FileManager.default.createDirectory(atPath: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(atPath: root) }
        let launcher = SessionLauncher(
            environment: ShellEnvironment(path: "/usr/bin:/bin"), hostExecutable: nil, sessionsDirectory: root,
            modelProbe: { _ in nil }
        )
        // No successful probe or session: do not advertise guessed aliases.
        let fallback = await launcher.availableModels()
        XCTAssertEqual(fallback, [])
        try ClaudeModelCatalog.save(try XCTUnwrap(options), to: ClaudeHostStore.modelsCachePath(root: root))
        let saved = await launcher.availableModels()
        XCTAssertEqual(saved?.map(\.id), options?.map(\.id))
        XCTAssertTrue(saved?.allSatisfy { $0.label.contains("列表未更新") } ?? false)
    }

    func testCatalogProbeReadsOnlyTheMatchingInitializeResponse() throws {
        let requestId = "catalog-1"
        let unrelated = try JSONSerialization.data(withJSONObject: [
            "type": "control_response", "response": [
                "request_id": "other", "subtype": "success",
                "response": ["models": [["value": "wrong", "displayName": "Wrong"]]],
            ],
        ])
        XCTAssertNil(ClaudeModelProbe.options(fromLine: unrelated, requestId: requestId))
        let answer = try JSONSerialization.data(withJSONObject: [
            "type": "control_response", "response": [
                "request_id": requestId, "subtype": "success",
                "response": ["models": [
                    ["value": "default", "displayName": "Default"],
                    ["value": "opus", "displayName": "DeepSeek V4.1 Flash"],
                    ["value": "company-fable", "displayName": "Fable 5 (company)"],
                    ["value": "sonnet", "displayName": "DeepSeek V4.1 Flash"],
                ]],
            ],
        ])
        XCTAssertEqual(ClaudeModelProbe.options(fromLine: answer, requestId: requestId)?.map(\.id),
                       ["opus", "company-fable", "sonnet"])
    }

    func testLiveCatalogProbeDiagnostic() throws {
        guard ProcessInfo.processInfo.environment["MISSIONGO_TEST_LIVE_CLAUDE_MODEL_PROBE"] == "1" else {
            throw XCTSkip("Requires a configured local Claude CLI")
        }
        let options = ClaudeModelProbe.fetch(environment: ShellEnvironment.resolve())
        XCTAssertFalse(try XCTUnwrap(options).isEmpty)
    }

    func testCatalogRefreshesWithoutStartingWorkAndMarksAnOlderList() async throws {
        let parent = FileManager.default.temporaryDirectory.appendingPathComponent("mg-models-\(UUID().uuidString)").path
        let root = "\(parent)/ClaudeSessions"
        try FileManager.default.createDirectory(atPath: parent, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(atPath: parent) }
        let result = Locked<[AgentModelOption]?>([AgentModelOption(id: "first", label: "First")])
        let launcher = SessionLauncher(
            environment: ShellEnvironment(path: "/usr/bin:/bin"), hostExecutable: nil,
            sessionsDirectory: root, modelProbe: { _ in result.current },
            modelCacheTTL: 0, modelProbeRetryInterval: 0
        )
        let first = await launcher.availableModels()
        XCTAssertEqual(first?.map(\.id), ["first"])
        XCTAssertEqual(ClaudeModelCatalog.load(from: ClaudeHostStore.modelsCachePath(root: root)), first)
        result.withLock { $0 = [AgentModelOption(id: "second", label: "Second")] }
        let second = await launcher.availableModels()
        XCTAssertEqual(second?.map(\.id), ["second"])
        result.withLock { $0 = nil }
        let stale = await launcher.availableModels()
        XCTAssertEqual(stale?.map(\.id), ["second"])
        XCTAssertEqual(stale?.first?.label, "Second（列表未更新）")
    }

    func testKeepsPickerChoicesWithDistinctIdsEvenWhenNamesOrRoutesMatch() {
        // A gateway can serve an Anthropic-looking id, and several aliases
        // with the same label can differ in the effort levels they support.
        let options = ClaudeModelCatalog.options(fromInitialize: [
            "models": [
                ["value": "default", "resolvedModel": "glm-5.3[1m]", "displayName": "Default (recommended)"],
                ["value": "opus", "resolvedModel": "glm-5.3", "displayName": "glm-5.3",
                 "supportedEffortLevels": ["low", "medium", "high"]],
                ["value": "claude-fable-5-1[1m]", "resolvedModel": "claude-fable-5-1[1m]", "displayName": "Fable",
                 "supportedEffortLevels": ["low", "high"]],
                ["value": "sonnet", "resolvedModel": "glm-5.3", "displayName": "glm-5.3",
                 "supportedEffortLevels": ["xhigh", "max"]],
                ["value": "haiku", "resolvedModel": "glm-5.3-flash", "displayName": "glm-5.3-flash",
                 "supportedEffortLevels": ["low", "medium"]],
            ],
        ])
        XCTAssertEqual(options, [
            AgentModelOption(id: "opus", label: "glm-5.3", efforts: ["low", "medium", "high"]),
            AgentModelOption(id: "claude-fable-5-1[1m]", label: "Fable", efforts: ["low", "high"]),
            AgentModelOption(id: "sonnet", label: "glm-5.3", efforts: ["xhigh", "max"]),
            AgentModelOption(id: "haiku", label: "glm-5.3-flash", efforts: ["low", "medium"]),
        ])
    }

    func testKeepsTheFullCatalogWhenNoAliasIsCustomMapped() {
        // A first-party account: every entry resolves to an Anthropic model,
        // so nothing is dropped and nothing collapses.
        let options = ClaudeModelCatalog.options(fromInitialize: [
            "models": [
                ["value": "opus", "resolvedModel": "claude-opus-5-5", "displayName": "Opus",
                 "supportedEffortLevels": ["low", "high"]],
                ["value": "claude-fable-5-1[1m]", "resolvedModel": "claude-fable-5-1[1m]", "displayName": "Fable",
                 "supportedEffortLevels": ["low", "high"]],
                ["value": "haiku", "resolvedModel": "claude-haiku-4-5", "displayName": "Haiku"],
            ],
        ])
        XCTAssertEqual(options, [
            AgentModelOption(id: "opus", label: "Opus", efforts: ["low", "high"]),
            AgentModelOption(id: "claude-fable-5-1[1m]", label: "Fable", efforts: ["low", "high"]),
            AgentModelOption(id: "haiku", label: "Haiku"),
        ])
    }

    func testMergesDuplicateIdsWhenTheCatalogCarriesNoResolvedModel() {
        // An older CLI without `resolvedModel`: same behavior as before, bar
        // collapsing entries that share an id.
        let options = ClaudeModelCatalog.options(fromInitialize: [
            "models": [
                ["value": "glm-5.3[1m]", "displayName": "glm-5.3[1m]", "supportedEffortLevels": ["low", "high"]],
                ["value": "Fable", "displayName": "Fable"],
                ["value": "glm-5.3[1m]", "displayName": "glm-5.3[1m]", "supportedEffortLevels": ["xhigh"]],
                ["value": "glm-5.3-flash[1m]", "displayName": "glm-5.3-flash[1m]"],
            ],
        ])
        XCTAssertEqual(options, [
            AgentModelOption(id: "glm-5.3[1m]", label: "glm-5.3[1m]", efforts: ["low", "high", "xhigh"]),
            AgentModelOption(id: "Fable", label: "Fable"),
            AgentModelOption(id: "glm-5.3-flash[1m]", label: "glm-5.3-flash[1m]"),
        ])
    }

    func testASettingsChangeBecomesOneControlRequestPerPart() {
        var ids = ["r1", "r2", "r3"].makeIterator()
        var change = ClaudeSettingsChange(
            AgentSessionSettings(revision: 7, mode: "acceptEdits", model: "sonnet", effort: "low"),
            makeRequestId: { ids.next()! }
        )
        XCTAssertEqual(change.requests.map(\.id), ["r1", "r2", "r3"])
        XCTAssertEqual(change.requests[0].request as NSDictionary, ["subtype": "set_permission_mode", "mode": "acceptEdits"])
        XCTAssertEqual(change.requests[1].request as NSDictionary, ["subtype": "set_model", "model": "sonnet"])
        XCTAssertEqual(
            change.requests[2].request as NSDictionary,
            ["subtype": "apply_flag_settings", "settings": ["effortLevel": "low"]]
        )
        XCTAssertFalse(change.receive(requestId: "other", response: ["subtype": "success"]))
        XCTAssertTrue(change.receive(requestId: "r1", response: ["subtype": "success"]))
        XCTAssertTrue(change.receive(requestId: "r2", response: ["subtype": "error", "error": "model not available"]))
        XCTAssertFalse(change.isComplete)
        XCTAssertTrue(change.receive(requestId: "r3", response: ["subtype": "success"]))
        XCTAssertTrue(change.isComplete)
        XCTAssertEqual(change.appliedSettings, AgentSessionSettings(revision: 7, mode: "acceptEdits", effort: "low"))

        var snapshot = ClaudeStreamSnapshot(sessionRef: "s")
        snapshot.consume(["type": "system", "subtype": "init", "model": "claude-opus-5"])
        snapshot.finishSettings(change)
        XCTAssertEqual(snapshot.state.mode, "acceptEdits")
        XCTAssertEqual(snapshot.state.model, "claude-opus-5", "a model that failed to switch is not claimed")
        XCTAssertEqual(snapshot.state.effort, "low")
        XCTAssertEqual(snapshot.state.settingsRevision, 7)
        XCTAssertEqual(snapshot.state.settingsError, "切换模型失败：model not available")
    }

    func testAMalformedSettingNeverReachesClaude() {
        let change = ClaudeSettingsChange(AgentSessionSettings(revision: 2, mode: "dontAsk", model: "-x"))
        XCTAssertTrue(change.requests.isEmpty)
        XCTAssertTrue(change.isComplete)
        XCTAssertEqual(change.errors.count, 2)
        XCTAssertTrue(change.errors[0].contains("不支持的 Claude Code 模式"))
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

    func testSuspendingASilentSessionIsNotConversationActivity() {
        var snapshot = ClaudeStreamSnapshot(sessionRef: "session-1")
        let contentAt = Date(timeIntervalSince1970: 1_700_000_000)
        snapshot.noteProgress(at: contentAt)

        snapshot.markSuspended()

        XCTAssertEqual(snapshot.state.status, "suspended")
        // The node reports this clock as the session's activityAt, and the idle
        // release is a MissionGo system operation, not conversation content:
        // it must leave the list time at the last real activity (AND-238).
        XCTAssertEqual(snapshot.state.lastProgressAt, contentAt)
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
        XCTAssertNil(resumed.sessionUrl)
        XCTAssertFalse(resumed.launchReady)
    }

    func testLocalControlConfirmsLaunchWithoutRemoteUrl() {
        var snapshot = ClaudeStreamSnapshot(sessionRef: "session-1")
        snapshot.setMissionGoControl()
        XCTAssertFalse(snapshot.state.launchReady)
        XCTAssertNil(snapshot.state.sessionUrl)
        snapshot.confirmLaunch()
        XCTAssertTrue(snapshot.state.launchReady)
        XCTAssertNil(snapshot.state.sessionUrl)
    }

    func testSwitchingFromRemoteToLocalControlDropsUrl() {
        var snapshot = ClaudeStreamSnapshot(sessionRef: "session-1")
        snapshot.setRemote(sessionUrl: "https://claude.ai/code/session_old")
        snapshot.confirmLaunch()
        snapshot.setMissionGoControl()
        XCTAssertTrue(snapshot.state.launchReady)
        XCTAssertNil(snapshot.state.sessionUrl)
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
        XCTAssertEqual(reservation.waitingForInput, true)
    }

    func testDeliversAReplyWhenOnlyBackgroundWorkKeepsTheSessionActive() async throws {
        let (launcher, root, sessionRef) = try fixture(status: "active")
        defer { try? FileManager.default.removeItem(atPath: root) }
        // The turn's `result` has arrived; only the background task holds the
        // session in "active". Such a session is at the prompt and must accept
        // a reply instead of stranding it for the task's lifetime (AND-183).
        try ClaudeHostFiles.write(
            ClaudeHostState(
                status: "active", sessionRef: sessionRef,
                activities: [AgentSessionActivity(id: "task-1", title: "后台轮询", detail: "运行中")],
                turnActive: false
            ),
            to: ClaudeHostStore.statePath(root: root, sessionRef: sessionRef)
        )
        let queued = NodeAgentSession(
            id: "server-session", agentKind: "claude_code", sessionRef: sessionRef, status: "active",
            command: AgentSessionCommand(id: "command-1", kind: "message", text: "合并")
        )
        let reservation = try await launcher.synchronize(queued)
        XCTAssertEqual(reservation.commandStatus, "delivering")

        let delivering = NodeAgentSession(
            id: queued.id, agentKind: queued.agentKind, sessionRef: sessionRef, status: "active",
            command: AgentSessionCommand(id: "command-1", kind: "message", text: "合并", status: "delivering")
        )
        _ = try await launcher.synchronize(delivering)
        let path = ClaudeHostStore.commandPath(root: root, sessionRef: sessionRef, commandId: "command-1")
        XCTAssertTrue(
            FileManager.default.fileExists(atPath: path),
            "a reply must reach the host while only background work runs"
        )
    }

    func testKeepsAReplyQueuedWhileTheTurnIsActuallyRunning() async throws {
        let (launcher, root, sessionRef) = try fixture(status: "active")
        defer { try? FileManager.default.removeItem(atPath: root) }
        try ClaudeHostFiles.write(
            ClaudeHostState(
                status: "active", sessionRef: sessionRef,
                activities: [AgentSessionActivity(id: "task-1", title: "后台轮询", detail: "运行中")],
                turnActive: true
            ),
            to: ClaudeHostStore.statePath(root: root, sessionRef: sessionRef)
        )
        let queued = NodeAgentSession(
            id: "server-session", agentKind: "claude_code", sessionRef: sessionRef, status: "active",
            command: AgentSessionCommand(id: "command-1", kind: "message", text: "合并")
        )
        let report = try await launcher.synchronize(queued)
        XCTAssertNil(report.commandStatus)
        let path = ClaudeHostStore.commandPath(root: root, sessionRef: sessionRef, commandId: "command-1")
        XCTAssertFalse(FileManager.default.fileExists(atPath: path))
    }

    func testAStoppedDetachedHostFoldsToSuspendedAndKeepsTheTranscript() async throws {
        let (launcher, root, sessionRef) = try fixture(status: "idle")
        defer { try? FileManager.default.removeItem(atPath: root) }
        let message = AgentSessionMessage(sourceId: "m1", turnId: "m1", role: "agent", text: "进行中")
        try ClaudeHostFiles.write(
            ClaudeHostState(
                status: "idle", sessionRef: sessionRef, hostPid: Int32.max, messages: [message],
                activities: [AgentSessionActivity(id: "t1", title: "后台任务", detail: "运行中")],
                waitingForInput: true
            ),
            to: ClaudeHostStore.statePath(root: root, sessionRef: sessionRef)
        )
        let report = try await launcher.synchronize(NodeAgentSession(
            id: "server-session",
            agentKind: "claude_code",
            sessionRef: sessionRef,
            status: "idle"
        ))
        XCTAssertEqual(report.status, "suspended")
        XCTAssertTrue(report.error?.contains("已转为挂起") == true)
        XCTAssertEqual(report.messages, [message])
        XCTAssertNotNil(report.activityAt)
        let folded = try ClaudeHostFiles.readState(ClaudeHostStore.statePath(root: root, sessionRef: sessionRef))
        XCTAssertEqual(folded.status, "suspended")
        XCTAssertNil(folded.hostPid)
        XCTAssertFalse(folded.waitingForInput)
        XCTAssertTrue(folded.activities.isEmpty)
        XCTAssertEqual(folded.messages, [message])
    }

    func testAStoppedRemoteControlHostStaysUnavailable() async throws {
        let (launcher, root, sessionRef) = try fixture(status: "idle")
        defer { try? FileManager.default.removeItem(atPath: root) }
        try ClaudeHostFiles.write(
            ClaudeHostState(
                status: "idle", sessionRef: sessionRef, hostPid: Int32.max,
                sessionUrl: "https://claude.ai/code/session_old"
            ),
            to: ClaudeHostStore.statePath(root: root, sessionRef: sessionRef)
        )
        let report = try await launcher.synchronize(NodeAgentSession(
            id: "server-session",
            agentKind: "claude_code",
            sessionRef: sessionRef,
            status: "idle"
        ))
        XCTAssertEqual(report.status, "unavailable")
        XCTAssertTrue(report.error?.contains("Remote Control") == true)
        XCTAssertEqual(report.sessionUrl, "https://claude.ai/code/session_old")
    }

    func testAStoppedFailedHostStaysUnavailable() async throws {
        let (launcher, root, sessionRef) = try fixture(status: "failed")
        defer { try? FileManager.default.removeItem(atPath: root) }
        try ClaudeHostFiles.write(
            ClaudeHostState(status: "failed", sessionRef: sessionRef, hostPid: Int32.max, error: "启动失败"),
            to: ClaudeHostStore.statePath(root: root, sessionRef: sessionRef)
        )
        let report = try await launcher.synchronize(NodeAgentSession(
            id: "server-session",
            agentKind: "claude_code",
            sessionRef: sessionRef,
            status: "failed"
        ))
        XCTAssertEqual(report.status, "unavailable")
        XCTAssertTrue(report.error?.contains("请重新派单") == true)
        let unchanged = try ClaudeHostFiles.readState(ClaudeHostStore.statePath(root: root, sessionRef: sessionRef))
        XCTAssertEqual(unchanged.status, "failed")
    }

    func testAStoppedHostAnswersAnInterruptWithNothingToStop() async throws {
        let (launcher, root, sessionRef) = try fixture(status: "idle")
        defer { try? FileManager.default.removeItem(atPath: root) }
        try ClaudeHostFiles.write(
            ClaudeHostState(status: "active", sessionRef: sessionRef, hostPid: Int32.max),
            to: ClaudeHostStore.statePath(root: root, sessionRef: sessionRef)
        )
        let report = try await launcher.synchronize(NodeAgentSession(
            id: "server-session",
            agentKind: "claude_code",
            sessionRef: sessionRef,
            status: "active",
            command: AgentSessionCommand(id: "stop-1", kind: "interrupt", text: "停止当前任务", turnId: "turn-1")
        ))
        XCTAssertEqual(report.commandStatus, "delivered")
        XCTAssertEqual(report.status, "suspended")
    }

    func testAReplyToAStoppedDetachedHostRestartsItAsASuspendedSession() async throws {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("missiongo-claude-dead-resume-\(UUID().uuidString)").path
        defer { try? FileManager.default.removeItem(atPath: root) }
        let sessionRef = UUID().uuidString.lowercased()
        let directory = ClaudeHostStore.sessionDirectory(root: root, sessionRef: sessionRef)
        try FileManager.default.createDirectory(atPath: "\(directory)/commands", withIntermediateDirectories: true)
        let statePath = ClaudeHostStore.statePath(root: root, sessionRef: sessionRef)
        let configPath = ClaudeHostStore.configPath(root: root, sessionRef: sessionRef)
        try ClaudeHostFiles.write(ClaudeHostState(
            status: "idle", sessionRef: sessionRef, hostPid: Int32.max, waitingForInput: true
        ), to: statePath)
        try ClaudeHostFiles.write(ClaudeHostConfiguration(
            claudeExecutable: "/c", cwd: "/r", mode: "plan", sessionName: "n", sessionRef: sessionRef, prompt: "p",
            statePath: statePath, commandsDirectory: "\(directory)/commands", logPath: "\(root)/host.log"
        ), to: configPath)
        // A stand-in host that exits at once: this test is about the files.
        let launcher = SessionLauncher(
            environment: ShellEnvironment(path: "/usr/bin:/bin"), hostExecutable: "/usr/bin/true", sessionsDirectory: root
        )
        let queued = try await launcher.synchronize(NodeAgentSession(
            id: "server-session", agentKind: "claude_code", sessionRef: sessionRef, status: "idle",
            command: AgentSessionCommand(id: "command-1", kind: "message", text: "继续")
        ))
        XCTAssertEqual(queued.commandStatus, "delivering")
        XCTAssertEqual(queued.status, "suspended")
        // The fold persisted before the restart, so the new host resumes the
        // conversation instead of re-sending the dispatch prompt.
        let folded = try ClaudeHostFiles.readState(statePath)
        XCTAssertEqual(folded.status, "suspended")
        XCTAssertNil(folded.hostPid)
        XCTAssertFalse(folded.waitingForInput)
        let resumed = try await launcher.synchronize(NodeAgentSession(
            id: "server-session", agentKind: "claude_code", sessionRef: sessionRef, status: "idle",
            command: AgentSessionCommand(id: "command-1", kind: "message", text: "继续", status: "delivering")
        ))
        XCTAssertEqual(resumed.error, "正在恢复 Claude Code 会话…")
        XCTAssertEqual(resumed.status, "suspended")
    }

    func testHandsADueSettingsChangeToARunningHostAndReportsTheOutcome() async throws {
        let (launcher, root, sessionRef) = try fixture(status: "idle")
        defer { try? FileManager.default.removeItem(atPath: root) }
        let statePath = ClaudeHostStore.statePath(root: root, sessionRef: sessionRef)
        var state = ClaudeHostState(status: "idle", sessionRef: sessionRef, acceptsSettings: true)
        state.model = "claude-opus-5"
        state.settingsRevision = 1
        try ClaudeHostFiles.write(state, to: statePath)
        let desired = AgentSessionSettings(revision: 2, mode: "acceptEdits", model: "sonnet", effort: "low")
        let session = NodeAgentSession(
            id: "server-session", agentKind: "claude_code", sessionRef: sessionRef, status: "idle",
            desiredSettings: desired, appliedSettingsRevision: 1
        )
        let pending = try await launcher.synchronize(session)
        XCTAssertEqual(pending.settingsRevision, 1)
        XCTAssertEqual(pending.model, "claude-opus-5")
        let path = ClaudeHostStore.commandPath(root: root, sessionRef: sessionRef, commandId: "settings-2")
        let command = try JSONDecoder().decode(ClaudeHostCommand.self, from: Data(contentsOf: URL(fileURLWithPath: path)))
        XCTAssertEqual(command.kind, "settings")
        XCTAssertEqual(command.settings, desired)

        // The host applied it, partly: the next poll says so and writes nothing more.
        try FileManager.default.removeItem(atPath: path)
        state.settingsRevision = 2
        state.settingsError = "切换模型失败：x"
        state.effort = "low"
        try ClaudeHostFiles.write(state, to: statePath)
        let applied = try await launcher.synchronize(session)
        XCTAssertEqual(applied.settingsRevision, 2)
        XCTAssertEqual(applied.settingsError, "切换模型失败：x")
        XCTAssertEqual(applied.effort, "low")
        XCTAssertFalse(FileManager.default.fileExists(atPath: path))
    }

    func testAnOlderRunningHostIsNotHandedASettingsCommand() async throws {
        let (launcher, root, sessionRef) = try fixture(status: "idle")
        defer { try? FileManager.default.removeItem(atPath: root) }
        _ = try await launcher.synchronize(NodeAgentSession(
            id: "server-session", agentKind: "claude_code", sessionRef: sessionRef, status: "idle",
            desiredSettings: AgentSessionSettings(revision: 1, model: "sonnet")
        ))
        let path = ClaudeHostStore.commandPath(root: root, sessionRef: sessionRef, commandId: "settings-1")
        XCTAssertFalse(FileManager.default.fileExists(atPath: path))
    }

    func testASuspendedSessionResumesWithTheSettingsChosenMeanwhile() async throws {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("missiongo-claude-resume-\(UUID().uuidString)").path
        defer { try? FileManager.default.removeItem(atPath: root) }
        let sessionRef = UUID().uuidString.lowercased()
        let directory = ClaudeHostStore.sessionDirectory(root: root, sessionRef: sessionRef)
        try FileManager.default.createDirectory(atPath: "\(directory)/commands", withIntermediateDirectories: true)
        let statePath = ClaudeHostStore.statePath(root: root, sessionRef: sessionRef)
        let configPath = ClaudeHostStore.configPath(root: root, sessionRef: sessionRef)
        try ClaudeHostFiles.write(ClaudeHostState(status: "suspended", sessionRef: sessionRef), to: statePath)
        try ClaudeHostFiles.write(ClaudeHostConfiguration(
            claudeExecutable: "/c", cwd: "/r", mode: "plan", sessionName: "n", sessionRef: sessionRef, prompt: "p",
            statePath: statePath, commandsDirectory: "\(directory)/commands", logPath: "\(root)/host.log"
        ), to: configPath)
        // A stand-in host that exits at once: this test is about the files.
        let launcher = SessionLauncher(
            environment: ShellEnvironment(path: "/usr/bin:/bin"), hostExecutable: "/usr/bin/true", sessionsDirectory: root
        )
        let reply = AgentSessionCommand(id: "command-1", kind: "message", text: "Continue", status: "delivering")
        _ = try await launcher.synchronize(NodeAgentSession(
            id: "server-session", agentKind: "claude_code", sessionRef: sessionRef, status: "idle",
            command: reply, desiredSettings: AgentSessionSettings(revision: 4, mode: "acceptEdits", model: "sonnet", effort: "max"),
            appliedSettingsRevision: 3
        ))
        let resumed = try JSONDecoder().decode(ClaudeHostConfiguration.self, from: Data(contentsOf: URL(fileURLWithPath: configPath)))
        XCTAssertEqual(resumed.mode, "acceptEdits")
        XCTAssertEqual(resumed.model, "sonnet")
        XCTAssertEqual(resumed.effort, "max")
        XCTAssertEqual(resumed.settingsRevision, 4)

        // A malformed change is recorded as failed; the session resumes as it was.
        _ = try await launcher.synchronize(NodeAgentSession(
            id: "server-session", agentKind: "claude_code", sessionRef: sessionRef, status: "idle",
            command: reply, desiredSettings: AgentSessionSettings(revision: 5, mode: "dontAsk"),
            appliedSettingsRevision: 4
        ))
        let state = try ClaudeHostFiles.readState(statePath)
        XCTAssertEqual(state.settingsRevision, 5)
        XCTAssertTrue(state.settingsError?.contains("不支持的 Claude Code 模式") == true)
        let unchanged = try JSONDecoder().decode(ClaudeHostConfiguration.self, from: Data(contentsOf: URL(fileURLWithPath: configPath)))
        XCTAssertEqual(unchanged.mode, "acceptEdits")
    }

    func testFinishedWorkClosesTheHostButKeepsItsConversation() async throws {
        let (_, root, sessionRef) = try fixture(status: "idle")
        defer { try? FileManager.default.removeItem(atPath: root) }
        let statePath = ClaudeHostStore.statePath(root: root, sessionRef: sessionRef)
        try ClaudeHostFiles.write(
            ClaudeHostState(status: "idle", sessionRef: sessionRef, hostPid: 4242),
            to: statePath
        )
        let launcher = SessionLauncher(
            environment: ShellEnvironment(path: "/usr/bin:/bin"),
            hostExecutable: nil,
            sessionsDirectory: root,
            terminateHost: { pid, _ in pid == 4242 }
        )
        let report = try await launcher.synchronize(NodeAgentSession(
            id: "server-session",
            agentKind: "claude_code",
            sessionRef: sessionRef,
            status: "idle",
            lifecycle: "close"
        ))

        XCTAssertEqual(report.status, "suspended")
        XCTAssertTrue(report.error?.contains("已全部完成") == true)
        XCTAssertEqual(report.sourceArchived, true)
        let state = try ClaudeHostFiles.readState(
            statePath
        )
        XCTAssertNil(state.hostPid)
        XCTAssertEqual(state.status, "suspended")
    }

    func testClosingFinishedWorkKeepsTheLastConversationTime() async throws {
        let (_, root, sessionRef) = try fixture(status: "idle")
        defer { try? FileManager.default.removeItem(atPath: root) }
        let statePath = ClaudeHostStore.statePath(root: root, sessionRef: sessionRef)
        let contentAt = Date().addingTimeInterval(-2 * 60 * 60)
        try ClaudeHostFiles.write(
            ClaudeHostState(status: "idle", sessionRef: sessionRef, hostPid: 4242, lastProgressAt: contentAt),
            to: statePath
        )
        let launcher = SessionLauncher(
            environment: ShellEnvironment(path: "/usr/bin:/bin"),
            hostExecutable: nil,
            sessionsDirectory: root,
            terminateHost: { pid, _ in pid == 4242 }
        )
        let report = try await launcher.synchronize(NodeAgentSession(
            id: "server-session",
            agentKind: "claude_code",
            sessionRef: sessionRef,
            status: "idle",
            lifecycle: "close"
        ))

        XCTAssertEqual(report.status, "suspended")
        // Finishing the work closes the process by itself; that system
        // operation must not move the conversation's activity time either
        // (AND-238).
        XCTAssertEqual(report.activityAt, SessionLauncher.activityTimestamp(contentAt))
    }
}

final class ClaudeHostProcessTests: XCTestCase {
    func testKernelBlobParsingSkipsPaddingNULs() {
        XCTAssertEqual(
            ClaudeHostProcess.arguments(inKernelBlob: [UInt8]("/host\0\0\0\0/cfg\0".utf8)),
            ["/host", "/cfg"]
        )
        XCTAssertEqual(ClaudeHostProcess.arguments(inKernelBlob: []), [])
        XCTAssertEqual(ClaudeHostProcess.arguments(inKernelBlob: [0, 0, 0]), [])
    }

    /// The incident behind the dead-host banner: an app update replaced the
    /// bundle and unlinked the host's executable, so `proc_pidpath` fails
    /// forever and a surviving host was judged dead. The kernel's copy of the
    /// argument vector still names the session's config, and that identifies
    /// the host as surely as the path did.
    func testAHostWhoseExecutableWasReplacedIsStillRecognizedByItsArguments() throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("missiongo-host-identity-\(UUID().uuidString)")
        try FileManager.default.createDirectory(atPath: directory.path, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }

        let hostPath = directory.appendingPathComponent(ClaudeHostLocation.executableName)
        try FileManager.default.copyItem(at: URL(fileURLWithPath: "/bin/sleep"), to: hostPath)
        let configPath = directory.appendingPathComponent("config.json").path

        let process = Process()
        process.executableURL = hostPath
        process.arguments = ["30", configPath]
        process.standardInput = FileHandle.nullDevice
        process.standardOutput = FileHandle.nullDevice
        process.standardError = FileHandle.nullDevice
        try process.run()
        defer {
            kill(process.processIdentifier, SIGKILL)
            process.waitUntilExit()
        }

        XCTAssertTrue(ClaudeHostProcess.isClaudeHost(process.processIdentifier))
        XCTAssertTrue(ClaudeHostProcess.isClaudeHost(process.processIdentifier, servingConfigPath: configPath))

        // The app update: the executable is unlinked while the host keeps running.
        try FileManager.default.removeItem(at: hostPath)

        XCTAssertFalse(
            ClaudeHostProcess.isClaudeHost(process.processIdentifier),
            "the name check cannot work anymore; this reproduces the incident"
        )
        XCTAssertTrue(ClaudeHostProcess.isClaudeHost(process.processIdentifier, servingConfigPath: configPath))

        // Another session's config path must not vouch for this host.
        XCTAssertFalse(ClaudeHostProcess.isClaudeHost(
            process.processIdentifier,
            servingConfigPath: directory.appendingPathComponent("other-config.json").path
        ))
    }
}
