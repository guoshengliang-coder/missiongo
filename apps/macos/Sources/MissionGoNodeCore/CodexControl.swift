import CryptoKit
import Foundation

/// Starts Codex threads through the app-server control socket.
///
/// The ChatGPT app runs a Codex app-server and listens on
/// `~/.codex/app-server-control/app-server-control.sock`, speaking JSON-RPC
/// over WebSocket over that Unix socket. A thread created there is the same
/// thread the Codex app, a remote-controlling Mac and the ChatGPT phone app all
/// show, which is the whole point: the operator watches, answers and approves
/// from there. There is no terminal and no pty, and no trust dialog to hang on.
///
/// Verified on a real machine: `initialize` → `thread/start` →
/// `thread/name/set` → `turn/start`, then disconnect. The turn keeps running
/// after this client goes away, and approval requests show up in the apps.
public protocol CodexControl: Sendable {
    /// Creates one named thread, sends its first turn and disconnects.
    /// Returns the thread id.
    func startThread(_ request: CodexThreadRequest) async throws -> String
}

public struct CodexThreadRequest: Equatable, Sendable {
    public let socketPath: String
    public let cwd: String
    public let settings: CodexThreadSettings
    public let name: String
    public let prompt: String
    public let workspaceRoots: [String]
    public let skillVersion: String?

    public init(socketPath: String, cwd: String, settings: CodexThreadSettings, name: String, prompt: String, workspaceRoots: [String] = [], skillVersion: String? = nil) {
        self.socketPath = socketPath
        self.cwd = cwd
        self.settings = settings
        self.name = name
        self.prompt = prompt
        self.workspaceRoots = workspaceRoots.isEmpty ? [cwd] : workspaceRoots
        self.skillVersion = skillVersion
    }
}

public enum CodexControlError: Error, Equatable, LocalizedError {
    case connect(path: String, reason: String)
    case handshake(String)
    case timedOut(method: String)
    case closed(method: String)
    case rpc(method: String, message: String)
    case invalidResponse(method: String)

    public var errorDescription: String? {
        switch self {
        case let .connect(path, reason):
            return "连不上 Codex 的控制通道 \(path)：\(reason)。确认 ChatGPT App 正在运行。"
        case let .handshake(detail):
            return "Codex 控制通道拒绝了连接：\(detail)"
        case let .timedOut(method):
            return "Codex 在规定时间内没有回应 \(method)。"
        case let .closed(method):
            return "Codex 控制通道在等待 \(method) 的回应时断开了。"
        case let .rpc(method, message):
            return "Codex 拒绝了 \(method)：\(message)"
        case let .invalidResponse(method):
            return "Codex 对 \(method) 的回应无法识别。"
        }
    }
}

/// The request bodies, kept apart from the socket so they can be pinned in tests.
public enum CodexProtocol {
    public static func initializeParams() -> [String: Any] {
        return [
            "clientInfo": ["name": "missiongo_macos", "title": "MissionGo", "version": "1"],
            // thread/name/set and the reviewer setting are behind this flag.
            "capabilities": ["experimentalApi": true],
        ]
    }

    public static func threadStartParams(cwd: String, settings: CodexThreadSettings, workspaceRoots: [String] = []) -> [String: Any] {
        return [
            "cwd": cwd,
            "sandbox": settings.sandbox,
            "approvalPolicy": settings.approvalPolicy,
            "approvalsReviewer": settings.approvalsReviewer,
            "runtimeWorkspaceRoots": workspaceRoots.isEmpty ? [cwd] : workspaceRoots,
        ]
    }

    /// Check the effective policy returned by the running server, not the CLI
    /// version or the presence of a field in its schema. No turn starts on a
    /// silent downgrade, unsupported field or managed-policy mismatch.
    public static func validateStarted(_ result: [String: Any], request: CodexThreadRequest) throws {
        func canonical(_ path: String) -> String {
            URL(fileURLWithPath: path).standardizedFileURL.resolvingSymlinksInPath().path
        }
        guard result["approvalsReviewer"] as? String == request.settings.approvalsReviewer,
              result["approvalPolicy"] as? String == request.settings.approvalPolicy,
              let cwd = result["cwd"] as? String, canonical(cwd) == canonical(request.cwd),
              let sandbox = result["sandbox"] as? [String: Any],
              sandbox["type"] as? String == "workspaceWrite",
              let writableRoots = sandbox["writableRoots"] as? [String],
              let runtimeRoots = result["runtimeWorkspaceRoots"] as? [String]
        else {
            throw CodexControlError.rpc(method: "thread/start", message: "Codex 未确认派单要求的审批方式或工作区沙箱；尚未启动任务。请升级 Codex 后台服务或检查组织权限策略。")
        }
        let effective = Set(([cwd] + writableRoots).map(canonical))
        let runtime = Set(runtimeRoots.map(canonical))
        guard request.workspaceRoots.allSatisfy({ effective.contains(canonical($0)) && runtime.contains(canonical($0)) }) else {
            throw CodexControlError.rpc(method: "thread/start", message: "Codex 未将本次 worktree 加入精确可写工作区；尚未启动任务。请升级 Codex 后台服务或检查工作区权限。")
        }
    }

    /// This read goes through the target thread's own MCP connection. A node
    /// credential or the CLI's "logged in" flag cannot prove these capabilities.
    public static func validateAccount(_ result: [String: Any], skillVersion: String?) throws {
        var account = result["structuredContent"] as? [String: Any]
        if account == nil, let content = result["content"] as? [[String: Any]] {
            account = content.compactMap { entry -> [String: Any]? in
                guard entry["type"] as? String == "text", let text = entry["text"] as? String else { return nil }
                return JSONValues.parse(text) as? [String: Any]
            }.first
        }
        guard !JSONValues.isTrue(result["isError"]),
              let account,
              let capabilities = account["capabilities"] as? [String: Any],
              JSONValues.isTrue(capabilities["canComment"]),
              let writeTools = capabilities["writeTools"] as? [String],
              writeTools.contains("append_comment"), writeTools.contains("claim_item") else {
            throw CodexControlError.rpc(method: "mcpServer/tool/call", message: "Codex 的 MissionGo MCP 未确认评论与领取权限；尚未启动任务。请在该节点运行 codex mcp login missiongo --scopes missiongo:read,missiongo:write 并完成授权，再派单。")
        }
        if let skillVersion {
            let expected = (account["skill"] as? [String: Any])?["expectedVersion"] as? String
            guard expected == skillVersion else {
                throw CodexControlError.rpc(method: "mcpServer/tool/call", message: "Codex 的 MissionGo Skill 版本与服务端不一致或无法核实；尚未启动任务。请等待 Skill 同步完成再派单。")
            }
        }
    }

    public static func threadNameParams(threadId: String, name: String) -> [String: Any] {
        return ["threadId": threadId, "name": name]
    }

    public static func turnStartParams(threadId: String, prompt: String) -> [String: Any] {
        return ["threadId": threadId, "input": [["type": "text", "text": prompt]]]
    }

    /// `result.thread.id` of a `thread/start` answer.
    public static func threadId(fromThreadStart result: [String: Any]) -> String? {
        guard let thread = result["thread"] as? [String: Any], let id = thread["id"] as? String, !id.isEmpty else {
            return nil
        }
        return id
    }

    static let threadIdPattern = AnchoredPattern("[A-Za-z0-9-]{1,100}")

    /// The link the console shows, or nil for an id that would not survive the
    /// server's link check — the thread still exists and is found by name.
    public static func threadLink(_ threadId: String) -> String? {
        guard threadIdPattern.matches(threadId) else { return nil }
        return "codex://threads/\(threadId)"
    }
}

public struct CodexAppServerControl: CodexControl {
    /// Per call. `thread/start` loads configuration and MCP servers, which can
    /// take a few seconds on a cold app-server.
    public let timeout: TimeInterval

    public init(timeout: TimeInterval = 30) {
        self.timeout = timeout
    }

    public func startThread(_ request: CodexThreadRequest) async throws -> String {
        let timeout = self.timeout
        return try await withCheckedThrowingContinuation { continuation in
            DispatchQueue.global().async {
                continuation.resume(with: Result { try CodexAppServerControl.startThreadSync(request, timeout: timeout) })
            }
        }
    }

    static func startThreadSync(_ request: CodexThreadRequest, timeout: TimeInterval) throws -> String {
        let connection = try JSONRPCWebSocket(socketPath: request.socketPath, timeout: timeout)
        defer { connection.close() }

        _ = try connection.call("initialize", CodexProtocol.initializeParams())
        try connection.notify("initialized")

        let started = try connection.call(
            "thread/start",
            CodexProtocol.threadStartParams(cwd: request.cwd, settings: request.settings, workspaceRoots: request.workspaceRoots)
        )
        guard let threadId = CodexProtocol.threadId(fromThreadStart: started) else {
            throw CodexControlError.invalidResponse(method: "thread/start")
        }
        try CodexProtocol.validateStarted(started, request: request)
        let account = try connection.call("mcpServer/tool/call", [
            "threadId": threadId, "server": "missiongo", "tool": "get_current_account", "arguments": [:],
        ])
        try CodexProtocol.validateAccount(account, skillVersion: request.skillVersion)
        // A thread that could not be named is still a working thread; failing the
        // dispatch here would leave it running with nobody told about it.
        _ = try? connection.call("thread/name/set", CodexProtocol.threadNameParams(threadId: threadId, name: request.name))
        _ = try connection.call("turn/start", CodexProtocol.turnStartParams(threadId: threadId, prompt: request.prompt))
        return threadId
    }
}

// MARK: - JSON-RPC over WebSocket over a Unix socket

/// Just enough WebSocket for a local JSON-RPC client: text frames out (masked,
/// as a client must), text frames in, ping answered, close honoured.
final class JSONRPCWebSocket {
    private let socket: UnixSocket
    private let timeout: TimeInterval
    private var buffer: [UInt8] = []
    private var nextId = 1

    init(socketPath: String, timeout: TimeInterval) throws {
        socket = try UnixSocket(path: socketPath, timeout: timeout)
        self.timeout = timeout
        do {
            try handshake()
        } catch {
            socket.close()
            throw error
        }
    }

    func close() {
        try? socket.write(WebSocketFrame.encode(opcode: WebSocketFrame.close, payload: [], mask: WebSocketFrame.randomMask()))
        socket.close()
    }

    private func handshake() throws {
        let key = Data((0..<16).map { _ in UInt8.random(in: 0...255) }).base64EncodedString()
        try socket.write(Array(WebSocketFrame.handshakeRequest(key: key).utf8))
        let deadline = Date().addingTimeInterval(timeout)
        let terminator: [UInt8] = Array("\r\n\r\n".utf8)
        while true {
            if let end = buffer.firstRange(of: terminator) {
                let head = String(decoding: buffer[..<end.lowerBound], as: UTF8.self)
                buffer.removeSubrange(..<end.upperBound)
                if let problem = WebSocketFrame.handshakeProblem(response: head, key: key) {
                    throw CodexControlError.handshake(problem)
                }
                return
            }
            if buffer.count > 16_384 { throw CodexControlError.handshake("响应头过长") }
            try readMore(deadline: deadline, method: "initialize")
        }
    }

    func call(_ method: String, _ params: [String: Any]) throws -> [String: Any] {
        let id = nextId
        nextId += 1
        try send(["jsonrpc": "2.0", "id": id, "method": method, "params": params])
        let deadline = Date().addingTimeInterval(timeout)
        while true {
            let message = try nextMessage(deadline: deadline, method: method)
            // A request from the server (an approval, say) carries a method. It is
            // left unanswered: once this client disconnects the app-server asks
            // the apps instead, which is where a person is.
            if message["method"] != nil { continue }
            guard let answered = JSONValues.number(message["id"]), Int(answered) == id else { continue }
            if let error = message["error"] as? [String: Any] {
                throw CodexControlError.rpc(method: method, message: error["message"] as? String ?? "未知错误")
            }
            return message["result"] as? [String: Any] ?? [:]
        }
    }

    func notify(_ method: String) throws {
        try send(["jsonrpc": "2.0", "method": method])
    }

    private func send(_ object: [String: Any]) throws {
        let data = try JSONSerialization.data(withJSONObject: object)
        try socket.write(WebSocketFrame.encode(opcode: WebSocketFrame.text, payload: Array(data), mask: WebSocketFrame.randomMask()))
    }

    private func nextMessage(deadline: Date, method: String) throws -> [String: Any] {
        var fragments: [UInt8] = []
        while true {
            while let frame = try WebSocketFrame.decode(&buffer) {
                switch frame.opcode {
                case WebSocketFrame.text, WebSocketFrame.continuation:
                    fragments += frame.payload
                    guard frame.fin else { continue }
                    let parsed = try? JSONSerialization.jsonObject(with: Data(fragments))
                    fragments = []
                    if let message = parsed as? [String: Any] { return message }
                case WebSocketFrame.ping:
                    try socket.write(WebSocketFrame.encode(opcode: WebSocketFrame.pong, payload: frame.payload, mask: WebSocketFrame.randomMask()))
                case WebSocketFrame.close:
                    throw CodexControlError.closed(method: method)
                default:
                    continue
                }
            }
            try readMore(deadline: deadline, method: method)
        }
    }

    private func readMore(deadline: Date, method: String) throws {
        while true {
            if Date() >= deadline { throw CodexControlError.timedOut(method: method) }
            switch try socket.read() {
            case let .data(bytes):
                buffer += bytes
                return
            case .closed:
                throw CodexControlError.closed(method: method)
            case .wouldBlock:
                continue
            }
        }
    }
}

enum WebSocketFrame {
    static let continuation: UInt8 = 0x0
    static let text: UInt8 = 0x1
    static let close: UInt8 = 0x8
    static let ping: UInt8 = 0x9
    static let pong: UInt8 = 0xA

    /// Far above any JSON-RPC answer this client waits for; a length beyond it
    /// is a broken stream, not a message to allocate for.
    static let maxPayload = 16 * 1024 * 1024

    struct Frame: Equatable {
        let fin: Bool
        let opcode: UInt8
        let payload: [UInt8]
    }

    struct FrameTooLarge: Error {}

    static func randomMask() -> [UInt8] {
        return (0..<4).map { _ in UInt8.random(in: 0...255) }
    }

    static func handshakeRequest(key: String) -> String {
        return "GET / HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
            + "Sec-WebSocket-Key: \(key)\r\nSec-WebSocket-Version: 13\r\n\r\n"
    }

    static func acceptValue(key: String) -> String {
        let digest = Insecure.SHA1.hash(data: Data((key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").utf8))
        return Data(digest).base64EncodedString()
    }

    /// nil when the server switched protocols for this key.
    static func handshakeProblem(response head: String, key: String) -> String? {
        let lines = head.components(separatedBy: "\r\n")
        let status = lines.first ?? ""
        guard status.hasPrefix("HTTP/1.1 101") else { return status.isEmpty ? "空响应" : status }
        let accept = lines.dropFirst().compactMap { line -> String? in
            let parts = line.split(separator: ":", maxSplits: 1)
            guard parts.count == 2, parts[0].trimmingCharacters(in: .whitespaces).lowercased() == "sec-websocket-accept" else { return nil }
            return parts[1].trimmingCharacters(in: .whitespaces)
        }.first
        guard accept == acceptValue(key: key) else { return "Sec-WebSocket-Accept 不匹配" }
        return nil
    }

    static func encode(opcode: UInt8, payload: [UInt8], mask: [UInt8]?) -> [UInt8] {
        var frame: [UInt8] = [0x80 | opcode]
        let maskBit: UInt8 = mask == nil ? 0 : 0x80
        if payload.count < 126 {
            frame.append(maskBit | UInt8(payload.count))
        } else if payload.count <= 0xFFFF {
            frame.append(maskBit | 126)
            frame += [UInt8(payload.count >> 8), UInt8(payload.count & 0xFF)]
        } else {
            frame.append(maskBit | 127)
            frame += (0..<8).reversed().map { UInt8((UInt64(payload.count) >> (UInt64($0) * 8)) & 0xFF) }
        }
        guard let mask else { return frame + payload }
        frame += mask
        frame += payload.enumerated().map { $0.element ^ mask[$0.offset % 4] }
        return frame
    }

    /// Takes one complete frame off the front of `buffer`, or returns nil and
    /// leaves the buffer alone when the frame has not fully arrived.
    static func decode(_ buffer: inout [UInt8]) throws -> Frame? {
        guard buffer.count >= 2 else { return nil }
        let fin = buffer[0] & 0x80 != 0
        let opcode = buffer[0] & 0x0F
        let masked = buffer[1] & 0x80 != 0
        var length = Int(buffer[1] & 0x7F)
        var offset = 2
        if length == 126 {
            guard buffer.count >= 4 else { return nil }
            length = Int(buffer[2]) << 8 | Int(buffer[3])
            offset = 4
        } else if length == 127 {
            guard buffer.count >= 10 else { return nil }
            var value: UInt64 = 0
            for index in 2..<10 { value = value << 8 | UInt64(buffer[index]) }
            guard value <= UInt64(maxPayload) else { throw FrameTooLarge() }
            length = Int(value)
            offset = 10
        }
        guard length <= maxPayload else { throw FrameTooLarge() }
        var mask: [UInt8] = []
        if masked {
            guard buffer.count >= offset + 4 else { return nil }
            mask = Array(buffer[offset..<offset + 4])
            offset += 4
        }
        guard buffer.count >= offset + length else { return nil }
        var payload = Array(buffer[offset..<offset + length])
        if masked {
            for index in payload.indices { payload[index] ^= mask[index % 4] }
        }
        buffer.removeSubrange(..<(offset + length))
        return Frame(fin: fin, opcode: opcode, payload: payload)
    }
}

/// A connected, blocking Unix domain socket with send and receive timeouts.
final class UnixSocket {
    enum ReadResult {
        case data([UInt8])
        case closed
        /// The receive timeout passed with nothing to read.
        case wouldBlock
    }

    private let descriptor: Int32
    private let closed = Locked(false)

    init(path: String, timeout: TimeInterval) throws {
        let descriptor = socket(AF_UNIX, SOCK_STREAM, 0)
        guard descriptor >= 0 else { throw CodexControlError.connect(path: path, reason: UnixSocket.errnoText()) }

        // A peer that goes away mid-write must come back as an error, not SIGPIPE.
        var one: Int32 = 1
        setsockopt(descriptor, SOL_SOCKET, SO_NOSIGPIPE, &one, socklen_t(MemoryLayout<Int32>.size))
        // Short slices, so the caller's own deadline is checked regularly.
        let slice = min(timeout, 1)
        var interval = timeval(tv_sec: Int(slice), tv_usec: Int32((slice - floor(slice)) * 1_000_000))
        setsockopt(descriptor, SOL_SOCKET, SO_RCVTIMEO, &interval, socklen_t(MemoryLayout<timeval>.size))
        var sendInterval = timeval(tv_sec: Int(max(timeout, 1)), tv_usec: 0)
        setsockopt(descriptor, SOL_SOCKET, SO_SNDTIMEO, &sendInterval, socklen_t(MemoryLayout<timeval>.size))

        var address = sockaddr_un()
        address.sun_family = sa_family_t(AF_UNIX)
        let bytes = Array(path.utf8)
        let capacity = MemoryLayout.size(ofValue: address.sun_path)
        guard bytes.count < capacity else {
            Darwin.close(descriptor)
            throw CodexControlError.connect(path: path, reason: "路径超过 \(capacity - 1) 字节")
        }
        withUnsafeMutableBytes(of: &address.sun_path) { raw in
            raw.copyBytes(from: bytes)
        }
        address.sun_len = UInt8(MemoryLayout<sockaddr_un>.size)
        let result = withUnsafePointer(to: &address) { pointer in
            pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                connect(descriptor, $0, socklen_t(MemoryLayout<sockaddr_un>.size))
            }
        }
        guard result == 0 else {
            let reason = UnixSocket.errnoText()
            Darwin.close(descriptor)
            throw CodexControlError.connect(path: path, reason: reason)
        }
        self.descriptor = descriptor
    }

    deinit {
        close()
    }

    func write(_ bytes: [UInt8]) throws {
        var sent = 0
        while sent < bytes.count {
            let count = bytes[sent...].withUnsafeBytes { raw in
                Darwin.send(descriptor, raw.baseAddress, raw.count, 0)
            }
            if count < 0 {
                if errno == EINTR { continue }
                throw CodexControlError.connect(path: "", reason: "写入失败：\(UnixSocket.errnoText())")
            }
            sent += count
        }
    }

    func read() throws -> ReadResult {
        var chunk = [UInt8](repeating: 0, count: 65_536)
        let count = chunk.withUnsafeMutableBytes { raw in
            recv(descriptor, raw.baseAddress, raw.count, 0)
        }
        if count > 0 { return .data(Array(chunk[..<count])) }
        if count == 0 { return .closed }
        if errno == EAGAIN || errno == EWOULDBLOCK || errno == EINTR { return .wouldBlock }
        throw CodexControlError.connect(path: "", reason: "读取失败：\(UnixSocket.errnoText())")
    }

    func close() {
        let first = closed.withLock { value -> Bool in
            defer { value = true }
            return !value
        }
        if first { Darwin.close(descriptor) }
    }

    static func errnoText() -> String {
        return String(cString: strerror(errno))
    }
}
