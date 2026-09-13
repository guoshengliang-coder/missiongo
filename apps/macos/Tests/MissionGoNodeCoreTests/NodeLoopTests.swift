import XCTest
@testable import MissionGoNodeCore

private final class FakeAPI: NodeAPI, @unchecked Sendable {
    let calls = Locked<[String]>([])
    let reports = Locked<[(String, DispatchReport)]>([])
    let queue: Locked<[Result<DispatchRequest?, Error>]>
    let heartbeatResult: Locked<Result<[RepoMapping], Error>>
    let reportFailuresBeforeSuccess: Locked<Int>

    init(
        claims: [Result<DispatchRequest?, Error>],
        heartbeat: Result<[RepoMapping], Error> = .success([]),
        reportFailures: Int = 0
    ) {
        queue = Locked(claims)
        heartbeatResult = Locked(heartbeat)
        reportFailuresBeforeSuccess = Locked(reportFailures)
    }

    func heartbeat(agents: [DetectedAgent], repoCandidates: [RepoCandidate]) async throws -> [RepoMapping] {
        calls.withLock { $0.append("heartbeat:\(agents.map(\.version).joined(separator: ",")):\(repoCandidates.count)") }
        return try heartbeatResult.current.get()
    }

    func claimNext(waitMs: Int) async throws -> DispatchRequest? {
        calls.withLock { $0.append("claim") }
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

    func detect() async -> String? {
        detections.withLock { $0 += 1 }
        return "2.1.232"
    }

    func launch(_ job: DispatchJob) async throws -> LaunchResult {
        return try outcome.get()
    }
}

private func fastTiming() -> NodeLoop.Timing {
    var timing = NodeLoop.Timing()
    timing.heartbeatInterval = 0.05
    timing.claimInterval = 0.01
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
            sessionName: "MissionGo AND-1", sessionUrl: "https://claude.ai/code/session_x", logPath: "/logs/d1.log"
        )))
        let loop = NodeLoop(api: api, adapters: [adapter], detectRepoCandidates: { [RepoCandidate(path: "/p", name: "p")] },
                            timing: fastTiming(), log: { _ in })
        let task = Task { try await loop.run() }
        await waitUntil { !loop.currentState.recentLaunches.isEmpty && loop.currentState.lastHeartbeatAt != nil }
        task.cancel()
        try await task.value

        // Two failed reports are retried rather than dropped.
        XCTAssertEqual(api.reports.current.map(\.0), ["d1"])
        XCTAssertEqual(api.reports.current.first?.1,
                       DispatchReport(status: .launched, sessionName: "MissionGo AND-1", sessionUrl: "https://claude.ai/code/session_x"))
        let state = loop.currentState
        XCTAssertEqual(state.connection, .stopped)
        XCTAssertEqual(state.recentLaunches.first?.dispatchId, "d1")
        XCTAssertEqual(state.recentLaunches.first?.reported, true)
        XCTAssertEqual(state.agents, [DetectedAgent(kind: "claude_code", version: "2.1.232")])
        XCTAssertTrue(api.calls.current.contains("heartbeat:2.1.232:1"))
        // Agent detection is cached across beats.
        XCTAssertEqual(adapter.detections.current, 1)
    }

    func testAFailedLaunchIsReportedAsFailedWithTheReason() async throws {
        let api = FakeAPI(claims: [.success(request)])
        let adapter = FakeAdapter(outcome: .failure(LaunchError("Claude Code 未登录（authMethod=none）")))
        let loop = NodeLoop(api: api, adapters: [adapter], timing: fastTiming(), log: { _ in })
        let task = Task { try await loop.run() }
        await waitUntil { !api.reports.current.isEmpty }
        task.cancel()
        try await task.value
        XCTAssertEqual(api.reports.current.first?.1, DispatchReport(status: .failed, error: "Claude Code 未登录（authMethod=none）"))
    }

    func testAnUnknownAgentIsReportedRatherThanDropped() async throws {
        let codex = DispatchRequest(dispatchId: "d2", itemKeys: ["AND-2"], repoPath: "/p", agentKind: "codex", mode: "x")
        let api = FakeAPI(claims: [.success(codex)])
        let loop = NodeLoop(api: api, adapters: [], detectRepoCandidates: { [] }, timing: fastTiming(), log: { _ in })
        let task = Task { try await loop.run() }
        await waitUntil { !api.reports.current.isEmpty }
        task.cancel()
        try await task.value
        XCTAssertEqual(api.reports.current.first?.1, DispatchReport(status: .failed, error: "本机没有 codex 的适配器。"))
    }

    func testNetworkErrorsKeepTheLoopRunning() async throws {
        let failure = APIError.network(NetworkFailure(host: "mg.test", error: URLError(.notConnectedToInternet)))
        let api = FakeAPI(claims: [.failure(failure), .failure(failure), .success(request)], heartbeat: .failure(failure))
        let adapter = FakeAdapter(outcome: .success(LaunchResult(sessionName: "MissionGo AND-1", sessionUrl: nil, logPath: "/l")))
        let errors = Locked<[String]>([])
        let loop = NodeLoop(api: api, adapters: [adapter], detectRepoCandidates: { [] }, timing: fastTiming(), log: { _ in },
                            onState: { state in
                                if state.connection == .offline, let error = state.lastError { errors.withLock { $0.append(error) } }
                            })
        let task = Task { try await loop.run() }
        await waitUntil { !api.reports.current.isEmpty }
        task.cancel()
        try await task.value
        XCTAssertEqual(api.reports.current.first?.1, DispatchReport(status: .launched, sessionName: "MissionGo AND-1"))
        XCTAssertTrue(errors.current.contains { $0.contains("拉取派单出错") && $0.contains("mg.test") }, "\(errors.current)")
        XCTAssertTrue(errors.current.contains { $0.contains("上报心跳出错") }, "\(errors.current)")
    }

    func testARevokedCredentialStopsBothLoopsAndSurfaces() async {
        let api = FakeAPI(claims: [], heartbeat: .failure(APIError.credentialRevoked(status: 401, detail: nil)))
        let loop = NodeLoop(api: api, adapters: [], detectRepoCandidates: { [] }, timing: fastTiming(), log: { _ in })
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
        let loop = NodeLoop(api: api, adapters: [], detectRepoCandidates: { [] }, timing: fastTiming(), log: { _ in })
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
}
