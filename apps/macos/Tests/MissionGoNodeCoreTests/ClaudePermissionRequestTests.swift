import XCTest
@testable import MissionGoNodeCore

final class ClaudePermissionRequestTests: XCTestCase {
    func testHostHandsPermissionPromptsToItselfOverStdio() {
        // Without a prompt tool Claude Code hides AskUserQuestion/ExitPlanMode
        // and denies every approval, so the flag must never go missing.
        let arguments = ClaudeHostArguments.claude(mode: "plan", sessionName: "M4-AND-131", sessionRef: "s-1", resuming: false)
        let index = try? XCTUnwrap(arguments.firstIndex(of: "--permission-prompt-tool"))
        XCTAssertEqual(index.map { arguments[$0 + 1] }, "stdio")
        XCTAssertEqual(arguments.suffix(2), ["--session-id", "s-1"])
        XCTAssertTrue(arguments.contains("--permission-mode"))
        let denied = try? XCTUnwrap(arguments.firstIndex(of: "--disallowedTools"))
        XCTAssertEqual(
            denied.map { arguments[$0 + 1] },
            "Bash(git reflog expire:*),Bash(git gc --prune=now:*),Bash(git push --force:*),Bash(git push -f:*)"
        )

        let resumed = ClaudeHostArguments.claude(mode: "plan", sessionName: "M4-AND-131", sessionRef: "s-1", resuming: true)
        XCTAssertEqual(resumed.suffix(2), ["--resume", "s-1"])
        XCTAssertTrue(resumed.contains("--permission-prompt-tool"))
    }

    func testModelAndEffortFlagsAppearOnlyWhenChosen() {
        let chosen = ClaudeHostArguments.claude(
            mode: "plan", sessionName: "M4-AND-130", sessionRef: "s-1", resuming: true, model: "opus[1m]", effort: "xhigh"
        )
        let model = try? XCTUnwrap(chosen.firstIndex(of: "--model"))
        XCTAssertEqual(model.map { chosen[$0 + 1] }, "opus[1m]")
        let effort = try? XCTUnwrap(chosen.firstIndex(of: "--effort"))
        XCTAssertEqual(effort.map { chosen[$0 + 1] }, "xhigh")
        // The session flag stays last either way.
        XCTAssertEqual(chosen.suffix(2), ["--resume", "s-1"])

        // Without a choice Claude Code follows the user's own settings.
        let local = ClaudeHostArguments.claude(mode: "plan", sessionName: "M4-AND-130", sessionRef: "s-1", resuming: false)
        XCTAssertFalse(local.contains("--model"))
        XCTAssertFalse(local.contains("--effort"))
    }

    func testReadsCanUseToolRequestsOnly() {
        let request = ClaudePermissionRequest(event: [
            "type": "control_request", "request_id": "r-1",
            "request": [
                "subtype": "can_use_tool", "tool_name": "Bash",
                "input": ["command": "touch a.txt"], "description": "Create a.txt",
            ],
        ])
        XCTAssertEqual(request?.requestId, "r-1")
        XCTAssertEqual(request?.toolName, "Bash")
        XCTAssertNil(ClaudePermissionRequest(event: [
            "type": "control_request", "request_id": "r-2", "request": ["subtype": "interrupt"],
        ]))
    }

    func testApprovalAndDenialForOrdinaryTools() {
        let request = ClaudePermissionRequest(requestId: "r-1", toolName: "Bash", input: ["command": "touch a.txt"])

        let approved = request.result(answer: " 批准 ")
        XCTAssertEqual(approved["behavior"] as? String, "allow")
        XCTAssertEqual((approved["updatedInput"] as? [String: Any])?["command"] as? String, "touch a.txt")

        let refused = request.result(answer: "拒绝")
        XCTAssertEqual(refused["behavior"] as? String, "deny")
        XCTAssertEqual(refused["message"] as? String, "用户拒绝了这次操作。")

        let redirected = request.result(answer: "不要建这个文件，跳过这一步")
        XCTAssertEqual(redirected["behavior"] as? String, "deny")
        XCTAssertEqual(redirected["message"] as? String, "不要建这个文件，跳过这一步")
    }

    func testAskUserQuestionAnswersAreAlwaysAllowed() {
        let request = ClaudePermissionRequest(requestId: "r-1", toolName: "AskUserQuestion", input: [
            "questions": [["question": "Which color?", "header": "Color"]],
        ])
        let result = request.result(answer: "Red")
        XCTAssertEqual(result["behavior"] as? String, "allow")
        let answers = (result["updatedInput"] as? [String: Any])?["answers"] as? [String: String]
        XCTAssertEqual(answers, ["Which color?": "Red"])
    }

    func testPlanApprovalFollowsTheQuestionOptions() {
        let request = ClaudePermissionRequest(requestId: "r-1", toolName: "ExitPlanMode", input: ["plan": "Do it"])
        XCTAssertEqual(request.result(answer: "批准并实施")["behavior"] as? String, "allow")
        XCTAssertEqual(request.result(answer: "继续修改计划")["behavior"] as? String, "deny")
    }

    func testOrdinaryToolIsShownAsAQuestionAndInteractiveToolsAreNot() {
        var snapshot = ClaudeStreamSnapshot(sessionRef: "session-1")
        snapshot.showPermissionRequest(ClaudePermissionRequest(
            requestId: "r-1", toolName: "Bash", input: ["command": "touch a.txt"], description: "Create a.txt"
        ))
        snapshot.showPermissionRequest(ClaudePermissionRequest(
            requestId: "r-1", toolName: "Bash", input: ["command": "touch a.txt"], description: "Create a.txt"
        ))
        snapshot.showPermissionRequest(ClaudePermissionRequest(requestId: "r-2", toolName: "AskUserQuestion", input: [:]))

        XCTAssertEqual(snapshot.state.messages.count, 1)
        let message = snapshot.state.messages[0]
        XCTAssertEqual(message.role, "agent")
        XCTAssertEqual(message.text, "Create a.txt\ntouch a.txt")
        XCTAssertEqual(message.questions, [AgentSessionQuestion(
            header: "授权请求", title: "Claude Code 请求使用 Bash", options: ["批准", "拒绝"]
        )])
    }

    func testLongArgumentsAreClipped() {
        let request = ClaudePermissionRequest(requestId: "r-1", toolName: "Bash", input: ["command": String(repeating: "x", count: 1_000)])
        XCTAssertEqual(request.promptText.count, 301)
        XCTAssertTrue(request.promptText.hasSuffix("…"))
    }

    func testParallelRequestsAreAnsweredOldestFirstAndEachOnce() {
        var queue = ClaudePermissionQueue()
        queue.enqueue(ClaudePermissionRequest(requestId: "r-1", toolName: "Bash", input: [:]))
        queue.enqueue(ClaudePermissionRequest(requestId: "r-2", toolName: "Edit", input: [:]))
        queue.enqueue(ClaudePermissionRequest(requestId: "r-3", toolName: "Write", input: [:]))

        XCTAssertEqual(queue.answerHead("批准")?.requestId, "r-1")
        // r-2 was answered on the claude.ai page.
        XCTAssertTrue(queue.cancel(requestId: "r-2"))
        XCTAssertFalse(queue.cancel(requestId: "r-2"))
        XCTAssertEqual(queue.head?.requestId, "r-3")
        XCTAssertEqual(queue.answerHead("拒绝")?.requestId, "r-3")
        XCTAssertTrue(queue.isEmpty)
        XCTAssertNil(queue.answerHead("批准"))
    }
}
