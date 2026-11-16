import XCTest
import CryptoKit
@testable import MissionGoNodeCore

final class DevelopmentReviewsTests: XCTestCase {
    func testExactSessionPrivateIndexAndUploadPreservation() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        defer { try? FileManager.default.removeItem(at: root) }
        func write(_ name: String, _ value: Any) throws {
            let url = root.appendingPathComponent(name + ".json")
            try JSONSerialization.data(withJSONObject: value).write(to: url)
            try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
        }
        let key = SHA256.hash(data: Data("codex:native".utf8)).map { String(format: "%02x", $0) }.joined()
        try write("session-" + key, ["task"])
        let binding: [String: Any] = ["agentKind": "codex", "sessionRef": "native", "requestId": "human", "scopeDigest": String(repeating: "a", count: 64), "base": String(repeating: "b", count: 40), "requiredChecks": ["behavior"]]
        try write("task", ["version": 1, "taskId": "task", "binding": binding, "revision": 4, "generation": 2,
            "status": "passed", "rounds": [["result": ["findings": [], "limitations": []]]],
            "checks": [["name": "behavior", "result": "passed", "method": "node test.mjs", "evidence": "exit=0; outputSha256=fixture"]]])
        let reviews = try XCTUnwrap(LocalDevelopmentReviews.read(agentKind: "codex", sessionRef: "native", root: root))
        XCTAssertEqual(reviews.count, 1); XCTAssertTrue(reviews[0].checksPassed); XCTAssertEqual(reviews[0].round, 1)
        XCTAssertTrue(reviews[0].checks?.first?.method.hasPrefix("local validation; argvSha256=") == true)
        XCTAssertFalse(reviews[0].checks?.first?.method.contains("node test.mjs") == true)
        XCTAssertEqual(reviews[0].requiredChecks, ["behavior"])
        XCTAssertNil(LocalDevelopmentReviews.read(agentKind: "codex", sessionRef: "unrelated", root: root))
        let report = AgentSessionReport(status: "idle", messages: []).reportingDevelopmentReviews(reviews)
        XCTAssertEqual(try APIClient.uploadableSnapshot(report).developmentReviews, reviews)
        try write("task", ["version": 2])
        XCTAssertEqual(LocalDevelopmentReviews.read(agentKind: "codex", sessionRef: "native", root: root)?[0].status, "incomplete")
    }
}
