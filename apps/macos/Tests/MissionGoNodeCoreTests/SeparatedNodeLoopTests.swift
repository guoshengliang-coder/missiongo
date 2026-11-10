import XCTest
@testable import MissionGoNodeCore

private final class ControlAPI: NodeAPI, @unchecked Sendable {
    let sessions = Locked<[NodeAgentSession]>([])
    let reports = Locked<[(String, AgentSessionReport)]>([])
    func heartbeat(agents: [DetectedAgent], repoCandidates: [RepoCandidate]) async throws -> HeartbeatReply { HeartbeatReply(repos: []) }
    func claimNext(waitMs: Int, availableAgentKinds: [String]?) async throws -> DispatchRequest? { try? await Task.sleep(nanoseconds: 20_000_000); return nil }
    func reportResult(dispatchId: String, report: DispatchReport) async throws {}
    func waitForAgentControl(cursor: String?, waitMs: Int) async throws -> NodeControlChange? {
        if waitMs > 0 { try await Task.sleep(nanoseconds: 20_000_000) }
        return NodeControlChange(cursor: UUID().uuidString)
    }
    func listAgentSessions() async throws -> [NodeAgentSession] { sessions.current }
    func reportAgentSession(sessionId: String, report: AgentSessionReport) async throws {
        reports.withLock { $0.append((sessionId, report)) }
        if let commandId = report.commandId {
            sessions.withLock { values in
                values = values.map { old in
                    guard old.id == sessionId, old.command?.id == commandId else { return old }
                    let command = report.commandStatus == "delivering" ? AgentSessionCommand(id: commandId,
                        kind: old.command?.kind ?? "message", text: "continue", turnId: old.command?.turnId, status: "delivering") : nil
                    return NodeAgentSession(id: old.id, sessionRef: old.sessionRef, status: report.status, command: command)
                }
            }
        }
    }
}
private final class ControlAdapter: AgentAdapter, @unchecked Sendable {
    let kind = "codex"
    let reading = Locked(false), release = Locked(false), holdControls = Locked(false)
    let inputIds = Locked<Set<String>>([])
    func detect() async -> String? { "fixture" }
    func launch(_ job: DispatchJob) async throws -> LaunchResult { throw LaunchError("unused") }
    func synchronize(_ session: NodeAgentSession) async throws -> AgentSessionReport {
        if session.syncPurpose == .observation {
            XCTAssertNil(session.command)
            if session.id == "target" {
                reading.withLock { $0 = true }
                while !release.current { try? await Task.sleep(nanoseconds: 5_000_000) }
            }
            return AgentSessionReport(status: "active", messages: [])
        }
        guard let command = session.command else { return AgentSessionReport(status: "idle", messages: []) }
        if session.id.hasPrefix("blocked") {
            while holdControls.current { try? await Task.sleep(nanoseconds: 5_000_000) }
        }
        if command.status == "queued" { return AgentSessionReport(status: "active", messages: [], commandId: command.id, commandStatus: "delivering") }
        _ = inputIds.withLock { $0.insert(command.id) }
        return AgentSessionReport(status: "idle", stopConfirmed: command.kind == "interrupt" ? true : nil,
            messages: [], commandId: command.id, commandStatus: "delivered", turnActive: false)
    }
}
final class SeparatedNodeLoopTests: XCTestCase {
    private func wait(_ predicate: () -> Bool, timeout: TimeInterval = 1) async -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline { if predicate() { return true }; try? await Task.sleep(nanoseconds: 5_000_000) }
        return predicate()
    }
    private func timing() -> NodeLoop.Timing {
        var value = NodeLoop.Timing(); value.sessionInterval = 0.02; value.claimInterval = 0.02; value.heartbeatInterval = 0.1; return value
    }
    func testSameSessionInputAndStopDoNotWaitForItsBlockedMirror() async throws {
        for kind in ["message", "interrupt"] {
            let api = ControlAPI(), adapter = ControlAdapter()
            api.sessions.withLock { $0 = [NodeAgentSession(id: "target", sessionRef: "ref", status: "active")] }
            let loop = NodeLoop(api: api, adapters: [adapter], fallbackNodeName: "Fixture", timing: timing(), log: { _ in })
            let task = Task { try await loop.run() }
            let started = await wait { adapter.reading.current }; XCTAssertTrue(started)
            let before = api.reports.current.count
            api.sessions.withLock { $0 = [NodeAgentSession(id: "target", sessionRef: "ref", status: "active",
                command: AgentSessionCommand(id: "command", kind: kind, text: "continue", turnId: "exact-turn"))] }
            let delivered = await wait({ api.reports.current.contains { $0.1.commandStatus == "delivered" } }, timeout: 0.5)
            XCTAssertTrue(delivered, "control must finish while the full mirror is still blocked")
            api.sessions.withLock { $0 = [] }
            // Keep the original source read blocked for a full two seconds.
            try? await Task.sleep(nanoseconds: 2_000_000_000)
            adapter.release.withLock { $0 = true }
            task.cancel(); try await task.value
            XCTAssertEqual(adapter.inputIds.current, ["command"])
            XCTAssertFalse(api.reports.current.dropFirst(before).contains { $0.1.commandId == nil && $0.1.status == "active" })
        }
    }
    func testStopHasItsOwnBoundedLaneWhenOrdinaryControlsAreBusy() async throws {
        let api = ControlAPI(), adapter = ControlAdapter(); adapter.holdControls.withLock { $0 = true }
        api.sessions.withLock { $0 = (0..<4).map { NodeAgentSession(id: "blocked-\($0)", sessionRef: "r\($0)", status: "active",
            command: AgentSessionCommand(id: "c\($0)", text: "hold", status: "delivering")) } }
        let loop = NodeLoop(api: api, adapters: [adapter], fallbackNodeName: "Fixture", timing: timing(), log: { _ in })
        let task = Task { try await loop.run() }
        try? await Task.sleep(nanoseconds: 60_000_000)
        api.sessions.withLock { $0.append(NodeAgentSession(id: "stop", sessionRef: "stop-ref", status: "active",
            command: AgentSessionCommand(id: "stop-command", kind: "interrupt", text: "stop", turnId: "exact", status: "delivering"))) }
        let delivered = await wait({ api.reports.current.contains { $0.1.stopConfirmed == true } }, timeout: 0.5); XCTAssertTrue(delivered)
        adapter.holdControls.withLock { $0 = false }; adapter.release.withLock { $0 = true }; api.sessions.withLock { $0 = [] }
        task.cancel(); try await task.value
    }
    func testAnOldReceiptDoesNotRestorePreStopState() async {
        let sync = SessionSynchronization()
        let old = AgentSessionReport(status: "active", messages: [], commandId: "message", commandStatus: "delivered", turnActive: true)
        _ = await sync.controlReport(old, id: "session", epoch: 1)
        _ = await sync.controlReport(AgentSessionReport(status: "idle", stopConfirmed: true, messages: [],
            commandId: "stop", commandStatus: "delivered", turnActive: false), id: "session", epoch: 2)
        let retry = await sync.controlReport(old, id: "session", epoch: 3)
        XCTAssertEqual(retry.commandId, "message"); XCTAssertEqual(retry.commandStatus, "delivered")
        XCTAssertEqual(retry.status, "idle"); XCTAssertEqual(retry.turnActive, false)
    }
    func testQueueBoundsConcurrencyAndCoalescesEachIdentity() async {
        for count in [1, 10, 50] {
            let queue = SessionWorkQueue(); let release = Locked(false), running = Locked<Set<Int>>([]), peak = Locked(0), completed = Locked<Set<Int>>([])
            for id in 0..<count {
                for _ in 0..<3 {
                    await queue.submit(String(id)) {
                        let size = running.withLock { values -> Int in XCTAssertFalse(values.contains(id)); values.insert(id); return values.count }
                        peak.withLock { $0 = max($0, size) }
                        while !release.current { try? await Task.sleep(nanoseconds: 2_000_000) }
                        _ = running.withLock { $0.remove(id) }; _ = completed.withLock { $0.insert(id) }
                    }
                }
            }
            release.withLock { $0 = true }
            let finished = await wait { completed.current.count == count }; XCTAssertTrue(finished)
            await queue.finish(); XCTAssertLessThanOrEqual(peak.current, 4)
        }
    }
}
