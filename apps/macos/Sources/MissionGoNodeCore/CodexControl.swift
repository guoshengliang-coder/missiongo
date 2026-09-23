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
    func readThread(socketPath: String, threadId: String) async throws -> CodexThreadSnapshot
    /// `overrides` carry the settings a person chose for this conversation;
    /// Codex keeps turn-level overrides for the turns after it too.
    func sendMessage(socketPath: String, threadId: String, text: String, clientUserMessageId: String, overrides: CodexTurnOverrides?) async throws
    func steerMessage(socketPath: String, threadId: String, turnId: String, text: String, clientUserMessageId: String) async throws
    func interruptTurn(socketPath: String, threadId: String, turnId: String) async throws
    func archiveThread(socketPath: String, threadId: String) async throws
    func unarchiveThread(socketPath: String, threadId: String) async throws
    /// Switches an idle thread's model, approvals and sandbox without starting a turn.
    func applySettings(socketPath: String, threadId: String, overrides: CodexTurnOverrides) async throws -> CodexAppliedSettings
    /// The models this app-server offers, hidden ones left out.
    func listModels(socketPath: String) async throws -> [AgentModelOption]
}

public extension CodexControl {
    func readThread(socketPath: String, threadId: String) async throws -> CodexThreadSnapshot {
        throw CodexControlError.rpc(method: "thread/read", message: "这个 Codex 控制器不支持读取会话。")
    }

    func sendMessage(socketPath: String, threadId: String, text: String, clientUserMessageId: String, overrides: CodexTurnOverrides?) async throws {
        throw CodexControlError.rpc(method: "turn/start", message: "这个 Codex 控制器不支持回复会话。")
    }

    func steerMessage(socketPath: String, threadId: String, turnId: String, text: String, clientUserMessageId: String) async throws {
        throw CodexControlError.rpc(method: "turn/steer", message: "这个 Codex 控制器不支持引导当前回合。")
    }

    func interruptTurn(socketPath: String, threadId: String, turnId: String) async throws {
        throw CodexControlError.rpc(method: "turn/interrupt", message: "这个 Codex 控制器不支持中断会话。")
    }

    func archiveThread(socketPath: String, threadId: String) async throws {
        throw CodexControlError.rpc(method: "thread/archive", message: "这个 Codex 控制器不支持归档会话。")
    }

    func unarchiveThread(socketPath: String, threadId: String) async throws {
        throw CodexControlError.rpc(method: "thread/unarchive", message: "这个 Codex 控制器不支持恢复会话。")
    }

    func applySettings(socketPath: String, threadId: String, overrides: CodexTurnOverrides) async throws -> CodexAppliedSettings {
        throw CodexControlError.rpc(method: "thread/resume", message: "这个 Codex 控制器不支持切换会话设置。")
    }

    func listModels(socketPath: String) async throws -> [AgentModelOption] {
        throw CodexControlError.rpc(method: "model/list", message: "这个 Codex 控制器不支持列出模型。")
    }
}

/// Settings a person chose for a running thread, sent with `thread/resume`
/// and every `turn/start` MissionGo sends for it. nil fields are left out.
public struct CodexTurnOverrides: Equatable, Sendable {
    public let model: String?
    public let effort: String?
    public let settings: CodexThreadSettings?

    public init(model: String? = nil, effort: String? = nil, settings: CodexThreadSettings? = nil) {
        self.model = model
        self.effort = effort
        self.settings = settings
    }

    /// Checks what arrived over the wire, as a launch does: a mode maps to the
    /// fixed thread settings of `CodexModes`, never to raw policy names.
    public init(desired: AgentSessionSettings) throws {
        var settings: CodexThreadSettings?
        if let mode = desired.mode {
            guard let mapped = CodexModes.threadSettings(for: mode) else {
                throw LaunchError("不支持的 Codex 模式：\(JSONValues.quote(mode))")
            }
            settings = mapped
        }
        if let problem = AgentModelSettings.problem(model: desired.model, effort: desired.effort) {
            throw LaunchError(problem)
        }
        self.init(model: desired.model, effort: desired.effort, settings: settings)
    }
}

/// What `thread/resume` reports the thread now runs with.
public struct CodexAppliedSettings: Equatable, Sendable {
    public let model: String?
    public let reasoningEffort: String?

    public init(model: String? = nil, reasoningEffort: String? = nil) {
        self.model = model
        self.reasoningEffort = reasoningEffort
    }
}

public struct CodexThreadSnapshot: Equatable, Sendable {
    public let status: String
    public let activeTurnId: String?
    public let messages: [AgentSessionMessage]
    public let archived: Bool
    public let activityAt: String?
    /// `thread.model` / `thread.reasoningEffort` as `thread/read` reports them.
    public let model: String?
    public let reasoningEffort: String?

    public init(
        status: String,
        activeTurnId: String? = nil,
        messages: [AgentSessionMessage],
        archived: Bool = false,
        activityAt: String? = nil,
        model: String? = nil,
        reasoningEffort: String? = nil
    ) {
        self.status = status
        self.activeTurnId = activeTurnId
        self.messages = messages
        self.archived = archived
        self.activityAt = activityAt
        self.model = model
        self.reasoningEffort = reasoningEffort
    }
}

public struct CodexThreadRequest: Equatable, Sendable {
    public let socketPath: String
    public let cwd: String
    public let settings: CodexThreadSettings
    public let name: String
    public let prompt: String
    public let workspaceRoots: [String]
    public let skillVersion: String?
    /// nil leaves the choice to Codex's own configuration.
    public let model: String?
    public let effort: String?

    public init(
        socketPath: String,
        cwd: String,
        settings: CodexThreadSettings,
        name: String,
        prompt: String,
        workspaceRoots: [String] = [],
        skillVersion: String? = nil,
        model: String? = nil,
        effort: String? = nil
    ) {
        self.socketPath = socketPath
        self.cwd = cwd
        self.settings = settings
        self.name = name
        self.prompt = prompt
        self.workspaceRoots = workspaceRoots.isEmpty ? [cwd] : workspaceRoots
        self.skillVersion = skillVersion
        self.model = model
        self.effort = effort
    }
}

public enum CodexControlError: Error, Equatable, LocalizedError {
    case connect(path: String, reason: String)
    case handshake(String)
    case timedOut(method: String)
    case closed(method: String)
    case rpc(method: String, message: String)
    case invalidResponse(method: String)
    case mcpAuthorization
    case skillStale

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
        case .mcpAuthorization:
            return "Codex 的 MissionGo MCP 未确认评论与领取权限；尚未启动任务。请在该节点重新完成 MCP 授权。"
        case .skillStale:
            return "Codex 的 MissionGo Skill 版本与服务端不一致或无法核实；尚未启动任务。请等待 Skill 同步完成再派单。"
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

    public static func threadStartParams(
        cwd: String,
        settings: CodexThreadSettings,
        workspaceRoots: [String] = [],
        model: String? = nil
    ) -> [String: Any] {
        var params: [String: Any] = [
            "cwd": cwd,
            "sandbox": settings.sandbox,
            "approvalPolicy": settings.approvalPolicy,
            "approvalsReviewer": settings.approvalsReviewer,
            "runtimeWorkspaceRoots": workspaceRoots.isEmpty ? [cwd] : workspaceRoots,
        ]
        // Left out rather than null: absent is Codex's own configured model.
        if let model { params["model"] = model }
        return params
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
            throw CodexControlError.mcpAuthorization
        }
        if let skillVersion {
            let expected = (account["skill"] as? [String: Any])?["expectedVersion"] as? String
            guard expected == skillVersion else {
                throw CodexControlError.skillStale
            }
        }
    }

    public static func threadNameParams(threadId: String, name: String) -> [String: Any] {
        return ["threadId": threadId, "name": name]
    }

    public static func turnStartParams(
        threadId: String,
        prompt: String,
        clientUserMessageId: String? = nil,
        overrides: CodexTurnOverrides? = nil
    ) -> [String: Any] {
        var params: [String: Any] = ["threadId": threadId, "input": [["type": "text", "text": prompt]]]
        if let clientUserMessageId { params["clientUserMessageId"] = clientUserMessageId }
        if let model = overrides?.model { params["model"] = model }
        if let effort = overrides?.effort { params["effort"] = effort }
        if let settings = overrides?.settings {
            params["approvalPolicy"] = settings.approvalPolicy
            params["approvalsReviewer"] = settings.approvalsReviewer
        }
        return params
    }

    public static func turnSteerParams(
        threadId: String,
        turnId: String,
        prompt: String,
        clientUserMessageId: String
    ) -> [String: Any] {
        return [
            "threadId": threadId,
            "expectedTurnId": turnId,
            "input": [["type": "text", "text": prompt]],
            "clientUserMessageId": clientUserMessageId,
        ]
    }

    public static func threadReadParams(threadId: String) -> [String: Any] {
        return ["threadId": threadId, "includeTurns": true]
    }

    public static func archivedThreadListParams(cursor: String? = nil) -> [String: Any] {
        var params: [String: Any] = [
            "archived": true,
            "limit": 100,
            "sortKey": "updated_at",
            "sortDirection": "desc",
            "useStateDbOnly": true,
            // An omitted or empty sourceKinds list defaults to interactive
            // threads and would miss sessions MissionGo created via app-server.
            "sourceKinds": [
                "cli", "vscode", "exec", "appServer", "subAgent", "subAgentReview",
                "subAgentCompact", "subAgentThreadSpawn", "subAgentOther", "unknown",
            ],
        ]
        if let cursor { params["cursor"] = cursor }
        return params
    }

    public static func threadListPage(_ result: [String: Any]) throws -> (ids: Set<String>, nextCursor: String?) {
        guard let data = result["data"] as? [[String: Any]] else {
            throw CodexControlError.invalidResponse(method: "thread/list")
        }
        let ids = Set(data.compactMap { entry -> String? in
            guard let id = entry["id"] as? String, !id.isEmpty else { return nil }
            return id
        })
        return (ids, result["nextCursor"] as? String)
    }

    public static func threadArchiveParams(threadId: String) -> [String: Any] {
        return ["threadId": threadId]
    }

    public static func threadUnarchiveParams(threadId: String) -> [String: Any] {
        return ["threadId": threadId]
    }

    /// `thread/resume` takes no effort; that one rides on the next `turn/start`.
    public static func threadResumeParams(threadId: String, overrides: CodexTurnOverrides? = nil) -> [String: Any] {
        var params: [String: Any] = ["threadId": threadId]
        if let model = overrides?.model { params["model"] = model }
        if let settings = overrides?.settings {
            params["approvalPolicy"] = settings.approvalPolicy
            params["approvalsReviewer"] = settings.approvalsReviewer
            params["sandbox"] = settings.sandbox
        }
        return params
    }

    public static func appliedSettings(fromResume result: [String: Any]) -> CodexAppliedSettings {
        let thread = result["thread"] as? [String: Any]
        return CodexAppliedSettings(
            model: (result["model"] as? String) ?? (thread?["model"] as? String),
            reasoningEffort: (result["reasoningEffort"] as? String) ?? (thread?["reasoningEffort"] as? String)
        )
    }

    public static func modelListParams(cursor: String? = nil) -> [String: Any] {
        var params: [String: Any] = ["includeHidden": false, "limit": 100]
        if let cursor { params["cursor"] = cursor }
        return params
    }

    /// One `model/list` page. Hidden models are skipped even if the server
    /// sends them: they are not meant to be picked.
    public static func modelListPage(_ result: [String: Any]) throws -> (models: [AgentModelOption], nextCursor: String?) {
        guard let data = result["data"] as? [[String: Any]] else {
            throw CodexControlError.invalidResponse(method: "model/list")
        }
        let models = data.compactMap { entry -> AgentModelOption? in
            guard !JSONValues.isTrue(entry["hidden"]) else { return nil }
            // `model` is what thread/start and turn/start take; `id` is the
            // catalogue key, used only when a server leaves `model` out.
            guard let id = (entry["model"] as? String).flatMap({ $0.isEmpty ? nil : $0 })
                    ?? (entry["id"] as? String).flatMap({ $0.isEmpty ? nil : $0 })
            else { return nil }
            let efforts = (entry["supportedReasoningEfforts"] as? [[String: Any]] ?? [])
                .compactMap { $0["reasoningEffort"] as? String }
            let label = (entry["displayName"] as? String).flatMap { $0.isEmpty ? nil : $0 } ?? id
            return AgentModelOption(
                id: id,
                label: label,
                efforts: efforts,
                defaultEffort: entry["defaultReasoningEffort"] as? String,
                isDefault: JSONValues.bool(entry["isDefault"])
            )
        }
        return (models, result["nextCursor"] as? String)
    }

    public static func turnInterruptParams(threadId: String, turnId: String) -> [String: Any] {
        return ["threadId": threadId, "turnId": turnId]
    }

    public static func threadSnapshot(fromRead result: [String: Any]) throws -> CodexThreadSnapshot {
        guard let thread = result["thread"] as? [String: Any] else {
            throw CodexControlError.invalidResponse(method: "thread/read")
        }
        let type = (thread["status"] as? [String: Any])?["type"] as? String
        let status: String
        switch type {
        case "active": status = "active"
        case "idle": status = "idle"
        case "systemError": status = "failed"
        // Codex unloads completed threads from memory. A reply resumes the
        // thread before starting its next turn, so this is an idle, recoverable
        // state rather than a broken conversation.
        case "notLoaded": status = "idle"
        default: status = "unavailable"
        }

        let turns = thread["turns"] as? [[String: Any]] ?? []
        let activeTurnId = turns.last(where: { $0["status"] as? String == "inProgress" })?["id"] as? String
        var messages: [AgentSessionMessage] = []
        for turn in turns {
            let turnId = turn["id"] as? String
            for item in turn["items"] as? [[String: Any]] ?? [] {
                guard let sourceId = item["id"] as? String,
                      let itemType = item["type"] as? String else { continue }
                let occurredAt = sourceActivityTimestamp(
                    item["createdAt"] ?? item["created_at"] ?? item["timestamp"]
                )
                switch itemType {
                case "userMessage":
                    let parts = (item["content"] as? [[String: Any]] ?? []).compactMap { content -> String? in
                        guard content["type"] as? String == "text" else { return nil }
                        return content["text"] as? String
                    }
                    let text = parts.joined(separator: "\n").trimmingCharacters(in: .whitespacesAndNewlines)
                    if !text.isEmpty {
                        messages.append(AgentSessionMessage(
                            sourceId: sourceId, turnId: turnId, role: "user", text: text,
                            occurredAt: occurredAt
                        ))
                    }
                case "agentMessage":
                    let questions = (item["questions"] as? [[String: Any]])?.compactMap { question -> AgentSessionQuestion? in
                        guard let title = question["title"] as? String, !title.isEmpty else { return nil }
                        return AgentSessionQuestion(title: title, options: question["options"] as? [String])
                    }
                    var text = (item["text"] as? String ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
                    if text.isEmpty, let questions, !questions.isEmpty {
                        text = questions.map(\.title).joined(separator: "\n")
                    }
                    if !text.isEmpty {
                        messages.append(AgentSessionMessage(
                            sourceId: sourceId,
                            turnId: turnId,
                            role: "agent",
                            phase: item["phase"] as? String,
                            text: text,
                            occurredAt: occurredAt,
                            questions: questions
                        ))
                    }
                case "plan":
                    let text = (item["text"] as? String ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
                    if !text.isEmpty {
                        messages.append(AgentSessionMessage(
                            sourceId: sourceId, turnId: turnId, role: "plan", text: text,
                            occurredAt: occurredAt
                        ))
                    }
                default:
                    continue
                }
            }
        }
        return CodexThreadSnapshot(
            status: status,
            activeTurnId: activeTurnId,
            messages: messages,
            activityAt: sourceActivityTimestamp(thread["updatedAt"] ?? thread["updated_at"]),
            model: thread["model"] as? String,
            reasoningEffort: thread["reasoningEffort"] as? String
        )
    }

    static func sourceActivityTimestamp(_ value: Any?) -> String? {
        let date: Date?
        if let number = value as? NSNumber {
            let raw = number.doubleValue
            date = Date(timeIntervalSince1970: raw > 10_000_000_000 ? raw / 1_000 : raw)
        } else if let text = value as? String {
            let fractional = ISO8601DateFormatter()
            fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
            date = fractional.date(from: text) ?? ISO8601DateFormatter().date(from: text)
        } else {
            date = nil
        }
        guard let date else { return nil }
        let output = ISO8601DateFormatter()
        output.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return output.string(from: date)
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

private final class CodexArchiveCache: @unchecked Sendable {
    private struct Entry {
        let ids: Set<String>
        let expiresAt: Date
    }

    private let entries = Locked<[String: Entry]>([:])
    private let ttl: TimeInterval

    init(ttl: TimeInterval = 15) {
        self.ttl = ttl
    }

    func value(socketPath: String, load: () throws -> Set<String>) throws -> Set<String> {
        let now = Date()
        if let cached = entries.withLock({ $0[socketPath] }), cached.expiresAt > now {
            return cached.ids
        }
        do {
            let ids = try load()
            entries.withLock { $0[socketPath] = Entry(ids: ids, expiresAt: now.addingTimeInterval(ttl)) }
            return ids
        } catch {
            if let stale = entries.withLock({ $0[socketPath] }) { return stale.ids }
            throw error
        }
    }

    /// After MissionGo itself archives or restores a thread the cached list is
    /// wrong for up to its whole lifetime; drop it so the next read asks again.
    func forget(socketPath: String) {
        entries.withLock { $0[socketPath] = nil }
    }
}

public struct CodexAppServerControl: CodexControl {
    /// Per call. `thread/start` loads configuration and MCP servers, which can
    /// take a few seconds on a cold app-server.
    public let timeout: TimeInterval
    private let archiveCache: CodexArchiveCache

    public init(timeout: TimeInterval = 30) {
        self.timeout = timeout
        archiveCache = CodexArchiveCache()
    }

    public func startThread(_ request: CodexThreadRequest) async throws -> String {
        let timeout = self.timeout
        return try await withCheckedThrowingContinuation { continuation in
            DispatchQueue.global().async {
                continuation.resume(with: Result { try CodexAppServerControl.startThreadSync(request, timeout: timeout) })
            }
        }
    }

    public func readThread(socketPath: String, threadId: String) async throws -> CodexThreadSnapshot {
        let timeout = self.timeout
        let archiveCache = self.archiveCache
        return try await withCheckedThrowingContinuation { continuation in
            DispatchQueue.global().async {
                continuation.resume(with: Result {
                    let connection = try JSONRPCWebSocket(socketPath: socketPath, timeout: timeout)
                    defer { connection.close() }
                    _ = try connection.call("initialize", CodexProtocol.initializeParams())
                    try connection.notify("initialized")
                    let archived = (try? archiveCache.value(socketPath: socketPath) {
                        try CodexAppServerControl.archivedThreadIds(connection: connection)
                    }.contains(threadId)) ?? false
                    if archived {
                        return CodexThreadSnapshot(status: "unavailable", messages: [], archived: true)
                    }
                    let result = try connection.call("thread/read", CodexProtocol.threadReadParams(threadId: threadId))
                    return try CodexProtocol.threadSnapshot(fromRead: result)
                })
            }
        }
    }

    public func archiveThread(socketPath: String, threadId: String) async throws {
        try await archiveCall("thread/archive", socketPath: socketPath, threadId: threadId)
    }

    public func unarchiveThread(socketPath: String, threadId: String) async throws {
        try await archiveCall("thread/unarchive", socketPath: socketPath, threadId: threadId)
    }

    private func archiveCall(_ method: String, socketPath: String, threadId: String) async throws {
        let timeout = self.timeout
        let archiveCache = self.archiveCache
        return try await withCheckedThrowingContinuation { continuation in
            DispatchQueue.global().async {
                continuation.resume(with: Result {
                    defer { archiveCache.forget(socketPath: socketPath) }
                    let connection = try JSONRPCWebSocket(socketPath: socketPath, timeout: timeout)
                    defer { connection.close() }
                    _ = try connection.call("initialize", CodexProtocol.initializeParams())
                    try connection.notify("initialized")
                    let params = method == "thread/archive"
                        ? CodexProtocol.threadArchiveParams(threadId: threadId)
                        : CodexProtocol.threadUnarchiveParams(threadId: threadId)
                    _ = try connection.call(method, params)
                })
            }
        }
    }

    private static func archivedThreadIds(connection: JSONRPCWebSocket) throws -> Set<String> {
        var ids = Set<String>()
        var cursor: String?
        var seenCursors = Set<String>()
        repeat {
            let result = try connection.call("thread/list", CodexProtocol.archivedThreadListParams(cursor: cursor))
            let page = try CodexProtocol.threadListPage(result)
            ids.formUnion(page.ids)
            cursor = page.nextCursor
            if let cursor, !seenCursors.insert(cursor).inserted {
                throw CodexControlError.invalidResponse(method: "thread/list")
            }
        } while cursor != nil
        return ids
    }

    public func sendMessage(socketPath: String, threadId: String, text: String, clientUserMessageId: String, overrides: CodexTurnOverrides?) async throws {
        let timeout = self.timeout
        return try await withCheckedThrowingContinuation { continuation in
            DispatchQueue.global().async {
                continuation.resume(with: Result {
                    let connection = try JSONRPCWebSocket(socketPath: socketPath, timeout: timeout)
                    defer { connection.close() }
                    _ = try connection.call("initialize", CodexProtocol.initializeParams())
                    try connection.notify("initialized")
                    _ = try connection.call(
                        "thread/resume",
                        CodexProtocol.threadResumeParams(threadId: threadId, overrides: overrides)
                    )
                    _ = try connection.call(
                        "turn/start",
                        CodexProtocol.turnStartParams(
                            threadId: threadId,
                            prompt: text,
                            clientUserMessageId: clientUserMessageId,
                            overrides: overrides
                        )
                    )
                })
            }
        }
    }

    public func applySettings(socketPath: String, threadId: String, overrides: CodexTurnOverrides) async throws -> CodexAppliedSettings {
        let timeout = self.timeout
        return try await withCheckedThrowingContinuation { continuation in
            DispatchQueue.global().async {
                continuation.resume(with: Result {
                    let connection = try JSONRPCWebSocket(socketPath: socketPath, timeout: timeout)
                    defer { connection.close() }
                    _ = try connection.call("initialize", CodexProtocol.initializeParams())
                    try connection.notify("initialized")
                    let result = try connection.call(
                        "thread/resume",
                        CodexProtocol.threadResumeParams(threadId: threadId, overrides: overrides)
                    )
                    return CodexProtocol.appliedSettings(fromResume: result)
                })
            }
        }
    }

    public func listModels(socketPath: String) async throws -> [AgentModelOption] {
        let timeout = self.timeout
        return try await withCheckedThrowingContinuation { continuation in
            DispatchQueue.global().async {
                continuation.resume(with: Result {
                    let connection = try JSONRPCWebSocket(socketPath: socketPath, timeout: timeout)
                    defer { connection.close() }
                    _ = try connection.call("initialize", CodexProtocol.initializeParams())
                    try connection.notify("initialized")
                    var models: [AgentModelOption] = []
                    var cursor: String?
                    var seenCursors = Set<String>()
                    repeat {
                        let result = try connection.call("model/list", CodexProtocol.modelListParams(cursor: cursor))
                        let page = try CodexProtocol.modelListPage(result)
                        models += page.models
                        cursor = page.nextCursor
                        if let cursor, !seenCursors.insert(cursor).inserted {
                            throw CodexControlError.invalidResponse(method: "model/list")
                        }
                    } while cursor != nil
                    return models
                })
            }
        }
    }

    public func steerMessage(socketPath: String, threadId: String, turnId: String, text: String, clientUserMessageId: String) async throws {
        let timeout = self.timeout
        return try await withCheckedThrowingContinuation { continuation in
            DispatchQueue.global().async {
                continuation.resume(with: Result {
                    let connection = try JSONRPCWebSocket(socketPath: socketPath, timeout: timeout)
                    defer { connection.close() }
                    _ = try connection.call("initialize", CodexProtocol.initializeParams())
                    try connection.notify("initialized")
                    _ = try connection.call(
                        "turn/steer",
                        CodexProtocol.turnSteerParams(
                            threadId: threadId,
                            turnId: turnId,
                            prompt: text,
                            clientUserMessageId: clientUserMessageId
                        )
                    )
                })
            }
        }
    }

    public func interruptTurn(socketPath: String, threadId: String, turnId: String) async throws {
        let timeout = self.timeout
        return try await withCheckedThrowingContinuation { continuation in
            DispatchQueue.global().async {
                continuation.resume(with: Result {
                    let connection = try JSONRPCWebSocket(socketPath: socketPath, timeout: timeout)
                    defer { connection.close() }
                    _ = try connection.call("initialize", CodexProtocol.initializeParams())
                    try connection.notify("initialized")
                    _ = try connection.call(
                        "turn/interrupt",
                        CodexProtocol.turnInterruptParams(threadId: threadId, turnId: turnId)
                    )
                })
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
            CodexProtocol.threadStartParams(
                cwd: request.cwd, settings: request.settings, workspaceRoots: request.workspaceRoots, model: request.model
            )
        )
        guard let threadId = CodexProtocol.threadId(fromThreadStart: started) else {
            throw CodexControlError.invalidResponse(method: "thread/start")
        }
        do {
            try CodexProtocol.validateStarted(started, request: request)
            let accountParams: [String: Any] = [
                "threadId": threadId, "server": "missiongo", "tool": "get_current_account", "arguments": [:],
            ]
            let account: [String: Any]
            do {
                account = try connection.call("mcpServer/tool/call", accountParams)
            } catch let error as CodexControlError where isMissionGoStartupTimeout(error) {
                // A cold MCP process can miss Codex's first 30-second startup
                // window. Retry this read-only permission probe once, but never
                // retry another error and never start the work turn until it passes.
                account = try connection.call("mcpServer/tool/call", accountParams)
            }
            try CodexProtocol.validateAccount(account, skillVersion: request.skillVersion)
            // A thread that could not be named is still a working thread; failing the
            // dispatch here would leave it running with nobody told about it.
            _ = try? connection.call("thread/name/set", CodexProtocol.threadNameParams(threadId: threadId, name: request.name))
            _ = try connection.call("turn/start", CodexProtocol.turnStartParams(
                threadId: threadId,
                prompt: request.prompt,
                overrides: CodexTurnOverrides(model: request.model, effort: request.effort)
            ))
        } catch {
            // Nothing reached turn/start successfully. Archive the empty shell
            // immediately so a stale Skill or MCP grant does not litter Codex.
            _ = try? connection.call("thread/archive", CodexProtocol.threadArchiveParams(threadId: threadId))
            throw error
        }
        return threadId
    }

    static func isMissionGoStartupTimeout(_ error: CodexControlError) -> Bool {
        guard case let .rpc(method, message) = error, method == "mcpServer/tool/call" else { return false }
        let normalized = message.lowercased()
        return normalized.contains("mcp startup failed")
            && normalized.contains("mcp client startup timed out")
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
