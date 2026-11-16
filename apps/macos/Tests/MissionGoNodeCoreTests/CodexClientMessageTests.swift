import XCTest
@testable import MissionGoNodeCore

final class CodexClientMessageTests: XCTestCase {
    func testKeepsNativeIdentityAndClientIdentitySeparate() throws {
        let snapshot = try CodexProtocol.threadSnapshot(fromRead: ["thread": ["status": ["type": "idle"], "turns": [[
            "id": "turn", "items": [["id": "native-user", "type": "userMessage", "clientId": "command",
                "content": [["type": "text", "text": "Continue"]]]]
        ]]]])
        let message = try XCTUnwrap(snapshot.messages.first)
        XCTAssertEqual(message.sourceId, "native-user")
        let encoded = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(message)) as? [String: Any])
        XCTAssertEqual(encoded["clientMessageId"] as? String, "command")
        let report = try APIClient.uploadableSnapshot(AgentSessionReport(status: "idle", messages: [message]))
        XCTAssertEqual(report.messages.first?.clientMessageId, "command")
        let page = try TranscriptHistory.page(snapshot.messages)
        XCTAssertEqual(page.messages.first?.clientMessageId, "command")
    }
}
