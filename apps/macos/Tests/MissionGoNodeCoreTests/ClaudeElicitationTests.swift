import XCTest
@testable import MissionGoNodeCore

final class ClaudeElicitationTests: XCTestCase {
    private func request(schema: [String: Any] = ["type": "object", "properties": [String: Any](), "required": [String](), "additionalProperties": false]) throws -> ClaudePermissionRequest {
        try XCTUnwrap(ClaudePermissionRequest(event: ["type": "control_request", "request_id": "form-1", "request": [
            "subtype": "elicitation", "mode": "form", "mcp_server_name": "fixture", "message": "Exact plan and validation goals",
            "requested_schema": schema,
        ]]))
    }

    func testConfirmationUsesItsOwnWireProtocolAndAnExplicitRequestBoundChoice() throws {
        let form = try request()
        XCTAssertNil(form.unsupportedReason)
        XCTAssertEqual(form.question.options, ["批准", "拒绝", "取消"])
        XCTAssertEqual(form.question.detail, "Exact plan and validation goals")
        XCTAssertTrue(form.isStalePermissionAnswer("批准"))
        XCTAssertTrue(form.isStalePermissionAnswer("授权请求 other: 批准"))
        XCTAssertEqual(form.result(answer: "批准")["action"] as? String, "cancel")
        let accepted = form.result(answer: "授权请求 form-1: 批准")
        XCTAssertEqual(accepted["action"] as? String, "accept")
        XCTAssertEqual((accepted["content"] as? [String: String])?.count, 0)
        XCTAssertNil(accepted["behavior"])
        XCTAssertEqual(form.result(answer: "授权请求 form-1: 拒绝")["action"] as? String, "decline")
        XCTAssertEqual(form.result(answer: "授权请求 form-1: 取消")["action"] as? String, "cancel")
        XCTAssertEqual(form.result(answer: "批准", boundRequestId: "form-1")["action"] as? String, "accept")
    }

    func testCannotApproveAnUnrepresentedSchema() throws {
        for schema: [String: Any] in [
            ["type": "object", "properties": ["name": ["type": "string"]]],
            ["type": "object", "properties": [:], "required": ["name"]],
            ["type": "object", "properties": [:], "required": "invalid"],
            ["type": "object", "properties": [:], "minProperties": 1],
        ] {
            let form = try request(schema: schema)
            XCTAssertNotNil(form.unsupportedReason)
            XCTAssertEqual(form.result(answer: "授权请求 form-1: 批准")["action"] as? String, "cancel")
        }
    }

    func testExternalConfirmationUsesTheLocalBridgeAndNeverOffersAWebGrant() throws {
        var snapshot = ClaudeStreamSnapshot(sessionRef: "native")
        snapshot.showExternalPermissionRequest(try request())
        XCTAssertTrue(snapshot.state.messages[0].text.contains("/answer form-1"))
        XCTAssertTrue(snapshot.state.messages[0].text.contains("Exact plan and validation goals"))
        XCTAssertNil(snapshot.state.messages[0].questions)
    }

    func testHostCompletesEachHumanChoiceAndDoesNotMistakeHeartbeatForExecution() async throws {
        for (choice, action) in [("批准", "accept"), ("拒绝", "decline"), ("取消", "cancel")] {
            let host = try SettingsHostFixture(prompt: "elicitation")
            defer { host.stop() }
            try await host.until { try host.state().waitingForInput }
            XCTAssertEqual(try host.state().status, "idle")
            XCTAssertTrue(try host.state().messages.last?.questions?.first?.detail?.contains("validation goals") == true)
            XCTAssertFalse(host.events().contains { $0["type"] as? String == "control_response" })
            try host.put(ClaudeHostCommand(id: "choice", kind: "message", text: "授权请求 mcp-confirm-1: " + choice))
            try await host.until { try !host.state().waitingForInput && host.state().messages.contains { $0.text == action } }
            XCTAssertEqual(try host.state().messages.first { $0.sourceId == "permission-mcp-confirm-1" }?.questions?.first?.answered, choice)
            let replies = host.events().filter { ($0["response"] as? [String: Any])?["request_id"] as? String == "mcp-confirm-1" }
            XCTAssertEqual(replies.count, 1)
        }
    }

    func testSourceCancellationWithdrawsOnlyItsCardAndRejectsItsLateAnswer() async throws {
        let host = try SettingsHostFixture(prompt: "elicitation parallel")
        defer { host.stop() }
        try await host.until { try host.state().messages.first { $0.sourceId == "permission-mcp-confirm-1" }?.questions?.first?.withdrawn == true }
        XCTAssertTrue(try host.state().waitingForInput)
        try host.put(ClaudeHostCommand(id: "old", kind: "message", text: "授权请求 mcp-confirm-1: 批准"))
        try await host.until { try host.state().commandResults["old"]?.status == "failed" }
        XCTAssertFalse(host.events().contains { ($0["response"] as? [String: Any])?["request_id"] as? String == "mcp-confirm-1" })
        try host.put(ClaudeHostCommand(id: "current", kind: "message", text: "授权请求 mcp-confirm-2: 取消"))
        try await host.until { try !host.state().waitingForInput }
    }

    func testUnsupportedFormsAndURLRequestsReturnAnErrorInsteadOfHanging() async throws {
        for prompt in ["elicitation fields", "elicitation url", "elicitation unknown"] {
            let host = try SettingsHostFixture(prompt: prompt)
            defer { host.stop() }
            try await host.until { host.events().contains { ($0["response"] as? [String: Any])?["subtype"] as? String == "error" } }
            XCTAssertFalse(try host.state().waitingForInput)
            try await host.until { try host.state().messages.contains { $0.text.contains("不支持此") } }
        }
    }
}
