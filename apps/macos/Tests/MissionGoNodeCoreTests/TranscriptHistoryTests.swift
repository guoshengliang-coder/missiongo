import XCTest
@testable import MissionGoNodeCore

final class TranscriptHistoryTests: XCTestCase {
    func testContinuationKeepsAnchorWhenNewMessagesArrive() throws {
        var messages = (0..<121).map { AgentSessionMessage(sourceId: "id-\($0)", role: "agent", text: "方案 🧑‍💻 \($0)") }
        let recent = try TranscriptHistory.page(messages)
        messages.append(AgentSessionMessage(sourceId: "new", role: "agent", text: "New"))
        let older = try TranscriptHistory.page(messages, cursor: recent.nextCursor)
        let oldest = try TranscriptHistory.page(messages, cursor: older.nextCursor)
        XCTAssertEqual((oldest.messages + older.messages + recent.messages).map(\.sourceId), Array(messages.dropLast()).map(\.sourceId))
        XCTAssertNil(oldest.nextCursor)
        messages[0] = AgentSessionMessage(sourceId: "id-0", role: "agent", text: "Changed earlier body")
        XCTAssertThrowsError(try TranscriptHistory.page(messages, cursor: recent.nextCursor))
        XCTAssertThrowsError(try TranscriptHistory.page(messages, cursor: "transcript:foreign"))
        XCTAssertThrowsError(try TranscriptHistory.page(messages, cursor: "arbitrary"))
    }
}
