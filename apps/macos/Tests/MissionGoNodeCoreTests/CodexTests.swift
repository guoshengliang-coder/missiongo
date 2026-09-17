import XCTest
@testable import MissionGoNodeCore

private func ok(_ stdout: String) -> CommandResult {
    return CommandResult(code: 0, stdout: stdout, stderr: "")
}

private let mcpReady = #"[{"name":"missiongo","enabled":true,"disabled_reason":null,"transport":{"type":"streamable_http","url":"https://missiongo.test/mcp"},"auth_status":"o_auth"}]"#

/// A `codex` that answers the three commands the preflight runs.
private func fakeCodex(
    login: CommandResult = CommandResult(code: 0, stdout: "", stderr: "Logged in using ChatGPT\n"),
    mcp: CommandResult = ok(mcpReady)
) -> CommandRunner {
    return { file, args in
        precondition(file.hasSuffix("codex"), "unexpected command: \(file)")
        switch args.first {
        case "--version": return ok("codex-cli 0.154.0\n")
        case "login": return login
        case "mcp": return mcp
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
private func shortTemporaryDirectory() throws -> String {
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
private final class FakeAppServer: @unchecked Sendable {
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
    static func happy(threadId: String = "01a09f35-d6fa-7eb2-9d90-1352cf2fb661") throws -> FakeAppServer {
        return try FakeAppServer { message in
            guard let id = message["id"], let method = message["method"] as? String else { return [] }
            switch method {
            case "thread/start":
                return [
                    // Notifications and a server request arrive before the answer.
                    ["jsonrpc": "2.0", "method": "thread/started", "params": ["thread": ["id": threadId]]],
                    ["jsonrpc": "2.0", "id": 900, "method": "item/commandExecution/requestApproval", "params": [:]],
                    ["jsonrpc": "2.0", "id": id, "result": ["thread": ["id": threadId]]],
                ]
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
        XCTAssertEqual(CodexModes.threadSettings(for: "plan")?.approvalsReviewer, "user")
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
    func testPlanModeAsksForACommentAndAStopBeforeClaiming() throws {
        XCTAssertEqual(
            try LaunchPrompt.build(itemKeys: ["HG-8"], dispatchId: "abc", mode: "plan"),
            [
                "使用 missiongo skill 处理这些工作条目：HG-8。",
                "",
                "本会话由 MissionGo 派单 abc 发起，上面列出的编号等同于用户给出的范围。",
                "整批条目走一个分支和一个 PR，之后按 Skill 的规则推进条目状态。",
                "会话起在仓库主目录，动手改代码前先按仓库规则建独立 worktree，不要直接在主工作区修改。",
                "建 worktree 用 git worktree add 再 cd 进去；不要用 EnterWorktree 一类的工具——仓库规定的 worktree 位置在它默认放行的范围之外，它会弹出授权框，而派单会话旁边没有人能回答。",
                "",
                "本次派单是计划模式：先完整读取条目，给出处理计划，把计划写成结构化评论回写到各条条目，然后在本会话里停下，等用户批准。",
                "用户批准之前不领取条目、不建分支、不改代码。",
            ].joined(separator: "\n")
        )
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
        // The default reviewer is not sent, so an app-server without the field still works.
        XCTAssertNil(plan["approvalsReviewer"])

        let auto = CodexProtocol.threadStartParams(cwd: "/repo", settings: CodexModes.threadSettings(for: "auto")!)
        XCTAssertEqual(auto["approvalsReviewer"] as? String, "auto_review")
    }

    func testTurnStartSendsThePromptAsOneTextInput() throws {
        let params = CodexProtocol.turnStartParams(threadId: "t1", prompt: "do it")
        XCTAssertEqual(params["threadId"] as? String, "t1")
        let input = params["input"] as? [[String: Any]]
        XCTAssertEqual(input?.count, 1)
        XCTAssertEqual(input?.first?["type"] as? String, "text")
        XCTAssertEqual(input?.first?["text"] as? String, "do it")
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
        XCTAssertEqual(server.methods, ["initialize", "initialized", "thread/start", "thread/name/set", "turn/start"])
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

        let down = await CodexStatus.check(environment: environment, location: location, run: fakeCodex())
        XCTAssertEqual(down, .daemonNotRunning(version: "0.154.0", path: location.controlSocketPath))
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

        let ready = await CodexStatus.check(environment: environment, location: location, run: fakeCodex())
        XCTAssertEqual(ready, .ready(version: "0.154.0"))
        XCTAssertEqual(ready.summary, "0.154.0")
        XCTAssertFalse(ready.needsAttention)
    }

    func testFindsCodexHomeFromTheEnvironment() {
        XCTAssertEqual(CodexLocation(environment: ShellEnvironment(path: "/bin", base: [:]), home: "/Users/dev").codexHome, "/Users/dev/.codex")
        XCTAssertEqual(
            CodexLocation(environment: ShellEnvironment(path: "/bin", base: ["CODEX_HOME": "/opt/codex"]), home: "/Users/dev").controlSocketPath,
            "/opt/codex/app-server-control/app-server-control.sock"
        )
    }
}

private final class RecordingControl: CodexControl, @unchecked Sendable {
    let requests = Locked<[CodexThreadRequest]>([])
    let threadId: String

    init(threadId: String = "01a09f35-d6fa-7eb2-9d90-1352cf2fb661") {
        self.threadId = threadId
    }

    func startThread(_ request: CodexThreadRequest) async throws -> String {
        requests.withLock { $0.append(request) }
        return threadId
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
            try LaunchPrompt.build(itemKeys: ["AND-42"], dispatchId: "d-1", mode: "plan", reworkItemKeys: ["AND-42"])
        )
        XCTAssertTrue(sent.prompt.contains("返工"))
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
        XCTAssertNil(result.logPath)
        let sent = try XCTUnwrap(control.requests.current.first)
        XCTAssertEqual(sent.socketPath, machine.location.controlSocketPath)
        XCTAssertEqual(sent.cwd, machine.repoPath)
        XCTAssertEqual(sent.name, "Mac mini-AND-42")
        XCTAssertEqual(sent.settings, CodexModes.threadSettings(for: "plan"))
        // The same prompt Claude Code gets, plan paragraph included.
        XCTAssertEqual(sent.prompt, try LaunchPrompt.build(itemKeys: ["AND-42"], dispatchId: "d-1", mode: "plan"))
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
                run: run, location: machine.location, control: control
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
