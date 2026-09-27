import XCTest
@testable import MissionGoNodeCore

final class ManagedExecutionTests: XCTestCase {
    func testActualServerWireReachesManagedNodeConsumer() async throws {
        guard let path = ProcessInfo.processInfo.environment["MANAGED_WIRE_FIXTURE"] else {
            throw XCTSkip("Generate with the server managed-execution HTTP test and MANAGED_WIRE_FIXTURE.")
        }
        struct Envelope: Decodable { let sessions: [NodeAgentSession] }
        let envelope = try JSONDecoder().decode(Envelope.self, from: Data(contentsOf: URL(fileURLWithPath: path)))
        let session = try XCTUnwrap(envelope.sessions.first)
        XCTAssertEqual(session.managedExecution?.role, "review")
        XCTAssertEqual(session.managedExecution?.stopRequested, true)
        XCTAssertTrue(session.occupiesExecutionSlot)
        XCTAssertNil(session.command)
        let launcher = CodexLauncher(environment: ShellEnvironment(path: "/synthetic/bin", base: [:]), serverUrl: nil,
            location: CodexLocation(codexHome: "/synthetic/agent"), control: ManagedStopControl(), resources: ManagedTestResources())
        let report = try await launcher.synchronize(session)
        XCTAssertTrue(report.messages.contains { $0.text.contains("fixture tool output") })
    }

    func testManagedProtocolRejectsUnverifiedNativeVersions() throws {
        XCTAssertNoThrow(try ManagedCodexProtocol.validateVersion(["userAgent": "codex_cli_rs/0.155.0-alpha.16.3 (fixture)"]))
        XCTAssertThrowsError(try ManagedCodexProtocol.validateVersion([:]))
        XCTAssertThrowsError(try ManagedCodexProtocol.validateVersion(["userAgent": "codex_cli_rs/0.156.0 (fixture)"]))
        XCTAssertThrowsError(try ManagedCodexProtocol.validateVersion(["userAgent": "codex_cli_rs/0.155.0-alpha.16.30 (fixture)"]))
    }

    func testMcpCapabilityValidationDoesNotTrustServerNames() throws {
        XCTAssertNoThrow(try ManagedCodexProtocol.validateMcp(["data": [
            ["name": "missiongo", "runtimeStatus": "disabled", "tools": [:]]
        ]]))
        for server: [String: Any] in [
            ["name": "worktracker", "runtimeStatus": "ready", "tools": ["claim_item": [:], "append_comment": [:]]],
            ["name": "worktracker", "tools": [:]],
            ["name": "anything", "runtimeStatus": "disabled", "tools": ["append_comment": [:]]]
        ] {
            XCTAssertThrowsError(try ManagedCodexProtocol.validateMcp(["data": [server]]))
        }
    }

    func testManagedJobDecodesServerContractAndRejectsPermissionMismatch() throws {
        let json = """
        {"intent":{"id":"intent-1","binding":{"runId":"run-1","decisionId":"decision-1","version":1,"stateVersion":2,
        "contentDigest":"content","scopeDigest":"scope","contractRevision":1,"idempotencyKey":"start-1","stageKey":"review",
        "role":"review","inputCommit":"\(String(repeating: "a", count: 40))","nodeId":"node-1","permissionMode":"read-only"},
        "stageId":"stage-1","generation":1,"state":"requested","ownershipHeld":true,"attemptId":null,"sessionId":null,
        "stopRequested":false,"outcome":null,"cleanup":null,"updatedAt":"2026-01-01T00:00:00.000Z"},
        "repoPath":"/synthetic/repository","taskContext":"{}","enabled":true}
        """
        let job = try JSONDecoder().decode(ManagedExecutionJob.self, from: Data(json.utf8))
        try job.validate()
        XCTAssertEqual(job.intent.binding.stateVersion, 2)
        XCTAssertNil(job.intent.attemptId)
        let mismatched = try JSONDecoder().decode(ManagedExecutionJob.self,
            from: Data(json.replacingOccurrences(of: "read-only", with: "workspace-write").utf8))
        XCTAssertThrowsError(try mismatched.validate())
    }

    func testStoppingManagedSessionKeepsVisibleExecutionStream() async throws {
        let launcher = CodexLauncher(environment: ShellEnvironment(path: "/synthetic/bin", base: [:]), serverUrl: nil,
            location: CodexLocation(codexHome: "/synthetic/agent"), control: ManagedStopControl(), resources: ManagedTestResources())
        let json = #"{"id":"mirror","agentKind":"codex","sessionRef":"native-thread","status":"active","managedExecution":{"id":"intent","runId":"run","stageId":"stage","generation":1,"role":"review","stopRequested":true}}"#
        let session = try JSONDecoder().decode(NodeAgentSession.self, from: Data(json.utf8))
        let report = try await launcher.synchronize(session)
        XCTAssertTrue(report.messages.contains { $0.text.contains("fixture tool output") })
    }

    func testManagedQueuedInputCannotUseUncheckedActiveTurnSteering() async throws {
        let launcher = CodexLauncher(environment: ShellEnvironment(path: "/synthetic/bin", base: [:]), serverUrl: nil,
            location: CodexLocation(codexHome: "/synthetic/agent"), control: ManagedStopControl(), resources: ManagedTestResources())
        let json = #"{"id":"mirror","agentKind":"codex","sessionRef":"native-thread","status":"active","managedExecution":{"id":"intent","runId":"run","stageId":"stage","generation":1,"role":"review","stopRequested":false},"command":{"id":"input","text":"review","status":"delivering","createdAt":"now"}}"#
        let session = try JSONDecoder().decode(NodeAgentSession.self, from: Data(json.utf8))
        let report = try await launcher.synchronize(session)
        XCTAssertNil(report.commandStatus, "Wait for idle so managed resume policy and MCP capability checks run.")
    }

    func testManagedResumeCannotRestoreMissionGoMcpOrWidenReviewPolicy() throws {
        let policy = try ManagedExecutionPolicy(role: "review")
        let params = CodexProtocol.threadResumeParams(threadId: "native-thread", overrides: CodexTurnOverrides(settings: policy.settings, managed: true))
        XCTAssertEqual((params["config"] as? [String: Bool])?["mcp_servers.missiongo.enabled"], false)
        XCTAssertEqual(params["sandbox"] as? String, "read-only")
        XCTAssertThrowsError(try ManagedCodexProtocol.validateResumed(["sandbox": ["type": "workspaceWrite"]], settings: policy.settings, context: ManagedResumeContext(threadId: "frozen-thread", resolvedModel: "actual-model", cwd: "/synthetic/work", writableRoots: [])))
    }

    func testManagedResumeRejectsIdentityAndScopeDrift() throws {
        let settings = try ManagedExecutionPolicy(role: "implement").settings
        let valid: [String: Any] = ["thread": ["id": "frozen-thread"], "model": "actual-model", "cwd": "/synthetic/work",
            "runtimeWorkspaceRoots": ["/synthetic/work"],
            "approvalPolicy": "on-request", "approvalsReviewer": "user",
            "sandbox": ["type": "workspaceWrite", "writableRoots": ["/synthetic/work"]]]
        XCTAssertNoThrow(try ManagedCodexProtocol.validateResumed(valid, settings: settings, context: ManagedResumeContext(threadId: "frozen-thread", resolvedModel: "actual-model", cwd: "/synthetic/work", writableRoots: ["/synthetic/work"])))
        for (key, value): (String, Any) in [("thread", ["id": "other"]), ("cwd", "/other"), ("model", "other"),
            ("sandbox", ["type": "workspaceWrite", "writableRoots": ["/synthetic/work", "/other"]]),
            ("thread", NSNull()), ("cwd", NSNull()), ("model", NSNull())] {
            var drift = valid; drift[key] = value
            XCTAssertThrowsError(try ManagedCodexProtocol.validateResumed(drift, settings: settings, context: ManagedResumeContext(threadId: "frozen-thread", resolvedModel: "actual-model", cwd: "/synthetic/work", writableRoots: ["/synthetic/work"])), key)
        }
    }

    func testManagedWorkspaceStartAndResumeShareImplicitAndExplicitCwdScope() throws {
        let settings = try ManagedExecutionPolicy(role: "implement").settings
        let cwd = "/synthetic/work"
        for roots: [String] in [[], [cwd]] {
            let result: [String: Any] = ["thread": ["id": "frozen-thread"], "model": "actual-model", "cwd": cwd,
                "runtimeWorkspaceRoots": [cwd], "approvalPolicy": "on-request", "approvalsReviewer": "user",
                "sandbox": ["type": "workspaceWrite", "writableRoots": roots]]
            let request = CodexThreadRequest(socketPath: "/synthetic/socket", cwd: cwd, settings: settings, name: "fixture", prompt: "no inference")
            XCTAssertNoThrow(try ManagedCodexProtocol.validate(result, request: request))
            let context = try ManagedCodexProtocol.runtimeReceipt(result).resumeContext()
            XCTAssertNoThrow(try ManagedCodexProtocol.validateResumed(result, settings: settings, context: context), "roots=\(roots)")
        }
    }

    func testManagedScopeRejectsMalformedRootsAndCwdAliasEscapes() throws {
        let root = URL(fileURLWithPath: ProcessInfo.processInfo.environment["TMPDIR"] ?? NSTemporaryDirectory())
            .appendingPathComponent(UUID().uuidString).resolvingSymlinksInPath()
        defer { try? FileManager.default.removeItem(at: root) }
        let work = root.appendingPathComponent("work"), outside = root.appendingPathComponent("outside")
        try FileManager.default.createDirectory(at: work, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: outside, withIntermediateDirectories: true)
        let alias = work.appendingPathComponent("alias")
        try FileManager.default.createSymbolicLink(at: alias, withDestinationURL: outside)
        let settings = try ManagedExecutionPolicy(role: "implement").settings
        let context = try ManagedRuntimeReceipt(sessionRef: "frozen", resolvedModel: "actual", cwd: work.path).resumeContext()
        let request = CodexThreadRequest(socketPath: "/synthetic/socket", cwd: work.path, settings: settings, name: "fixture", prompt: "no inference")
        let valid: [String: Any] = ["thread": ["id": "frozen"], "model": "actual", "cwd": work.path,
            "runtimeWorkspaceRoots": [work.path], "approvalPolicy": "on-request", "approvalsReviewer": "user",
            "sandbox": ["type": "workspaceWrite", "writableRoots": [] as [String]]]
        let invalidFields: [(String, Any)] = [
            ("cwd", "relative"), ("cwd", alias.path), ("cwd", alias.path + "/.."),
            ("runtimeWorkspaceRoots", [work.path, outside.path]), ("runtimeWorkspaceRoots", [] as [String]),
            ("runtimeWorkspaceRoots", ["relative"]), ("runtimeWorkspaceRoots", "invalid"),
            ("approvalPolicy", "never"), ("approvalsReviewer", "auto_review"),
            ("sandbox", ["type": "workspaceWrite"]), ("sandbox", ["type": "dangerFullAccess"]),
            ("sandbox", ["type": "workspaceWrite", "writableRoots": "invalid"]),
            ("sandbox", ["type": "workspaceWrite", "writableRoots": [work.path, outside.path]]),
            ("sandbox", ["type": "workspaceWrite", "writableRoots": ["relative"]]),
            ("sandbox", ["type": "workspaceWrite", "writableRoots": [alias.path + "/.."]])
        ]
        for (key, value) in invalidFields {
            var bad = valid; bad[key] = value
            XCTAssertThrowsError(try ManagedCodexProtocol.validate(bad, request: request), key)
            XCTAssertThrowsError(try ManagedCodexProtocol.validateResumed(bad, settings: settings, context: context), key)
        }
        for key in ["cwd", "runtimeWorkspaceRoots", "approvalPolicy", "approvalsReviewer", "sandbox"] {
            var bad = valid; bad.removeValue(forKey: key)
            XCTAssertThrowsError(try ManagedCodexProtocol.validate(bad, request: request), key)
            XCTAssertThrowsError(try ManagedCodexProtocol.validateResumed(bad, settings: settings, context: context), key)
        }
        for roots in [[outside.path], ["relative"], [alias.path]] {
            XCTAssertThrowsError(try ManagedCodexProtocol.validateResumed(valid, settings: settings,
                context: ManagedResumeContext(threadId: "frozen", resolvedModel: "actual", cwd: work.path, writableRoots: roots)))
        }
        // A once-canonical frozen directory replaced by a symlink cannot move the scope.
        try FileManager.default.removeItem(at: work)
        try FileManager.default.createSymbolicLink(at: work, withDestinationURL: outside)
        XCTAssertThrowsError(try ManagedCodexProtocol.validateResumed(valid, settings: settings, context: context))
    }

    func testRuntimeReceiptNeverInventsSessionOrModel() throws {
        XCTAssertThrowsError(try ManagedCodexProtocol.runtimeReceipt(["model": "native-model"]))
        let missing = try ManagedCodexProtocol.runtimeReceipt(["thread": ["id": "native-thread"]])
        XCTAssertNil(missing.resolvedModel)
        let actual = try ManagedCodexProtocol.runtimeReceipt(["thread": ["id": "native-thread"], "model": "native-model"])
        XCTAssertEqual(actual.sessionRef, "native-thread")
        XCTAssertEqual(actual.resolvedModel, "native-model")
    }

    func testManagedMirrorIncludesVisibleToolOutput() throws {
        let snapshot = try CodexProtocol.threadSnapshot(fromRead: ["thread": ["id": "thread", "status": ["type": "idle"],
            "turns": [["id": "turn", "items": [["id": "command", "type": "commandExecution", "command": "fixture-test", "aggregatedOutput": "1 test passed"]]]]]], includeExecutionItems: true)
        XCTAssertEqual(snapshot.messages.count, 1)
        XCTAssertTrue(snapshot.messages.first?.text.contains("1 test passed") == true)
    }

    func testManagedSessionWireBindingPreservesReviewAndStop() throws {
        let json = #"{"id":"mirror","agentKind":"codex","sessionRef":"native-thread","status":"active","managedExecution":{"id":"intent","runId":"run","stageId":"stage","generation":1,"role":"review","stopRequested":true}}"#
        let session = try JSONDecoder().decode(NodeAgentSession.self, from: Data(json.utf8))
        XCTAssertEqual(session.managedExecution?.role, "review")
        XCTAssertEqual(session.managedExecution?.generation, 1)
        XCTAssertTrue(session.managedExecution?.stopRequested == true)
    }

    func testManagedPolicyIsBoundedAndReviewUsesNativeReadOnly() throws {
        let policy = try ManagedExecutionPolicy(role: "review")
        XCTAssertEqual(policy.settings.sandbox, "read-only")
        XCTAssertEqual(policy.settings.approvalPolicy, "never")
        let prompt = try policy.prompt(context: "fixture task", inputCommit: String(repeating: "a", count: 40))
        XCTAssertTrue(prompt.contains("Hermes"))
        XCTAssertFalse(prompt.contains("使用 missiongo skill"))
        XCTAssertThrowsError(try ManagedExecutionPolicy(role: "deploy"))
        XCTAssertThrowsError(try policy.prompt(context: String(repeating: "x", count: 65_000), inputCommit: String(repeating: "a", count: 40)), "The bound includes fixed policy instructions, not only task data.")
        XCTAssertThrowsError(try policy.prompt(context: String(repeating: "x", count: 65_537), inputCommit: String(repeating: "a", count: 40)))
    }
}

private struct ManagedTestResources: CodexResourceChecking {
    func unavailableReason(socketPath: String) async -> String? { nil }
}

private struct ManagedStopControl: CodexControl {
    let interrupts = Locked<[String]>([])
    func startThread(_ request: CodexThreadRequest) async throws -> String { throw LaunchError("No fixture launch.") }
    func readThread(socketPath: String, threadId: String) async throws -> CodexThreadSnapshot {
        CodexThreadSnapshot(status: "idle", messages: [])
    }
    func readManagedThread(socketPath: String, threadId: String) async throws -> CodexThreadSnapshot {
        try CodexProtocol.threadSnapshot(fromRead: ["thread": ["id": threadId, "status": ["type": "active"],
            "turns": [["id": "turn", "status": "inProgress", "items": [["id": "command", "type": "commandExecution", "aggregatedOutput": "fixture tool output"]]]]]], includeExecutionItems: true)
    }
    func interruptTurn(socketPath: String, threadId: String, turnId: String) async throws { interrupts.withLock { $0.append(threadId) } }
}

private final class ReceiptAPI: NodeAPI, @unchecked Sendable {
    let job: Locked<ManagedExecutionJob>
    let reports = Locked<[ManagedExecutionObservation]>([])
    let reject = Locked(true)
    let committedBeforeLoss: Bool
    let offeredJobs = Locked<[ManagedExecutionJob]?>(nil)
    let rejectedIds = Locked<Set<String>>([])
    let successfulIds = Locked<[String]>([])
    let claims = Locked<[String]>([])
    let polls = Locked(0)
    init(committedBeforeLoss: Bool) throws {
        self.committedBeforeLoss = committedBeforeLoss
        let json = """
        {"intent":{"id":"receipt-intent","binding":{"runId":"run","decisionId":"decision","version":1,"stateVersion":2,
        "contentDigest":"content","scopeDigest":"scope","contractRevision":1,"idempotencyKey":"start","stageKey":"implement",
        "role":"implement","inputCommit":"\(String(repeating: "a", count: 40))","nodeId":"node","permissionMode":"workspace-write"},
        "stageId":"stage","generation":1,"state":"requested","ownershipHeld":true,"attemptId":null,"sessionId":null,
        "stopRequested":false,"outcome":null,"cleanup":null},"repoPath":"/synthetic/repo","taskContext":"{}","enabled":true}
        """
        job = Locked(try JSONDecoder().decode(ManagedExecutionJob.self, from: Data(json.utf8)))
    }
    func change(state: String, session: String? = nil) throws {
        var object = try JSONSerialization.jsonObject(with: JSONEncoder().encode(job.current)) as! [String: Any]
        var intent = object["intent"] as! [String: Any]
        intent["state"] = state
        intent["sessionId"] = session ?? NSNull() as Any
        object["intent"] = intent
        let next = try JSONDecoder().decode(ManagedExecutionJob.self, from: JSONSerialization.data(withJSONObject: object))
        job.withLock { $0 = next }
    }
    let sessions = Locked<[NodeAgentSession]>([])
    func listAgentSessions() async throws -> [NodeAgentSession] { sessions.current }
    func reportAgentSession(sessionId: String, report: AgentSessionReport) async throws {}
    func managedJobs() async throws -> [ManagedExecutionJob] {
        polls.withLock { $0 += 1 }; return offeredJobs.current ?? [job.current]
    }
    func claimManaged(id: String, generation: Int) async throws -> ManagedExecutionIntent {
        claims.withLock { $0.append(id) }; return job.current.intent
    }
    func permitManaged(id: String, generation: Int) async throws -> ManagedExecutionPermit {
        try change(state: "starting")
        return ManagedExecutionPermit(intent: job.current.intent, mayStart: true)
    }
    func reportManaged(id: String, observation: ManagedExecutionObservation) async throws -> ManagedObservationReceipt {
        reports.withLock { $0.append(observation) }
        if rejectedIds.current.contains(id) { throw LaunchError("409 observation_not_expected") }
        if committedBeforeLoss || !reject.current { try change(state: observation.state, session: observation.sessionRef) }
        if reject.current { throw URLError(.networkConnectionLost) }
        successfulIds.withLock { $0.append(id) }
        return ManagedObservationReceipt(accepted: true)
    }
    func heartbeat(agents: [DetectedAgent], repoCandidates: [RepoCandidate]) async throws -> HeartbeatReply { HeartbeatReply(repos: []) }
    func claimNext(waitMs: Int, availableAgentKinds: [String]?) async throws -> DispatchRequest? { nil }
    func reportResult(dispatchId: String, report: DispatchReport) async throws {}
}
struct ReceiptAdapter: AgentAdapter {
    let kind = "codex"
    let launches = Locked(0)
    let turns = Locked(0)
    let synchronized = Locked<[NodeAgentSession]>([])
    func synchronize(_ session: NodeAgentSession) async throws -> AgentSessionReport {
        synchronized.withLock { $0.append(session) }
        return AgentSessionReport(status: session.status, messages: [])
    }
    let turnContexts = Locked<[String]>([])
    func startManagedTurn(_ job: ManagedExecutionJob, receipt: ManagedRuntimeReceipt) async throws {
        turns.withLock { $0 += 1 }; turnContexts.withLock { $0.append(job.taskContext) }
    }
    func detect() async -> String? { "fixture" }
    func launch(_ job: DispatchJob) async throws -> LaunchResult { throw LaunchError("No manual launch") }
    func launchManaged(_ job: ManagedExecutionJob) async throws -> ManagedRuntimeReceipt {
        launches.withLock { $0 += 1 }
        return ManagedRuntimeReceipt(sessionRef: "real-fixture-thread", resolvedModel: "real-fixture-model", cwd: "/synthetic/work")
    }
}
extension ManagedExecutionTests {
    func testPermanentObservationRejectionIsolatesBatchAndOrdinaryJobsAcrossRestarts() async throws {
        let root = URL(fileURLWithPath: ProcessInfo.processInfo.environment["TMPDIR"] ?? NSTemporaryDirectory()).appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let journal = root.appendingPathComponent("ManagedExecutionRuntime")
        try FileManager.default.createDirectory(at: journal, withIntermediateDirectories: true)
        let api = try ReceiptAPI(committedBeforeLoss: false)
        api.reject.withLock { $0 = false }
        func job(_ id: String) throws -> ManagedExecutionJob {
            let data = try JSONEncoder().encode(api.job.current)
            return try JSONDecoder().decode(ManagedExecutionJob.self, from: Data(String(decoding: data, as: UTF8.self)
                .replacingOccurrences(of: "receipt-intent", with: id).utf8))
        }
        let bad = try job("a-rejected"), good = try job("b-accepted"), next = api.job.current
        api.rejectedIds.withLock { $0 = [bad.intent.id] }
        api.offeredJobs.withLock { $0 = [bad, next] }
        for value in [bad, good] {
            let entry = ManagedExecutionRuntime.Entry(job: value, phase: "running",
                receipt: ManagedRuntimeReceipt(sessionRef: "real-fixture-thread", resolvedModel: "real-fixture-model"),
                pending: ManagedExecutionObservation(sequence: 3, generation: 1, state: "waiting",
                    sessionRef: "real-fixture-thread", resolvedModel: "real-fixture-model"))
            try JSONEncoder().encode(entry).write(to: journal.appendingPathComponent(value.intent.id + ".json"))
        }
        let rejectedFile = journal.appendingPathComponent(bad.intent.id + ".json")
        let original = try Data(contentsOf: rejectedFile)
        let adapter = ReceiptAdapter()
        for _ in 0..<2 {
            var timing = NodeLoop.Timing(); timing.sessionInterval = 0.01
            let loop = NodeLoop(api: api, managedExecutionEnabled: true, adapters: [adapter], fallbackNodeName: "fixture",
                timing: timing, attachmentCacheRoot: root, log: { _ in })
            let before = api.polls.current
            let task = Task { try await loop.run() }
            for _ in 0..<100 {
                if api.polls.current > before && api.claims.current.contains(next.intent.id) { break }
                try await Task.sleep(nanoseconds: 5_000_000)
            }
            task.cancel(); _ = try? await task.value
            XCTAssertGreaterThan(api.polls.current, before)
            XCTAssertTrue(api.claims.current.contains(next.intent.id))
            XCTAssertEqual(try Data(contentsOf: rejectedFile), original)
        }
        XCTAssertTrue(api.successfulIds.current.contains(good.intent.id))
        XCTAssertEqual(adapter.launches.current, 1)
    }

    func testFirstTurnWaitsForDurableServerIdentityACK() async throws {
        let root = URL(fileURLWithPath: ProcessInfo.processInfo.environment["TMPDIR"] ?? NSTemporaryDirectory()).appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let api = try ReceiptAPI(committedBeforeLoss: false)
        let adapter = ReceiptAdapter()
        let runtime = ManagedExecutionRuntime(root: root)
        do { try await runtime.process(api.job.current, api: api, adapter: adapter) } catch {}
        XCTAssertEqual(adapter.launches.current, 1)
        XCTAssertEqual(adapter.turns.current, 0)
        XCTAssertEqual(api.reports.current.first?.state, "bound")
        api.job.withLock { $0 = ManagedExecutionJob(intent: $0.intent, repoPath: $0.repoPath, taskContext: "changed after launch intent", enabled: $0.enabled) }
        api.reject.withLock { $0 = false }
        try await runtime.process(api.job.current, api: api, adapter: adapter)
        XCTAssertEqual(adapter.turns.current, 1)
        XCTAssertEqual(adapter.turnContexts.current, ["{}"])
        try await ManagedExecutionRuntime(root: root).process(api.job.current, api: api, adapter: adapter)
        XCTAssertEqual(adapter.launches.current, 1)
        XCTAssertEqual(adapter.turns.current, 1)
    }

    func testLaunchReceiptRetriesAfterNetworkFailureWithoutRestart() async throws {
        try await checkReceiptRetry(restart: false, committedBeforeLoss: false)
    }
    func testLaunchReceiptSurvivesNodeRestartBeforeServerCommit() async throws {
        try await checkReceiptRetry(restart: true, committedBeforeLoss: false)
    }
    func testLaunchReceiptReplaysAfterCommitWithLostACKAndRestart() async throws {
        try await checkReceiptRetry(restart: true, committedBeforeLoss: true)
    }
    private func checkReceiptRetry(restart: Bool, committedBeforeLoss: Bool) async throws {
        let root = URL(fileURLWithPath: ProcessInfo.processInfo.environment["TMPDIR"] ?? NSTemporaryDirectory()).appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let api = try ReceiptAPI(committedBeforeLoss: committedBeforeLoss)
        let adapter = ReceiptAdapter()
        var timing = NodeLoop.Timing(); timing.sessionInterval = 0.01
        func makeLoop() -> NodeLoop {
            NodeLoop(api: api, managedExecutionEnabled: true, adapters: [adapter], fallbackNodeName: "fixture",
                timing: timing, attachmentCacheRoot: root, log: { _ in })
        }
        var task = Task { try await makeLoop().run() }
        for _ in 0..<200 {
            if !api.reports.current.isEmpty { break }
            try await Task.sleep(nanoseconds: 5_000_000)
        }
        XCTAssertEqual(api.reports.current.first?.sessionRef, "real-fixture-thread")
        if restart { task.cancel(); _ = try? await task.value }
        api.reject.withLock { $0 = false }
        if restart { task = Task { try await makeLoop().run() } }
        for _ in 0..<200 {
            if api.reports.current.count > 1 { break }
            try await Task.sleep(nanoseconds: 5_000_000)
        }
        task.cancel(); _ = try? await task.value
        XCTAssertGreaterThan(api.reports.current.count, 1)
        XCTAssertEqual(try APIClient.encoder.encode(api.reports.current.first!), try APIClient.encoder.encode(api.reports.current[1]))
        XCTAssertEqual(api.reports.current.last?.sessionRef, "real-fixture-thread")
        XCTAssertEqual(api.reports.current.last?.resolvedModel, "real-fixture-model")
        XCTAssertEqual(adapter.launches.current, 1)
    }
}

extension ManagedExecutionTests {
    func testCrashWindowsKeepOwnershipAndNeverRepeatThreadOrTurn() async throws {
        for phase in ["launching", "turnPermitPending", "turnStarting"] {
            let root = URL(fileURLWithPath: ProcessInfo.processInfo.environment["TMPDIR"] ?? NSTemporaryDirectory()).appendingPathComponent(UUID().uuidString)
            defer { try? FileManager.default.removeItem(at: root) }
            let api = try ReceiptAPI(committedBeforeLoss: false)
            api.reject.withLock { $0 = false }
            let adapter = ReceiptAdapter()
            try await ManagedExecutionRuntime(root: root).process(api.job.current, api: api, adapter: adapter)
            let file = root.appendingPathComponent(api.job.current.intent.id + ".json")
            var journal = try JSONSerialization.jsonObject(with: Data(contentsOf: file)) as! [String: Any]
            journal["phase"] = phase
            if phase == "launching" { journal.removeValue(forKey: "receipt") }
            try JSONSerialization.data(withJSONObject: journal).write(to: file)
            try await ManagedExecutionRuntime(root: root).process(api.job.current, api: api, adapter: adapter)
            XCTAssertEqual(api.reports.current.last?.state, "unknown")
            XCTAssertEqual(api.reports.current.last?.sessionRef, phase == "launching" ? nil : "real-fixture-thread")
            XCTAssertEqual(adapter.launches.current, 1)
            XCTAssertEqual(adapter.turns.current, 1)
        }
    }
    func testObservationSequenceSurvivesRestartAndRepeatingStates() async throws {
        let root = URL(fileURLWithPath: ProcessInfo.processInfo.environment["TMPDIR"] ?? NSTemporaryDirectory()).appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let api = try ReceiptAPI(committedBeforeLoss: false)
        api.reject.withLock { $0 = false }
        let adapter = ReceiptAdapter()
        try await ManagedExecutionRuntime(root: root).process(api.job.current, api: api, adapter: adapter)
        let binding = ManagedSessionBinding(state: "running", id: api.job.current.intent.id, runId: "run", stageId: "stage", generation: 1, role: "implement", stopRequested: false)
        for state in ["waiting", "running", "waiting"] {
            try await ManagedExecutionRuntime(root: root).observe(binding, state: state, sessionRef: "real-fixture-thread", model: nil, api: api)
        }
        XCTAssertEqual(api.reports.current.map(\.sequence), [1, 2, 3, 4, 5])
        XCTAssertEqual(api.reports.current.map(\.state), ["bound", "running", "waiting", "running", "waiting"])
        XCTAssertTrue(api.reports.current.allSatisfy { $0.resolvedModel == "real-fixture-model" })
    }
}

extension ManagedExecutionTests {
    func testLocalDisableBlocksExistingManagedInputsButPreservesManual() async throws {
        let api = try ReceiptAPI(committedBeforeLoss: false)
        let adapter = ReceiptAdapter()
        let root = URL(fileURLWithPath: ProcessInfo.processInfo.environment["TMPDIR"] ?? NSTemporaryDirectory()).appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        for state in ["running", "waiting"] {
            for command in ["queued", "delivering"] {
                let json = """
                {"id":"\(state)-\(command)","agentKind":"codex","sessionRef":"native-\(state)","status":"idle",
                "managedExecution":{"id":"intent","runId":"run","stageId":"stage","generation":1,"state":"\(state)","role":"review","stopRequested":false},
                "command":{"id":"input","text":"queued task","status":"\(command)","createdAt":"now"}}
                """
                let session = try JSONDecoder().decode(NodeAgentSession.self, from: Data(json.utf8))
                api.sessions.withLock { $0.append(session) }
            }
        }
        let manual = NodeAgentSession(id: "manual", sessionRef: "manual-thread", status: "idle")
        api.sessions.withLock { $0.append(manual) }
        var timing = NodeLoop.Timing(); timing.sessionInterval = 0.01
        let loop = NodeLoop(api: api, managedExecutionEnabled: false, adapters: [adapter], fallbackNodeName: "fixture",
            timing: timing, attachmentCacheRoot: root, log: { _ in })
        let task = Task { try await loop.run() }
        for _ in 0..<200 {
            if adapter.synchronized.current.count >= 5 { break }
            try await Task.sleep(nanoseconds: 5_000_000)
        }
        task.cancel(); _ = try? await task.value
        let seen = adapter.synchronized.current
        XCTAssertTrue(seen.contains(manual))
        XCTAssertEqual(Set(seen.filter { $0.managedExecution != nil }.map(\.id)).count, 4)
        for session in seen where session.managedExecution != nil {
            XCTAssertNil(session.command)
            XCTAssertEqual(session.managedExecution?.stopRequested, true)
        }
        XCTAssertEqual(adapter.launches.current, 0); XCTAssertEqual(adapter.turns.current, 0)
    }
}

extension ManagedExecutionTests {
    func testInstalledNativeStartAndResumeEvidence() throws {
        guard let path = ProcessInfo.processInfo.environment["MANAGED_NATIVE_RESUME_EVIDENCE"] else {
            throw XCTSkip("Point to the credential-free independent raw app-server evidence.")
        }
        let evidence = try JSONSerialization.jsonObject(with: Data(contentsOf: URL(fileURLWithPath: path))) as! [String: [String: Any]]
        var contexts: [String: ManagedResumeContext] = [:]
        let settings = try ManagedExecutionPolicy(role: "review").settings
        for (_, entry) in evidence {
            let request = entry["request"] as? [String: Any]
            guard request?["method"] as? String == "thread/start",
                  let response = entry["response"] as? [String: Any], let result = response["result"] as? [String: Any],
                  let params = request?["params"] as? [String: Any], let cwd = params["cwd"] as? String else { continue }
            try ManagedCodexProtocol.validate(result, request: CodexThreadRequest(socketPath: "/synthetic/socket", cwd: cwd,
                settings: settings, name: "fixture", prompt: "no inference"))
            let context = try ManagedCodexProtocol.runtimeReceipt(result).resumeContext()
            contexts[context.threadId] = context
        }
        XCTAssertEqual(contexts.count, 2)
        var checked = 0
        for (_, entry) in evidence {
            let request = entry["request"] as? [String: Any]
            guard request?["method"] as? String == "thread/resume",
                  let params = request?["params"] as? [String: Any], let id = params["threadId"] as? String,
                  let response = entry["response"] as? [String: Any], let result = response["result"] as? [String: Any] else { continue }
            let context = try XCTUnwrap(contexts[id])
            try ManagedCodexProtocol.validateResumed(result, settings: settings, context: context)
            for key in ["thread", "cwd", "model", "sandbox"] {
                var changed = result; changed[key] = NSNull()
                XCTAssertThrowsError(try ManagedCodexProtocol.validateResumed(changed, settings: settings, context: context))
            }
            checked += 1
        }
        XCTAssertGreaterThanOrEqual(checked, 4)
    }
}

private final class ResumeContractControl: CodexControl, @unchecked Sendable {
    let received = Locked<[CodexTurnOverrides]>([])
    func startThread(_ request: CodexThreadRequest) async throws -> String { throw LaunchError("No fixture start") }
    func readThread(socketPath: String, threadId: String) async throws -> CodexThreadSnapshot {
        CodexThreadSnapshot(status: "idle", messages: [], model: "drifted-observation-model")
    }
    func sendMessage(socketPath: String, threadId: String, text: String, clientUserMessageId: String, overrides: CodexTurnOverrides?) async throws {
        let value = try XCTUnwrap(overrides)
        received.withLock { $0.append(value) }
    }
}
extension ManagedExecutionTests {
    func testBothResumePathsCarryFrozenRuntimeIdentity() async throws {
        let api = try ReceiptAPI(committedBeforeLoss: false)
        let control = ResumeContractControl()
        let launcher = CodexLauncher(environment: ShellEnvironment(path: "/synthetic/bin", base: [:]), serverUrl: nil,
            location: CodexLocation(codexHome: "/synthetic/agent"), control: control, resources: ManagedTestResources())
        let receipt = ManagedRuntimeReceipt(sessionRef: "frozen-thread", resolvedModel: "actual-model", cwd: "/synthetic/work")
        try await launcher.startManagedTurn(api.job.current, receipt: receipt)
        let command = try JSONDecoder().decode(AgentSessionCommand.self, from: Data(#"{"id":"reply","text":"more","status":"delivering","createdAt":"now"}"#.utf8))
        var binding = ManagedSessionBinding(state: "running", id: "intent", runId: "run", stageId: "stage", generation: 1, role: "implement", stopRequested: false)
        binding.resumeContext = try receipt.resumeContext()
        _ = try await launcher.synchronize(NodeAgentSession(id: "mirror", managedExecution: binding,
            sessionRef: receipt.sessionRef, status: "idle", command: command))
        XCTAssertEqual(control.received.current.count, 2)
        for overrides in control.received.current {
            XCTAssertEqual(overrides.managedContext, try receipt.resumeContext())
            XCTAssertNil(overrides.model, "Request model is not evidence of the actual resolved model")
        }
        let root = URL(fileURLWithPath: ProcessInfo.processInfo.environment["TMPDIR"] ?? NSTemporaryDirectory()).appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        api.reject.withLock { $0 = false }
        let runtime = ManagedExecutionRuntime(root: root)
        try await runtime.process(api.job.current, api: api, adapter: ReceiptAdapter())
        let live = ManagedSessionBinding(state: "running", id: api.job.current.intent.id, runId: "run", stageId: "stage", generation: 1, role: "implement", stopRequested: false)
        let frozen = try await runtime.resumeContext(live, sessionRef: "real-fixture-thread")
        XCTAssertEqual(frozen?.resolvedModel, "real-fixture-model")
        XCTAssertEqual(frozen?.cwd, "/synthetic/work")
        let changed = try await runtime.resumeContext(live, sessionRef: "changed")
        XCTAssertNil(changed)
    }
    func testMinimalStopWireAndDisabledOutboxReplay() async throws {
        guard let path = ProcessInfo.processInfo.environment["MANAGED_WIRE_FIXTURE"] else { throw XCTSkip("Generate HTTP fixtures first") }
        struct Poll: Decodable { struct Stop: Decodable { let id: String; let generation: Int }; let jobs: [ManagedExecutionJob]; let stops: [Stop] }
        let poll = try JSONDecoder().decode(Poll.self, from: Data(contentsOf: URL(fileURLWithPath: path + ".minimal-jobs.json")))
        XCTAssertTrue(poll.jobs.isEmpty); XCTAssertEqual(poll.stops.count, 1); XCTAssertEqual(poll.stops.first?.generation, 1)
        struct Sessions: Decodable { let sessions: [NodeAgentSession] }
        let sessions = try JSONDecoder().decode(Sessions.self, from: Data(contentsOf: URL(fileURLWithPath: path + ".minimal-sessions.json")))
        let session = try XCTUnwrap(sessions.sessions.first)
        XCTAssertEqual(session.managedExecution?.id, poll.stops.first?.id)
        XCTAssertTrue(session.managedExecution?.stopRequested == true); XCTAssertNil(session.command)
        let control = ManagedStopControl()
        let launcher = CodexLauncher(environment: ShellEnvironment(path: "/synthetic/bin", base: [:]), serverUrl: nil,
            location: CodexLocation(codexHome: "/synthetic/agent"), control: control, resources: ManagedTestResources())
        _ = try await launcher.synchronize(session)
        XCTAssertEqual(control.interrupts.current, [session.sessionRef])
        let root = URL(fileURLWithPath: ProcessInfo.processInfo.environment["TMPDIR"] ?? NSTemporaryDirectory()).appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let api = try ReceiptAPI(committedBeforeLoss: false)
        let adapter = ReceiptAdapter()
        do { try await ManagedExecutionRuntime(root: root).process(api.job.current, api: api, adapter: adapter) } catch {}
        let pending = try XCTUnwrap(api.reports.current.first)
        api.reject.withLock { $0 = false }
        try await ManagedExecutionRuntime(root: root).flushObservations(api: api)
        XCTAssertEqual(try APIClient.encoder.encode(api.reports.current.last!), try APIClient.encoder.encode(pending))
        XCTAssertEqual(adapter.launches.current, 1); XCTAssertEqual(adapter.turns.current, 0)
    }
}
