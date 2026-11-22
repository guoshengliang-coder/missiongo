import XCTest
import Foundation
import Darwin
@testable import MissionGoNodeCore

final class CodexWriterProbeTests: XCTestCase {
    func testProbeNeverCreatesOrDeletesLockAndRejectsUnsafeIdentity() throws {
        let home = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: home, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: home) }
        let id = UUID().uuidString
        XCTAssertEqual(CodexWriterProbe.state(codexHome: home.path, threadId: id, runtimeStatus: "notLoaded"), "ready")
        XCTAssertFalse(FileManager.default.fileExists(atPath: home.appendingPathComponent("thread-writer-locks").path))
        XCTAssertEqual(CodexWriterProbe.state(codexHome: home.path, threadId: "../other", runtimeStatus: "idle"), "unknown")
        XCTAssertEqual(CodexWriterProbe.state(codexHome: home.path, threadId: id, runtimeStatus: nil), "unknown")
        XCTAssertEqual(CodexWriterProbe.state(codexHome: home.path, threadId: id, runtimeStatus: "active"), "unknown")
    }
    func testHeldLockAndReleaseAreObservedWithoutResumingAThread() throws {
        let home = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        let locks = home.appendingPathComponent("thread-writer-locks")
        try FileManager.default.createDirectory(at: locks, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: home) }
        let id = UUID().uuidString, path = locks.appendingPathComponent(id + ".lock").path
        let fd = open(path, O_CREAT | O_RDWR, 0o600)
        XCTAssertGreaterThanOrEqual(fd, 0)
        defer { close(fd) }
        XCTAssertEqual(flock(fd, LOCK_EX | LOCK_NB), 0)
        XCTAssertEqual(CodexWriterProbe.state(codexHome: home.path, threadId: id, runtimeStatus: "notLoaded"), "occupied")
        XCTAssertEqual(CodexWriterProbe.state(codexHome: home.path, threadId: id, runtimeStatus: "idle"), "ready")
        XCTAssertEqual(flock(fd, LOCK_UN), 0)
        XCTAssertEqual(CodexWriterProbe.state(codexHome: home.path, threadId: id, runtimeStatus: "notLoaded"), "ready")
        XCTAssertTrue(FileManager.default.fileExists(atPath: path))
        XCTAssertEqual(CodexWriterProbe.state(codexHome: home.path, threadId: id, runtimeStatus: "idle", archived: true), "unknown")
    }
    func testReadinessSurvivesObservationAndEncodesSeparatelyFromDelivery() throws {
        let report = AgentSessionReport(status: "idle", messages: []).reportingReplyReadiness(CodexReplyReadiness(state: "occupied"))
            .replacingMessages([]).reportingSettings(model: nil, effort: nil, settingsRevision: nil, settingsError: nil)
            .reportingApproval(nil).reportingObservation(observedAt: "2026-11-22T00:00:00Z", lastProgressAt: "2026-11-21T00:00:00Z")
        let json = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(report)) as? [String: Any])
        XCTAssertEqual((json["replyReadiness"] as? [String: Any])?["state"] as? String, "occupied")
        XCTAssertNil(json["commandId"])
        XCTAssertNil(json["commandStatus"])
    }
}
