import XCTest
@testable import MissionGoNodeCore

final class CodexApprovalTests: XCTestCase {
    private func elicitation(id: Any = 900, mode: String = "form", schema: [String: Any] = ["type": "object", "properties": [:]]) -> [String: Any] {
        ["jsonrpc": "2.0", "id": id, "method": "mcpServer/elicitation/request", "params": [
            "threadId": "thread-1", "turnId": "turn-1", "serverName": "cua_repl", "mode": mode,
            "message": "Allow Computer Use to use \"Simulator\"?", "requestedSchema": schema,
            "_meta": ["persist": ["session", "always"], "tool_name": "get_app_state",
                      "tool_params": ["app": "com.apple.iphonesimulator"]]
        ]]
    }

    func testSimulatorPromptHasNoItemIdOrTimestampAndOnlyGrantsOneRequest() throws {
        for mode in ["form", "openai/form"] {
            let request = try XCTUnwrap(CodexApprovalRequest(elicitation(mode: mode), threadId: "thread-1"))
            XCTAssertEqual(request.snapshot.status, "pending")
            XCTAssertTrue(request.snapshot.action.contains("Simulator"))
            XCTAssertTrue(request.snapshot.startedAtMs > 0)
            let result = request.result(decision: "accept")
            XCTAssertEqual(result["action"] as? String, "accept")
            XCTAssertEqual((result["content"] as? [String: Any])?.count, 0)
            XCTAssertNil(result["scope"])
            XCTAssertNil(result["persist"])
            XCTAssertTrue(request.result(decision: "decline")["content"] is NSNull)
        }
    }

    func testNonemptyFormsAndURLFlowsCannotBeApprovedWithEmptyContent() throws {
        for (mode, schema) in [
            ("url", ["type": "object"]),
            ("form", ["type": "object", "properties": ["token": ["type": "string"]]]),
            ("form", ["type": "object", "required": ["confirmed"]]),
            ("form", ["type": "object", "oneOf": [["required": ["confirmed"]]]]),
            ("form", ["type": "object", "required": "malformed"])
        ] as [(String, [String: Any])] {
            let request = try XCTUnwrap(CodexApprovalRequest(elicitation(mode: mode, schema: schema), threadId: "thread-1"))
            XCTAssertEqual(request.snapshot.status, "unavailable")
            XCTAssertNotNil(request.snapshot.reason)
        }
    }

    func testOrdinaryApprovalsDoNotRequireUndocumentedTimestampAndReconnectHasANewIdentity() throws {
        let message: [String: Any] = ["id": 900, "method": "item/commandExecution/requestApproval", "params": [
            "threadId": "thread-1", "turnId": "turn-1", "itemId": "item-1", "command": "echo fixture"
        ]]
        let first = try XCTUnwrap(CodexApprovalRequest(message, threadId: "thread-1"))
        let reconnected = try XCTUnwrap(CodexApprovalRequest(message, threadId: "thread-1"))
        XCTAssertEqual(first.snapshot.status, "pending")
        XCTAssertNotEqual(first.snapshot.id, reconnected.snapshot.id)
        XCTAssertTrue(first.matches(rpcId: 900))
        XCTAssertFalse(first.matches(rpcId: "900"))
        XCTAssertNil(CodexApprovalRequest(message, threadId: "another-thread"))
        XCTAssertEqual(first.result(decision: "accept")["decision"] as? String, "accept")
    }

    private func wait(_ condition: () -> Bool, file: StaticString = #filePath, line: UInt = #line) {
        let deadline = Date().addingTimeInterval(4)
        while !condition() && Date() < deadline { usleep(10_000) }
        XCTAssertTrue(condition(), file: file, line: line)
    }

    func testSimulatorAnswerTravelsOnOriginalSocketAndNoPermanentGrantIsAdded() throws {
        let prompt = elicitation()
        let server = try FakeAppServer { message in
            guard let id = message["id"], let method = message["method"] as? String else { return [] }
            let response: [String: Any] = ["id": id, "result": [:]]
            return method == "thread/resume" ? [response, prompt] : [response]
        }
        let monitor = CodexApprovalMonitor()
        defer { monitor.stop(threadId: "thread-1"); server.waitUntilDone() }
        monitor.watch(socketPath: server.path, threadId: "thread-1")
        wait { monitor.snapshot(threadId: "thread-1")?.status == "pending" }
        let approval = try XCTUnwrap(monitor.snapshot(threadId: "thread-1"))
        try monitor.answer(threadId: "thread-1", approvalId: approval.id, decision: "accept")
        wait { monitor.snapshot(threadId: "thread-1")?.status == "approved" }
        // Publishing the local state follows the socket write, but the fake
        // server receives that frame on another queue. Wait for both ends.
        wait { server.received.current.contains { $0.contains("\"action\":\"accept\"") } }
        let messages = server.received.current.compactMap { try? JSONSerialization.jsonObject(with: Data($0.utf8)) as? [String: Any] }
        let answer = try XCTUnwrap(messages.first { $0["method"] == nil && ($0["id"] as? Int) == 900 })
        let result = try XCTUnwrap(answer["result"] as? [String: Any])
        XCTAssertEqual(result["action"] as? String, "accept")
        XCTAssertTrue((result["content"] as? [String: Any])?.isEmpty == true)
        XCTAssertNil(result["persist"])
        XCTAssertThrowsError(try monitor.answer(threadId: "thread-1", approvalId: approval.id, decision: "accept"))
    }

    func testMultipleRequestsAreNotOverwrittenAndStopCancelsRemainingRequest() throws {
        let first = elicitation(id: 900), second = elicitation(id: "second")
        let server = try FakeAppServer { message in
            guard let id = message["id"], let method = message["method"] as? String else { return [] }
            let response: [String: Any] = ["id": id, "result": [:]]
            return method == "thread/resume" ? [response, first, second] : [response]
        }
        let monitor = CodexApprovalMonitor()
        defer { monitor.stop(threadId: "thread-1"); server.waitUntilDone() }
        monitor.watch(socketPath: server.path, threadId: "thread-1")
        wait { monitor.snapshot(threadId: "thread-1")?.status == "pending" }
        let approval = try XCTUnwrap(monitor.snapshot(threadId: "thread-1"))
        try monitor.answer(threadId: "thread-1", approvalId: approval.id, decision: "decline")
        wait { let next = monitor.snapshot(threadId: "thread-1"); return next?.status == "pending" && next?.id != approval.id }
        monitor.cancel(threadId: "thread-1", turnId: "turn-1")
        wait { monitor.snapshot(threadId: "thread-1")?.status == "denied" }
        wait { server.received.current.contains { $0.contains("\"action\":\"cancel\"") } }
        let answers = server.received.current.compactMap { try? JSONSerialization.jsonObject(with: Data($0.utf8)) as? [String: Any] }.filter { $0["method"] == nil }
        XCTAssertEqual(answers.count, 2)
        XCTAssertEqual((answers.last?["result"] as? [String: Any])?["action"] as? String, "cancel")
    }

    func testResolvedPromptCannotBeAnsweredByAnOldConsoleDecision() throws {
        let prompt = elicitation()
        let server = try FakeAppServer { message in
            guard let id = message["id"], let method = message["method"] as? String else { return [] }
            let response: [String: Any] = ["id": id, "result": [:]]
            return method == "thread/resume" ? [response, prompt,
                ["method": "serverRequest/resolved", "params": ["threadId": "thread-1", "requestId": 900]]] : [response]
        }
        let monitor = CodexApprovalMonitor()
        defer { monitor.stop(threadId: "thread-1"); server.waitUntilDone() }
        monitor.watch(socketPath: server.path, threadId: "thread-1")
        wait { monitor.snapshot(threadId: "thread-1")?.status == "resolved" }
        let old = try XCTUnwrap(monitor.snapshot(threadId: "thread-1"))
        XCTAssertThrowsError(try monitor.answer(threadId: "thread-1", approvalId: old.id, decision: "accept"))
        XCTAssertFalse(server.received.current.contains { $0.contains("\"action\":\"accept\"") })
    }

    func testReconnectToIdleClearsAPromptThatWasResolvedWhileDisconnected() throws {
        let prompt = elicitation()
        let original = try FakeAppServer { message in
            guard let id = message["id"], let method = message["method"] as? String else { return [] }
            let response: [String: Any] = ["id": id, "result": [:]]
            return method == "thread/resume" ? [response, prompt] : [response]
        }
        let monitor = CodexApprovalMonitor()
        monitor.watch(socketPath: original.path, threadId: "thread-1")
        wait { monitor.snapshot(threadId: "thread-1")?.status == "pending" }
        let old = try XCTUnwrap(monitor.snapshot(threadId: "thread-1"))
        monitor.stop(threadId: "thread-1")
        wait { monitor.snapshot(threadId: "thread-1")?.status == "unavailable" }
        original.waitUntilDone()
        let restored = try FakeAppServer { message in
            guard let id = message["id"], let method = message["method"] as? String else { return [] }
            let result: [String: Any] = method == "thread/resume"
                ? ["thread": ["id": "thread-1", "status": ["type": "idle"]]] : [:]
            return [["id": id, "result": result]]
        }
        defer { monitor.stop(threadId: "thread-1"); restored.waitUntilDone() }
        monitor.watch(socketPath: restored.path, threadId: "thread-1")
        wait { monitor.snapshot(threadId: "thread-1")?.status == "resolved" }
        XCTAssertThrowsError(try monitor.answer(threadId: "thread-1", approvalId: old.id, decision: "accept"))
    }
}
