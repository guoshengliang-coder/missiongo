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

    func testSimulatorPromptKeepsOneTimeApprovalAndOffersAdvertisedLifetimes() throws {
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
            XCTAssertNil(result["_meta"])
            XCTAssertEqual(request.snapshot.options?.map(\.kind), ["once", "session", "always", "decline"])
            XCTAssertTrue(request.result(decision: "decline")["content"] is NSNull)
        }
    }

    func testRequiredHumanCommandNeverOffersRememberedAuthorization() throws {
        let message: [String: Any] = ["id": 9, "method": "item/commandExecution/requestApproval", "params": [
            "threadId": "thread-1", "turnId": "turn-1", "kind": "humanCommand", "command": "git status",
            "availableDecisions": ["accept", "acceptForSession", "decline", "cancel",
                ["acceptWithExecpolicyAmendment": ["execpolicy_amendment": ["git", "status"]]]]]]
        let request = try XCTUnwrap(CodexApprovalRequest(message, threadId: "thread-1"))
        XCTAssertEqual(request.snapshot.options?.map(\.kind), ["once", "decline", "cancel"])
        XCTAssertEqual(request.result(decision: "acceptForSession")["decision"] as? String, "cancel")
    }

    func testMcpPersistenceUsesOnlyAdvertisedLifetimesAndDoesNotEchoMetadata() throws {
        let cases: [(Any?, [String])] = [(nil, []), ("session", ["session"]), ("always", ["always"]),
            (["session", "always", "always"], ["session", "always"]), (true, []), (["unknown"], [])]
        for (advertised, expected) in cases {
            var message = elicitation()
            var params = message["params"] as! [String: Any]
            params["_meta"] = advertised.map { ["persist": $0, "tool_params": ["private": "not-returned"]] } ?? [:]
            message["params"] = params
            let request = try XCTUnwrap(CodexApprovalRequest(message, threadId: "thread-1"))
            XCTAssertEqual(request.snapshot.options?.map(\.kind), ["once"] + expected + ["decline"])
            XCTAssertNil(request.result(decision: "accept")["_meta"])
            XCTAssertNil(request.result(decision: "decline")["_meta"])
            for (scope, decision) in [("session", "acceptForSession"), ("always", "acceptAlways")] {
                let result = request.result(decision: decision)
                if expected.contains(scope) {
                    XCTAssertEqual(result["action"] as? String, "accept")
                    XCTAssertEqual(result["_meta"] as? [String: String], ["persist": scope])
                    XCTAssertTrue((result["content"] as? [String: Any])?.isEmpty == true)
                    XCTAssertNil(result["scope"])
                } else {
                    XCTAssertEqual(result["action"] as? String, "cancel")
                }
            }
        }
    }

    func testMcpWithoutTurnIdStillOffersTheNativeScopes() throws {
        var message = elicitation()
        var params = message["params"] as! [String: Any]
        params["turnId"] = NSNull()
        message["params"] = params
        let request = try XCTUnwrap(CodexApprovalRequest(message, threadId: "thread-1"))
        XCTAssertFalse(request.snapshot.turnId.isEmpty)
        XCTAssertEqual(request.snapshot.options?.map(\.kind), ["once", "session", "always", "decline"])
    }

    func testLegacyAppApprovalPreservesAllNativeLabelsAndAnswerShape() throws {
        for method in ["item/tool/requestUserInput", "tool/requestUserInput"] {
            let message: [String: Any] = ["id": 3, "method": method, "params": [
                "threadId": "thread-1", "turnId": "turn-1", "questions": [[
                    "id": "approval", "question": "Allow app?", "options": [
                        ["label": "Allow once", "description": "This call"],
                        ["label": "Allow for session", "description": "Current session"],
                        ["label": "Always allow", "description": "Remember this tool"],
                        ["label": "Decline", "description": "Do not run"]]]]]]
            let request = try XCTUnwrap(CodexApprovalRequest(message, threadId: "thread-1"))
            XCTAssertEqual(request.snapshot.options?.map(\.label), ["Allow once", "Allow for session", "Always allow", "Decline"])
            let result = request.result(decision: "choice-2")
            XCTAssertEqual(result["answers"] as? [String: [String: [String]]], ["approval": ["answers": ["Always allow"]]])
            XCTAssertNil(result["decision"])
            XCTAssertTrue((request.result(decision: "acceptAlways")["answers"] as? [String: Any])?.isEmpty == true)
        }
    }

    func testNonemptyFormsCannotGainPersistenceEvenWhenMetadataOffersIt() throws {
        let request = try XCTUnwrap(CodexApprovalRequest(elicitation(schema: ["type": "object",
            "properties": ["token": ["type": "string"]]]), threadId: "thread-1"))
        XCTAssertEqual(request.snapshot.status, "unavailable")
        XCTAssertTrue(request.snapshot.options?.isEmpty == true)
        XCTAssertEqual(request.result(decision: "acceptAlways")["action"] as? String, "cancel")
    }

    func testOversizedScopeCannotBeApprovedFromATruncatedPreview() throws {
        let message: [String: Any] = ["id": 3, "method": "item/permissions/requestApproval", "params": [
            "threadId": "thread-1", "turnId": "turn-1", "permissions": ["fileSystem": ["write": [String(repeating: "x", count: 5_000)]]]]]
        XCTAssertEqual(CodexApprovalRequest(message, threadId: "thread-1")?.snapshot.status, "unavailable")
    }

    func testPersistentMcpDecisionTravelsOnOriginalSocket() throws {
        for decision in ["acceptForSession", "acceptAlways"] {
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
            try monitor.answer(threadId: "thread-1", approvalId: approval.id, decision: decision)
            wait { server.received.current.contains { $0.contains("\"_meta\"") } }
            let messages = server.received.current.compactMap { try? JSONSerialization.jsonObject(with: Data($0.utf8)) as? [String: Any] }
            let result = try XCTUnwrap(messages.first { ($0["id"] as? Int) == 900 }?["result"] as? [String: Any])
            XCTAssertEqual(result["_meta"] as? [String: String], ["persist": decision == "acceptAlways" ? "always" : "session"])
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
    private func command(decisions: [Any]? = nil) -> [String: Any] {
        var params: [String: Any] = ["threadId": "thread-1", "turnId": "turn-1", "command": "git status"]
        if let decisions { params["availableDecisions"] = decisions }
        return ["id": 900, "method": "item/commandExecution/requestApproval", "params": params]
    }

    func testCommandOptionsRespectTheNativeListAndUseTheExactProposedRule() throws {
        let rule: [String: Any] = ["acceptWithExecpolicyAmendment": ["execpolicy_amendment": ["git", "status"]]]
        let request = try XCTUnwrap(CodexApprovalRequest(command(decisions: ["accept", "acceptForSession", rule, "decline"]), threadId: "thread-1"))
        XCTAssertEqual(request.snapshot.options?.map(\.id), ["accept", "acceptForSession", "execpolicy-2", "decline"])
        XCTAssertEqual(request.result(decision: "acceptForSession")["decision"] as? String, "acceptForSession")
        let decision = try XCTUnwrap(request.result(decision: "execpolicy-2")["decision"] as? [String: Any])
        XCTAssertEqual((decision["acceptWithExecpolicyAmendment"] as? [String: Any])?["execpolicy_amendment"] as? [String], ["git", "status"])
        XCTAssertEqual(request.snapshot.options?[2].detail, "\"git\" \"status\"")
        let restricted = try XCTUnwrap(CodexApprovalRequest(command(decisions: ["accept", "decline"]), threadId: "thread-1"))
        XCTAssertEqual(restricted.snapshot.options?.map(\.id), ["accept", "decline"])
        XCTAssertEqual(restricted.result(decision: "acceptForSession")["decision"] as? String, "cancel")
        let empty = try XCTUnwrap(CodexApprovalRequest(command(decisions: []), threadId: "thread-1"))
        XCTAssertEqual(empty.snapshot.status, "unavailable")
        XCTAssertEqual(empty.snapshot.options, [])
        let oversized: [String: Any] = ["acceptWithExecpolicyAmendment": ["execpolicy_amendment": [String(repeating: "x", count: 4_001)]]]
        let bounded = try XCTUnwrap(CodexApprovalRequest(command(decisions: ["accept", oversized, "decline"]), threadId: "thread-1"))
        XCTAssertEqual(bounded.snapshot.options?.map(\.id), ["accept", "decline"])
    }

    func testPermissionsSessionGrantContainsOnlyRequestedPermissions() throws {
        let permissions: [String: Any] = ["network": ["enabled": true]]
        let request = try XCTUnwrap(CodexApprovalRequest(["id": 901, "method": "item/permissions/requestApproval",
            "params": ["threadId": "thread-1", "turnId": "turn-1", "permissions": permissions]], threadId: "thread-1"))
        XCTAssertEqual(request.snapshot.options?.map(\.kind), ["turn", "session", "decline"])
        XCTAssertEqual(request.result(decision: "acceptForSession")["scope"] as? String, "session")
        XCTAssertEqual((request.result(decision: "acceptForSession")["permissions"] as? [String: Any])?.keys.sorted(), ["network"])
        XCTAssertEqual((request.result(decision: "decline")["permissions"] as? [String: Any])?.count, 0)
    }

    func testPendingRequestOutlivesPollingAndRejectsAnUnofferedChoice() throws {
        let prompt = command(decisions: ["accept", "acceptForSession", "decline"])
        let server = try FakeAppServer { message in
            guard let id = message["id"], let method = message["method"] as? String else { return [] }
            let response: [String: Any] = ["id": id, "result": [:]]
            return method == "thread/resume" ? [response, prompt] : [response]
        }
        let monitor = CodexApprovalMonitor(idleTimeout: 0.01)
        defer { monitor.stop(threadId: "thread-1"); server.waitUntilDone() }
        monitor.watch(socketPath: server.path, threadId: "thread-1")
        wait { monitor.snapshot(threadId: "thread-1")?.status == "pending" }
        let approval = try XCTUnwrap(monitor.snapshot(threadId: "thread-1"))
        // Cross several receive cycles without touching watch(): equivalent to
        // leaving the page/backgrounding the phone past the old idle limit.
        Thread.sleep(forTimeInterval: 1.2)
        XCTAssertEqual(monitor.snapshot(threadId: "thread-1")?.status, "pending")
        XCTAssertFalse(server.clientClosed.current)
        XCTAssertThrowsError(try monitor.answer(threadId: "thread-1", approvalId: approval.id, decision: "execpolicy-2"))
        try monitor.answer(threadId: "thread-1", approvalId: approval.id, decision: "acceptForSession")
        XCTAssertThrowsError(try monitor.answer(threadId: "thread-1", approvalId: approval.id, decision: "decline"))
        wait { monitor.snapshot(threadId: "thread-1")?.status == "approved" }
        wait { server.received.current.contains { $0.contains("\"decision\":\"acceptForSession\"") } }
    }

    func testTransportLossReconnectsWithoutPollingAndDoesNotReplayTheOldDecision() throws {
        let prompt = command(decisions: ["accept", "acceptForSession", "decline"])
        let respond: @Sendable ([String: Any]) -> [[String: Any]] = { message in
            guard let id = message["id"], let method = message["method"] as? String else { return [] }
            let response: [String: Any] = ["id": id, "result": [:]]
            return method == "thread/resume" ? [response, prompt] : [response]
        }
        let original = try FakeAppServer(respond: respond)
        let monitor = CodexApprovalMonitor(reconnectDelay: 0.1)
        monitor.watch(socketPath: original.path, threadId: "thread-1")
        wait { monitor.snapshot(threadId: "thread-1")?.status == "pending" }
        let old = try XCTUnwrap(monitor.snapshot(threadId: "thread-1"))
        original.disconnectClient()
        original.waitUntilDone()
        wait { monitor.snapshot(threadId: "thread-1")?.status == "reconnecting" }
        XCTAssertThrowsError(try monitor.answer(threadId: "thread-1", approvalId: old.id, decision: "acceptForSession"))
        try FileManager.default.removeItem(atPath: original.path)
        let restored = try FakeAppServer(path: original.path, respond: respond)
        defer { monitor.stop(threadId: "thread-1"); restored.waitUntilDone() }
        wait { monitor.snapshot(threadId: "thread-1")?.status == "pending" && monitor.snapshot(threadId: "thread-1")?.id != old.id }
        XCTAssertThrowsError(try monitor.answer(threadId: "thread-1", approvalId: old.id, decision: "acceptForSession"))
        XCTAssertFalse(restored.received.current.contains { $0.contains("\"decision\"") })
        let fresh = try XCTUnwrap(monitor.snapshot(threadId: "thread-1"))
        try monitor.answer(threadId: "thread-1", approvalId: fresh.id, decision: "acceptForSession")
        wait { monitor.snapshot(threadId: "thread-1")?.status == "approved" }
        wait { restored.received.current.contains { $0.contains("\"decision\":\"acceptForSession\"") } }
    }

    func testNetworkRulesAreOfferedOnlyWhenNativeDecisionsContainThem() throws {
        let rule: [String: Any] = ["applyNetworkPolicyAmendment": ["network_policy_amendment": ["host": "example.test", "action": "allow"]]]
        let request = try XCTUnwrap(CodexApprovalRequest(command(decisions: ["accept", rule, "decline"]), threadId: "thread-1"))
        XCTAssertEqual(request.snapshot.options?.map(\.kind), ["once", "networkAllow", "decline"])
        XCTAssertEqual(request.snapshot.options?[1].detail, "example.test")
        let result = try XCTUnwrap(request.result(decision: "network-1")["decision"] as? [String: Any])
        XCTAssertNotNil(result["applyNetworkPolicyAmendment"])
    }

    func testCompletedTurnClearsAReconnectingRequestThatWasNotReplayed() throws {
        let prompt = command()
        let original = try FakeAppServer { message in
            guard let id = message["id"], let method = message["method"] as? String else { return [] }
            let response: [String: Any] = ["id": id, "result": [:]]
            return method == "thread/resume" ? [response, prompt] : [response]
        }
        let monitor = CodexApprovalMonitor(reconnectDelay: 0.1)
        monitor.watch(socketPath: original.path, threadId: "thread-1")
        wait { monitor.snapshot(threadId: "thread-1")?.status == "pending" }
        original.disconnectClient()
        original.waitUntilDone()
        wait { monitor.snapshot(threadId: "thread-1")?.status == "reconnecting" }
        try FileManager.default.removeItem(atPath: original.path)
        let restored = try FakeAppServer(path: original.path) { message in
            guard let id = message["id"], let method = message["method"] as? String else { return [] }
            let response: [String: Any] = ["id": id, "result": [:]]
            return method == "thread/resume" ? [response, ["method": "turn/completed", "params": ["threadId": "thread-1", "turn": ["id": "turn-1"]]]] : [response]
        }
        defer { monitor.stop(threadId: "thread-1"); restored.waitUntilDone() }
        wait { monitor.snapshot(threadId: "thread-1")?.status == "resolved" }
    }

}
