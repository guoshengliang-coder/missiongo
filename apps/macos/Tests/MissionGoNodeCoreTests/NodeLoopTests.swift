import XCTest
@testable import MissionGoNodeCore

private final class FakeAPI: NodeAPI, @unchecked Sendable {
    let calls = Locked<[String]>([])
    let heartbeats = Locked<[[DetectedAgent]]>([])
    let reports = Locked<[(String, DispatchReport)]>([])
    let queue: Locked<[Result<DispatchRequest?, Error>]>
    let heartbeatResult: Locked<Result<HeartbeatReply, Error>>
    let reportFailuresBeforeSuccess: Locked<Int>

    init(
        claims: [Result<DispatchRequest?, Error>],
        heartbeat: Result<HeartbeatReply, Error> = .success(HeartbeatReply(repos: [])),
        reportFailures: Int = 0
    ) {
        queue = Locked(claims)
        heartbeatResult = Locked(heartbeat)
        reportFailuresBeforeSuccess = Locked(reportFailures)
    }

    func heartbeat(agents: [DetectedAgent], repoCandidates: [RepoCandidate]) async throws -> HeartbeatReply {
        calls.withLock { $0.append("heartbeat:\(agents.map(\.version).joined(separator: ",")):\(repoCandidates.count)") }
        heartbeats.withLock { $0.append(agents) }
        return try heartbeatResult.current.get()
    }

    func claimNext(waitMs: Int, availableAgentKinds: [String]?) async throws -> DispatchRequest? {
        calls.withLock { $0.append("claim:\((availableAgentKinds ?? []).joined(separator: ","))") }
        let next = queue.withLock { $0.isEmpty ? nil : $0.removeFirst() }
        guard let next else {
            // An idle long poll: keep the loop from spinning.
            try? await Task.sleep(nanoseconds: 20_000_000)
            return nil
        }
        return try next.get()
    }

    func reportResult(dispatchId: String, report: DispatchReport) async throws {
        let fail = reportFailuresBeforeSuccess.withLock { remaining -> Bool in
            guard remaining > 0 else { return false }
            remaining -= 1
            return true
        }
        if fail { throw APIError.network(NetworkFailure(host: "mg.test", error: URLError(.networkConnectionLost))) }
        reports.withLock { $0.append((dispatchId, report)) }
    }
}

private struct FakeAdapter: AgentAdapter {
    let kind = "claude_code"
    let outcome: Result<LaunchResult, LaunchError>
    let detections = Locked(0)
    let jobs = Locked<[DispatchJob]>([])

    func detect() async -> String? {
        detections.withLock { $0 += 1 }
        return "2.1.232"
    }

    func launch(_ job: DispatchJob) async throws -> LaunchResult {
        jobs.withLock { $0.append(job) }
        return try outcome.get()
    }
}

private struct RecoveringAdapter: AgentAdapter {
    let kind = "claude_code"
    let detections = Locked(0)

    func detect() async -> String? {
        let count = detections.withLock { value -> Int in
            value += 1
            return value
        }
        return count == 1 ? nil : "2.1.276"
    }

    func launch(_ job: DispatchJob) async throws -> LaunchResult {
        throw LaunchError("Not used by this test")
    }
}

private struct UnavailableAdapter: AgentAdapter {
    let kind: String
    let reason: String

    func detect() async -> String? { "1.0.0" }
    func dispatchAvailability() async -> AgentDispatchAvailability { .unavailable(reason: reason) }
    func launch(_ job: DispatchJob) async throws -> LaunchResult { throw LaunchError("not used") }
}

private struct ModelAdapter: AgentAdapter {
    let kind = "codex"
    let jobs = Locked<[DispatchJob]>([])

    func detect() async -> String? { "0.155.1" }
    func availableModels() async -> [AgentModelOption]? {
        [AgentModelOption(id: "gpt-5.1-codex", label: "GPT-5.1 Codex", efforts: ["low"])]
    }
    func launch(_ job: DispatchJob) async throws -> LaunchResult {
        jobs.withLock { $0.append(job) }
        return LaunchResult(sessionName: "M-AND-1", sessionUrl: nil, sessionRef: "t", logPath: nil)
    }
}

private func fastTiming() -> NodeLoop.Timing {
    var timing = NodeLoop.Timing()
    timing.heartbeatInterval = 0.05
    timing.claimInterval = 0.01
    timing.agentUnavailableInterval = 0.01
    timing.resultRetryDelay = 0.01
    return timing
}

private let request = DispatchRequest(
    dispatchId: "d1", itemKeys: ["AND-1"], repoPath: "/Users/dev/p", agentKind: "claude_code", mode: "plan"
)

final class NodeLoopTests: XCTestCase {
    private func waitUntil(_ condition: @escaping () -> Bool, timeout: TimeInterval = 5) async {
        let deadline = Date().addingTimeInterval(timeout)
        while !condition(), Date() < deadline {
            try? await Task.sleep(nanoseconds: 10_000_000)
        }
    }

    func testLaunchesAClaimedDispatchAndReportsTheSession() async throws {
        let api = FakeAPI(claims: [.success(request)], reportFailures: 2)
        let adapter = FakeAdapter(outcome: .success(LaunchResult(
            sessionName: "Mac mini-AND-1", sessionUrl: "https://claude.ai/code/session_x", logPath: "/logs/d1.log"
        )))
        let loop = NodeLoop(api: api, adapters: [adapter], fallbackNodeName: "Mac mini", detectRepoCandidates: { [RepoCandidate(path: "/p", name: "p")] },
                            timing: fastTiming(), log: { _ in })
        let task = Task { try await loop.run() }
        await waitUntil { !loop.currentState.recentLaunches.isEmpty && loop.currentState.lastHeartbeatAt != nil }
        task.cancel()
        try await task.value

        // Two failed reports are retried rather than dropped.
        XCTAssertEqual(api.reports.current.map(\.0), ["d1"])
        XCTAssertEqual(api.reports.current.first?.1,
                       DispatchReport(status: .launched, sessionName: "Mac mini-AND-1", sessionUrl: "https://claude.ai/code/session_x"))
        let state = loop.currentState
        XCTAssertEqual(state.connection, .stopped)
        XCTAssertEqual(state.recentLaunches.first?.dispatchId, "d1")
        XCTAssertEqual(state.recentLaunches.first?.reported, true)
        XCTAssertEqual(state.agents, [DetectedAgent(kind: "claude_code", version: "2.1.232")])
        XCTAssertTrue(api.calls.current.contains("heartbeat:2.1.232:1"))
        // Agent detection is cached across beats.
        XCTAssertEqual(adapter.detections.current, 1)
    }

    func testHeartbeatCarriesTheAdaptersModelsAndTheDispatchPassesItsChoice() async throws {
        let api = FakeAPI(claims: [.success(DispatchRequest(
            dispatchId: "d2", itemKeys: ["AND-1"], repoPath: "/p", agentKind: "codex", mode: "plan",
            model: "gpt-5.1-codex", effort: "low"
        ))])
        let adapter = ModelAdapter()
        let loop = NodeLoop(api: api, adapters: [adapter], fallbackNodeName: "M", timing: fastTiming(), log: { _ in })
        let task = Task { try await loop.run() }
        await waitUntil { !loop.currentState.recentLaunches.isEmpty && loop.currentState.lastHeartbeatAt != nil }
        task.cancel()
        try await task.value

        XCTAssertEqual(loop.currentState.agents.first?.models?.map(\.id), ["gpt-5.1-codex"])
        XCTAssertEqual(adapter.jobs.current.first?.model, "gpt-5.1-codex")
        XCTAssertEqual(adapter.jobs.current.first?.effort, "low")
    }

    func testHeartbeatPublishesTheSkillVersionToTheMenuState() async throws {
        let api = FakeAPI(
            claims: [],
            heartbeat: .success(HeartbeatReply(repos: [], expectedSkillVersion: "5.10.0"))
        )
        let loop = NodeLoop(
            api: api,
            adapters: [FakeAdapter(outcome: .failure(LaunchError("not used")))],
            fallbackNodeName: "M",
            timing: fastTiming(),
            log: { _ in }
        )
        let task = Task { try await loop.run() }
        await waitUntil { loop.currentState.expectedSkillVersion == "5.10.0" }
        task.cancel()
        try await task.value

        XCTAssertEqual(loop.currentState.expectedSkillVersion, "5.10.0")
    }

    func testSkillReadinessIsPublishedBeforeClaimsResume() async throws {
        let api = FakeAPI(
            claims: [.success(request)],
            heartbeat: .success(HeartbeatReply(repos: [], expectedSkillVersion: "5.10.0"))
        )
        let adapter = FakeAdapter(outcome: .success(LaunchResult(
            sessionName: "M-AND-1", sessionUrl: nil, sessionRef: "s1", logPath: nil
        )))
        let loop = NodeLoop(
            api: api,
            adapters: [adapter],
            fallbackNodeName: "M",
            timing: fastTiming(),
            skillReadiness: { _, expected in
                AgentSkillSnapshot(
                    localVersion: expected == "5.10.0" ? "5.10.0" : "5.9.0",
                    expectedVersion: expected,
                    syncState: expected == "5.10.0" ? "ready" : "stale"
                )
            },
            log: { _ in }
        )
        let task = Task { try await loop.run() }
        await waitUntil { !api.reports.current.isEmpty && api.heartbeats.current.count >= 2 }
        task.cancel()
        try await task.value

        XCTAssertEqual(api.heartbeats.current.first?.first?.ready, false)
        XCTAssertEqual(api.heartbeats.current.dropFirst().first?.first?.ready, true)
        XCTAssertEqual(api.reports.current.first?.1.status, .launched)
    }

    func testMissingAgentIsDetectedAgainOnTheNextHeartbeat() async throws {
        let api = FakeAPI(claims: [])
        let adapter = RecoveringAdapter()
        let loop = NodeLoop(api: api, adapters: [adapter], fallbackNodeName: "Mac mini", timing: fastTiming(), log: { _ in })
        let task = Task { try await loop.run() }
        await waitUntil { api.calls.current.contains(where: { $0.hasPrefix("heartbeat:2.1.276:") }) }
        task.cancel()
        try await task.value

        XCTAssertTrue(api.calls.current.contains(where: { $0.hasPrefix("heartbeat::") }))
        XCTAssertTrue(api.calls.current.contains(where: { $0.hasPrefix("heartbeat:2.1.276:") }))
        XCTAssertEqual(adapter.detections.current, 2)
    }

    func testAFailedLaunchIsReportedAsFailedWithTheReason() async throws {
        let api = FakeAPI(claims: [.success(request)])
        let adapter = FakeAdapter(outcome: .failure(LaunchError("Claude Code 未登录（authMethod=none）")))
        let loop = NodeLoop(api: api, adapters: [adapter], fallbackNodeName: "Mac mini", timing: fastTiming(), log: { _ in })
        let task = Task { try await loop.run() }
        await waitUntil { !api.reports.current.isEmpty }
        task.cancel()
        try await task.value
        XCTAssertEqual(api.reports.current.first?.1, DispatchReport(
            status: .failed, error: "Claude Code 未登录（authMethod=none）",
            failureCode: "unknown", failureStage: "unknown"
        ))
    }

    func testATransientMcpFailureReturnsTheSameDispatchToTheQueueWithDiagnostics() async throws {
        let api = FakeAPI(claims: [.success(request)])
        let diagnostic = DispatchMcpDiagnostic(
            threadId: "thread-1", startupStatus: "failed", runtimeStatus: "starting",
            error: "MCP client startup timed out", observedAt: "2026-09-23T00:00:00Z"
        )
        let adapter = FakeAdapter(outcome: .failure(LaunchError(
            "MissionGo MCP 启动超时", failureCode: "mcp_timeout", failureStage: "mcp",
            retryAfterSeconds: 30, diagnosticSnapshot: DispatchDiagnosticSnapshot(mcp: diagnostic)
        )))
        let loop = NodeLoop(api: api, adapters: [adapter], fallbackNodeName: "Mac mini", timing: fastTiming(), log: { _ in })
        let task = Task { try await loop.run() }
        await waitUntil { !api.reports.current.isEmpty }
        task.cancel()
        try await task.value

        XCTAssertEqual(api.reports.current.first?.1, DispatchReport(
            status: .retry, error: "MissionGo MCP 启动超时", failureCode: "mcp_timeout", failureStage: "mcp",
            retryAfterSeconds: 30, diagnosticSnapshot: DispatchDiagnosticSnapshot(mcp: diagnostic)
        ))
    }

    func testUnavailableAgentIsExcludedBeforeTheServerHandsOverWork() async throws {
        let api = FakeAPI(claims: [])
        let ready = FakeAdapter(outcome: .failure(LaunchError("not used")))
        let blocked = UnavailableAdapter(kind: "codex", reason: "资源余量不足")
        let messages = Locked<[String]>([])
        let loop = NodeLoop(
            api: api, adapters: [ready, blocked], fallbackNodeName: "Mac mini",
            timing: fastTiming(), log: { message in messages.withLock { $0.append(message) } }
        )
        let task = Task { try await loop.run() }
        await waitUntil { api.calls.current.contains("claim:claude_code") }
        task.cancel()
        try await task.value

        XCTAssertFalse(api.calls.current.contains { $0.contains("codex") })
        XCTAssertTrue(api.calls.current.contains { $0.hasPrefix("heartbeat:") && $0.contains("1.0.0") })
        XCTAssertTrue(messages.current.contains { $0.contains("暂停领取 codex 派单") && $0.contains("资源余量不足") })
    }

    func testNamesTheSessionAfterTheNodeNameTheServerSent() async {
        let adapter = FakeAdapter(outcome: .success(LaunchResult(sessionName: "x", sessionUrl: nil, logPath: "/l")))
        let loop = NodeLoop(api: FakeAPI(claims: []), adapters: [adapter], fallbackNodeName: "Mac mini", log: { _ in })
        let named = DispatchRequest(
            dispatchId: "d1", itemKeys: ["HG-49"], repoPath: "/p", agentKind: "claude_code", mode: "plan", nodeName: "老王的 Mac"
        )
        _ = await loop.launchDispatch(named)
        XCTAssertEqual(adapter.jobs.current.first?.nodeName, "老王的 Mac")
    }

    func testFallsBackToTheStoredNameWhenAnOlderServerSendsNone() async {
        let adapter = FakeAdapter(outcome: .success(LaunchResult(sessionName: "x", sessionUrl: nil, logPath: "/l")))
        let loop = NodeLoop(api: FakeAPI(claims: []), adapters: [adapter], fallbackNodeName: "Mac mini", log: { _ in })
        _ = await loop.launchDispatch(request)
        XCTAssertEqual(adapter.jobs.current.first?.nodeName, "Mac mini")
        // An older server sends no round either: a first session, nothing reworked.
        XCTAssertEqual(adapter.jobs.current.first?.round, 1)
        XCTAssertEqual(adapter.jobs.current.first?.reworkItemKeys, [])
    }

    func testHandsTheRoundAndReworkKeysToTheAgent() async {
        let adapter = FakeAdapter(outcome: .success(LaunchResult(sessionName: "x", sessionUrl: nil, logPath: "/l")))
        let loop = NodeLoop(api: FakeAPI(claims: []), adapters: [adapter], fallbackNodeName: "Mac mini", log: { _ in })
        _ = await loop.launchDispatch(DispatchRequest(
            dispatchId: "d1", itemKeys: ["HG-49"], repoPath: "/p", agentKind: "claude_code", mode: "plan",
            round: 2, reworkItemKeys: ["HG-49"]
        ))
        XCTAssertEqual(adapter.jobs.current.first?.round, 2)
        XCTAssertEqual(adapter.jobs.current.first?.reworkItemKeys, ["HG-49"])
    }

    func testAnUnknownAgentIsReportedRatherThanDropped() async {
        let codex = DispatchRequest(dispatchId: "d2", itemKeys: ["AND-2"], repoPath: "/p", agentKind: "codex", mode: "x")
        let loop = NodeLoop(api: FakeAPI(claims: []), adapters: [], fallbackNodeName: "Mac mini", log: { _ in })
        let (report, _) = await loop.launchDispatch(codex)
        XCTAssertEqual(report, DispatchReport(
            status: .failed, error: "本机没有 codex 的适配器。",
            failureCode: "unknown", failureStage: "readiness"
        ))
    }

    func testNetworkErrorsKeepTheLoopRunning() async throws {
        let failure = APIError.network(NetworkFailure(host: "mg.test", error: URLError(.notConnectedToInternet)))
        let api = FakeAPI(claims: [.failure(failure), .failure(failure), .success(request)], heartbeat: .failure(failure))
        let adapter = FakeAdapter(outcome: .success(LaunchResult(sessionName: "Mac mini-AND-1", sessionUrl: nil, logPath: "/l")))
        let errors = Locked<[String]>([])
        let loop = NodeLoop(api: api, adapters: [adapter], fallbackNodeName: "Mac mini", detectRepoCandidates: { [] }, timing: fastTiming(), log: { _ in },
                            onState: { state in
                                if state.connection == .offline, let error = state.lastError { errors.withLock { $0.append(error) } }
                            })
        let task = Task { try await loop.run() }
        await waitUntil { !api.reports.current.isEmpty }
        task.cancel()
        try await task.value
        XCTAssertEqual(api.reports.current.first?.1, DispatchReport(status: .launched, sessionName: "Mac mini-AND-1"))
        XCTAssertTrue(errors.current.contains { $0.contains("拉取派单出错") && $0.contains("mg.test") }, "\(errors.current)")
        XCTAssertTrue(errors.current.contains { $0.contains("上报心跳出错") }, "\(errors.current)")
    }

    func testARevokedCredentialStopsBothLoopsAndSurfaces() async {
        let api = FakeAPI(claims: [], heartbeat: .failure(APIError.credentialRevoked(status: 401, detail: nil)))
        let loop = NodeLoop(api: api, adapters: [], fallbackNodeName: "Mac mini", detectRepoCandidates: { [] }, timing: fastTiming(), log: { _ in })
        do {
            try await loop.run()
            XCTFail("expected credentialRevoked")
        } catch let error as APIError {
            guard case .credentialRevoked = error else { return XCTFail("\(error)") }
        } catch {
            XCTFail("\(error)")
        }
        XCTAssertEqual(loop.currentState.connection, .credentialRevoked)
        let callsAtStop = api.calls.current.count
        try? await Task.sleep(nanoseconds: 200_000_000)
        XCTAssertEqual(api.calls.current.count, callsAtStop)
    }

    func testPublishesStatesOnTheStream() async throws {
        let api = FakeAPI(claims: [])
        let loop = NodeLoop(api: api, adapters: [], fallbackNodeName: "Mac mini", detectRepoCandidates: { [] }, timing: fastTiming(), log: { _ in })
        let task = Task { try await loop.run() }
        var sawOnline = false
        for await state in loop.states where state.connection == .online {
            sawOnline = true
            break
        }
        task.cancel()
        try await task.value
        XCTAssertTrue(sawOnline)
    }

    /// The reconnect button (AND-177): a wake runs the next heartbeat round at
    /// once. The interval is a minute so a pass can only come from the wake —
    /// waiting it out would blow the test timeout.
    func testRetryNowRerunsTheHeartbeatWithoutWaitingOutTheInterval() async throws {
        let api = FakeAPI(
            claims: [],
            heartbeat: .failure(APIError.network(NetworkFailure(host: "mg.test", error: URLError(.timedOut))))
        )
        var timing = fastTiming()
        timing.heartbeatInterval = 60
        let loop = NodeLoop(api: api, adapters: [], fallbackNodeName: "Mac mini", detectRepoCandidates: { [] }, timing: timing, log: { _ in })
        let task = Task { try await loop.run() }
        await waitUntil { loop.currentState.lastError?.contains("上报心跳出错") == true }
        // Let the loop reach its sleep before waking it; the failure is
        // published a moment before the sleeper is registered.
        try await Task.sleep(nanoseconds: 200_000_000)
        loop.retryNow()
        await waitUntil { api.heartbeats.current.count >= 2 }
        task.cancel()
        try await task.value
        XCTAssertGreaterThanOrEqual(api.heartbeats.current.count, 2)
    }

    /// A wake must not blunt the stop signal: cancelling still ends the loops.
    func testStoppingStillWorksAfterAWake() async throws {
        let api = FakeAPI(claims: [])
        let loop = NodeLoop(api: api, adapters: [], fallbackNodeName: "Mac mini", detectRepoCandidates: { [] }, timing: fastTiming(), log: { _ in })
        let task = Task { try await loop.run() }
        await waitUntil { loop.currentState.lastHeartbeatAt != nil }
        loop.retryNow()
        task.cancel()
        try await task.value
        XCTAssertEqual(loop.currentState.connection, .stopped)
    }
}
