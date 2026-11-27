import Foundation
import XCTest
@testable import MissionGoNodeCore

final class SessionHealthTests: XCTestCase {
    private let start = Date(timeIntervalSince1970: 1_790_000_010)

    func testPollsAndReplyAcknowledgementsDoNotInventExecutionProgress() throws {
        let tracker = SessionHealthTracker()
        let source = AgentSessionReport(status: "active", messages: [], turnActive: true)
        let first = tracker.observe(source, key: "session", now: start)
        let same = tracker.observe(source, key: "session", now: start.addingTimeInterval(610))
        XCTAssertEqual(first.lastProgressAt, same.lastProgressAt)
        XCTAssertNotEqual(first.observedAt, same.observedAt)
        let reply = AgentSessionReport(status: "active", messages: [], commandId: "new-reply", commandStatus: "delivered", turnActive: true)
        XCTAssertEqual(tracker.observe(reply, key: "session", now: start.addingTimeInterval(620)).lastProgressAt, first.lastProgressAt)
        // A new binding generation gets its own observation window.
        XCTAssertNotEqual(tracker.observe(source, key: "session:generation2", now: start.addingTimeInterval(620)).lastProgressAt, first.lastProgressAt)
    }

    func testRealToolProgressAndLeavingApprovalResetTheObservationWindow() {
        let tracker = SessionHealthTracker()
        let first = AgentSessionReport(status: "active", progressRevision: "revision1", messages: [], turnActive: true)
        let initial = tracker.observe(first, key: "session", now: start)
        let progressed = AgentSessionReport(status: "active", progressRevision: "revision2", messages: [], turnActive: true)
        XCTAssertNotEqual(tracker.observe(progressed, key: "session", now: start.addingTimeInterval(610)).lastProgressAt, initial.lastProgressAt)
        let waiting = AgentSessionReport(status: "active", messages: [], turnActive: true, waitingForInput: true)
        _ = tracker.observe(waiting, key: "session", now: start.addingTimeInterval(620))
        let resumed = tracker.observe(first, key: "session", now: start.addingTimeInterval(2000))
        XCTAssertEqual(resumed.lastProgressAt, SessionLauncher.activityTimestamp(start.addingTimeInterval(2000)))
        let stopped = tracker.observe(AgentSessionReport(status: "idle", messages: [], turnActive: false), key: "session", now: start.addingTimeInterval(2001))
        XCTAssertEqual(stopped.status, "idle")
        XCTAssertEqual(stopped.turnActive, false)
    }

    func testToolOnlyOpenCodeMessagesExposeWaitWithoutLeakingArgumentsOutputOrReasoning() throws {
        func entries(status: String, reasoning: String = "private reasoning", output: String = "private output") -> [[String: Any]] {
            [["id": "assistant", "type": "assistant", "time": ["created": 1_790_000_000_000], "content": [
                ["type": "reasoning", "text": reasoning],
                ["type": "tool", "id": "ci", "name": "shell", "time": ["ran": 1_790_000_000_000],
                 "state": ["status": status, "input": ["command": "gh run watch 123 --token=private-token"],
                           "content": [["type": "text", "text": output]]]]
            ]]]
        }
        let running = NativeExecutionProgress.openCode(entries: entries(status: "running"))
        XCTAssertEqual(running.activities.first?.title, "等待 CI")
        XCTAssertNotNil(running.activities.first?.startedAt)
        XCTAssertEqual(running.revision, NativeExecutionProgress.openCode(entries: entries(status: "running", reasoning: "changed private reasoning")).revision)
        XCTAssertNotEqual(running.revision, NativeExecutionProgress.openCode(entries: entries(status: "running", output: "new longer private output")).revision)
        let report = AgentSessionReport(status: "active", messages: []).reportingExecution(
            activities: running.activities, revision: running.revision, turnStartedAt: running.turnStartedAt, lastOutputAt: running.lastOutputAt)
        let encoded = String(data: try JSONEncoder().encode(report), encoding: .utf8)!
        for secret in ["private-token", "private output", "private reasoning", "gh run watch"] { XCTAssertFalse(encoded.contains(secret)) }
        let complete = NativeExecutionProgress.openCode(entries: entries(status: "completed"))
        XCTAssertTrue(complete.activities.isEmpty)
        XCTAssertNotEqual(running.revision, complete.revision)
        let idle = NativeExecutionProgress.openCode(entries: entries(status: "running") + [["id": "idle", "type": "idle", "time": ["created": 1_790_000_100_000]]])
        XCTAssertTrue(idle.activities.isEmpty)
    }

    func testLatestCodexTurnOwnsTheActiveTurnAndExecutionActivity() throws {
        let result: [String: Any] = ["thread": ["status": ["type": "idle"], "turns": [
            ["id": "old", "status": "inProgress", "items": []],
            ["id": "latest", "status": "completed", "items": []]
        ]]]
        let snapshot = try CodexProtocol.threadSnapshot(fromRead: result)
        XCTAssertEqual(snapshot.status, "idle")
        XCTAssertNil(snapshot.activeTurnId)
        let progress = NativeExecutionProgress.codex(turns: [["id": "latest", "status": "inProgress", "items": [
            ["id": "tool", "type": "commandExecution", "status": "inProgress", "command": "gh run watch 123", "createdAt": 1_790_000_000],
            ["id": "reasoning", "type": "reasoning", "encryptedContent": "private"]
        ]]])
        XCTAssertEqual(progress.activities.first?.title, "等待 CI")
        XCTAssertNotNil(progress.activities.first?.startedAt)
    }

    func testGitHubWaitOnlyUsesSuccessfulStatusResultsAndDoesNotRestampReplays() {
        func snapshot(_ id: String, status: String = "queued", exitCode: Int = 0) -> NativeExecutionProgress {
            NativeExecutionProgress.codex(turns: [["id": "turn", "status": "inProgress", "items": [
                ["id": id, "type": "commandExecution", "status": "completed", "exitCode": exitCode,
                 "command": "gh run view 123 --json status,url",
                 "aggregatedOutput": #"{"status":"\#(status)","url":"https://github.com/example/repo/actions/runs/123"}"#]
            ]]])
        }
        let tracker = SessionHealthTracker()
        func observe(_ progress: NativeExecutionProgress, _ date: Date) -> AgentSessionActivity.Wait? {
            let report = AgentSessionReport(status: "active", messages: []).reportingExecution(
                activities: progress.activities, revision: progress.revision, turnStartedAt: nil, lastOutputAt: nil)
            return tracker.observe(report, key: "session", now: date).activities.first?.wait
        }
        let first = observe(snapshot("check-1"), start)
        XCTAssertEqual(first?.kind, "ci")
        XCTAssertEqual(first?.status, "queued")
        XCTAssertEqual(first?.at, observe(snapshot("check-1"), start.addingTimeInterval(700))?.at)
        XCTAssertNotEqual(first?.at, observe(snapshot("check-2", status: "in_progress"), start.addingTimeInterval(701))?.at)
        XCTAssertTrue(snapshot("check-3", status: "completed").activities.isEmpty)
        XCTAssertTrue(snapshot("check-3", exitCode: 1).activities.isEmpty)
    }

    func testWatchOnlyRefreshesFromNewCompleteFrames() {
        let command = "gh run watch 123 --repo example/repo"
        func activities(_ command: String, _ output: String) -> [AgentSessionActivity] {
            NativeExecutionProgress.codex(turns: [["status": "inProgress", "items": [
                ["type": "commandExecution", "status": "inProgress", "id": "watch", "command": command, "aggregatedOutput": output]
            ]]]).activities
        }
        let marker = "Refreshing run status every 3 seconds. Press Ctrl+C to quit.\n\n"
        let frame = marker + "* main Checks · 123\n"
        XCTAssertEqual(activities(command, marker).first?.wait?.kind, "tool")
        XCTAssertEqual(activities(command + " | cat", frame).first?.wait?.kind, "tool")
        let tracker = SessionHealthTracker()
        func observe(_ activities: [AgentSessionActivity], after: TimeInterval) -> AgentSessionActivity.Wait? {
            let report = AgentSessionReport(status: "active", messages: [], activities: activities, turnActive: true)
            return tracker.observe(report, key: "watch", now: start.addingTimeInterval(after)).activities.first?.wait
        }
        let first = observe(activities(command, frame), after: 0)
        XCTAssertEqual(first?.url, "https://github.com/example/repo/actions/runs/123")
        _ = observe([], after: 300)
        XCTAssertEqual(first?.at, observe(activities(command, frame), after: 610)?.at)
        XCTAssertNotEqual(first?.at, observe(activities(command, frame + frame), after: 611)?.at)
    }

    func testCodexNativeUserInputWaitIsExplicitlyRecognized() throws {
        let snapshot = try CodexProtocol.threadSnapshot(fromRead: ["thread": [
            "status": ["type": "active", "activeFlags": ["waitingOnUserInput"]],
            "turns": [["id": "current", "status": "inProgress", "items": []]]
        ]])
        XCTAssertTrue(snapshot.waitingOnUserInput)
        XCTAssertFalse(snapshot.waitingOnApproval)
    }

    func testReportTransformationsPreserveObservationClocks() {
        let report = AgentSessionReport(status: "active", messages: [])
            .reportingObservation(observedAt: "observed", lastProgressAt: "progress")
            .reportingSettings(model: nil, effort: nil, settingsRevision: nil, settingsError: nil)
            .reportingApproval(nil).replacingMessages([])
        XCTAssertEqual(report.observedAt, "observed")
        XCTAssertEqual(report.lastProgressAt, "progress")
    }
}
