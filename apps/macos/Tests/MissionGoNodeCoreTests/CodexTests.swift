import XCTest
@testable import MissionGoNodeCore

private func ok(_ stdout: String) -> CommandResult {
    return CommandResult(code: 0, stdout: stdout, stderr: "")
}

private let mcpReady = #"[{"name":"missiongo","enabled":true,"disabled_reason":null,"transport":{"type":"streamable_http","url":"https://missiongo.test/mcp"},"auth_status":"o_auth"}]"#

/// Stands in for `codex app-server daemon start`: counts the calls and, when
/// given a path, starts listening there the way the real daemon does.
private final class FakeDaemon: @unchecked Sendable {
    let starts = Locked(0)
    private let listener = Locked<Int32?>(nil)
    private let socketPath: String?

    init(bringsUp socketPath: String? = nil) {
        self.socketPath = socketPath
    }

    func start() -> CommandResult {
        starts.withLock { $0 += 1 }
        guard let socketPath else { return CommandResult(code: 1, stdout: "", stderr: "daemon refused to start\n") }
        listener.withLock { current in
            if current == nil { current = try? listeningSocket(at: socketPath) }
        }
        return ok(#"{"status":"started","backend":"pid"}"#)
    }

    deinit {
        listener.current.map { _ = close($0) }
    }
}

/// A `codex` that answers the commands the preflight runs.
private func fakeCodex(
    login: CommandResult = CommandResult(code: 0, stdout: "", stderr: "Logged in using ChatGPT\n"),
    mcp: CommandResult = ok(mcpReady),
    daemon: FakeDaemon = FakeDaemon()
) -> CommandRunner {
    return { file, args in
        precondition(file.hasSuffix("codex"), "unexpected command: \(file)")
        switch args.first {
        case "--version": return ok("codex-cli 0.154.0\n")
        case "login": return login
        case "mcp": return mcp
        case "app-server":
            precondition(args == ["app-server", "daemon", "start"], "unexpected args: \(args)")
            return daemon.start()
        default: preconditionFailure("unexpected args: \(args)")
        }
    }
}

/// A PATH holding an executable `codex`, so binary lookup finds one.
private func codexOnPath() throws -> ShellEnvironment {
    let bin = FileManager.default.temporaryDirectory.appendingPathComponent("mg-codex-bin-\(UUID().uuidString)").path
    try FileManager.default.createDirectory(atPath: bin, withIntermediateDirectories: true)
    try Data("#!/bin/sh\nexit 0\n".utf8).write(to: URL(fileURLWithPath: "\(bin)/codex"))
    try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: "\(bin)/codex")
    return ShellEnvironment(path: "\(bin):/usr/bin:/bin", base: [:])
}

/// A short temporary directory: a Unix socket path must fit in 104 bytes.
func shortTemporaryDirectory() throws -> String {
    let path = "/tmp/mg-\(UUID().uuidString.prefix(8))"
    try FileManager.default.createDirectory(atPath: path, withIntermediateDirectories: true)
    return path
}

/// A listening Unix socket at `path`, so the path is a socket and not a file.
private func listeningSocket(at path: String) throws -> Int32 {
    let descriptor = socket(AF_UNIX, SOCK_STREAM, 0)
    var address = sockaddr_un()
    address.sun_family = sa_family_t(AF_UNIX)
    withUnsafeMutableBytes(of: &address.sun_path) { $0.copyBytes(from: Array(path.utf8)) }
    address.sun_len = UInt8(MemoryLayout<sockaddr_un>.size)
    let bound = withUnsafePointer(to: &address) {
        $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { bind(descriptor, $0, socklen_t(MemoryLayout<sockaddr_un>.size)) }
    }
    guard bound == 0, listen(descriptor, 4) == 0 else {
        throw NSError(domain: "test", code: Int(errno), userInfo: [NSLocalizedDescriptionKey: String(cString: strerror(errno))])
    }
    return descriptor
}

/// Stands in for the app-server: one connection, the WebSocket handshake, then
/// a scripted answer for each request it receives.
final class FakeAppServer: @unchecked Sendable {
    let path: String
    private let listener: Int32
    let received = Locked<[String]>([])
    let clientClosed = Locked(false)
    private let finished = DispatchSemaphore(value: 0)

    /// Given a request, the messages to send back, in order.
    init(respond: @escaping @Sendable ([String: Any]) -> [[String: Any]]) throws {
        path = try shortTemporaryDirectory() + "/c.sock"
        listener = try listeningSocket(at: path)
        let listener = self.listener
        DispatchQueue.global().async { [self] in
            defer { finished.signal() }
            let connection = accept(listener, nil, nil)
            guard connection >= 0 else { return }
            defer { close(connection) }
            var buffer: [UInt8] = []
            func readMore() -> Bool {
                var chunk = [UInt8](repeating: 0, count: 65_536)
                let count = recv(connection, &chunk, chunk.count, 0)
                guard count > 0 else { return false }
                buffer += chunk[..<count]
                return true
            }
            func send(_ bytes: [UInt8]) {
                _ = bytes.withUnsafeBytes { Darwin.send(connection, $0.baseAddress, $0.count, 0) }
            }
            let terminator = Array("\r\n\r\n".utf8)
            while buffer.firstRange(of: terminator) == nil {
                guard readMore() else { return }
            }
            let end = buffer.firstRange(of: terminator)!
            let head = String(decoding: buffer[..<end.lowerBound], as: UTF8.self)
            buffer.removeSubrange(..<end.upperBound)
            let key = head.components(separatedBy: "\r\n")
                .first { $0.lowercased().hasPrefix("sec-websocket-key:") }?
                .split(separator: ":", maxSplits: 1)[1].trimmingCharacters(in: .whitespaces) ?? ""
            send(Array("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: \(WebSocketFrame.acceptValue(key: key))\r\n\r\n".utf8))
            while true {
                guard let frame = try? WebSocketFrame.decode(&buffer) else {
                    guard readMore() else { return }
                    continue
                }
                if frame.opcode == WebSocketFrame.close {
                    clientClosed.withLock { $0 = true }
                    return
                }
                let text = String(decoding: frame.payload, as: UTF8.self)
                received.withLock { $0.append(text) }
                guard let message = try? JSONSerialization.jsonObject(with: Data(frame.payload)) as? [String: Any] else { continue }
                for answer in respond(message) {
                    let data = try! JSONSerialization.data(withJSONObject: answer)
                    send(WebSocketFrame.encode(opcode: WebSocketFrame.text, payload: Array(data), mask: nil))
                }
            }
        }
    }

    func waitUntilDone() {
        _ = finished.wait(timeout: .now() + 5)
        close(listener)
    }

    var methods: [String] {
        return received.current.compactMap { text in
            (try? JSONSerialization.jsonObject(with: Data(text.utf8)) as? [String: Any])?["method"] as? String
        }
    }

    func params(of method: String) -> [String: Any]? {
        for text in received.current {
            guard let message = try? JSONSerialization.jsonObject(with: Data(text.utf8)) as? [String: Any],
                  message["method"] as? String == method
            else { continue }
            return message["params"] as? [String: Any]
        }
        return nil
    }

    /// Answers every request the way the real app-server did in the spike.
    static func happy(
        threadId: String = "01a09f35-d6fa-7eb2-9d90-1352cf2fb661",
        accountResult: [String: Any]? = nil,
        accountStartupFailures: Int = 0
    ) throws -> FakeAppServer {
        let remainingAccountFailures = Locked(accountStartupFailures)
        return try FakeAppServer { message in
            guard let id = message["id"], let method = message["method"] as? String else { return [] }
            switch method {
            case "thread/start":
                let params = message["params"] as? [String: Any] ?? [:]
                let cwd = params["cwd"] as? String ?? "/repo"
                let roots = params["runtimeWorkspaceRoots"] as? [String] ?? [cwd]
                return [
                    // Notifications and a server request arrive before the answer.
                    ["jsonrpc": "2.0", "method": "thread/started", "params": ["thread": ["id": threadId]]],
                    ["jsonrpc": "2.0", "id": 900, "method": "item/commandExecution/requestApproval", "params": [:]],
                    ["jsonrpc": "2.0", "id": id, "result": [
                        "thread": ["id": threadId], "cwd": cwd,
                        "approvalsReviewer": params["approvalsReviewer"] ?? "user",
                        "approvalPolicy": "on-request", "runtimeWorkspaceRoots": roots,
                        "sandbox": ["type": "workspaceWrite", "writableRoots": roots.filter { $0 != cwd }],
                    ]],
                ]
            case "mcpServer/tool/call":
                let shouldFail = remainingAccountFailures.withLock { remaining in
                    guard remaining > 0 else { return false }
                    remaining -= 1
                    return true
                }
                if shouldFail {
                    return [["id": id, "error": [
                        "code": -32603,
                        "message": "failed to get client: MCP startup failed: MCP client startup timed out after 30s",
                    ]]]
                }
                if let accountResult { return [["id": id, "result": accountResult]] }
                return [["id": id, "result": ["structuredContent": [
                    "capabilities": ["canComment": true, "writeTools": ["append_comment", "claim_item"]],
                    "skill": ["expectedVersion": "5.8.0"],
                ]]]]
            default:
                return [["jsonrpc": "2.0", "id": id, "result": [:]]]
            }
        }
    }
}

final class CodexModesTests: XCTestCase {
    func testEveryModeKeepsTheSandboxAndOnRequestApprovals() {
        XCTAssertEqual(CodexModes.allowed, ["plan", "default", "auto"])
        for mode in CodexModes.allowed {
            let settings = CodexModes.threadSettings(for: mode)
            XCTAssertEqual(settings?.sandbox, "workspace-write", mode)
            XCTAssertEqual(settings?.approvalPolicy, "on-request", mode)
        }
        XCTAssertEqual(CodexModes.threadSettings(for: "plan")?.approvalsReviewer, "auto_review")
        XCTAssertEqual(CodexModes.threadSettings(for: "default")?.approvalsReviewer, "user")
        XCTAssertEqual(CodexModes.threadSettings(for: "auto")?.approvalsReviewer, "auto_review")
    }

    func testRefusesEverythingElse() {
        for mode in ["never", "danger-full-access", "bypassPermissions", "acceptEdits", "", "plan "] {
            XCTAssertNil(CodexModes.threadSettings(for: mode), mode)
        }
    }

    func testTheModeListIsOneLiteralLineForTheRepositoryCheck() throws {
        // scripts compare this line against CODEX_MODES in packages/domain.
        let source = try String(contentsOfFile: #filePath.replacingOccurrences(
            of: "Tests/MissionGoNodeCoreTests/CodexTests.swift", with: "Sources/MissionGoNodeCore/CodexModes.swift"
        ))
        XCTAssertTrue(source.contains(#"["plan", "default", "auto"]"#))
    }
}

final class PlanPromptTests: XCTestCase {
    func testBothClientsWaitBeforeAllWritesButOnlyClaudeExitsNativePlanMode() throws {
        for client in [LaunchPrompt.Client.claudeCode, .codex] {
            let prompt = try LaunchPrompt.build(itemKeys: ["HG-8"], dispatchId: "abc", mode: "plan", client: client)
            XCTAssertTrue(prompt.contains("用户批准之前不回写评论、不领取条目、不建分支或 worktree、不改代码"))
            XCTAssertTrue(prompt.contains("用户批准之后，先将已批准的计划以结构化评论"))
            XCTAssertTrue(prompt.contains("待确认项一次问齐"))
            XCTAssertEqual(prompt.contains("退出 plan 模式"), client == .claudeCode)
            XCTAssertEqual(prompt.contains("自动审查仅处理技术权限请求"), client == .codex)
        }
    }

    func testOtherModesGetNoPlanParagraph() throws {
        for mode in ["default", "auto", "acceptEdits"] {
            XCTAssertFalse(try LaunchPrompt.build(itemKeys: ["HG-8"], dispatchId: "abc", mode: mode).contains("计划模式"), mode)
        }
    }
}

final class CodexProtocolTests: XCTestCase {
    func testThreadStartCarriesTheRepositoryAndTheModeSettings() throws {
        let plan = CodexProtocol.threadStartParams(cwd: "/repo", settings: CodexModes.threadSettings(for: "plan")!)
        XCTAssertEqual(plan["cwd"] as? String, "/repo")
        XCTAssertEqual(plan["sandbox"] as? String, "workspace-write")
        XCTAssertEqual(plan["approvalPolicy"] as? String, "on-request")
        XCTAssertEqual(plan["approvalsReviewer"] as? String, "auto_review")
        XCTAssertEqual(plan["runtimeWorkspaceRoots"] as? [String], ["/repo"])

        let auto = CodexProtocol.threadStartParams(cwd: "/repo", settings: CodexModes.threadSettings(for: "auto")!)
        XCTAssertEqual(auto["approvalsReviewer"] as? String, "auto_review")
        let manual = CodexProtocol.threadStartParams(cwd: "/repo", settings: CodexModes.threadSettings(for: "default")!)
        XCTAssertEqual(manual["approvalsReviewer"] as? String, "user")
    }

    func testTurnStartSendsThePromptAsOneTextInput() throws {
        let params = CodexProtocol.turnStartParams(threadId: "t1", prompt: "do it")
        XCTAssertEqual(params["threadId"] as? String, "t1")
        let input = params["input"] as? [[String: Any]]
        XCTAssertEqual(input?.count, 1)
        XCTAssertEqual(input?.first?["type"] as? String, "text")
        XCTAssertEqual(input?.first?["text"] as? String, "do it")
        XCTAssertNil(params["clientUserMessageId"])
        XCTAssertEqual(
            CodexProtocol.turnStartParams(threadId: "t1", prompt: "do it", clientUserMessageId: "command-1")["clientUserMessageId"] as? String,
            "command-1"
        )
    }

    func testTurnSteerPinsTheActiveTurnAndClientMessage() throws {
        let params = CodexProtocol.turnSteerParams(
            threadId: "t1", turnId: "turn-1", prompt: "focus here", clientUserMessageId: "command-1"
        )
        XCTAssertEqual(params["threadId"] as? String, "t1")
        XCTAssertEqual(params["expectedTurnId"] as? String, "turn-1")
        XCTAssertEqual(params["clientUserMessageId"] as? String, "command-1")
        let input = params["input"] as? [[String: Any]]
        XCTAssertEqual(input?.first?["type"] as? String, "text")
        XCTAssertEqual(input?.first?["text"] as? String, "focus here")
    }

    func testReadsOnlyUserVisibleThreadItems() throws {
        let snapshot = try CodexProtocol.threadSnapshot(fromRead: [
            "thread": [
                "status": ["type": "idle"],
                "updatedAt": 1_797_808_200_123 as NSNumber,
                "turns": [[
                    "id": "turn-1",
                    "items": [
                        [
                            "id": "u1", "type": "userMessage", "createdAt": "2026-09-22T01:02:03.000Z",
                            "content": [["type": "text", "text": "Please continue"]],
                        ],
                        ["id": "r1", "type": "reasoning", "summary": ["private reasoning"]],
                        ["id": "p1", "type": "plan", "created_at": 1_797_808_201 as NSNumber, "text": "1. Inspect\n2. Fix"],
                        [
                            "id": "a1", "type": "agentMessage", "text": "Choose a scope", "phase": "commentary",
                            "questions": [["title": "Scope", "options": ["small", "complete"]]],
                        ],
                    ],
                ]],
            ],
        ])

        XCTAssertEqual(snapshot.status, "idle")
        XCTAssertEqual(snapshot.messages.map(\.sourceId), ["u1", "p1", "a1"])
        XCTAssertEqual(snapshot.messages.map(\.role), ["user", "plan", "agent"])
        XCTAssertEqual(snapshot.messages[0].occurredAt, "2026-09-22T01:02:03.000Z")
        XCTAssertEqual(snapshot.messages[1].occurredAt, "2026-12-20T23:10:01.000Z")
        XCTAssertEqual(snapshot.messages.last?.questions, [AgentSessionQuestion(title: "Scope", options: ["small", "complete"])])
        XCTAssertEqual(snapshot.activityAt, "2026-12-20T23:10:00.123Z")
    }

    func testNormalizesCodexSourceActivityTimestamps() {
        XCTAssertEqual(
            CodexProtocol.sourceActivityTimestamp("2026-09-21T05:30:00Z"),
            "2026-09-21T05:30:00.000Z"
        )
        XCTAssertNil(CodexProtocol.sourceActivityTimestamp("not-a-date"))
    }

    func testReadsTheActiveTurnIdForSameTurnSteering() throws {
        let snapshot = try CodexProtocol.threadSnapshot(fromRead: [
            "thread": [
                "status": ["type": "active"],
                "turns": [
                    ["id": "turn-1", "status": "completed", "items": []],
                    ["id": "turn-2", "status": "inProgress", "items": []],
                ],
            ],
        ])

        XCTAssertEqual(snapshot.status, "active")
        XCTAssertEqual(snapshot.activeTurnId, "turn-2")
    }

    func testTreatsAnUnloadedThreadAsIdleBecauseReplyResumesIt() throws {
        let snapshot = try CodexProtocol.threadSnapshot(fromRead: [
            "thread": ["status": ["type": "notLoaded"], "turns": []],
        ])

        XCTAssertEqual(snapshot.status, "idle")
    }

    func testReadAndResumeParametersKeepTheNativeThreadId() {
        XCTAssertEqual(CodexProtocol.threadReadParams(threadId: "t1")["includeTurns"] as? Bool, true)
        XCTAssertEqual(CodexProtocol.threadReadParams(threadId: "t1")["threadId"] as? String, "t1")
        XCTAssertEqual(CodexProtocol.threadResumeParams(threadId: "t1")["threadId"] as? String, "t1")
        XCTAssertEqual(CodexProtocol.turnInterruptParams(threadId: "t1", turnId: "r1")["turnId"] as? String, "r1")
    }

    func testArchivedThreadListingIncludesAppServerThreadsAndParsesPagination() throws {
        let params = CodexProtocol.archivedThreadListParams(cursor: "next-page")
        XCTAssertEqual(params["archived"] as? Bool, true)
        XCTAssertEqual(params["cursor"] as? String, "next-page")
        XCTAssertTrue((params["sourceKinds"] as? [String])?.contains("appServer") == true)
        let page = try CodexProtocol.threadListPage([
            "data": [["id": "thread-1"], ["id": "thread-2"]],
            "nextCursor": "page-2",
        ])
        XCTAssertEqual(page.ids, Set(["thread-1", "thread-2"]))
        XCTAssertEqual(page.nextCursor, "page-2")
    }

    func testOnlyAPlainIdBecomesALink() {
        XCTAssertEqual(
            CodexProtocol.threadLink("01a09f35-d6fa-7eb2-9d90-1352cf2fb661"),
            "codex://threads/01a09f35-d6fa-7eb2-9d90-1352cf2fb661"
        )
        for id in ["", "a/b", "a?b", "a b", "a\n", String(repeating: "a", count: 101)] {
            XCTAssertNil(CodexProtocol.threadLink(id), id)
        }
    }
}

final class WebSocketFrameTests: XCTestCase {
    func testComputesTheAcceptValueFromTheRFCExample() {
        XCTAssertEqual(WebSocketFrame.acceptValue(key: "dGhlIHNhbXBsZSBub25jZQ=="), "s3pPLMBiTxaQ9kYGzzhZRbK+xOo=")
    }

    func testRefusesAServerThatDidNotSwitchOrAnsweredTheWrongKey() {
        let key = "dGhlIHNhbXBsZSBub25jZQ=="
        XCTAssertNil(WebSocketFrame.handshakeProblem(
            response: "HTTP/1.1 101 Switching Protocols\r\nSec-WebSocket-Accept: s3pPLMBiTxaQ9kYGzzhZRbK+xOo=", key: key
        ))
        XCTAssertEqual(WebSocketFrame.handshakeProblem(response: "HTTP/1.1 404 Not Found", key: key), "HTTP/1.1 404 Not Found")
        XCTAssertNotNil(WebSocketFrame.handshakeProblem(response: "HTTP/1.1 101 Switching Protocols\r\nSec-WebSocket-Accept: nope", key: key))
    }

    func testRoundTripsMaskedFramesOfEveryLengthEncoding() throws {
        for size in [0, 5, 125, 126, 65_535, 65_536] {
            let payload = (0..<size).map { UInt8($0 % 251) }
            var buffer = WebSocketFrame.encode(opcode: WebSocketFrame.text, payload: payload, mask: [1, 2, 3, 4])
            let frame = try WebSocketFrame.decode(&buffer)
            XCTAssertEqual(frame, WebSocketFrame.Frame(fin: true, opcode: WebSocketFrame.text, payload: payload), "\(size)")
            XCTAssertTrue(buffer.isEmpty)
        }
    }

    func testWaitsForAFrameThatHasNotFullyArrived() throws {
        let whole = WebSocketFrame.encode(opcode: WebSocketFrame.text, payload: Array("hello".utf8), mask: nil)
        var partial = Array(whole.dropLast())
        XCTAssertNil(try WebSocketFrame.decode(&partial))
        XCTAssertEqual(partial.count, whole.count - 1)
    }

    func testRefusesAnAbsurdLength() {
        var buffer: [UInt8] = [0x81, 127, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF]
        XCTAssertThrowsError(try WebSocketFrame.decode(&buffer))
    }
}

final class CodexAppServerControlTests: XCTestCase {
    private func request(socketPath: String) -> CodexThreadRequest {
        return CodexThreadRequest(
            socketPath: socketPath, cwd: "/Users/dev/repo",
            settings: CodexModes.threadSettings(for: "plan")!, name: "Mac mini-AND-1", prompt: "使用 missiongo skill"
        )
    }

    func testStartsANamedThreadSendsTheTurnAndDisconnects() async throws {
        let server = try FakeAppServer.happy()
        let threadId = try await CodexAppServerControl(timeout: 5).startThread(request(socketPath: server.path))
        server.waitUntilDone()

        XCTAssertEqual(threadId, "01a09f35-d6fa-7eb2-9d90-1352cf2fb661")
        XCTAssertEqual(server.methods, [
            "initialize", "initialized", "thread/start", "mcpServerStatus/list", "mcpServer/tool/call",
            "thread/name/set", "turn/start", "thread/unsubscribe",
        ])
        XCTAssertEqual(server.params(of: "mcpServer/tool/call")?["tool"] as? String, "get_current_account")
        XCTAssertEqual(server.params(of: "thread/start")?["cwd"] as? String, "/Users/dev/repo")
        XCTAssertEqual(server.params(of: "thread/name/set")?["name"] as? String, "Mac mini-AND-1")
        XCTAssertEqual(server.params(of: "thread/name/set")?["threadId"] as? String, threadId)
        XCTAssertEqual(server.params(of: "turn/start")?["threadId"] as? String, threadId)
        // The approval request the server sent was left for the apps to answer.
        XCTAssertFalse(server.received.current.contains { $0.contains("\"id\":900") })
        XCTAssertTrue(server.clientClosed.current)
    }

    func testReportsARefusedThreadWithTheServersMessage() async throws {
        let server = try FakeAppServer { message in
            guard let id = message["id"], let method = message["method"] as? String else { return [] }
            if method == "thread/start" {
                return [["jsonrpc": "2.0", "id": id, "error": ["code": -32600, "message": "cwd does not exist"]]]
            }
            return [["jsonrpc": "2.0", "id": id, "result": [:]]]
        }
        do {
            _ = try await CodexAppServerControl(timeout: 5).startThread(request(socketPath: server.path))
            XCTFail("expected a failure")
        } catch {
            XCTAssertEqual(error as? CodexControlError, .rpc(method: "thread/start", message: "cwd does not exist"))
        }
        server.waitUntilDone()
        XCTAssertFalse(server.methods.contains("turn/start"))
    }

    func testStartupTimeoutIsDiagnosedWithoutBlindlyRetryingTheToolCall() async throws {
        let server = try FakeAppServer.happy(accountStartupFailures: 1)
        do {
            _ = try await CodexAppServerControl(timeout: 5).startThread(request(socketPath: server.path))
            XCTFail("expected a failure")
        } catch let CodexControlError.mcpStartup(diagnostic) {
            XCTAssertEqual(diagnostic.name, "missiongo")
            XCTAssertEqual(diagnostic.threadId, "01a09f35-d6fa-7eb2-9d90-1352cf2fb661")
            XCTAssertTrue(diagnostic.error?.contains("startup timed out") == true)
        }
        server.waitUntilDone()

        XCTAssertEqual(server.methods.filter { $0 == "mcpServer/tool/call" }.count, 1)
        XCTAssertFalse(server.methods.contains("turn/start"))
        XCTAssertTrue(server.methods.contains("thread/archive"))
        XCTAssertTrue(server.methods.contains("thread/unsubscribe"))
    }

    func testStartupTimeoutCarriesAStableMcpFailureInsteadOfASecondProbe() async throws {
        let server = try FakeAppServer.happy(accountStartupFailures: 2)
        do {
            _ = try await CodexAppServerControl(timeout: 5).startThread(request(socketPath: server.path))
            XCTFail("expected a failure")
        } catch {
            guard case let CodexControlError.mcpStartup(diagnostic) = error else {
                return XCTFail("unexpected error: \(error)")
            }
            XCTAssertEqual(diagnostic.name, "missiongo")
            XCTAssertTrue(diagnostic.error?.contains("startup timed out") == true)
        }
        server.waitUntilDone()
        XCTAssertEqual(server.methods.filter { $0 == "mcpServer/tool/call" }.count, 1)
        XCTAssertFalse(server.methods.contains("turn/start"))
    }

    func testInterruptsTheExactActiveTurn() async throws {
        let server = try FakeAppServer { message in
            guard let id = message["id"] else { return [] }
            return [["jsonrpc": "2.0", "id": id, "result": [:]]]
        }
        try await CodexAppServerControl(timeout: 5).interruptTurn(
            socketPath: server.path,
            threadId: "thread-1",
            turnId: "turn-9"
        )
        server.waitUntilDone()

        XCTAssertEqual(server.methods, ["initialize", "initialized", "turn/interrupt"])
        XCTAssertEqual(server.params(of: "turn/interrupt")?["threadId"] as? String, "thread-1")
        XCTAssertEqual(server.params(of: "turn/interrupt")?["turnId"] as? String, "turn-9")
    }

    func testSteersTheExactActiveTurnWithAStableClientMessageId() async throws {
        let server = try FakeAppServer { message in
            guard let id = message["id"] else { return [] }
            return [["jsonrpc": "2.0", "id": id, "result": ["turnId": "turn-9"]]]
        }
        try await CodexAppServerControl(timeout: 5).steerMessage(
            socketPath: server.path,
            threadId: "thread-1",
            turnId: "turn-9",
            text: "Focus on the failing test",
            clientUserMessageId: "command-1"
        )
        server.waitUntilDone()

        XCTAssertEqual(server.methods, ["initialize", "initialized", "turn/steer"])
        let params = server.params(of: "turn/steer")
        XCTAssertEqual(params?["threadId"] as? String, "thread-1")
        XCTAssertEqual(params?["expectedTurnId"] as? String, "turn-9")
        XCTAssertEqual(params?["clientUserMessageId"] as? String, "command-1")
        let input = params?["input"] as? [[String: Any]]
        XCTAssertEqual(input?.first?["text"] as? String, "Focus on the failing test")
    }

    func testDetectsAnArchivedThreadWithoutTryingToReadItAsActive() async throws {
        let server = try FakeAppServer { message in
            guard let id = message["id"], let method = message["method"] as? String else { return [] }
            if method == "thread/list" {
                return [["jsonrpc": "2.0", "id": id, "result": [
                    "data": [["id": "thread-archived"]],
                ]]]
            }
            return [["jsonrpc": "2.0", "id": id, "result": [:]]]
        }
        let snapshot = try await CodexAppServerControl(timeout: 5).readThread(
            socketPath: server.path,
            threadId: "thread-archived"
        )
        server.waitUntilDone()

        XCTAssertTrue(snapshot.archived)
        XCTAssertEqual(snapshot.status, "unavailable")
        XCTAssertEqual(server.methods, ["initialize", "initialized", "thread/list"])
    }

    func testPassesTheModelToThreadStartAndTheEffortToTheFirstTurn() async throws {
        let server = try FakeAppServer.happy()
        let base = request(socketPath: server.path)
        _ = try await CodexAppServerControl(timeout: 5).startThread(CodexThreadRequest(
            socketPath: base.socketPath, cwd: base.cwd, settings: base.settings, name: base.name, prompt: base.prompt,
            model: "gpt-5.1-codex", effort: "xhigh"
        ))
        server.waitUntilDone()
        XCTAssertEqual(server.params(of: "thread/start")?["model"] as? String, "gpt-5.1-codex")
        XCTAssertNil(server.params(of: "thread/start")?["effort"])
        XCTAssertEqual(server.params(of: "turn/start")?["model"] as? String, "gpt-5.1-codex")
        XCTAssertEqual(server.params(of: "turn/start")?["effort"] as? String, "xhigh")
    }

    func testLeavesModelAndEffortOutWhenTheDispatchFollowsLocalConfig() async throws {
        let server = try FakeAppServer.happy()
        _ = try await CodexAppServerControl(timeout: 5).startThread(request(socketPath: server.path))
        server.waitUntilDone()
        XCTAssertNil(server.params(of: "thread/start")?["model"])
        XCTAssertNil(server.params(of: "turn/start")?["model"])
        XCTAssertNil(server.params(of: "turn/start")?["effort"])
    }

    func testListsModelsAcrossPagesAndSkipsHiddenOnes() async throws {
        let server = try FakeAppServer { message in
            guard let id = message["id"], let method = message["method"] as? String else { return [] }
            guard method == "model/list" else { return [["jsonrpc": "2.0", "id": id, "result": [:]]] }
            let cursor = (message["params"] as? [String: Any])?["cursor"] as? String
            if cursor == nil {
                return [["jsonrpc": "2.0", "id": id, "result": [
                    "data": [
                        ["id": "m1", "model": "gpt-5.1-codex", "displayName": "GPT-5.1 Codex", "hidden": false, "isDefault": true,
                         "defaultReasoningEffort": "medium",
                         "supportedReasoningEfforts": [["reasoningEffort": "low", "description": ""], ["reasoningEffort": "medium", "description": ""]]],
                        ["id": "secret", "model": "internal", "displayName": "Internal", "hidden": true],
                    ],
                    "nextCursor": "page-2",
                ]]]
            }
            return [["jsonrpc": "2.0", "id": id, "result": [
                "data": [["id": "gpt-5-mini", "displayName": "GPT-5 mini", "hidden": false, "isDefault": false,
                          "supportedReasoningEfforts": []]],
            ]]]
        }
        let models = try await CodexAppServerControl(timeout: 5).listModels(socketPath: server.path)
        server.waitUntilDone()

        XCTAssertEqual(models, [
            AgentModelOption(id: "gpt-5.1-codex", label: "GPT-5.1 Codex", efforts: ["low", "medium"], defaultEffort: "medium", isDefault: true),
            AgentModelOption(id: "gpt-5-mini", label: "GPT-5 mini", efforts: [], isDefault: false),
        ])
        XCTAssertEqual(server.methods, ["initialize", "initialized", "model/list", "model/list"])
        XCTAssertEqual(server.params(of: "model/list")?["includeHidden"] as? Bool, false)
    }

    func testAppliesSettingsThroughThreadResume() async throws {
        let server = try FakeAppServer { message in
            guard let id = message["id"] else { return [] }
            if message["method"] as? String == "thread/resume" {
                return [["jsonrpc": "2.0", "id": id, "result": ["model": "gpt-5.1-codex", "reasoningEffort": "high", "thread": ["id": "thread-1"]]]]
            }
            return [["jsonrpc": "2.0", "id": id, "result": [:]]]
        }
        let applied = try await CodexAppServerControl(timeout: 5).applySettings(
            socketPath: server.path, threadId: "thread-1",
            overrides: CodexTurnOverrides(model: "gpt-5.1-codex", effort: "high", settings: CodexModes.threadSettings(for: "default"))
        )
        server.waitUntilDone()

        XCTAssertEqual(applied, CodexAppliedSettings(model: "gpt-5.1-codex", reasoningEffort: "high"))
        XCTAssertEqual(server.methods, ["initialize", "initialized", "thread/resume"])
        let params = server.params(of: "thread/resume")
        XCTAssertEqual(params?["threadId"] as? String, "thread-1")
        XCTAssertEqual(params?["model"] as? String, "gpt-5.1-codex")
        XCTAssertEqual(params?["approvalPolicy"] as? String, "on-request")
        XCTAssertEqual(params?["approvalsReviewer"] as? String, "user")
        XCTAssertEqual(params?["sandbox"] as? String, "workspace-write")
        // thread/resume takes no effort; it rides on the next turn/start.
        XCTAssertNil(params?["effort"])
    }

    func testAReplyResumesAndStartsTheTurnWithTheOverrides() async throws {
        let server = try FakeAppServer { message in
            guard let id = message["id"] else { return [] }
            return [["jsonrpc": "2.0", "id": id, "result": [:]]]
        }
        try await CodexAppServerControl(timeout: 5).sendMessage(
            socketPath: server.path, threadId: "thread-1", text: "Continue", clientUserMessageId: "command-1",
            overrides: CodexTurnOverrides(model: "gpt-5.1-codex", effort: "low", settings: CodexModes.threadSettings(for: "auto"))
        )
        server.waitUntilDone()

        XCTAssertEqual(server.methods, ["initialize", "initialized", "thread/resume", "turn/start"])
        XCTAssertEqual(server.params(of: "thread/resume")?["model"] as? String, "gpt-5.1-codex")
        let turn = server.params(of: "turn/start")
        XCTAssertEqual(turn?["model"] as? String, "gpt-5.1-codex")
        XCTAssertEqual(turn?["effort"] as? String, "low")
        XCTAssertEqual(turn?["approvalPolicy"] as? String, "on-request")
        XCTAssertEqual(turn?["approvalsReviewer"] as? String, "auto_review")
        XCTAssertEqual(turn?["clientUserMessageId"] as? String, "command-1")
    }

    func testReadsTheThreadsModelAndEffort() throws {
        let snapshot = try CodexProtocol.threadSnapshot(fromRead: [
            "thread": ["status": ["type": "idle"], "turns": [], "model": "gpt-5.1-codex", "reasoningEffort": "high"],
        ])
        XCTAssertEqual(snapshot.model, "gpt-5.1-codex")
        XCTAssertEqual(snapshot.reasoningEffort, "high")
    }

    func testSaysTheChatGPTAppIsNotRunningWhenNothingListens() async throws {
        let path = try shortTemporaryDirectory() + "/missing.sock"
        do {
            _ = try await CodexAppServerControl(timeout: 2).startThread(request(socketPath: path))
            XCTFail("expected a failure")
        } catch {
            XCTAssertTrue(error.localizedDescription.contains("ChatGPT App"), error.localizedDescription)
        }
    }

    func testTimesOutOnAServerThatNeverAnswers() async throws {
        let server = try FakeAppServer { _ in [] }
        let started = Date()
        do {
            _ = try await CodexAppServerControl(timeout: 1).startThread(request(socketPath: server.path))
            XCTFail("expected a failure")
        } catch {
            XCTAssertEqual(error as? CodexControlError, .timedOut(method: "initialize"))
        }
        XCTAssertLessThan(Date().timeIntervalSince(started), 4)
        server.waitUntilDone()
    }
}

final class CodexPreflightTests: XCTestCase {
    func testReadsTheMissionGoServerFromTheMcpList() {
        XCTAssertEqual(CodexPreflight.parseMcpList(mcpReady), .ready)
        XCTAssertEqual(CodexPreflight.parseMcpList(#"[{"name":"other","enabled":true}]"#), .missing)
        XCTAssertEqual(CodexPreflight.parseMcpList(#"[{"name":"missiongo","enabled":false}]"#), .disabled)
        XCTAssertEqual(CodexPreflight.parseMcpList(#"[{"name":"missiongo","enabled":true,"auth_status":"not_logged_in"}]"#), .notLoggedIn)
        XCTAssertEqual(CodexPreflight.parseMcpList("warning: something\n" + mcpReady), .ready)
        XCTAssertEqual(CodexPreflight.parseMcpList("not json"), .unreadable)
    }

    func testTheMcpHintPointsAtTheLoggedInServer() {
        XCTAssertEqual(
            CodexPreflight.mcpSetupCommand(serverUrl: "https://missiongo.test"),
            "codex mcp add missiongo --url https://missiongo.test/mcp && codex mcp login missiongo"
        )
    }

    func testFollowsASymlinkToTheRealSocket() throws {
        // lstat would call this a symlink and the menu would say the app is not
        // running while it plainly is.
        let root = try shortTemporaryDirectory()
        let real = "\(root)/real.sock"
        let link = "\(root)/link.sock"
        let listener = try listeningSocket(at: real)
        defer { _ = close(listener) }
        try FileManager.default.createSymbolicLink(atPath: link, withDestinationPath: real)
        XCTAssertTrue(CodexLocation.isSocket(link))
        XCTAssertTrue(CodexLocation.controlChannelIsUp(link))
    }

    func testASocketFileNobodyListensOnIsNotAChannel() throws {
        // The app leaves its socket file behind when it quits. Taking the file
        // for an answer made the menu say ready and the dispatch fail.
        let root = try shortTemporaryDirectory()
        let path = "\(root)/dead.sock"
        let listener = try listeningSocket(at: path)
        _ = close(listener)
        XCTAssertTrue(CodexLocation.isSocket(path), "the file outlives the listener")
        XCTAssertFalse(CodexLocation.controlChannelIsUp(path))
    }

    func testTheMenuBlamesTheDaemonRatherThanTheApp() async throws {
        // The socket belongs to `codex app-server daemon`; the ChatGPT app never
        // creates one, so "the app is open" must not read as "ready", and the
        // fix has to be the command that starts the daemon.
        let environment = try codexOnPath()
        let root = try shortTemporaryDirectory()
        let codexHome = "\(root)/codex"
        try FileManager.default.createDirectory(atPath: "\(codexHome)/app-server-control", withIntermediateDirectories: true)
        let location = CodexLocation(codexHome: codexHome)

        let daemon = FakeDaemon()
        let down = await CodexStatus.check(environment: environment, location: location, run: fakeCodex(daemon: daemon), daemonWait: 0.2)
        XCTAssertEqual(down, .daemonNotRunning(version: "0.154.0", path: location.controlSocketPath))
        XCTAssertEqual(daemon.starts.current, 1, "the check tries the start itself before asking anybody")
        XCTAssertEqual(down.summary, "后台服务未运行")
        // The path is in the hint: without it there is nothing to go and look at.
        XCTAssertEqual(down.fixHint?.contains(location.controlSocketPath), true)
        XCTAssertEqual(down.fixCommand(serverUrl: "https://missiongo.test"), "codex app-server daemon start")
        XCTAssertTrue(down.needsAttention)
        XCTAssertFalse(down.isReady)
    }

    func testTheMenuSaysReadyOnlyWhenSomethingAnswersOnTheSocket() async throws {
        let environment = try codexOnPath()
        let root = try shortTemporaryDirectory()
        let codexHome = "\(root)/codex"
        try FileManager.default.createDirectory(atPath: "\(codexHome)/app-server-control", withIntermediateDirectories: true)
        let location = CodexLocation(codexHome: codexHome)
        let listener = try listeningSocket(at: location.controlSocketPath)
        defer { _ = close(listener) }

        let daemon = FakeDaemon()
        let ready = await CodexStatus.check(environment: environment, location: location, run: fakeCodex(daemon: daemon))
        XCTAssertEqual(ready, .ready(version: "0.154.0"))
        XCTAssertEqual(ready.summary, "0.154.0")
        XCTAssertFalse(ready.needsAttention)
        XCTAssertEqual(daemon.starts.current, 0, "a daemon that answers is left alone")
    }

    func testTheMenuStartsAStoppedDaemonAndSaysReady() async throws {
        // Nothing starts the daemon after a reboot; the check the operator asks
        // for starts it instead of sending them to a terminal.
        let environment = try codexOnPath()
        let root = try shortTemporaryDirectory()
        let codexHome = "\(root)/codex"
        try FileManager.default.createDirectory(atPath: "\(codexHome)/app-server-control", withIntermediateDirectories: true)
        let location = CodexLocation(codexHome: codexHome)
        let daemon = FakeDaemon(bringsUp: location.controlSocketPath)

        let status = await CodexStatus.check(environment: environment, location: location, run: fakeCodex(daemon: daemon))
        XCTAssertEqual(status, .ready(version: "0.154.0"))
        XCTAssertEqual(daemon.starts.current, 1)
    }

    func testAStartThatBringsNothingUpReportsWhatTheCommandSaid() async throws {
        let root = try shortTemporaryDirectory()
        let location = CodexLocation(codexHome: "\(root)/codex")
        let daemon = FakeDaemon()
        let started = Date()
        let outcome = await CodexPreflight.ensureDaemon(
            binary: "/usr/local/bin/codex", location: location, run: fakeCodex(daemon: daemon), wait: 0.3, pollInterval: 0.05
        )
        XCTAssertEqual(outcome, .failed(output: "退出码 1：daemon refused to start"))
        XCTAssertEqual(daemon.starts.current, 1, "one start per check, not one per poll")
        XCTAssertLessThan(Date().timeIntervalSince(started), 2)
    }

    func testFindsCodexHomeFromTheEnvironment() {
        XCTAssertEqual(CodexLocation(environment: ShellEnvironment(path: "/bin", base: [:]), home: "/Users/dev").codexHome, "/Users/dev/.codex")
        XCTAssertEqual(
            CodexLocation(environment: ShellEnvironment(path: "/bin", base: ["CODEX_HOME": "/opt/codex"]), home: "/Users/dev").controlSocketPath,
            "/opt/codex/app-server-control/app-server-control.sock"
        )
    }
}

final class CodexFileDescriptorGuardTests: XCTestCase {
    func testReadsTheOwnerDirectlyFromAConnectedUnixSocket() throws {
        let path = try shortTemporaryDirectory() + "/owner.sock"
        let listener = try listeningSocket(at: path)
        defer { _ = close(listener) }

        XCTAssertEqual(CodexFileDescriptorGuard.socketOwnerPID(path), getpid())
    }

    func testParsesTheProcessThatOwnsTheControlSocket() {
        XCTAssertEqual(CodexFileDescriptorGuard.ownerPID(fromLsof: "p2809\nccodex\nf12\n"), 2809)
        XCTAssertNil(CodexFileDescriptorGuard.ownerPID(fromLsof: "ccodex\nf12\n"))
    }

    func testKeepsSixtyFourDescriptorsInReserve() {
        XCTAssertNil(CodexFileDescriptorGuard.unavailableReason(openFiles: 191, softLimit: 256))
        let reason = CodexFileDescriptorGuard.unavailableReason(openFiles: 192, softLimit: 256)
        XCTAssertTrue(reason?.contains("192/256") == true)
        XCTAssertTrue(reason?.contains("留在队列") == true)
        XCTAssertTrue(reason?.contains("daemon restart") == true)
    }

    func testTrustsOnlyTheCurrentManagedDaemonState() throws {
        let data = Data(#"{"pid":68039,"processStartTime":"2026-09-22T12:00:00Z","executableIdentity":{"digest":[1,2,3]}}"#.utf8)
        XCTAssertEqual(CodexFileDescriptorGuard.verifiedManagedSoftLimit(ownerPID: 68039, stateData: data), 4096)
        XCTAssertNil(CodexFileDescriptorGuard.verifiedManagedSoftLimit(ownerPID: 68040, stateData: data))
        // Codex CLI 0.154 writes this current state shape without an identity.
        XCTAssertEqual(CodexFileDescriptorGuard.verifiedManagedSoftLimit(
            ownerPID: 68039,
            stateData: Data(#"{"pid":68039,"processStartTime":"Wed Sep 23 22:09:56 2026"}"#.utf8)
        ), 4096)
        XCTAssertNil(CodexFileDescriptorGuard.verifiedManagedSoftLimit(
            ownerPID: 68039,
            stateData: Data(#"{"pid":68039,"processStartTime":"","executableIdentity":{"digest":[]}}"#.utf8)
        ))
        XCTAssertNil(CodexFileDescriptorGuard.verifiedManagedSoftLimit(
            ownerPID: 68039,
            stateData: Data(#"{"pid":68039,"processStartTime":"2026-09-22T12:00:00Z","executableIdentity":{"digest":[]}}"#.utf8)
        ))
    }

    func testRaisedDaemonLimitDoesNotUseMissionGoProcessLimit() async {
        let guardrail = CodexFileDescriptorGuard(
            run: { _, _ in CommandResult(code: 0, stdout: "p68039\nccodex\n", stderr: "") },
            softLimit: { pid in pid == 68039 ? 4096 : nil },
            openFiles: { _ in 194 }
        )
        let reason = await guardrail.unavailableReason(socketPath: "/tmp/app-server.sock")
        XCTAssertNil(reason)
    }

    func testProbeFailuresFailClosedAndExposeTheSource() async {
        let guardrail = CodexFileDescriptorGuard(
            run: { _, _ in CommandResult(code: 1, stdout: "", stderr: "not permitted") },
            softLimit: { _ in 256 }, openFiles: { _ in 255 }, managedStatePath: "/managed/app-server.pid"
        )
        let snapshot = await guardrail.snapshot(socketPath: "/tmp/missing.sock")
        XCTAssertEqual(snapshot?.status, "unavailable")
        XCTAssertEqual(snapshot?.source, "/managed/app-server.pid")
        XCTAssertNotNil(snapshot?.checkedAt)
        XCTAssertTrue(snapshot?.reason?.contains("暂停") == true)
    }

    func testMakesDescriptorExhaustionAndMcpTimeoutActionable() {
        XCTAssertTrue(CodexFailure.explain(CodexControlError.rpc(
            method: "thread/start", message: "Too many open files (os error 24)"
        )).contains("daemon restart"))
        XCTAssertTrue(CodexFailure.explain(CodexControlError.rpc(
            method: "mcpServer/tool/call", message: "MCP startup timed out after 30s"
        )).contains("MCP 启动超时"))
    }
}

private struct FixedCodexResources: CodexResourceChecking {
    let reason: String?
    func unavailableReason(socketPath: String) async -> String? { reason }
}

private final class RecordingControl: CodexControl, @unchecked Sendable {
    let requests = Locked<[CodexThreadRequest]>([])
    let replies = Locked<[(String, String)]>([])
    let steerings = Locked<[(String, String, String)]>([])
    let interruptions = Locked<[(String, String)]>([])
    let archived = Locked<[String]>([])
    var archiveError: Error?
    let replyOverrides = Locked<[CodexTurnOverrides?]>([])
    let appliedSettings = Locked<[(String, CodexTurnOverrides)]>([])
    var applyError: Error?
    var applyResult = CodexAppliedSettings()
    let modelLists = Locked(0)
    var modelListResult: Result<[AgentModelOption], Error> = .success([])
    let startupFailures = Locked(0)
    var startupError: Error?
    var loadedThreads = true
    let threadId: String
    var snapshot = CodexThreadSnapshot(status: "idle", messages: [])

    init(threadId: String = "01a09f35-d6fa-7eb2-9d90-1352cf2fb661") {
        self.threadId = threadId
    }

    func startThread(_ request: CodexThreadRequest) async throws -> String {
        requests.withLock { $0.append(request) }
        if let startupError {
            let shouldFail = startupFailures.withLock { remaining -> Bool in
                guard remaining > 0 else { return false }
                remaining -= 1
                return true
            }
            if shouldFail { throw startupError }
        }
        return threadId
    }

    func hasLoadedThreads(socketPath: String) async throws -> Bool { loadedThreads }

    func readThread(socketPath: String, threadId: String) async throws -> CodexThreadSnapshot {
        return snapshot
    }

    func sendMessage(socketPath: String, threadId: String, text: String, clientUserMessageId: String, overrides: CodexTurnOverrides?) async throws {
        replies.withLock { $0.append((clientUserMessageId, text)) }
        replyOverrides.withLock { $0.append(overrides) }
        mirrorDeliveredReply(clientUserMessageId: clientUserMessageId, text: text)
    }

    /// When set, a delivered reply appears in the thread: the next readThread
    /// mirrors it the way the real app-server does once a turn starts.
    var mirrorDeliveredReplies = false

    private func mirrorDeliveredReply(clientUserMessageId: String, text: String) {
        guard mirrorDeliveredReplies else { return }
        snapshot = CodexThreadSnapshot(
            status: "active",
            messages: snapshot.messages + [AgentSessionMessage(
                sourceId: clientUserMessageId, role: "user", text: text,
                occurredAt: "2026-09-26T00:00:01.000Z"
            )],
            activityAt: snapshot.activityAt
        )
    }

    func applySettings(socketPath: String, threadId: String, overrides: CodexTurnOverrides) async throws -> CodexAppliedSettings {
        if let applyError { throw applyError }
        appliedSettings.withLock { $0.append((threadId, overrides)) }
        return applyResult
    }

    func listModels(socketPath: String) async throws -> [AgentModelOption] {
        modelLists.withLock { $0 += 1 }
        return try modelListResult.get()
    }

    func steerMessage(socketPath: String, threadId: String, turnId: String, text: String, clientUserMessageId: String) async throws {
        steerings.withLock { $0.append((clientUserMessageId, turnId, text)) }
        mirrorDeliveredReply(clientUserMessageId: clientUserMessageId, text: text)
    }

    func interruptTurn(socketPath: String, threadId: String, turnId: String) async throws {
        interruptions.withLock { $0.append((threadId, turnId)) }
    }

    func archiveThread(socketPath: String, threadId: String) async throws {
        if let archiveError { throw archiveError }
        archived.withLock { $0.append(threadId) }
    }

    let unarchived = Locked<[String]>([])
    var snapshotAfterUnarchive: CodexThreadSnapshot?

    func unarchiveThread(socketPath: String, threadId: String) async throws {
        unarchived.withLock { $0.append(threadId) }
        if let snapshotAfterUnarchive { snapshot = snapshotAfterUnarchive }
    }
}

final class CodexLauncherTests: XCTestCase {
    /// A Codex home with the control socket listening and the Skill installed,
    /// and a git repository to work in.
    private func machine(skill: Bool = true, socket: Bool = true) throws -> (location: CodexLocation, repoPath: String, listener: Int32?) {
        let root = try shortTemporaryDirectory()
        let codexHome = "\(root)/codex"
        try FileManager.default.createDirectory(atPath: "\(codexHome)/app-server-control", withIntermediateDirectories: true)
        let location = CodexLocation(codexHome: codexHome)
        if skill {
            try FileManager.default.createDirectory(atPath: "\(codexHome)/skills/missiongo", withIntermediateDirectories: true)
            try Data("---\nname: missiongo\nversion: 5.3.0\n---\n".utf8).write(to: URL(fileURLWithPath: location.skillPath))
        }
        let repoPath = "\(root)/repo"
        try FileManager.default.createDirectory(atPath: "\(repoPath)/.git", withIntermediateDirectories: true)
        let listener = socket ? try listeningSocket(at: location.controlSocketPath) : nil
        if socket {
            let daemonDirectory = "\(codexHome)/app-server-daemon"
            try FileManager.default.createDirectory(atPath: daemonDirectory, withIntermediateDirectories: true)
            try Data("""
            {"pid":\(getpid()),"processStartTime":"test-process","executableIdentity":{"digest":[1]}}
            """.utf8).write(to: URL(fileURLWithPath: "\(daemonDirectory)/app-server.pid"))
        }
        return (location, repoPath, listener)
    }

    private func job(mode: String = "plan", repoPath: String, round: Int = 1, rework: [String] = []) -> DispatchJob {
        return DispatchJob(
            dispatchId: "d-1", itemKeys: ["AND-42"], repoPath: repoPath, mode: mode, nodeName: "Mac mini",
            round: round, reworkItemKeys: rework
        )
    }

    func testNamesASecondThreadByRoundAndTellsItAboutTheRework() async throws {
        let machine = try machine()
        defer { machine.listener.map { _ = close($0) } }
        let control = RecordingControl()
        let launcher = CodexLauncher(
            environment: try codexOnPath(), serverUrl: "https://missiongo.test",
            run: fakeCodex(), location: machine.location, control: control
        )
        let result = try await launcher.launch(job(repoPath: machine.repoPath, round: 2, rework: ["AND-42"]))

        XCTAssertEqual(result.sessionName, "Mac mini-AND-42 第2轮")
        let sent = try XCTUnwrap(control.requests.current.first)
        XCTAssertEqual(sent.name, "Mac mini-AND-42 第2轮")
        XCTAssertEqual(
            sent.prompt,
            try LaunchPrompt.build(
                itemKeys: ["AND-42"], dispatchId: "d-1", mode: "plan", reworkItemKeys: ["AND-42"],
                client: .codex, worktreePath: CodexWorkspace.worktreePath(repoPath: machine.repoPath, dispatchId: "d-1")
            )
        )
        XCTAssertTrue(sent.prompt.contains("返工"))
    }

    func testADispatchStartsAStoppedDaemonAndGoesAhead() async throws {
        // A dispatch arrives when nobody is at the machine: failing it with a
        // command to run left every Codex dispatch failed until someone came by.
        let machine = try machine(socket: false)
        let daemon = FakeDaemon(bringsUp: machine.location.controlSocketPath)
        let control = RecordingControl()
        let launcher = CodexLauncher(
            environment: try codexOnPath(), serverUrl: "https://missiongo.test",
            run: fakeCodex(daemon: daemon), location: machine.location, control: control,
            resources: FixedCodexResources(reason: nil)
        )
        _ = try await launcher.launch(job(repoPath: machine.repoPath))

        XCTAssertEqual(daemon.starts.current, 1)
        XCTAssertEqual(control.requests.current.count, 1)
    }

    func testStartsAThreadInTheRepositoryAndReportsItsLink() async throws {
        let machine = try machine()
        defer { machine.listener.map { _ = close($0) } }
        let control = RecordingControl()
        let launcher = CodexLauncher(
            environment: try codexOnPath(), serverUrl: "https://missiongo.test",
            run: fakeCodex(), location: machine.location, control: control
        )
        let result = try await launcher.launch(job(repoPath: machine.repoPath))

        XCTAssertEqual(result.sessionName, "Mac mini-AND-42")
        XCTAssertEqual(result.sessionUrl, "codex://threads/01a09f35-d6fa-7eb2-9d90-1352cf2fb661")
        XCTAssertEqual(result.sessionRef, "01a09f35-d6fa-7eb2-9d90-1352cf2fb661")
        XCTAssertNil(result.logPath)
        let sent = try XCTUnwrap(control.requests.current.first)
        XCTAssertEqual(sent.socketPath, machine.location.controlSocketPath)
        XCTAssertEqual(sent.cwd, machine.repoPath)
        XCTAssertEqual(sent.name, "Mac mini-AND-42")
        XCTAssertEqual(sent.settings, CodexModes.threadSettings(for: "plan"))
        let path = try CodexWorkspace.worktreePath(repoPath: machine.repoPath, dispatchId: "d-1")
        XCTAssertEqual(sent.workspaceRoots, [machine.repoPath, path])
        XCTAssertFalse(FileManager.default.fileExists(atPath: path), "Plan dispatch must not create the worktree")
        XCTAssertEqual(sent.prompt, try LaunchPrompt.build(
            itemKeys: ["AND-42"], dispatchId: "d-1", mode: "plan", client: .codex, worktreePath: path
        ))
    }

    func testMcpTimeoutWithLoadedThreadsRequeuesWithoutRestartingTheDaemon() async throws {
        let machine = try machine()
        defer { machine.listener.map { _ = close($0) } }
        let control = RecordingControl()
        let diagnostic = DispatchMcpDiagnostic(
            threadId: "thread-empty", startupStatus: "failed", runtimeStatus: "starting",
            error: "MCP client startup timed out"
        )
        control.startupError = CodexControlError.mcpStartup(diagnostic)
        control.startupFailures.withLock { $0 = 1 }
        control.loadedThreads = true
        let launcher = CodexLauncher(
            environment: try codexOnPath(), serverUrl: nil, run: fakeCodex(),
            location: machine.location, control: control
        )

        do {
            _ = try await launcher.launch(job(repoPath: machine.repoPath))
            XCTFail("expected a retry")
        } catch let error as LaunchError {
            XCTAssertEqual(error.retryAfterSeconds, 30)
            XCTAssertEqual(error.failureCode, "mcp_timeout")
            XCTAssertEqual(error.diagnosticSnapshot?.mcp, diagnostic)
        }
        XCTAssertEqual(control.requests.current.count, 1)
    }

    func testMcpTimeoutRestartsOnceOnlyAfterTheDaemonIsProvenIdle() async throws {
        let machine = try machine()
        defer { machine.listener.map { _ = close($0) } }
        let control = RecordingControl()
        let diagnostic = DispatchMcpDiagnostic(
            threadId: "thread-empty", startupStatus: "failed", error: "MCP client startup timed out"
        )
        control.startupError = CodexControlError.mcpStartup(diagnostic)
        control.startupFailures.withLock { $0 = 1 }
        control.loadedThreads = false
        let restarts = Locked(0)
        let base = fakeCodex()
        let run: CommandRunner = { file, args in
            if args == ["app-server", "daemon", "restart"] {
                restarts.withLock { $0 += 1 }
                return ok(#"{"status":"restarted"}"#)
            }
            return await base(file, args)
        }
        let launcher = CodexLauncher(
            environment: try codexOnPath(), serverUrl: nil, run: run,
            location: machine.location, control: control
        )

        let result = try await launcher.launch(job(repoPath: machine.repoPath))
        XCTAssertEqual(result.sessionRef, control.threadId)
        XCTAssertEqual(control.requests.current.count, 2)
        XCTAssertEqual(restarts.current, 1)
    }

    func testResourcePressureStopsBeforeCreatingAThread() async throws {
        let machine = try machine()
        defer { machine.listener.map { _ = close($0) } }
        let control = RecordingControl()
        let launcher = CodexLauncher(
            environment: try codexOnPath(), serverUrl: "https://missiongo.test",
            run: fakeCodex(), location: machine.location, control: control,
            resources: FixedCodexResources(reason: "Codex 后台服务文件描述符余量不足")
        )

        do {
            _ = try await launcher.launch(job(repoPath: machine.repoPath))
            XCTFail("expected resource pressure")
        } catch {
            XCTAssertTrue(error.localizedDescription.contains("文件描述符余量不足"))
        }
        XCTAssertTrue(control.requests.current.isEmpty)
    }

    func testRefusesAModeOutsideTheListBeforeTouchingAnything() async throws {
        let control = RecordingControl()
        let launcher = CodexLauncher(
            environment: try codexOnPath(), serverUrl: nil, run: fakeCodex(),
            location: CodexLocation(codexHome: "/nonexistent"), control: control
        )
        do {
            _ = try await launcher.launch(job(mode: "danger-full-access", repoPath: "/nonexistent"))
            XCTFail("expected a failure")
        } catch {
            XCTAssertTrue(error.localizedDescription.hasPrefix("不支持的 Codex 模式"), error.localizedDescription)
        }
        XCTAssertTrue(control.requests.current.isEmpty)
    }

    func testEachMissingPieceNamesItsFixAndStartsNothing() async throws {
        let environment = try codexOnPath()
        let cases: [(String, CommandRunner, Bool, Bool, String)] = [
            ("not logged in", fakeCodex(login: CommandResult(code: 1, stdout: "", stderr: "Not logged in\n")), true, true, "Codex 未登录"),
            // Nothing listening: the daemon is what provides that socket, so the
            // failure names the command that starts it.
            ("channel down", fakeCodex(), true, false, "codex app-server daemon start"),
            ("channel down, start says why", fakeCodex(), true, false, "daemon refused to start"),
            ("no mcp", fakeCodex(mcp: ok("[]")), true, true, "codex mcp add missiongo --url https://missiongo.test/mcp"),
            ("mcp logged out", fakeCodex(mcp: ok(#"[{"name":"missiongo","enabled":true,"auth_status":"not_logged_in"}]"#)), true, true, "codex mcp login missiongo"),
            ("no skill", fakeCodex(), false, true, "missiongo Skill"),
        ]
        for (label, run, skill, socket, expected) in cases {
            let machine = try machine(skill: skill, socket: socket)
            defer { machine.listener.map { _ = close($0) } }
            let control = RecordingControl()
            let launcher = CodexLauncher(
                environment: environment, serverUrl: "https://missiongo.test",
                run: run, location: machine.location, control: control, daemonWait: 0.2
            )
            do {
                _ = try await launcher.launch(job(repoPath: machine.repoPath))
                XCTFail("expected a failure: \(label)")
            } catch {
                XCTAssertTrue(error.localizedDescription.contains(expected), "\(label): \(error.localizedDescription)")
            }
            XCTAssertTrue(control.requests.current.isEmpty, label)
        }
    }

    func testAnUnlinkableThreadIdStillCountsAsLaunched() async throws {
        let machine = try machine()
        defer { machine.listener.map { _ = close($0) } }
        let launcher = CodexLauncher(
            environment: try codexOnPath(), serverUrl: nil, run: fakeCodex(),
            location: machine.location, control: RecordingControl(threadId: "odd/id")
        )
        let result = try await launcher.launch(job(repoPath: machine.repoPath))
        XCTAssertNil(result.sessionUrl)
        XCTAssertEqual(result.sessionName, "Mac mini-AND-42")
    }

    func testAnIdleThreadReservesThenDeliversTheQueuedWebReply() async throws {
        let control = RecordingControl(threadId: "thread-1")
        control.snapshot = CodexThreadSnapshot(
            status: "idle",
            messages: [AgentSessionMessage(sourceId: "a1", role: "agent", text: "Ready")],
            activityAt: "2026-09-21T05:30:00.000Z"
        )
        let launcher = CodexLauncher(
            environment: try codexOnPath(), serverUrl: nil, run: fakeCodex(),
            location: CodexLocation(codexHome: "/tmp/codex"), control: control
        )
        let reserved = try await launcher.synchronize(NodeAgentSession(
            id: "session-1",
            sessionRef: "thread-1",
            status: "idle",
            command: AgentSessionCommand(id: "command-1", text: "Continue")
        ))

        XCTAssertTrue(control.replies.current.isEmpty)
        XCTAssertEqual(reserved.status, "idle")
        XCTAssertEqual(reserved.commandId, "command-1")
        XCTAssertEqual(reserved.commandStatus, "delivering")

        let report = try await launcher.synchronize(NodeAgentSession(
            id: "session-1",
            sessionRef: "thread-1",
            status: "idle",
            command: AgentSessionCommand(id: "command-1", text: "Continue", status: "delivering")
        ))
        XCTAssertEqual(control.replies.current.map { [$0.0, $0.1] }, [["command-1", "Continue"]])
        XCTAssertEqual(report.status, "active")
        XCTAssertEqual(report.commandId, "command-1")
        XCTAssertEqual(report.commandStatus, "delivered")
        XCTAssertEqual(report.messages.map(\.sourceId), ["a1"])
        XCTAssertEqual(report.activityAt, "2026-09-21T05:30:00.000Z")
    }

    func testAnAlreadyMirroredCodexReplyIsAcknowledgedWithoutSendingAgain() async throws {
        let control = RecordingControl(threadId: "thread-1")
        control.snapshot = CodexThreadSnapshot(status: "idle", messages: [
            AgentSessionMessage(sourceId: "command-1", role: "user", text: "Continue")
        ])
        let launcher = CodexLauncher(
            environment: try codexOnPath(), serverUrl: nil, run: fakeCodex(),
            location: CodexLocation(codexHome: "/tmp/codex"), control: control
        )
        let report = try await launcher.synchronize(NodeAgentSession(
            id: "session-1", sessionRef: "thread-1", status: "idle",
            command: AgentSessionCommand(id: "command-1", text: "Continue", status: "delivering")
        ))
        XCTAssertEqual(report.commandStatus, "delivered")
        XCTAssertTrue(control.replies.current.isEmpty)
    }

    /// AND-219: the delivered report re-reads the thread, so the reply it just
    /// delivered travels with the delivery confirmation instead of arriving
    /// one poll later.
    func testADeliveredReplyCarriesItsMirrorInTheSameReport() async throws {
        let control = RecordingControl(threadId: "thread-1")
        control.snapshot = CodexThreadSnapshot(
            status: "idle",
            messages: [AgentSessionMessage(sourceId: "a1", role: "agent", text: "Ready")]
        )
        control.mirrorDeliveredReplies = true
        let launcher = CodexLauncher(
            environment: try codexOnPath(), serverUrl: nil, run: fakeCodex(),
            location: CodexLocation(codexHome: "/tmp/codex"), control: control
        )
        let report = try await launcher.synchronize(NodeAgentSession(
            id: "session-1", sessionRef: "thread-1", status: "idle",
            command: AgentSessionCommand(id: "command-1", text: "Continue", status: "delivering")
        ))
        XCTAssertEqual(report.commandStatus, "delivered")
        XCTAssertEqual(report.messages.map(\.sourceId), ["a1", "command-1"])
        XCTAssertEqual(report.status, "active")
        XCTAssertEqual(report.turnActive, true)
    }

    /// AND-223: Codex maps its active thread onto the turn state the console
    /// reads, the way Claude reports turnActive.
    func testAnActiveCodexThreadReportsItsTurn() async throws {
        let control = RecordingControl(threadId: "thread-1")
        control.snapshot = CodexThreadSnapshot(
            status: "active", activeTurnId: "turn-9",
            messages: [AgentSessionMessage(sourceId: "a1", role: "agent", text: "Working")]
        )
        let launcher = CodexLauncher(
            environment: try codexOnPath(), serverUrl: nil, run: fakeCodex(),
            location: CodexLocation(codexHome: "/tmp/codex"), control: control
        )
        let running = try await launcher.synchronize(NodeAgentSession(
            id: "session-1", sessionRef: "thread-1", status: "active"
        ))
        XCTAssertEqual(running.turnActive, true)

        control.snapshot = CodexThreadSnapshot(status: "idle", messages: [])
        let idle = try await launcher.synchronize(NodeAgentSession(
            id: "session-1", sessionRef: "thread-1", status: "idle"
        ))
        XCTAssertEqual(idle.turnActive, false)
    }

    func testAnUnavailableCodexThreadLeavesDeliveryForHumanConfirmation() async throws {
        let control = RecordingControl(threadId: "thread-1")
        control.snapshot = CodexThreadSnapshot(status: "unavailable", messages: [])
        let launcher = CodexLauncher(
            environment: try codexOnPath(), serverUrl: nil, run: fakeCodex(),
            location: CodexLocation(codexHome: "/tmp/codex"), control: control
        )
        let report = try await launcher.synchronize(NodeAgentSession(
            id: "session-1", sessionRef: "thread-1", status: "idle",
            command: AgentSessionCommand(id: "command-1", text: "Continue", status: "delivering")
        ))
        XCTAssertEqual(report.commandStatus, "delivery_unknown")
        XCTAssertTrue(control.replies.current.isEmpty)
    }

    func testAnActiveThreadReservesThenSteersTheQueuedWebReply() async throws {
        let control = RecordingControl(threadId: "thread-1")
        control.snapshot = CodexThreadSnapshot(status: "active", activeTurnId: "turn-9", messages: [])
        let launcher = CodexLauncher(
            environment: try codexOnPath(), serverUrl: nil, run: fakeCodex(),
            location: CodexLocation(codexHome: "/tmp/codex"), control: control
        )
        let reserved = try await launcher.synchronize(NodeAgentSession(
            id: "session-1",
            sessionRef: "thread-1",
            status: "active",
            command: AgentSessionCommand(id: "command-1", text: "Continue")
        ))

        XCTAssertTrue(control.replies.current.isEmpty)
        XCTAssertTrue(control.steerings.current.isEmpty)
        XCTAssertEqual(reserved.commandStatus, "delivering")
        XCTAssertEqual(reserved.status, "active")

        let report = try await launcher.synchronize(NodeAgentSession(
            id: "session-1",
            sessionRef: "thread-1",
            status: "active",
            command: AgentSessionCommand(id: "command-1", text: "Continue", status: "delivering")
        ))

        XCTAssertTrue(control.replies.current.isEmpty)
        XCTAssertEqual(control.steerings.current.map { [$0.0, $0.1, $0.2] }, [["command-1", "turn-9", "Continue"]])
        XCTAssertEqual(report.commandStatus, "delivered")
        XCTAssertEqual(report.status, "active")
    }

    func testAnArchivedCodexThreadIsReportedAndDoesNotReceiveAQueuedReply() async throws {
        let machine = try machine()
        defer { machine.listener.map { _ = close($0) } }
        let control = RecordingControl(threadId: "thread-1")
        control.snapshot = CodexThreadSnapshot(status: "unavailable", messages: [], archived: true)
        let launcher = CodexLauncher(
            environment: try codexOnPath(), serverUrl: nil, run: fakeCodex(),
            location: machine.location, control: control
        )
        let report = try await launcher.synchronize(NodeAgentSession(
            id: "session-1",
            sessionRef: "thread-1",
            status: "idle",
            command: AgentSessionCommand(id: "command-1", text: "Continue")
        ))

        XCTAssertTrue(control.replies.current.isEmpty)
        XCTAssertEqual(report.sourceArchived, true)
        XCTAssertEqual(report.commandStatus, "failed")
        XCTAssertTrue(report.error?.contains("归档") == true)
    }

    func testArchivesTheSourceThreadOfAFinishedConversation() async throws {
        let control = RecordingControl(threadId: "thread-1")
        control.snapshot = CodexThreadSnapshot(status: "idle", messages: [])
        let launcher = CodexLauncher(
            environment: try codexOnPath(), serverUrl: nil, run: fakeCodex(),
            location: CodexLocation(codexHome: "/tmp/codex"), control: control
        )
        let report = try await launcher.synchronize(NodeAgentSession(
            id: "session-1", sessionRef: "thread-1", status: "idle", archiveInSource: true
        ))

        XCTAssertEqual(control.archived.current, ["thread-1"])
        XCTAssertEqual(report.sourceArchived, true)
        XCTAssertEqual(report.status, "idle")
        XCTAssertNil(report.error)
    }

    func testReportsASourceArchiveThatFailedInsteadOfRetryingForever() async throws {
        let control = RecordingControl(threadId: "thread-1")
        control.snapshot = CodexThreadSnapshot(status: "idle", messages: [])
        control.archiveError = CodexControlError.rpc(method: "thread/archive", message: "thread not found")
        let launcher = CodexLauncher(
            environment: try codexOnPath(), serverUrl: nil, run: fakeCodex(),
            location: CodexLocation(codexHome: "/tmp/codex"), control: control
        )
        let report = try await launcher.synchronize(NodeAgentSession(
            id: "session-1", sessionRef: "thread-1", status: "idle", archiveInSource: true
        ))

        XCTAssertNil(report.sourceArchived)
        XCTAssertNotNil(report.sourceArchiveError)
    }

    func testRestoresTheSourceThreadOfAConversationRestoredInMissionGo() async throws {
        let control = RecordingControl(threadId: "thread-1")
        control.snapshot = CodexThreadSnapshot(status: "unavailable", messages: [], archived: true)
        control.snapshotAfterUnarchive = CodexThreadSnapshot(status: "idle", messages: [])
        let launcher = CodexLauncher(
            environment: try codexOnPath(), serverUrl: nil, run: fakeCodex(),
            location: CodexLocation(codexHome: "/tmp/codex"), control: control
        )
        let report = try await launcher.synchronize(NodeAgentSession(
            id: "session-1", sessionRef: "thread-1", status: "idle", restoreInSource: true
        ))

        XCTAssertEqual(control.unarchived.current, ["thread-1"])
        XCTAssertEqual(report.sourceRestored, true)
        XCTAssertEqual(report.sourceArchived, false)
        XCTAssertEqual(report.status, "idle")
        XCTAssertNil(report.error)
    }

    func testDecodesTheSourceArchiveRequestAndDefaultsItOff() throws {
        let asked = try JSONDecoder().decode(NodeAgentSession.self, from: Data(
            #"{"id":"s","sessionRef":"t","status":"idle","archiveInSource":true}"#.utf8
        ))
        XCTAssertTrue(asked.archiveInSource)
        XCTAssertFalse(asked.restoreInSource)
        let older = try JSONDecoder().decode(NodeAgentSession.self, from: Data(
            #"{"id":"s","sessionRef":"t","status":"idle"}"#.utf8
        ))
        XCTAssertFalse(older.archiveInSource)
    }

    func testAnActiveThreadExecutesAQueuedInterrupt() async throws {
        let control = RecordingControl(threadId: "thread-1")
        control.snapshot = CodexThreadSnapshot(status: "active", messages: [])
        let launcher = CodexLauncher(
            environment: try codexOnPath(), serverUrl: nil, run: fakeCodex(),
            location: CodexLocation(codexHome: "/tmp/codex"), control: control
        )
        let report = try await launcher.synchronize(NodeAgentSession(
            id: "session-1",
            sessionRef: "thread-1",
            status: "active",
            command: AgentSessionCommand(
                id: "command-stop", kind: "interrupt", text: "停止当前任务", turnId: "turn-9"
            )
        ))

        XCTAssertEqual(control.interruptions.current.map { [$0.0, $0.1] }, [["thread-1", "turn-9"]])
        XCTAssertEqual(report.status, "idle")
        XCTAssertEqual(report.commandId, "command-stop")
        XCTAssertEqual(report.commandStatus, "delivered")
    }

    func testPassesTheDispatchModelAndEffortToTheThread() async throws {
        let machine = try machine()
        defer { machine.listener.map { _ = close($0) } }
        let control = RecordingControl()
        let launcher = CodexLauncher(
            environment: try codexOnPath(), serverUrl: "https://missiongo.test",
            run: fakeCodex(), location: machine.location, control: control
        )
        _ = try await launcher.launch(DispatchJob(
            dispatchId: "d-1", itemKeys: ["AND-42"], repoPath: machine.repoPath, mode: "plan", nodeName: "Mac mini",
            model: "gpt-5.1-codex", effort: "high"
        ))
        let sent = try XCTUnwrap(control.requests.current.first)
        XCTAssertEqual(sent.model, "gpt-5.1-codex")
        XCTAssertEqual(sent.effort, "high")
    }

    func testRefusesAMalformedModelBeforeTouchingAnything() async throws {
        let control = RecordingControl()
        let launcher = CodexLauncher(
            environment: try codexOnPath(), serverUrl: nil, run: fakeCodex(),
            location: CodexLocation(codexHome: "/nonexistent"), control: control
        )
        do {
            _ = try await launcher.launch(DispatchJob(
                dispatchId: "d-1", itemKeys: ["AND-42"], repoPath: "/nonexistent", mode: "plan", nodeName: "M",
                model: "--dangerously-bypass-approvals-and-sandbox"
            ))
            XCTFail("expected a failure")
        } catch {
            XCTAssertTrue(error.localizedDescription.hasPrefix("不支持的模型名"), error.localizedDescription)
        }
        XCTAssertTrue(control.requests.current.isEmpty)
    }

    func testAnIdleThreadAppliesDesiredSettingsAndAcknowledgesTheRevision() async throws {
        let control = RecordingControl(threadId: "thread-1")
        control.snapshot = CodexThreadSnapshot(status: "idle", messages: [], model: "gpt-5", reasoningEffort: "medium")
        control.applyResult = CodexAppliedSettings(model: "gpt-5.1-codex", reasoningEffort: "medium")
        let launcher = CodexLauncher(
            environment: try codexOnPath(), serverUrl: nil, run: fakeCodex(),
            location: CodexLocation(codexHome: "/tmp/codex"), control: control
        )
        let report = try await launcher.synchronize(NodeAgentSession(
            id: "session-1", sessionRef: "thread-1", status: "idle",
            desiredSettings: AgentSessionSettings(revision: 3, mode: "default", model: "gpt-5.1-codex", effort: "high"),
            appliedSettingsRevision: 2
        ))

        let applied = try XCTUnwrap(control.appliedSettings.current.first)
        XCTAssertEqual(applied.0, "thread-1")
        XCTAssertEqual(applied.1, CodexTurnOverrides(
            model: "gpt-5.1-codex", effort: "high", settings: CodexModes.threadSettings(for: "default")
        ))
        XCTAssertEqual(report.settingsRevision, 3)
        XCTAssertNil(report.settingsError)
        XCTAssertEqual(report.model, "gpt-5.1-codex")
        XCTAssertEqual(report.effort, "medium")
    }

    func testAlreadyAppliedOrActiveSettingsAreNotAppliedAgain() async throws {
        let control = RecordingControl(threadId: "thread-1")
        control.snapshot = CodexThreadSnapshot(status: "active", activeTurnId: "turn-1", messages: [], model: "gpt-5")
        let launcher = CodexLauncher(
            environment: try codexOnPath(), serverUrl: nil, run: fakeCodex(),
            location: CodexLocation(codexHome: "/tmp/codex"), control: control
        )
        let desired = AgentSessionSettings(revision: 3, model: "gpt-5.1-codex")
        // A running turn keeps its settings; the change waits for an idle poll.
        let active = try await launcher.synchronize(NodeAgentSession(
            id: "session-1", sessionRef: "thread-1", status: "active", desiredSettings: desired, appliedSettingsRevision: 2
        ))
        XCTAssertNil(active.settingsRevision)
        XCTAssertEqual(active.model, "gpt-5")

        control.snapshot = CodexThreadSnapshot(status: "idle", messages: [])
        let applied = try await launcher.synchronize(NodeAgentSession(
            id: "session-1", sessionRef: "thread-1", status: "idle", desiredSettings: desired, appliedSettingsRevision: 3
        ))
        XCTAssertNil(applied.settingsRevision)
        XCTAssertTrue(control.appliedSettings.current.isEmpty)
    }

    func testAFailedSettingsChangeIsReportedForItsRevision() async throws {
        let control = RecordingControl(threadId: "thread-1")
        control.snapshot = CodexThreadSnapshot(status: "idle", messages: [])
        control.applyError = CodexControlError.rpc(method: "thread/resume", message: "unknown model")
        let launcher = CodexLauncher(
            environment: try codexOnPath(), serverUrl: nil, run: fakeCodex(),
            location: CodexLocation(codexHome: "/tmp/codex"), control: control
        )
        let failed = try await launcher.synchronize(NodeAgentSession(
            id: "session-1", sessionRef: "thread-1", status: "idle",
            desiredSettings: AgentSessionSettings(revision: 1, model: "nope")
        ))
        XCTAssertEqual(failed.settingsRevision, 1)
        XCTAssertTrue(failed.settingsError?.contains("unknown model") == true)

        // A mode outside the list never reaches Codex at all.
        let refused = try await launcher.synchronize(NodeAgentSession(
            id: "session-1", sessionRef: "thread-1", status: "idle",
            desiredSettings: AgentSessionSettings(revision: 2, mode: "danger-full-access")
        ))
        XCTAssertEqual(refused.settingsRevision, 2)
        XCTAssertTrue(refused.settingsError?.contains("不支持的 Codex 模式") == true)
    }

    func testEveryReplyCarriesTheDesiredSettings() async throws {
        let control = RecordingControl(threadId: "thread-1")
        control.snapshot = CodexThreadSnapshot(status: "idle", messages: [])
        let launcher = CodexLauncher(
            environment: try codexOnPath(), serverUrl: nil, run: fakeCodex(),
            location: CodexLocation(codexHome: "/tmp/codex"), control: control
        )
        _ = try await launcher.synchronize(NodeAgentSession(
            id: "session-1", sessionRef: "thread-1", status: "idle",
            command: AgentSessionCommand(id: "command-1", text: "Continue", status: "delivering"),
            desiredSettings: AgentSessionSettings(revision: 4, mode: "auto", model: "gpt-5.1-codex", effort: "low"),
            appliedSettingsRevision: 4
        ))
        XCTAssertEqual(control.replyOverrides.current, [CodexTurnOverrides(
            model: "gpt-5.1-codex", effort: "low", settings: CodexModes.threadSettings(for: "auto")
        )])

        _ = try await launcher.synchronize(NodeAgentSession(
            id: "session-1", sessionRef: "thread-1", status: "idle",
            command: AgentSessionCommand(id: "command-2", text: "Again", status: "delivering")
        ))
        XCTAssertEqual(control.replyOverrides.current.last, .some(nil))
    }

    func testModelListIsCachedAndAFailureReusesTheLastOne() async throws {
        let machine = try machine()
        defer { machine.listener.map { _ = close($0) } }
        let control = RecordingControl()
        let models = [AgentModelOption(id: "gpt-5.1-codex", label: "GPT-5.1 Codex", efforts: ["low", "high"], defaultEffort: "high", isDefault: true)]
        control.modelListResult = .success(models)
        let launcher = CodexLauncher(
            environment: try codexOnPath(), serverUrl: nil, run: fakeCodex(),
            location: machine.location, control: control, modelCacheTTL: 0
        )
        let first = await launcher.availableModels()
        XCTAssertEqual(first, models)
        control.modelListResult = .failure(CodexControlError.timedOut(method: "model/list"))
        let second = await launcher.availableModels()
        XCTAssertEqual(second, models)
        XCTAssertEqual(control.modelLists.current, 2)

        let cached = CodexLauncher(
            environment: try codexOnPath(), serverUrl: nil, run: fakeCodex(),
            location: machine.location, control: control
        )
        control.modelListResult = .success(models)
        _ = await cached.availableModels()
        _ = await cached.availableModels()
        XCTAssertEqual(control.modelLists.current, 3)
    }

    func testNoControlChannelReportsNoModelsWithoutStartingAnything() async throws {
        let machine = try machine(socket: false)
        let control = RecordingControl()
        let launcher = CodexLauncher(
            environment: try codexOnPath(), serverUrl: nil, run: fakeCodex(),
            location: machine.location, control: control
        )
        let models = await launcher.availableModels()
        XCTAssertEqual(models, [])
        XCTAssertEqual(control.modelLists.current, 0)
    }

    func testDetectReportsTheVersionOnlyWhenCodexIsInstalled() async throws {
        let installed = CodexLauncher(environment: try codexOnPath(), serverUrl: nil, run: fakeCodex())
        let version = await installed.detect()
        XCTAssertEqual(version, "0.154.0")
    }
}

final class SkillSyncTests: XCTestCase {
    private func skill(_ version: String) -> String {
        return "---\nname: missiongo\ndescription: x\nversion: \(version)\n---\n\n# MissionGo\n"
    }

    func testReadsTheVersionFromTheFrontMatterOnly() {
        XCTAssertEqual(SkillSync.version(ofSkill: skill("5.3.0")), "5.3.0")
        XCTAssertNil(SkillSync.version(ofSkill: "---\nname: other\nversion: 1.0.0\n---\n"))
        XCTAssertNil(SkillSync.version(ofSkill: "<html>version: 5.3.0</html>"))
        XCTAssertNil(SkillSync.version(ofSkill: "# no front matter\nname: missiongo\nversion: 5.3.0\n"))
    }

    func testComparesVersionsNumerically() {
        XCTAssertTrue(SkillSync.isNewer("5.10.0", than: "5.9.0"))
        XCTAssertTrue(SkillSync.isNewer("5.3", than: "5.2.9"))
        XCTAssertFalse(SkillSync.isNewer("5.2.0", than: "5.2.0"))
        XCTAssertFalse(SkillSync.isNewer("5.2.0", than: "5.3.0"))
    }

    func testOnlyTargetsAgentsInstalledHere() throws {
        let home = try shortTemporaryDirectory()
        try FileManager.default.createDirectory(atPath: "\(home)/.claude", withIntermediateDirectories: true)
        XCTAssertEqual(SkillSync.targets(home: home, codexHome: "\(home)/.codex"), ["\(home)/.claude/skills/missiongo/SKILL.md"])
    }

    func testWritesMissingAndOlderCopiesAndLeavesNewerOnesAndSymlinks() throws {
        let root = try shortTemporaryDirectory()
        let missing = "\(root)/a/skills/missiongo/SKILL.md"
        let older = "\(root)/b/skills/missiongo/SKILL.md"
        let newer = "\(root)/c/skills/missiongo/SKILL.md"
        let linked = "\(root)/d/skills/missiongo/SKILL.md"
        for (path, version) in [(older, "5.2.0"), (newer, "5.4.0")] {
            try FileManager.default.createDirectory(atPath: (path as NSString).deletingLastPathComponent, withIntermediateDirectories: true)
            try Data(skill(version).utf8).write(to: URL(fileURLWithPath: path))
        }
        try FileManager.default.createDirectory(atPath: "\(root)/d/skills", withIntermediateDirectories: true)
        try FileManager.default.createDirectory(atPath: "\(root)/source", withIntermediateDirectories: true)
        try Data(skill("5.0.0").utf8).write(to: URL(fileURLWithPath: "\(root)/source/SKILL.md"))
        try FileManager.default.createSymbolicLink(atPath: "\(root)/d/skills/missiongo", withDestinationPath: "\(root)/source")

        let outcome = try SkillSync.apply(skill: skill("5.3.0"), targets: [missing, older, newer, linked])

        XCTAssertEqual(outcome.version, "5.3.0")
        XCTAssertEqual(outcome.updated, [missing, older])
        XCTAssertTrue(outcome.failures.isEmpty)
        XCTAssertEqual(SkillSync.version(ofSkill: try String(contentsOfFile: missing)), "5.3.0")
        XCTAssertEqual(SkillSync.version(ofSkill: try String(contentsOfFile: older)), "5.3.0")
        XCTAssertEqual(SkillSync.version(ofSkill: try String(contentsOfFile: newer)), "5.4.0")
        XCTAssertEqual(SkillSync.version(ofSkill: try String(contentsOfFile: "\(root)/source/SKILL.md")), "5.0.0")
    }

    func testRefusesSomethingThatIsNotTheSkill() {
        XCTAssertThrowsError(try SkillSync.apply(skill: "<!doctype html>", targets: [])) {
            XCTAssertEqual($0 as? SkillSync.SyncError, .invalidSkill)
        }
    }
}
