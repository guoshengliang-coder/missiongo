import XCTest
@testable import MissionGoNodeCore

final class ConsolePerformanceTests: XCTestCase {
    func testExactNewTurnProducesOneDurationAndOldOutputNeverCompletesIt() {
        let observer = ConsolePerformanceObserver()
        let idle = NodeAgentSession(id: "session", sessionRef: "thread", status: "idle")
        _ = observer.observe(idle, report: .init(status: "idle", messages: [.init(sourceId: "old", turnId: "old-turn", role: "agent", text: "private")]), now: 1)
        let session = NodeAgentSession(id: "session", sessionRef: "thread", status: "active", command: .init(id: "command", text: "private", status: "delivering"))
        observer.begin(session, now: 10)
        let delivery = observer.observe(session, report: .init(status: "active", messages: [.init(sourceId: "command", turnId: "new-turn", role: "user", text: "private"), .init(sourceId: "old", turnId: "old-turn", role: "agent", text: "private")], commandId: "command", commandStatus: "delivered"), now: 12)
        XCTAssertEqual(delivery.first?.events.first?.durationMs, 2000)
        XCTAssertFalse(delivery.flatMap(\.events).contains { $0.stage == "agent_first_output" })
        let response = AgentSessionReport(status: "active", messages: [.init(sourceId: "reply", turnId: "new-turn", role: "agent", text: "private")])
        let first = observer.observe(session, report: response, now: 15)
        XCTAssertEqual(first.first?.events.first?.durationMs, 5000)
        XCTAssertTrue(observer.observe(session, report: response, now: 16).isEmpty)
    }
    func testMissingBaselineAndOtherAgentsRemainExplicitlyUncorrelated() throws {
        for kind in ["codex", "opencode"] {
            let observer = ConsolePerformanceObserver()
            let session = NodeAgentSession(id: "session", agentKind: kind, sessionRef: "thread", status: "active", command: .init(id: "command", text: "private", status: "delivering"))
            observer.begin(session, now: 10)
            let reports = observer.observe(session, report: .init(status: "active", messages: [], commandId: "command", commandStatus: "delivered"), now: 11)
            XCTAssertTrue(reports.flatMap(\.events).contains { $0.result == "uncorrelated" })
            let encoded = String(data: try JSONEncoder().encode(reports), encoding: .utf8)!
            XCTAssertFalse(encoded.contains("thread"))
        }
    }
    func testClaudeUsesTheExactCommandUUIDWithoutGuessingFromText() {
        let observer = ConsolePerformanceObserver()
        let session = NodeAgentSession(id: "session", agentKind: "claude_code", sessionRef: "thread", status: "active", command: .init(id: "command", text: "private", status: "delivering"))
        observer.begin(session, now: 10)
        let reports = observer.observe(session, report: .init(status: "active", messages: [
            .init(sourceId: "command", turnId: "command", role: "user", text: "private"),
            .init(sourceId: "reply", turnId: "command", role: "agent", text: "private")
        ], commandId: "command", commandStatus: "delivered"), now: 12)
        XCTAssertEqual(reports.first?.turnId, "command")
        XCTAssertTrue(reports.flatMap(\.events).contains { $0.stage == "agent_first_output" })
    }

    func testCompletedObservationsDoNotExhaustTheNodeAfter256Commands() {
        let observer = ConsolePerformanceObserver()
        var count = 0
        for index in 0..<300 {
            let id = "command-\(index)"
            let session = NodeAgentSession(id: "session", sessionRef: "thread", status: "active", command: .init(id: id, text: "private", status: "delivering"))
            observer.begin(session, now: Double(index))
            count += observer.observe(session, report: .init(status: "active", messages: [], commandId: id, commandStatus: "delivered"), now: Double(index)+0.1).count
        }
        XCTAssertEqual(count, 300)
    }

}
