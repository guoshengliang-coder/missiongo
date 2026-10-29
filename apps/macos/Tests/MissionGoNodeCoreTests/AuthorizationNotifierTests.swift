import XCTest

@testable import MissionGoNodeCore

/// AND-306: when the machine's own read of an agent's authorization deserves
/// to interrupt the person, and how loudly.
final class AuthorizationNotifierTests: XCTestCase {
    private func snapshot(_ state: String, expiresIn seconds: Double? = nil) -> McpAuthSnapshot {
        McpAuthSnapshot(
            state: state,
            expiresAt: seconds.map { Date().addingTimeInterval($0) },
            checkedAt: Date()
        )
    }

    func testDeadIsCriticalAndHealthyStaysQuiet() {
        XCTAssertNil(AuthorizationNoticeScheduler.notice(for: "opencode", snapshot: nil))
        XCTAssertNil(AuthorizationNoticeScheduler.notice(for: "opencode", snapshot: snapshot("valid", expiresIn: 90 * 86_400)))
        XCTAssertNil(AuthorizationNoticeScheduler.notice(for: "opencode", snapshot: snapshot("unknown")))

        let dead = AuthorizationNoticeScheduler.notice(for: "opencode", snapshot: snapshot("invalid"))
        XCTAssertEqual(dead?.level, .critical)
        XCTAssertEqual(dead?.agentName, "OpenCode")
        XCTAssertTrue(dead?.body.contains("中断") == true)
    }

    /// The window decides the volume: days left is a warning, the final day
    /// is critical because the next dispatch breaks.
    func testExpiringSplitsIntoWarningAndCritical() {
        let days = AuthorizationNoticeScheduler.notice(for: "codex", snapshot: snapshot("expiring", expiresIn: 5 * 86_400))
        XCTAssertEqual(days?.level, .warning)
        XCTAssertEqual(days?.daysLeft, 5)

        let hours = AuthorizationNoticeScheduler.notice(for: "codex", snapshot: snapshot("expiring", expiresIn: 10 * 3_600))
        XCTAssertEqual(hours?.level, .critical)

        // Expiring without a readable date cannot be graded; stay quiet rather
        // than guess.
        XCTAssertNil(AuthorizationNoticeScheduler.notice(for: "codex", snapshot: snapshot("expiring")))
    }

    /// A 30-second heartbeat must not repeat the same warning all day.
    func testGateSendsOncePerAgentAndLevelPerDay() {
        let store = MemoryNoticeStore()
        let now = Date(timeIntervalSince1970: 1_800_000_000)
        XCTAssertTrue(AuthorizationNoticeGate.shouldSend(level: .warning, agentKind: "opencode", now: now, store: store))
        XCTAssertFalse(AuthorizationNoticeGate.shouldSend(level: .warning, agentKind: "opencode", now: now.addingTimeInterval(60), store: store))
        // Another level or another agent is a different conversation.
        XCTAssertTrue(AuthorizationNoticeGate.shouldSend(level: .critical, agentKind: "opencode", now: now.addingTimeInterval(60), store: store))
        XCTAssertTrue(AuthorizationNoticeGate.shouldSend(level: .warning, agentKind: "codex", now: now.addingTimeInterval(60), store: store))
        // A day later the same warning may speak again.
        XCTAssertTrue(AuthorizationNoticeGate.shouldSend(level: .warning, agentKind: "opencode", now: now.addingTimeInterval(AuthorizationNoticeGate.repeatInterval + 1), store: store))
    }
}

private final class MemoryNoticeStore: AuthorizationNoticeStore, @unchecked Sendable {
    private var sent: [String: Date] = [:]
    private let lock = NSLock()

    func lastSent(at key: String) -> Date? {
        lock.lock(); defer { lock.unlock() }
        return sent[key]
    }

    func markSent(at key: String, now: Date) {
        lock.lock(); defer { lock.unlock() }
        sent[key] = now
    }
}
