import XCTest
@testable import MissionGoNodeCore

final class DispatchPermissionsTests: XCTestCase {
    func testDistinctDispatchesReserveDistinctPathsWithoutCreatingThem() throws {
        let root = try shortTemporaryDirectory()
        let repo = root + "/repo"
        let first = try CodexWorkspace.worktreePath(repoPath: repo, dispatchId: "batch-1")
        let second = try CodexWorkspace.worktreePath(repoPath: repo, dispatchId: "batch-2")
        XCTAssertNotEqual(first, second)
        XCTAssertEqual(URL(fileURLWithPath: first).deletingLastPathComponent(), URL(fileURLWithPath: repo).deletingLastPathComponent())
        XCTAssertFalse(FileManager.default.fileExists(atPath: first))
        for id in ["../escape", "x/y", "id\n", String(repeating: "x", count: 101)] {
            XCTAssertThrowsError(try CodexWorkspace.worktreePath(repoPath: repo, dispatchId: id))
        }
    }

    func testExistingDirtyDirectoryAndDanglingSymlinkAreNeverGranted() throws {
        let root = try shortTemporaryDirectory()
        let repo = root + "/repo"
        let existing = try CodexWorkspace.worktreePath(repoPath: repo, dispatchId: "existing")
        try FileManager.default.createDirectory(atPath: existing, withIntermediateDirectories: true)
        let file = existing + "/uncommitted.txt"
        try Data("unfinished".utf8).write(to: URL(fileURLWithPath: file))
        XCTAssertThrowsError(try CodexWorkspace.worktreePath(repoPath: repo, dispatchId: "existing"))
        XCTAssertEqual(try String(contentsOfFile: file), "unfinished")
        let link = try CodexWorkspace.worktreePath(repoPath: repo, dispatchId: "link")
        try FileManager.default.createSymbolicLink(atPath: link, withDestinationPath: root + "/absent")
        XCTAssertThrowsError(try CodexWorkspace.worktreePath(repoPath: repo, dispatchId: "link"))
    }

    func testUnconfirmedPoliciesNeverStartTheFirstTurn() async throws {
        for mismatch in ["reviewer", "missingReviewer", "roots", "sandbox", "policy"] {
            let server = try FakeAppServer { message in
                guard let id = message["id"] else { return [] }
                var result: [String: Any] = [:]
                if message["method"] as? String == "thread/start" {
                    result = [
                        "thread": ["id": "test-thread"], "cwd": "/repo",
                        "approvalPolicy": "on-request", "approvalsReviewer": "auto_review",
                        "runtimeWorkspaceRoots": ["/repo", "/worktree"],
                        "sandbox": ["type": "workspaceWrite", "writableRoots": ["/worktree"]],
                    ]
                    switch mismatch {
                    case "reviewer": result["approvalsReviewer"] = "user"
                    case "missingReviewer": result.removeValue(forKey: "approvalsReviewer")
                    case "roots": result["sandbox"] = ["type": "workspaceWrite", "writableRoots": ["/"]]
                    case "sandbox": result["sandbox"] = ["type": "dangerFullAccess"]
                    default: result["approvalPolicy"] = "never"
                    }
                }
                return [["id": id, "result": result]]
            }
            do {
                _ = try await CodexAppServerControl(timeout: 3).startThread(CodexThreadRequest(
                    socketPath: server.path, cwd: "/repo", settings: CodexModes.threadSettings(for: "plan")!,
                    name: "test", prompt: "test", workspaceRoots: ["/repo", "/worktree"]
                ))
                XCTFail("Expected rejection: \(mismatch)")
            } catch {
                XCTAssertTrue(error.localizedDescription.contains("尚未启动任务"), error.localizedDescription)
            }
            server.waitUntilDone()
            XCTAssertFalse(server.methods.contains("turn/start"), mismatch)
            XCTAssertTrue(server.methods.contains("thread/archive"), mismatch)
        }
    }

    func testAllClaudeModesKeepTheirNativePermissionArgument() throws {
        for mode in ["plan", "default", "acceptEdits", "auto"] {
            let command = try SessionLauncher.launchCommand(sessionName: "test", mode: mode, prompt: "test")
            let index = try XCTUnwrap(command.args.firstIndex(of: "--permission-mode"))
            XCTAssertEqual(command.args[index + 1], mode)
            XCTAssertFalse(command.args.contains("auto_review"))
            XCTAssertFalse(command.args.contains("--add-dir"))
        }
    }

    func testReadOnlyAndStaleMcpConnectionsNeverStartWork() async throws {
        let invalidAccounts: [[String: Any]] = [
            ["capabilities": ["canComment": false, "writeTools": []]],
            ["capabilities": ["canComment": true, "writeTools": ["append_comment"]]],
            ["capabilities": ["canComment": true, "writeTools": ["append_comment", "claim_item"]], "skill": ["expectedVersion": "5.7.0"]],
        ]
        for account in invalidAccounts {
            let server = try FakeAppServer.happy(accountResult: ["structuredContent": account])
            do {
                _ = try await CodexAppServerControl(timeout: 3).startThread(CodexThreadRequest(
                    socketPath: server.path, cwd: "/repo", settings: CodexModes.threadSettings(for: "plan")!,
                    name: "test", prompt: "test", skillVersion: "5.8.0"
                ))
                XCTFail("Expected preflight rejection")
            } catch {
                XCTAssertTrue(error.localizedDescription.contains("尚未启动任务"), error.localizedDescription)
            }
            server.waitUntilDone()
            XCTAssertTrue(server.methods.contains("mcpServer/tool/call"))
            XCTAssertFalse(server.methods.contains("turn/start"))
            XCTAssertTrue(server.methods.contains("thread/archive"))
        }
    }

    func testTextOnlyMcpAccountAndToolErrors() throws {
        let content: [[String: Any]] = [["type": "text", "text": #"{"capabilities":{"canComment":true,"writeTools":["append_comment","claim_item"]},"skill":{"expectedVersion":"5.8.0"}}"#]]
        XCTAssertNoThrow(try CodexProtocol.validateAccount(["content": content], skillVersion: "5.8.0"))
        XCTAssertThrowsError(try CodexProtocol.validateAccount(["isError": true, "content": content], skillVersion: "5.8.0"))
        XCTAssertThrowsError(try CodexProtocol.validateAccount(["content": [["type": "text", "text": "login required"]]], skillVersion: "5.8.0"))
    }
}
