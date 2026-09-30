import XCTest
@testable import MissionGoNodeCore

final class AgentSkillSyncTests: XCTestCase {
    private func skill(_ version: String) -> String {
        "---\nname: missiongo\nversion: \(version)\n---\n# Fixture\n"
    }

    private func directory() throws -> URL {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        addTeardownBlock { try? FileManager.default.removeItem(at: root) }
        return root
    }

    func testAlreadyCurrentReadsActualVersionWithoutDownloading() async throws {
        let target = try directory().appendingPathComponent("SKILL.md")
        try skill("5.15.0").write(to: target, atomically: true, encoding: .utf8)
        StubURLProtocol.install { _, _ in .failure(URLError(.notConnectedToInternet)) }
        let result = await SkillSync.check(
            serverUrl: "https://example.test", target: target.path, expectedVersion: "5.15.0",
            session: StubURLProtocol.session()
        )
        XCTAssertEqual(result.localVersion, "5.15.0")
        XCTAssertEqual(result.expectedVersion, "5.15.0")
        XCTAssertEqual(result.syncState, "ready")
        XCTAssertNil(result.reason)
        XCTAssertTrue(StubURLProtocol.recorded.isEmpty)
    }

    func testBackgroundUpgradeAndPartialFailureRecoverIndependently() async throws {
        let root = try directory()
        let good = root.appendingPathComponent("good/SKILL.md")
        let blocked = root.appendingPathComponent("blocked")
        let bad = blocked.appendingPathComponent("SKILL.md")
        try FileManager.default.createDirectory(at: good.deletingLastPathComponent(), withIntermediateDirectories: true)
        try skill("5.14.0").write(to: good, atomically: true, encoding: .utf8)
        try Data("not a directory".utf8).write(to: blocked)
        let remote = skill("5.15.0")
        StubURLProtocol.install { _, _ in .response(status: 200, body: remote) }
        let tracker = AgentSkillSync()
        let goodAttempt = tracker.begin("codex", localVersion: "5.14.0", expectedVersion: "5.15.0")
        let goodResult = await SkillSync.check(
            serverUrl: "https://example.test", target: good.path, expectedVersion: "5.15.0",
            session: StubURLProtocol.session()
        )
        tracker.finish("codex", attempt: goodAttempt, snapshot: goodResult)
        let badAttempt = tracker.begin("claude_code", localVersion: nil, expectedVersion: "5.15.0")
        let badResult = await SkillSync.check(
            serverUrl: "https://example.test", target: bad.path, expectedVersion: "5.15.0",
            session: StubURLProtocol.session()
        )
        tracker.finish("claude_code", attempt: badAttempt, snapshot: badResult)
        XCTAssertEqual(SkillSync.localVersion(at: good.path), "5.15.0")
        XCTAssertEqual(tracker.snapshots["codex"]?.syncState, "ready")
        XCTAssertEqual(tracker.snapshots["claude_code"]?.syncState, "failed")
        XCTAssertFalse(badResult.reason?.isEmpty ?? true)
        XCTAssertNil(badResult.localVersion)

        try FileManager.default.removeItem(at: blocked)
        let retry = tracker.begin("claude_code", localVersion: nil, expectedVersion: "5.15.0")
        let recovered = await SkillSync.check(
            serverUrl: "https://example.test", target: bad.path, expectedVersion: "5.15.0",
            session: StubURLProtocol.session()
        )
        tracker.finish("claude_code", attempt: retry, snapshot: recovered)
        XCTAssertEqual(tracker.snapshots["claude_code"]?.localVersion, "5.15.0")
        XCTAssertEqual(tracker.snapshots["claude_code"]?.syncState, "ready")
        XCTAssertNil(tracker.snapshots["claude_code"]?.reason)
        XCTAssertEqual(tracker.snapshots["codex"], goodResult)
    }

    func testDownloadFailuresPreserveVersionsAndExplainTheCause() async throws {
        let target = try directory().appendingPathComponent("SKILL.md")
        try skill("5.14.0").write(to: target, atomically: true, encoding: .utf8)
        StubURLProtocol.install { _, _ in .response(status: 503, body: "") }
        let failed = await SkillSync.check(
            serverUrl: "https://example.test", target: target.path, expectedVersion: "5.15.0",
            session: StubURLProtocol.session()
        )
        XCTAssertEqual(failed.localVersion, "5.14.0")
        XCTAssertEqual(failed.expectedVersion, "5.15.0")
        XCTAssertEqual(failed.syncState, "failed")
        XCTAssertTrue(failed.reason?.contains("HTTP 503") == true)
    }

    func testProtectedAndNewerFilesDoNotReportFalseSuccess() async throws {
        let root = try directory()
        let target = root.appendingPathComponent("SKILL.md")
        let source = root.appendingPathComponent("source.md")
        try skill("5.14.0").write(to: source, atomically: true, encoding: .utf8)
        try FileManager.default.createSymbolicLink(at: target, withDestinationURL: source)
        let remote = skill("5.15.0")
        StubURLProtocol.install { _, _ in .response(status: 200, body: remote) }
        let linked = await SkillSync.check(
            serverUrl: "https://example.test", target: target.path, expectedVersion: "5.15.0",
            session: StubURLProtocol.session()
        )
        XCTAssertEqual(linked.localVersion, "5.14.0")
        XCTAssertTrue(linked.reason?.contains("符号链接") == true)
        try FileManager.default.removeItem(at: target)
        try skill("5.16.0").write(to: target, atomically: true, encoding: .utf8)
        let newer = await SkillSync.check(
            serverUrl: "https://example.test", target: target.path, expectedVersion: "5.15.0",
            session: StubURLProtocol.session()
        )
        XCTAssertEqual(newer.localVersion, "5.16.0")
        XCTAssertEqual(newer.syncState, "failed")
        XCTAssertTrue(newer.reason?.contains("高于服务端要求") == true)
    }

    func testOldCompletionCannotReplaceRetryOrRestoreDisabledClient() {
        let tracker = AgentSkillSync()
        let old = tracker.begin("codex", localVersion: "5.14.0", expectedVersion: "5.15.0")
        let retry = tracker.begin("codex", localVersion: "5.14.0", expectedVersion: "5.15.0")
        let ready = AgentSkillSnapshot(localVersion: "5.15.0", expectedVersion: "5.15.0", syncState: "ready")
        tracker.finish("codex", attempt: retry, snapshot: ready)
        tracker.finish("codex", attempt: old, snapshot: AgentSkillSnapshot(syncState: "failed", reason: "old error"))
        XCTAssertEqual(tracker.snapshots["codex"], ready)
        XCTAssertFalse(tracker.isCurrent("codex", attempt: old))
        tracker.remove("codex")
        tracker.finish("codex", attempt: retry, snapshot: ready)
        XCTAssertNil(tracker.snapshots["codex"])
        let signedOut = tracker.begin("codex", localVersion: nil, expectedVersion: "5.15.0")
        tracker.invalidateAll()
        XCTAssertFalse(tracker.isCurrent("codex", attempt: signedOut))
        tracker.finish("codex", attempt: signedOut, snapshot: ready)
        XCTAssertTrue(tracker.snapshots.isEmpty)
    }
}
