import CryptoKit
import Foundation

/// Starts Codex threads through the app-server control socket.
///
/// The ChatGPT app runs a Codex app-server and listens on
/// `~/.codex/app-server-control/app-server-control.sock`, speaking JSON-RPC
/// over WebSocket over that Unix socket. A thread created there is the same
/// thread the Codex app, a remote-controlling Mac and the ChatGPT phone app all
/// show. MissionGo mirrors the conversation and handles supported permission
/// requests through a dedicated connection to this same runtime.
///
/// Verified on a real machine: `initialize` → `thread/start` →
/// `thread/name/set` → `turn/start`, then disconnect. The turn keeps running
/// after this client goes away; the approval observer receives live requests.
public protocol CodexControl: Sendable {
    /// Creates one named thread, sends its first turn and disconnects.
    /// Returns the thread id.
    func initialTurnId(threadId: String) -> String?
    func startThread(_ request: CodexThreadRequest) async throws -> String
    func startManagedThread(_ request: CodexThreadRequest) async throws -> ManagedRuntimeReceipt
    func readThread(socketPath: String, threadId: String) async throws -> CodexThreadSnapshot
    /// Reads runtime state without loading the transcript or resuming the thread.
    func readThreadStatus(socketPath: String, threadId: String) async throws -> CodexThreadSnapshot
    func readExternalThread(socketPath: String, threadId: String) async throws -> CodexThreadSnapshot
    func readArtifactThread(socketPath: String, threadId: String) async throws -> CodexThreadSnapshot
    func readHistoryPage(socketPath: String, threadId: String, cursor: String) async throws -> AgentHistoryResult
    func readManagedThread(socketPath: String, threadId: String) async throws -> CodexThreadSnapshot
    /// `overrides` carry the settings a person chose for this conversation;
    /// Codex keeps turn-level overrides for the turns after it too.
    func sendExternalMessage(socketPath: String, threadId: String, text: String, clientUserMessageId: String) async throws
    func sendExternalMessage(socketPath: String, threadId: String, text: String, clientUserMessageId: String, imagePaths: [String]) async throws
    func sendExternalMessage(socketPath: String, threadId: String, text: String, clientUserMessageId: String, imagePaths: [String], overrides: CodexTurnOverrides?) async throws
    func sendMessage(socketPath: String, threadId: String, text: String, clientUserMessageId: String, overrides: CodexTurnOverrides?) async throws
    func steerMessage(socketPath: String, threadId: String, turnId: String, text: String, clientUserMessageId: String) async throws
    func steerMessage(socketPath: String, threadId: String, turnId: String, text: String, clientUserMessageId: String, imagePaths: [String]) async throws
    func interruptTurn(socketPath: String, threadId: String, turnId: String) async throws
    func archiveThread(socketPath: String, threadId: String) async throws
    func unarchiveThread(socketPath: String, threadId: String) async throws
    /// Switches an idle thread's model, approvals and sandbox without starting a turn.
    func applySettings(socketPath: String, threadId: String, overrides: CodexTurnOverrides) async throws -> CodexAppliedSettings
    /// The models this app-server offers, hidden ones left out.
    func listModels(socketPath: String) async throws -> [AgentModelOption]
    /// Fail closed for daemon restart: every loaded thread is treated as work
    /// that must not be interrupted, even when it is presently idle.
    func hasLoadedThreads(socketPath: String) async throws -> Bool
    /// A dedicated subscription keeps approval requests visible to MissionGo.
    func approvalSnapshot(socketPath: String, threadId: String) -> CodexApprovalSnapshot?
    func answerApproval(threadId: String, approvalId: String, decision: String) throws
    func cancelApprovals(threadId: String, turnId: String)
}

public extension CodexControl {
    func initialTurnId(threadId: String) -> String? { nil }
    func readArtifactThread(socketPath: String, threadId: String) async throws -> CodexThreadSnapshot {
        try await readThread(socketPath: socketPath, threadId: threadId)
    }
    func readExternalThread(socketPath: String, threadId: String) async throws -> CodexThreadSnapshot {
        try await readThread(socketPath: socketPath, threadId: threadId)
    }
    func approvalSnapshot(socketPath: String, threadId: String) -> CodexApprovalSnapshot? { nil }
    func answerApproval(threadId: String, approvalId: String, decision: String) throws {
        throw CodexControlError.rpc(method: "approval", message: "这个 Codex 控制器不支持控制台授权。")
    }
    func cancelApprovals(threadId: String, turnId: String) {}
    func readHistoryPage(socketPath: String, threadId: String, cursor: String) async throws -> AgentHistoryResult {
        throw CodexControlError.invalidResponse(method: "thread/turns/list unsupported")
    }
    func readManagedThread(socketPath: String, threadId: String) async throws -> CodexThreadSnapshot {
        try await readThread(socketPath: socketPath, threadId: threadId)
    }
    func startManagedThread(_ request: CodexThreadRequest) async throws -> ManagedRuntimeReceipt {
        throw CodexControlError.invalidResponse(method: "managed thread unsupported")
    }
    func readThread(socketPath: String, threadId: String) async throws -> CodexThreadSnapshot {
        throw CodexControlError.rpc(method: "thread/read", message: "这个 Codex 控制器不支持读取会话。")
    }

    func readThreadStatus(socketPath: String, threadId: String) async throws -> CodexThreadSnapshot {
        try await readThread(socketPath: socketPath, threadId: threadId)
    }

    func sendExternalMessage(socketPath: String, threadId: String, text: String, clientUserMessageId: String) async throws {
        throw CodexControlError.rpc(method: "turn/start", message: "这个 Codex 控制器不支持向原生外部会话直接回复。")
    }
    func sendExternalMessage(socketPath: String, threadId: String, text: String, clientUserMessageId: String, imagePaths: [String]) async throws {
        guard imagePaths.isEmpty else { throw CodexControlError.messageNotSent("这个控制器不支持图片输入，请更新本机节点。") }
        try await sendExternalMessage(socketPath: socketPath, threadId: threadId, text: text, clientUserMessageId: clientUserMessageId)
    }
    func sendExternalMessage(socketPath: String, threadId: String, text: String, clientUserMessageId: String, imagePaths: [String], overrides: CodexTurnOverrides?) async throws {
        guard overrides == nil else { throw CodexControlError.messageNotSent("当前控制器不支持外部会话设置，请更新本机节点。") }
        try await sendExternalMessage(socketPath: socketPath, threadId: threadId, text: text, clientUserMessageId: clientUserMessageId, imagePaths: imagePaths)
    }
    func steerMessage(socketPath: String, threadId: String, turnId: String, text: String, clientUserMessageId: String, imagePaths: [String]) async throws {
        guard imagePaths.isEmpty else { throw CodexControlError.messageNotSent("这个控制器不支持图片输入，请更新本机节点。") }
        try await steerMessage(socketPath: socketPath, threadId: threadId, turnId: turnId, text: text, clientUserMessageId: clientUserMessageId)
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

    func hasLoadedThreads(socketPath: String) async throws -> Bool { true }
}

public struct CodexApprovalOption: Codable, Equatable, Sendable {
    public let id: String
    public let kind: String
    public let detail: String?
    public let label: String?

    public init(id: String, kind: String, detail: String? = nil, label: String? = nil) {
        self.id = id
        self.kind = kind
        self.detail = detail
        self.label = label
    }
}

public struct CodexApprovalSnapshot: Codable, Equatable, Sendable {
    public let id: String
    public let kind: String
    public let status: String
    public let turnId: String
    public let action: String
    public let reason: String?
    public let startedAtMs: Int64
    public let requestKind: String?
    public let options: [CodexApprovalOption]?

    public init(id: String, kind: String, status: String, turnId: String, action: String,
                reason: String? = nil, startedAtMs: Int64, requestKind: String? = nil,
                options: [CodexApprovalOption]? = nil) {
        self.id = id
        self.kind = kind
        self.status = status
        self.turnId = turnId
        self.action = action
        self.reason = reason
        self.startedAtMs = startedAtMs
        self.requestKind = requestKind
        self.options = options
    }
}

/// Settings a person chose for a running thread, sent with `thread/resume`
/// and every `turn/start` MissionGo sends for it. nil fields are left out.
public struct CodexTurnOverrides: Equatable, Sendable {
    public let model: String?
    public let effort: String?
    public let settings: CodexThreadSettings?
    public let managed: Bool
    public let managedContext: ManagedResumeContext?

    public init(model: String? = nil, effort: String? = nil, settings: CodexThreadSettings? = nil, managed: Bool = false, managedContext: ManagedResumeContext? = nil) {
        self.model = model
        self.effort = effort
        self.settings = settings
        self.managed = managed
        self.managedContext = managedContext
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
    /// A bounded history window or metadata-only read must never prove that a
    /// previously delivering message was absent from the source transcript.
    public var historyLimited = false
    public var history: AgentHistoryMetadata?
    public let execution: NativeExecutionProgress
    public let failure: CodexSessionFailure?
    public let status: String
    /// Keep runtime readiness separate from the last turn's failure.
    public let runtimeStatus: String?
    public let waitingOnApproval: Bool
    public let waitingOnUserInput: Bool
    public var canContinueAfterFailure: Bool {
        status == "failed" && ["idle", "notLoaded", "systemError"].contains(runtimeStatus ?? "")
            && ["codex_server_error", "codex_connection_failed", "codex_rate_limit_exceeded"].contains(failure?.code ?? "")
            && activeTurnId == nil
    }
    public let activeTurnId: String?
    public var messages: [AgentSessionMessage]
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
        reasoningEffort: String? = nil,
        failure: CodexSessionFailure? = nil,
        runtimeStatus: String? = nil,
        waitingOnApproval: Bool = false,
        waitingOnUserInput: Bool = false,
        execution: NativeExecutionProgress = NativeExecutionProgress()
    ) {
        self.execution = execution
        self.failure = failure
        self.status = status
        self.runtimeStatus = runtimeStatus
        self.waitingOnApproval = waitingOnApproval
        self.waitingOnUserInput = waitingOnUserInput
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
    /// No turn/start or turn/steer was attempted; safe to release the composer.
    case messageNotSent(String)
    case connect(path: String, reason: String)
    case handshake(String)
    case timedOut(method: String)
    case closed(method: String)
    case rpc(method: String, message: String)
    case invalidResponse(method: String)
    case mcpAuthorization
    case skillStale
    case mcpStartup(DispatchMcpDiagnostic)

    public var errorDescription: String? {
        switch self {
        case let .messageNotSent(reason): return "回复未发送：\(reason)"
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
        case let .mcpStartup(diagnostic):
            let state = diagnostic.startupStatus ?? diagnostic.runtimeStatus ?? "unknown"
            let detail = diagnostic.error.map { "：\($0)" } ?? ""
            return "Codex 的 MissionGo MCP 启动异常（\(state)）\(detail)"
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
              sandbox["type"] as? String == (request.settings.sandbox == "read-only" ? "readOnly" : "workspaceWrite"),
              let runtimeRoots = result["runtimeWorkspaceRoots"] as? [String],
              request.workspaceRoots.allSatisfy({ Set(runtimeRoots.map(canonical)).contains(canonical($0)) }) else {
            throw CodexControlError.rpc(method: "thread/start", message: "Codex 未确认实际审批方式与原生沙箱；尚未启动任务。")
        }
        if request.settings.sandbox == "workspace-write" {
            guard let writableRoots = sandbox["writableRoots"] as? [String],
                  request.workspaceRoots.allSatisfy({ Set(([cwd] + writableRoots).map(canonical)).contains(canonical($0)) }) else {
                throw CodexControlError.rpc(method: "thread/start", message: "Codex 未确认精确可写工作区；尚未启动任务。")
            }
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

    private static func userInput(prompt: String, imagePaths: [String]) -> [[String: Any]] {
        [["type": "text", "text": prompt]] + imagePaths.map { ["type": "localImage", "path": $0] }
    }

    public static func turnStartParams(
        threadId: String,
        prompt: String,
        clientUserMessageId: String? = nil,
        overrides: CodexTurnOverrides? = nil,
        imagePaths: [String] = []
    ) -> [String: Any] {
        var params: [String: Any] = ["threadId": threadId, "input": userInput(prompt: prompt, imagePaths: imagePaths)]
        if let clientUserMessageId { params["clientUserMessageId"] = clientUserMessageId }
        if let model = overrides?.model { params["model"] = model }
        if let effort = overrides?.effort { params["effort"] = effort }
        if let settings = overrides?.settings {
            params["approvalPolicy"] = settings.approvalPolicy
            params["approvalsReviewer"] = settings.approvalsReviewer
            if settings.sandbox == "read-only" { params["sandboxPolicy"] = ["type": "readOnly"] }
            if let model = overrides?.model {
                params["collaborationMode"] = ["mode": settings.planning ? "plan" : "default",
                    "settings": ["model": model, "reasoning_effort": overrides?.effort as Any? ?? NSNull(), "developer_instructions": NSNull()]]
            }
        }
        return params
    }

    public static func turnSteerParams(
        threadId: String,
        turnId: String,
        prompt: String,
        clientUserMessageId: String,
        imagePaths: [String] = []
    ) -> [String: Any] {
        return [
            "threadId": threadId,
            "expectedTurnId": turnId,
            "input": userInput(prompt: prompt, imagePaths: imagePaths),
            "clientUserMessageId": clientUserMessageId,
        ]
    }

    public static func threadReadParams(threadId: String, includeTurns: Bool = true) -> [String: Any] {
        return ["threadId": threadId, "includeTurns": includeTurns]
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
        var params: [String: Any] = ["threadId": threadId, "excludeTurns": true]
        if overrides?.managed == true { params["config"] = ["mcp_servers.missiongo.enabled": false] }
        if let model = overrides?.model { params["model"] = model }
        if let settings = overrides?.settings {
            params["approvalPolicy"] = settings.approvalPolicy
            params["approvalsReviewer"] = settings.approvalsReviewer
            params["sandbox"] = settings.sandbox
        }
        return params
    }

    public static func validateEffectiveSettings(_ result: [String: Any], settings: CodexThreadSettings) throws {
        let sandbox = result["sandbox"] as? [String: Any]
        guard result["approvalPolicy"] as? String == settings.approvalPolicy,
              result["approvalsReviewer"] as? String == settings.approvalsReviewer,
              sandbox?["type"] as? String == (settings.sandbox == "read-only" ? "readOnly" : "workspaceWrite") else {
            // Only emit known policy values, never arbitrary server payloads.
            func actual(_ value: Any?, allowed: [String]) -> String {
                guard let value else { return "missing" }
                guard let text = value as? String, allowed.contains(text) else { return "unsupported" }
                return text
            }
            let policy = actual(result["approvalPolicy"], allowed: ["on-request", "never", "untrusted", "on-failure"])
            let reviewer = actual(result["approvalsReviewer"], allowed: ["user", "auto_review", "guardian_subagent"])
            let sandboxType = actual(sandbox?["type"], allowed: ["readOnly", "workspaceWrite", "dangerFullAccess", "externalSandbox"])
            let expectedSandbox = settings.sandbox == "read-only" ? "readOnly" : "workspaceWrite"
            throw LaunchError("Codex 未确认请求的原生权限模式（approvalPolicy: \(policy)，期望 \(settings.approvalPolicy)；approvalsReviewer: \(reviewer)，期望 \(settings.approvalsReviewer)；sandbox.type: \(sandboxType)，期望 \(expectedSandbox)），未发送消息或标记生效。")
        }
    }

    /// Loaded threads can ignore thread/resume overrides. Update the live
    /// settings explicitly, then use a fresh resume to verify the effective
    /// policy. An empty update acknowledgement is not proof of application.
    public static func threadSettingsUpdateParams(threadId: String, overrides: CodexTurnOverrides, resumed: [String: Any]) throws -> [String: Any] {
        var params: [String: Any] = ["threadId": threadId]
        if let model = overrides.model { params["model"] = model }
        if let effort = overrides.effort { params["effort"] = effort }
        if let settings = overrides.settings {
            params["approvalPolicy"] = settings.approvalPolicy
            params["approvalsReviewer"] = settings.approvalsReviewer
            if settings.sandbox == "read-only" {
                params["sandboxPolicy"] = ["type": "readOnly", "networkAccess": false]
            } else {
                guard let cwd = resumed["cwd"] as? String, cwd.hasPrefix("/") else {
                    throw LaunchError("Codex 未返回工作目录，无法确认可写范围；未发送消息或标记生效。")
                }
                let roots = resumed["runtimeWorkspaceRoots"] as? [String] ?? [cwd]
                guard roots.allSatisfy({ $0.hasPrefix("/") }) else {
                    throw LaunchError("Codex 未返回有效工作区，无法确认可写范围；未发送消息或标记生效。")
                }
                params["sandboxPolicy"] = ["type": "workspaceWrite", "writableRoots": Array(Set([cwd] + roots)).sorted(), "networkAccess": false]
            }
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

    public static func threadSnapshot(fromRead result: [String: Any], includeExecutionItems: Bool = false) throws -> CodexThreadSnapshot {
        guard let thread = result["thread"] as? [String: Any] else {
            throw CodexControlError.invalidResponse(method: "thread/read")
        }
        let type = (thread["status"] as? [String: Any])?["type"] as? String
        var status: String
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
        // A failed turn may leave a healthy-but-idle or unloaded thread. Only
        // the latest turn counts; an old failure must not poison a later run.
        let latest = turns.last
        if ["idle", "notLoaded"].contains(type ?? ""), latest?["status"] as? String == "failed" { status = "failed" }
        let failure = status == "failed" ? CodexSessionFailure.fromTurn(
            latest?["status"] as? String == "failed" ? latest : nil
        ) : nil
        let activeTurnId = latest?["status"] as? String == "inProgress" ? latest?["id"] as? String : nil
        var messages: [AgentSessionMessage] = []
        for turn in turns {
            let turnId = turn["id"] as? String
            for item in turn["items"] as? [[String: Any]] ?? [] {
                guard let sourceId = item["id"] as? String,
                      let itemType = item["type"] as? String else { continue }
                let occurredAt = sourceActivityTimestamp(
                    item["createdAt"] ?? item["created_at"] ?? item["timestamp"] ?? turn["startedAt"]
                )
                switch itemType {
                case "userMessage":
                    let parts = (item["content"] as? [[String: Any]] ?? []).compactMap { content -> String? in
                        guard content["type"] as? String == "text" else { return nil }
                        return content["text"] as? String
                    }
                    let text = parts.joined(separator: "\n")
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
                    var text = (item["text"] as? String ?? "")
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
                case "imageGeneration":
                    if item["status"] as? String == "completed", item["failure"] == nil || item["failure"] is NSNull,
                       let path = item["savedPath"] as? String, AgentArtifactReader.path(path) != nil,
                       ["png", "jpg", "jpeg", "gif", "webp", "svg"].contains(URL(fileURLWithPath: path).pathExtension.lowercased()) {
                        let href = URL(fileURLWithPath: path).absoluteString
                        messages.append(AgentSessionMessage(sourceId: sourceId, turnId: turnId, role: "agent",
                            text: "![image](<\(href)>)", occurredAt: occurredAt))
                    }
                case "plan":
                    let text = (item["text"] as? String ?? "")
                    if !text.isEmpty {
                        messages.append(AgentSessionMessage(
                            sourceId: sourceId, turnId: turnId, role: "plan", text: text,
                            occurredAt: occurredAt
                        ))
                    }
                default:
                    if includeExecutionItems {
                        // Keep visible native tool/event records; never mirror encrypted reasoning payloads.
                        var visible = item
                        visible.removeValue(forKey: "encryptedContent")
                        visible.removeValue(forKey: "encrypted_content")
                        if itemType == "reasoning" { visible = ["type": itemType, "summary": item["summary"] ?? []] }
                        if let data = try? JSONSerialization.data(withJSONObject: visible, options: [.sortedKeys]),
                           let text = String(data: data, encoding: .utf8) {
                            messages.append(AgentSessionMessage(sourceId: sourceId, turnId: turnId, role: "agent",
                                phase: "execution", text: text, occurredAt: occurredAt))
                        }
                    }
                }
            }
        }
        return CodexThreadSnapshot(
            status: status,
            activeTurnId: activeTurnId,
            messages: AgentSessionAnswerTrace.markingAnswered(messages),
            activityAt: sourceActivityTimestamp(thread["updatedAt"] ?? thread["updated_at"]),
            model: thread["model"] as? String,
            reasoningEffort: thread["reasoningEffort"] as? String,
            failure: failure,
            runtimeStatus: type,
            waitingOnApproval: ((thread["status"] as? [String: Any])?["activeFlags"] as? [String] ?? []).contains("waitingOnApproval"),
            waitingOnUserInput: ((thread["status"] as? [String: Any])?["activeFlags"] as? [String] ?? []).contains("waitingOnUserInput"),
            execution: NativeExecutionProgress.codex(turns: turns)
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

/// Metadata only: never includes paths, thread IDs, transcript text or tool arguments.
struct CodexReadFailure: Error, LocalizedError {
    let stage: String
    let reason: String
    let elapsedMilliseconds: Int
    let receivedBytes: Int
    let includesHistory: Bool
    let lastSuccessfulRead: Date?

    var errorDescription: String? {
        let last = lastSuccessfulRead.map { ISO8601DateFormatter().string(from: $0) } ?? "尚无成功记录"
        let version = AppUpdater.currentVersion() ?? "development"
        return "Codex 会话同步失败（\(reason)）；尚不能确认原任务是否停止。诊断：stage=\(stage), elapsedMs=\(elapsedMilliseconds), connectionReceivedBytes=\(receivedBytes), includeTurns=\(includesHistory), lastSuccessfulRead=\(last), nodeVersion=\(version)。"
    }
}

public struct CodexAppServerControl: CodexControl {
    /// Per call. `thread/start` loads configuration and MCP servers, which can
    /// take a few seconds on a cold app-server.
    public let timeout: TimeInterval
    /// Per poll of the mirror path (`thread/read` and friends). This runs every
    /// couple of seconds per session, so a half-dead daemon must fail a read
    /// fast instead of holding its whole timeout (AND-220); a slow launch or
    /// reply keeps the full `timeout` above.
    public let readTimeout: TimeInterval
    private let archiveCache: CodexArchiveCache
    private let approvalMonitor: CodexApprovalMonitor
    private let successfulReads = Locked<[String: Date]>([:])

    public init(timeout: TimeInterval = 30, readTimeout: TimeInterval = 10) {
        self.timeout = timeout
        self.readTimeout = readTimeout
        archiveCache = CodexArchiveCache()
        approvalMonitor = CodexApprovalMonitor()
    }

    private let initialTurns = Locked<[String:String]>([:])
    public func initialTurnId(threadId: String) -> String? { initialTurns.current[threadId] }

    public func startThread(_ request: CodexThreadRequest) async throws -> String {
        let timeout = self.timeout
        let started: (String, String?) = try await withCheckedThrowingContinuation { continuation in
            DispatchQueue.global().async {
                continuation.resume(with: Result { try CodexAppServerControl.startThreadSync(request, timeout: timeout) })
            }
        }
        let (threadId, turnId) = started
        if let turnId { initialTurns.withLock { $0[threadId] = turnId } }
        approvalMonitor.watch(socketPath: request.socketPath, threadId: threadId)
        return threadId
    }

    public func approvalSnapshot(socketPath: String, threadId: String) -> CodexApprovalSnapshot? {
        approvalMonitor.watch(socketPath: socketPath, threadId: threadId)
        return approvalMonitor.snapshot(threadId: threadId)
    }

    public func answerApproval(threadId: String, approvalId: String, decision: String) throws {
        try approvalMonitor.answer(threadId: threadId, approvalId: approvalId, decision: decision)
    }

    public func cancelApprovals(threadId: String, turnId: String) {
        approvalMonitor.cancel(threadId: threadId, turnId: turnId)
    }

    public func readManagedThread(socketPath: String, threadId: String) async throws -> CodexThreadSnapshot {
        try await readThread(socketPath: socketPath, threadId: threadId, includeExecutionItems: true)
    }
    public func readThread(socketPath: String, threadId: String) async throws -> CodexThreadSnapshot {
        try await readThread(socketPath: socketPath, threadId: threadId, includeExecutionItems: false)
    }
    public func readArtifactThread(socketPath: String, threadId: String) async throws -> CodexThreadSnapshot {
        // Archived/unloaded transcripts remain eligible, but never resume a runtime or subscribe to approvals.
        try await readThread(socketPath: socketPath, threadId: threadId, includeExecutionItems: false, checkArchiveList: false)
    }
    public func readExternalThread(socketPath: String, threadId: String) async throws -> CodexThreadSnapshot {
        // Exact identity is checked by readThread. Reading history does not grant input.
        try await readThread(socketPath: socketPath, threadId: threadId, includeExecutionItems: false, checkArchiveList: false)
    }
    public func readThreadStatus(socketPath: String, threadId: String) async throws -> CodexThreadSnapshot {
        try await readThread(socketPath: socketPath, threadId: threadId, includeExecutionItems: false,
            checkArchiveList: false, includeTurns: false, timeoutOverride: min(readTimeout, 3))
    }
    private func readThread(socketPath: String, threadId: String, includeExecutionItems: Bool, checkArchiveList: Bool = true, requireLoaded: Bool = false, includeTurns: Bool = true, timeoutOverride: TimeInterval? = nil) async throws -> CodexThreadSnapshot {
        let timeout = timeoutOverride ?? self.readTimeout
        let archiveCache = self.archiveCache
        let successfulReads = self.successfulReads
        return try await withCheckedThrowingContinuation { continuation in
            DispatchQueue.global().async {
                continuation.resume(with: Result {
                    let started = Date()
                    var stage = "connect"
                    var connection: JSONRPCWebSocket?
                    defer { connection?.close() }
                    do {
                        if includeTurns, !includeExecutionItems {
                            return try Self.readBoundedHistory(socketPath: socketPath, threadId: threadId,
                                timeout: timeout, checkArchiveList: checkArchiveList, requireLoaded: requireLoaded,
                                archiveCache: archiveCache)
                        }
                        let channel = try JSONRPCWebSocket(socketPath: socketPath, timeout: timeout)
                        connection = channel
                        stage = "initialize"
                        _ = try channel.call("initialize", CodexProtocol.initializeParams())
                        try channel.notify("initialized")
                        let archived = checkArchiveList && ((try? archiveCache.value(socketPath: socketPath) {
                            try CodexAppServerControl.archivedThreadIds(connection: channel)
                        }.contains(threadId)) ?? false)
                        if archived {
                            return CodexThreadSnapshot(status: "unavailable", messages: [], archived: true)
                        }
                        stage = "thread/read"
                        let result = try channel.call("thread/read", CodexProtocol.threadReadParams(threadId: threadId, includeTurns: includeTurns))
                        if !checkArchiveList, (result["thread"] as? [String: Any])?["id"] as? String != threadId {
                            throw CodexControlError.invalidResponse(method: "thread/read identity")
                        }
                        if requireLoaded { try Self.requireExternalRuntime(result, threadId: threadId) }
                        let snapshot = try CodexProtocol.threadSnapshot(fromRead: result, includeExecutionItems: includeExecutionItems)
                        if includeTurns {
                            successfulReads.withLock { values in
                                values[threadId] = Date()
                                if values.count > 128, let oldest = values.min(by: { $0.value < $1.value })?.key {
                                    values.removeValue(forKey: oldest)
                                }
                            }
                        }
                        return snapshot
                    } catch let error as CodexControlError {
                        let reason: String
                        switch error {
                        case .timedOut: reason = "读取超时"
                        case .closed: reason = "控制通道断开"
                        case .connect: reason = "控制通道连接失败"
                        case .handshake: reason = "控制通道握手失败"
                        default: throw error
                        }
                        throw CodexReadFailure(stage: stage, reason: reason,
                            elapsedMilliseconds: Int(Date().timeIntervalSince(started) * 1_000),
                            receivedBytes: connection?.receivedBytes ?? 0, includesHistory: includeTurns,
                            lastSuccessfulRead: successfulReads.current[threadId])
                    }
                })
            }
        }
    }

    /// Recover a long conversation using metadata and native message
    /// pages. Old servers and even an oversized single turn still leave runtime
    /// state usable. The server keeps previously mirrored messages by source id.
    private static func readBoundedHistory(socketPath: String, threadId: String, timeout: TimeInterval,
        checkArchiveList: Bool, requireLoaded: Bool, archiveCache: CodexArchiveCache) throws -> CodexThreadSnapshot {
        let connection = try JSONRPCWebSocket(socketPath: socketPath, timeout: timeout)
        defer { connection.close() }
        _ = try connection.call("initialize", CodexProtocol.initializeParams())
        try connection.notify("initialized")
        if checkArchiveList, ((try? archiveCache.value(socketPath: socketPath) {
            try archivedThreadIds(connection: connection)
        }.contains(threadId)) ?? false) {
            return CodexThreadSnapshot(status: "unavailable", messages: [], archived: true)
        }
        let result = try connection.call("thread/read", CodexProtocol.threadReadParams(threadId: threadId, includeTurns: false))
        guard var thread = result["thread"] as? [String: Any], thread["id"] as? String == threadId else {
            throw CodexControlError.invalidResponse(method: "thread/read identity")
        }
        if requireLoaded { try requireExternalRuntime(result, threadId: threadId) }
        let page: SummaryPage
        do { page = try Self.summaryPage(connection: connection, threadId: threadId, cursor: nil, timeout: timeout) }
        catch {
            var snapshot = try CodexProtocol.threadSnapshot(fromRead: result)
            snapshot.messages = []
            snapshot.historyLimited = true
            snapshot.history = AgentHistoryMetadata(complete: false, error: "unavailable")
            return snapshot
        }
        thread["turns"] = page.turns
        var snapshot = try CodexProtocol.threadSnapshot(fromRead: ["thread": thread])
        snapshot.historyLimited = true
        let hadSummaryMessages = !snapshot.messages.isEmpty
        snapshot.messages = []
        // Turn summaries omit commentary and plans. They supply runtime/turn
        // metadata only; visible conversation content must come from item pages.
        do {
            let items = try visibleItemPage(connection: connection, threadId: threadId, cursor: nil, timeout: timeout)
            if items.messages.isEmpty && hadSummaryMessages {
                throw CodexControlError.invalidResponse(method: "thread/items/list missing visible history")
            }
            snapshot.messages = items.messages
            snapshot.history = AgentHistoryMetadata(cursor: items.nextCursor,
                complete: items.nextCursor == nil && items.error == nil, error: items.error)
        } catch {
            snapshot.history = AgentHistoryMetadata(complete: false, error: "unavailable")
        }
        return snapshot
    }

    struct VisibleItemPage {
        let messages: [AgentSessionMessage]
        let nextCursor: String?
        var error: String? = nil
    }

    /// Version the cursor so cached turn-summary pages cannot silently be
    /// mistaken for complete item history. Legacy cursors restart this same
    /// bound thread's item lane; source IDs deduplicate the overlap.
    static let itemCursorPrefix = "items-v1:"
    static func visibleItemPage(connection: JSONRPCWebSocket, threadId: String,
        cursor: String?, timeout: TimeInterval) throws -> VisibleItemPage {
        var cursor = cursor.flatMap { $0.hasPrefix(itemCursorPrefix) ? String($0.dropFirst(itemCursorPrefix.count)) : nil }
        var seen = Set<String>()
        if let cursor { seen.insert(cursor) }
        var messages: [AgentSessionMessage] = []
        var visibleBytes = 0
        let started = Date()
        let initialBytes = connection.receivedBytes
        for _ in 0..<8 {
            var params: [String: Any] = ["threadId": threadId, "limit": 50, "sortDirection": "desc"]
            if let cursor { params["cursor"] = cursor }
            let previous = cursor
            do {
                let page = try connection.call("thread/items/list", params)
                guard let entries = page["data"] as? [[String: Any]], entries.count <= 50 else {
                    throw CodexControlError.invalidResponse(method: "thread/items/list")
                }
                let next = page["nextCursor"] as? String
                if let next, next.isEmpty || next.utf16.count + itemCursorPrefix.count > 4096 || !seen.insert(next).inserted {
                    throw CodexControlError.invalidResponse(method: "thread/items/list cursor")
                }
                for entry in entries {
                    guard let turnId = entry["turnId"] as? String, var item = entry["item"] as? [String: Any] else {
                        throw CodexControlError.invalidResponse(method: "thread/items/list entry")
                    }
                    item["createdAt"] = item["createdAt"] ?? entry["startedAtMs"] ?? entry["completedAtMs"]
                    let parsed = try CodexProtocol.threadSnapshot(fromRead: ["thread": ["turns": [["id": turnId, "items": [item]]]]]).messages
                    messages += parsed
                    visibleBytes += parsed.reduce(0) { $0 + $1.text.utf8.count }
                }
                cursor = next
                if next == nil || messages.count >= 50 || visibleBytes >= 512 * 1024
                    || connection.receivedBytes - initialBytes >= 8 * 1024 * 1024
                    || Date().timeIntervalSince(started) >= timeout { break }
            } catch {
                if case CodexControlError.invalidResponse = error { throw error }
                guard let previous else { throw error }
                return VisibleItemPage(messages: AgentSessionAnswerTrace.markingAnswered(Array(messages.reversed())),
                    nextCursor: itemCursorPrefix + previous, error: "unavailable")
            }
        }
        return VisibleItemPage(messages: AgentSessionAnswerTrace.markingAnswered(Array(messages.reversed())),
            nextCursor: cursor.map { itemCursorPrefix + $0 })
    }

    private struct SummaryPage {
        let turns: [[String: Any]]
        let nextCursor: String?
        var error: String? = nil
    }

    private static func summaryPage(connection: JSONRPCWebSocket, threadId: String,
        cursor: String?, timeout: TimeInterval) throws -> SummaryPage {
        var turns: [[String: Any]] = []
        var cursor = cursor
        var seen = Set<String>()
        if let cursor { seen.insert(cursor) }
        let started = Date()
        let initialBytes = connection.receivedBytes
        for _ in 0..<8 {
            var params: [String: Any] = ["threadId": threadId, "limit": turns.isEmpty ? 1 : 8 - turns.count,
                "sortDirection": "desc", "itemsView": "summary"]
            if let cursor { params["cursor"] = cursor }
            let previous = cursor
            do {
                let page = try connection.call("thread/turns/list", params)
                guard let data = page["data"] as? [[String: Any]], data.count <= 8 - turns.count,
                      connection.receivedBytes - initialBytes <= WebSocketFrame.maxPayload else {
                    throw CodexControlError.invalidResponse(method: "thread/turns/list")
                }
                let next = page["nextCursor"] as? String
                if let next, !seen.insert(next).inserted {
                    throw CodexControlError.invalidResponse(method: "thread/turns/list cursor")
                }
                turns += data
                cursor = next
                if next == nil || turns.count >= 8 { break }
            } catch {
                guard !turns.isEmpty, let previous else { throw error }
                // A failing older page must not discard the live turn already
                // confirmed on this read. Leave its cursor available for retry.
                return SummaryPage(turns: Array(turns.reversed()), nextCursor: previous, error: "unavailable")
            }
            if Date().timeIntervalSince(started) >= timeout { break }
        }
        return SummaryPage(turns: Array(turns.reversed()), nextCursor: cursor)
    }

    public func readHistoryPage(socketPath: String, threadId: String, cursor: String) async throws -> AgentHistoryResult {
        let timeout = self.readTimeout
        return try await withCheckedThrowingContinuation { continuation in
            DispatchQueue.global().async {
                continuation.resume(with: Result {
                    let connection = try JSONRPCWebSocket(socketPath: socketPath, timeout: timeout)
                    defer { connection.close() }
                    _ = try connection.call("initialize", CodexProtocol.initializeParams())
                    try connection.notify("initialized")
                    let metadata = try connection.call("thread/read", CodexProtocol.threadReadParams(threadId: threadId, includeTurns: false))
                    guard let thread = metadata["thread"] as? [String: Any], thread["id"] as? String == threadId else {
                        throw CodexControlError.invalidResponse(method: "thread/read identity")
                    }
                    let page = try Self.visibleItemPage(connection: connection, threadId: threadId, cursor: cursor, timeout: timeout)
                    return AgentHistoryResult(messages: page.messages,
                        nextCursor: page.nextCursor)
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
        // An archive list that paginates forever would hold the sync poll for
        // its whole timeout budget; past this many pages the answer is wrong on
        // purpose rather than late (AND-220). Callers treat a throw as "not
        // archived" and ask `thread/read` directly.
        let pageLimit = 50
        var pages = 0
        repeat {
            let result = try connection.call("thread/list", CodexProtocol.archivedThreadListParams(cursor: cursor))
            let page = try CodexProtocol.threadListPage(result)
            ids.formUnion(page.ids)
            cursor = page.nextCursor
            if let cursor, !seenCursors.insert(cursor).inserted {
                throw CodexControlError.invalidResponse(method: "thread/list")
            }
            pages += 1
            if pages >= pageLimit, cursor != nil {
                throw CodexControlError.invalidResponse(method: "thread/list")
            }
        } while cursor != nil
        return ids
    }

    private static func requireExternalRuntime(_ result: [String: Any], threadId: String) throws {
        guard let thread = result["thread"] as? [String: Any], thread["id"] as? String == threadId else {
            throw CodexControlError.invalidResponse(method: "thread/read identity")
        }
        guard let status = thread["status"] as? [String: Any],
              ["idle", "active", "systemError"].contains(status["type"] as? String ?? "") else {
            throw CodexControlError.rpc(method: "thread/read", message: "这条原生会话未在当前 Codex 运行时加载，请在原 Codex 客户端打开后再连接。")
        }
    }

    public func sendExternalMessage(socketPath: String, threadId: String, text: String, clientUserMessageId: String) async throws {
        try await sendExternalMessage(socketPath: socketPath, threadId: threadId, text: text, clientUserMessageId: clientUserMessageId, imagePaths: [])
    }

    public func sendExternalMessage(socketPath: String, threadId: String, text: String, clientUserMessageId: String, imagePaths: [String]) async throws {
        try await sendExternalMessage(socketPath: socketPath, threadId: threadId, text: text, clientUserMessageId: clientUserMessageId, imagePaths: imagePaths, overrides: nil)
    }

    public func sendExternalMessage(socketPath: String, threadId: String, text: String, clientUserMessageId: String, imagePaths: [String], overrides: CodexTurnOverrides?) async throws {
        // External plan/default/auto modes cannot be faithfully mapped by the
        // turn API. Keep the source's permissions and collaboration mode.
        guard overrides?.settings == nil else {
            throw CodexControlError.messageNotSent("外部 Codex 模式请在原客户端调整。")
        }
        let timeout = self.timeout
        return try await withCheckedThrowingContinuation { continuation in
            DispatchQueue.global().async {
                continuation.resume(with: Result {
                    var inputAttempted = false
                    do {
                        let connection = try JSONRPCWebSocket(socketPath: socketPath, timeout: timeout)
                        defer { connection.close() }
                        _ = try connection.call("initialize", CodexProtocol.initializeParams())
                        try connection.notify("initialized")
                        let source = try connection.call("thread/read", CodexProtocol.threadReadParams(threadId: threadId, includeTurns: false))
                        try Self.requireExternalRuntime(source, threadId: threadId)
                        guard ((source["thread"] as? [String: Any])?["status"] as? [String: Any])?["type"] as? String == "idle" else {
                            throw CodexControlError.rpc(method: "turn/start", message: "原会话状态已变化，请等待同步后再回复。")
                        }
                        // Keep the source loaded and its approval channel intact.
                        // Only explicit console choices ride on this new turn;
                        // an ordinary reply leaves every source setting alone.
                        inputAttempted = true
                        _ = try connection.call("turn/start", CodexProtocol.turnStartParams(threadId: threadId, prompt: text,
                            clientUserMessageId: clientUserMessageId, overrides: overrides, imagePaths: imagePaths))
                    } catch {
                        if inputAttempted { throw error }
                        throw CodexControlError.messageNotSent(CodexSessionFailure.redact(error.localizedDescription))
                    }
                })
            }
        }
    }

    public func sendMessage(socketPath: String, threadId: String, text: String, clientUserMessageId: String, overrides: CodexTurnOverrides?) async throws {
        let timeout = self.timeout
        return try await withCheckedThrowingContinuation { continuation in
            DispatchQueue.global().async {
                continuation.resume(with: Result {
                    var inputAttempted = false
                    do {
                        let connection = try JSONRPCWebSocket(socketPath: socketPath, timeout: timeout)
                        defer { connection.close() }
                        let initialized = try connection.call("initialize", CodexProtocol.initializeParams())
                        if overrides?.managed == true { try ManagedCodexProtocol.validateVersion(initialized) }
                        try connection.notify("initialized")
                        if overrides?.managed == true {
                            guard let context = overrides?.managedContext, context.threadId == threadId, overrides?.settings != nil else {
                                throw LaunchError("Managed resume requires a frozen receipt.")
                            }
                        }
                        let resumed = try Self.resumeApplyingSettings(connection: connection, threadId: threadId, overrides: overrides)
                        if overrides?.managed == true, let settings = overrides?.settings, let context = overrides?.managedContext {
                            try ManagedCodexProtocol.validateResumed(resumed, settings: settings, context: context)
                            try ManagedCodexProtocol.validateMcp(connection.call("mcpServerStatus/list", ["threadId": threadId, "limit": 100]))
                        }
                        guard let thread = resumed["thread"] as? [String: Any], thread["id"] as? String == threadId else {
                            throw CodexControlError.invalidResponse(method: "thread/resume")
                        }
                        var resumeState = resumed
                        // Recovering a failed turn needs its error classification,
                        // not every historical tool result. Normal idle sends use
                        // the live state returned by resume without loading history.
                        if (thread["status"] as? [String: Any])?["type"] as? String == "systemError",
                           (thread["turns"] as? [[String: Any]] ?? []).isEmpty {
                            let page = try connection.call("thread/turns/list", ["threadId": threadId,
                                "limit": 1, "sortDirection": "desc", "itemsView": "summary"])
                            var recent = thread
                            recent["turns"] = page["data"] as? [[String: Any]] ?? []
                            resumeState["thread"] = recent
                        }
                        let snapshot = try CodexProtocol.threadSnapshot(fromRead: resumeState)
                        // Codex keeps systemError after a failed turn and clears
                        // it only when the next turn starts. Requiring idle here
                        // would block the manual recovery allowed by the launcher.
                        let recovering = overrides?.managed != true && snapshot.runtimeStatus == "systemError"
                            && snapshot.canContinueAfterFailure
                        let hasActiveTurn = (thread["turns"] as? [[String: Any]] ?? []).contains { $0["status"] as? String == "inProgress" }
                        guard (snapshot.runtimeStatus == "idle" || recovering), !hasActiveTurn else {
                            throw LaunchError("原会话当前不可接收消息；MissionGo 未发送回复，请稍后重试或检查节点诊断。")
                        }
                        inputAttempted = true
                        _ = try connection.call(
                            "turn/start",
                            CodexProtocol.turnStartParams(
                                threadId: threadId,
                                prompt: text,
                                clientUserMessageId: clientUserMessageId,
                                overrides: overrides.map { CodexTurnOverrides(model: $0.model ?? resumed["model"] as? String,
                                    effort: $0.effort, settings: $0.settings, managed: $0.managed, managedContext: $0.managedContext) }
                            )
                        )
                    } catch {
                        if inputAttempted { throw error }
                        throw CodexControlError.messageNotSent(CodexSessionFailure.redact(error.localizedDescription))
                    }
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
                    let result = try Self.resumeApplyingSettings(connection: connection, threadId: threadId, overrides: overrides)
                    if let settings = overrides.settings { try CodexProtocol.validateEffectiveSettings(result, settings: settings) }
                    return CodexProtocol.appliedSettings(fromResume: result)
                })
            }
        }
    }

    private static func resumeApplyingSettings(connection: JSONRPCWebSocket, threadId: String, overrides: CodexTurnOverrides?) throws -> [String: Any] {
        var result = try connection.call("thread/resume", CodexProtocol.threadResumeParams(threadId: threadId, overrides: overrides))
        // Managed execution keeps its separate frozen-receipt validation.
        guard let overrides, !overrides.managed, let settings = overrides.settings else { return result }
        guard (result["thread"] as? [String: Any])?["id"] as? String == threadId else {
            throw CodexControlError.invalidResponse(method: "thread/resume identity")
        }
        do {
            try CodexProtocol.validateEffectiveSettings(result, settings: settings)
            return result
        } catch {
            // Older servers that apply resume overrides take the path above.
            // Never unload an existing thread or start a turn to change settings.
            let thread = result["thread"] as? [String: Any]
            guard (thread?["status"] as? [String: Any])?["type"] as? String != "active",
                  !(thread?["turns"] as? [[String: Any]] ?? []).contains(where: { $0["status"] as? String == "inProgress" }) else {
                throw LaunchError("原会话正在运行，请等待当前回合结束后再切换权限。")
            }
            let params = try CodexProtocol.threadSettingsUpdateParams(threadId: threadId, overrides: overrides, resumed: result)
            do {
                _ = try connection.call("thread/settings/update", params)
            } catch let updateError {
                throw LaunchError("\(error.localizedDescription) 权限更新失败：\(CodexSessionFailure.redact(updateError.localizedDescription))")
            }
            result = try connection.call("thread/resume", CodexProtocol.threadResumeParams(threadId: threadId))
        }
        guard (result["thread"] as? [String: Any])?["id"] as? String == threadId else {
            throw CodexControlError.invalidResponse(method: "thread/resume identity")
        }
        try CodexProtocol.validateEffectiveSettings(result, settings: settings)
        return result
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

    public func hasLoadedThreads(socketPath: String) async throws -> Bool {
        let timeout = self.readTimeout
        return try await withCheckedThrowingContinuation { continuation in
            DispatchQueue.global().async {
                continuation.resume(with: Result {
                    let connection = try JSONRPCWebSocket(socketPath: socketPath, timeout: timeout)
                    defer { connection.close() }
                    _ = try connection.call("initialize", CodexProtocol.initializeParams())
                    try connection.notify("initialized")
                    let result = try connection.call("thread/loaded/list", ["limit": 1])
                    guard let ids = result["data"] as? [String] else {
                        throw CodexControlError.invalidResponse(method: "thread/loaded/list")
                    }
                    return !ids.isEmpty
                })
            }
        }
    }

    public func steerMessage(socketPath: String, threadId: String, turnId: String, text: String, clientUserMessageId: String) async throws {
        try await steerMessage(socketPath: socketPath, threadId: threadId, turnId: turnId, text: text, clientUserMessageId: clientUserMessageId, imagePaths: [])
    }

    public func steerMessage(socketPath: String, threadId: String, turnId: String, text: String, clientUserMessageId: String, imagePaths: [String]) async throws {
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
                            clientUserMessageId: clientUserMessageId, imagePaths: imagePaths
                        )
                    )
                })
            }
        }
    }

    public func interruptTurn(socketPath: String, threadId: String, turnId: String) async throws {
        let timeout = min(self.timeout, 5)
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

    public func startManagedThread(_ request: CodexThreadRequest) async throws -> ManagedRuntimeReceipt {
        let timeout = self.timeout
        return try await withCheckedThrowingContinuation { continuation in
            DispatchQueue.global().async {
                continuation.resume(with: Result { try Self.startManagedSync(request, timeout: timeout) })
            }
        }
    }

    static func startManagedSync(_ request: CodexThreadRequest, timeout: TimeInterval) throws -> ManagedRuntimeReceipt {
        let connection = try JSONRPCWebSocket(socketPath: request.socketPath, timeout: timeout)
        defer { connection.close() }
        try ManagedCodexProtocol.validateVersion(connection.call("initialize", CodexProtocol.initializeParams()))
        try connection.notify("initialized")
        let started = try connection.call("thread/start", ManagedCodexProtocol.startParams(request))
        let receipt = try ManagedCodexProtocol.runtimeReceipt(started)
        let threadId = receipt.sessionRef
        do {
            try ManagedCodexProtocol.validate(started, request: request)
            try ManagedCodexProtocol.validateMcp(connection.call("mcpServerStatus/list", ["threadId": threadId, "limit": 100]))
            guard let model = receipt.resolvedModel, !model.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
                throw CodexControlError.invalidResponse(method: "managed/thread/start model")
            }
            _ = try? connection.call("thread/name/set", CodexProtocol.threadNameParams(threadId: threadId, name: request.name))
            // Identity is returned and durably acknowledged before the coordinator permits a turn.
        } catch {
            // A turn/start timeout may already have started work. Keep its identity;
            // never archive, restart the daemon or try another thread automatically.
            throw ManagedLaunchUncertain(receipt: receipt)
        }
        _ = try? connection.call("thread/unsubscribe", ["threadId": threadId])
        return receipt
    }

    static func startThreadSync(_ request: CodexThreadRequest, timeout: TimeInterval) throws -> (String, String?) {
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
        var initialTurnId: String?
        do {
            try CodexProtocol.validateStarted(started, request: request)
            // Ask the app-server for the thread-scoped MCP state. Older app-
            // servers may not expose this method, so the permission probe below
            // remains the compatibility source of truth.
            _ = try? connection.call("mcpServerStatus/list", ["threadId": threadId, "limit": 100])
            let accountParams: [String: Any] = [
                "threadId": threadId, "server": "missiongo", "tool": "get_current_account", "arguments": [:],
            ]
            let account = try connection.call("mcpServer/tool/call", accountParams)
            try CodexProtocol.validateAccount(account, skillVersion: request.skillVersion)
            // A thread that could not be named is still a working thread; failing the
            // dispatch here would leave it running with nobody told about it.
            _ = try? connection.call("thread/name/set", CodexProtocol.threadNameParams(threadId: threadId, name: request.name))
            if request.settings.planning && (started["model"] as? String)?.isEmpty != false {
                throw LaunchError("Codex 未确认原生规划模型，尚未启动任务。")
            }
            let firstTurn = try connection.call("turn/start", CodexProtocol.turnStartParams(
                threadId: threadId,
                prompt: request.prompt,
                overrides: CodexTurnOverrides(model: request.model ?? started["model"] as? String, effort: request.effort, settings: request.settings)
            ))
            initialTurnId = (firstTurn["turn"] as? [String:Any])?["id"] as? String
        } catch {
            let diagnostic = missionGoDiagnostic(connection: connection, threadId: threadId, fallback: error)
            // Nothing reached turn/start successfully. Archive the empty shell
            // immediately so a stale Skill or MCP grant does not litter Codex.
            _ = try? connection.call("thread/archive", CodexProtocol.threadArchiveParams(threadId: threadId))
            _ = try? connection.call("thread/unsubscribe", ["threadId": threadId])
            if isMissionGoStartupFailure(error) { throw CodexControlError.mcpStartup(diagnostic) }
            throw error
        }
        _ = try? connection.call("thread/unsubscribe", ["threadId": threadId])
        return (threadId, initialTurnId)
    }

    static func missionGoDiagnostic(
        connection: JSONRPCWebSocket, threadId: String, fallback error: Error
    ) -> DispatchMcpDiagnostic {
        let statusResult = try? connection.call("mcpServerStatus/list", ["threadId": threadId, "limit": 100])
        let status = (statusResult?["data"] as? [[String: Any]])?.first { $0["name"] as? String == "missiongo" }
        let event = connection.notifications.reversed().first { message in
            guard message["method"] as? String == "mcpServer/startupStatus/updated",
                  let params = message["params"] as? [String: Any] else { return false }
            return params["name"] as? String == "missiongo"
        }?["params"] as? [String: Any]
        return DispatchMcpDiagnostic(
            threadId: threadId,
            startupStatus: event?["status"] as? String,
            runtimeStatus: status?["runtimeStatus"] as? String,
            authStatus: status?["authStatus"] as? String,
            error: (event?["error"] as? String) ?? (status?["toolsError"] as? String) ?? error.localizedDescription,
            failureReason: event?["failureReason"] as? String
        )
    }

    static func isMissionGoStartupFailure(_ error: Error) -> Bool {
        guard let control = error as? CodexControlError else { return false }
        if case let .timedOut(method) = control, method == "mcpServer/tool/call" { return true }
        guard case let .rpc(method, message) = control, method == "mcpServer/tool/call" else { return false }
        let normalized = message.lowercased()
        return normalized.contains("mcp startup") || normalized.contains("mcp client startup")
    }

}

// MARK: - Approval observation

/// One observer per Codex thread. App-server approval requests are live JSON-RPC
/// requests, not part of thread/read. The observer owns the socket until the
/// node stops polling an idle thread. Pending approvals keep the socket alive;
/// an answer is sent only on the socket that received the request.
final class CodexApprovalMonitor: @unchecked Sendable {
    private struct Watch {
        var active = false
        var lastTouched = Date()
        var snapshot: CodexApprovalSnapshot?
        var decision: (id: String, choice: String)?
        var cancelledTurn: String?
        var stopped = false
    }
    private let watches = Locked<[String: Watch]>([:])

    private let idleTimeout: TimeInterval
    private let reconnectDelay: TimeInterval

    init(idleTimeout: TimeInterval = 60, reconnectDelay: TimeInterval = 2) {
        self.idleTimeout = idleTimeout
        self.reconnectDelay = reconnectDelay
    }

    func watch(socketPath: String, threadId: String) {
        let start = watches.withLock { state -> Bool in
            var watch = state[threadId] ?? Watch()
            watch.lastTouched = Date()
            watch.stopped = false
            defer { state[threadId] = watch }
            guard !watch.active else { return false }
            watch.active = true
            return true
        }
        guard start else { return }
        DispatchQueue.global().async { [self] in run(socketPath: socketPath, threadId: threadId) }
    }

    func snapshot(threadId: String) -> CodexApprovalSnapshot? {
        watches.current[threadId]?.snapshot
    }

    func stop(threadId: String) {
        watches.withLock { state in
            guard var watch = state[threadId] else { return }
            watch.stopped = true
            state[threadId] = watch
        }
    }

    func answer(threadId: String, approvalId: String, decision: String) throws {
        let accepted = watches.withLock { state -> Bool in
            guard var watch = state[threadId], watch.active,
                  watch.snapshot?.id == approvalId,
                  watch.snapshot?.kind == "manual",
                  watch.snapshot?.status == "pending",
                  watch.snapshot?.options?.contains(where: { $0.id == decision }) == true else { return false }
            if let queued = watch.decision, queued.id != approvalId || queued.choice != decision { return false }
            watch.decision = (approvalId, decision)
            state[threadId] = watch
            return true
        }
        if !accepted { throw CodexControlError.rpc(method: "approval", message: "授权请求已失效或已有其他决定。") }
    }

    func cancel(threadId: String, turnId: String) {
        watches.withLock { state in
            guard var watch = state[threadId] else { return }
            watch.cancelledTurn = turnId
            watch.decision = nil
            state[threadId] = watch
        }
    }

    private func run(socketPath: String, threadId: String) {
        while watches.current[threadId]?.stopped == false {
            var pending: [CodexApprovalRequest] = []
            do {
                let connection = try JSONRPCWebSocket(socketPath: socketPath, timeout: 2)
                defer { connection.close() }
                _ = try connection.call("initialize", CodexProtocol.initializeParams())
                try connection.notify("initialized")
                let resumed = try connection.call("thread/resume", ["threadId": threadId, "excludeTurns": true])
                for message in connection.notifications {
                    observe(message, threadId: threadId, pending: &pending)
                }
                // A prompt can be resolved while this observer is disconnected.
                // Do not leave its unavailable card behind after an idle resume.
                if let thread = resumed["thread"] as? [String: Any],
                   let status = thread["status"] as? [String: Any],
                   ["idle", "notLoaded"].contains(status["type"] as? String ?? ""), pending.isEmpty {
                    watches.withLock { state in
                        guard var watch = state[threadId], let old = watch.snapshot,
                              old.kind == "manual", ["pending", "unavailable", "reconnecting"].contains(old.status) else { return }
                        watch.snapshot = CodexApprovalSnapshot(id: old.id, kind: old.kind, status: "resolved",
                            turnId: old.turnId, action: old.action, reason: "来源回合已结束，旧授权请求已失效。",
                            startedAtMs: old.startedAtMs, requestKind: old.requestKind, options: old.options)
                        watch.decision = nil
                        state[threadId] = watch
                    }
                }
                while true {
                    let current = watches.current[threadId]
                    guard let current, !current.stopped else { break }
                    // A human may return much later or from another device. An
                    // outstanding request owns this socket regardless of polling.
                    guard !pending.isEmpty || current.snapshot?.status == "reconnecting"
                        || Date().timeIntervalSince(current.lastTouched) < idleTimeout else { break }
                    if let cancelledTurn = current.cancelledTurn, pending.contains(where: { $0.snapshot.turnId == cancelledTurn }) {
                        for request in pending.filter({ $0.snapshot.turnId == cancelledTurn }) {
                            try connection.respond(id: request.rpcId, result: request.result(decision: "cancel"))
                            pending.removeAll { $0.snapshot.id == request.snapshot.id }
                            publish(request.ended("denied", reason: "用户已终止当前回合，未授予权限。"), pending: pending, threadId: threadId)
                        }
                    } else if let decision = current.decision,
                              let request = pending.first(where: { $0.snapshot.id == decision.id }) {
                        try connection.respond(id: request.rpcId, result: request.result(decision: decision.choice))
                        pending.removeAll { $0.snapshot.id == decision.id }
                        let denied = request.snapshot.options?.contains {
                            $0.id == decision.choice && ["decline", "cancel", "networkDeny"].contains($0.kind)
                        } == true
                        let answeredQuestion = ["item/tool/requestUserInput", "tool/requestUserInput"].contains(request.method)
                        publish(request.ended(answeredQuestion ? "resolved" : denied ? "denied" : "approved"),
                            pending: pending, threadId: threadId)
                    }
                    do {
                        let message = try connection.receive(timeout: 1)
                        observe(message, threadId: threadId, pending: &pending)
                    } catch CodexControlError.timedOut { continue }
                }
            } catch {
                watches.withLock { state in
                    guard var watch = state[threadId], !watch.stopped,
                          let old = watch.snapshot, old.kind == "manual",
                          ["pending", "reconnecting"].contains(old.status) else { return }
                    watch.snapshot = CodexApprovalSnapshot(id: old.id, kind: old.kind, status: "reconnecting",
                        turnId: old.turnId, action: old.action,
                        reason: "授权连接已断开，正在重新连接并核实来源请求。旧决定不会自动重发。",
                        startedAtMs: old.startedAtMs, requestKind: old.requestKind, options: old.options)
                    watch.decision = nil
                    state[threadId] = watch
                }
            }
            if watches.current[threadId]?.stopped == true { break }
            let current = watches.current[threadId]
            guard current?.snapshot?.status == "reconnecting" else { break }
            // Reconnection gets fresh request identities from Codex. Never replay
            // an RPC id or decision captured on a previous transport connection.
            Thread.sleep(forTimeInterval: reconnectDelay)
        }
        watches.withLock { state in
            guard var watch = state[threadId] else { return }
            if let old = watch.snapshot, old.kind == "manual", ["pending", "reconnecting"].contains(old.status) {
                watch.snapshot = CodexApprovalSnapshot(id: old.id, kind: old.kind, status: "unavailable",
                    turnId: old.turnId, action: old.action, reason: "Codex 授权连接已断开，请在 Codex 中核实。",
                    startedAtMs: old.startedAtMs, requestKind: old.requestKind, options: old.options)
            }
            watch.active = false
            watch.decision = nil
            watch.cancelledTurn = nil
            state[threadId] = watch
        }
    }

    private func publish(_ ended: CodexApprovalSnapshot, pending: [CodexApprovalRequest], threadId: String) {
        watches.withLock { state in
            guard var watch = state[threadId] else { return }
            watch.snapshot = pending.first?.snapshot ?? ended
            watch.decision = nil
            state[threadId] = watch
        }
    }

    private func observe(_ message: [String: Any], threadId: String,
                         pending: inout [CodexApprovalRequest]) {
        guard let method = message["method"] as? String,
              let params = message["params"] as? [String: Any],
              params["threadId"] as? String == threadId else { return }
        if let request = CodexApprovalRequest(message, threadId: threadId) {
            guard !pending.contains(where: { $0.matches(rpcId: request.rpcId) }) else { return }
            pending.append(request)
            watches.withLock { state in
                guard var watch = state[threadId] else { return }
                watch.snapshot = pending.first?.snapshot
                state[threadId] = watch
            }
        } else if method == "serverRequest/resolved", let rpcId = params["requestId"],
                  let request = pending.first(where: { $0.matches(rpcId: rpcId) }) {
            pending.removeAll { $0.matches(rpcId: rpcId) }
            publish(request.ended("resolved"), pending: pending, threadId: threadId)
        } else if method == "item/autoApprovalReview/started" || method == "item/autoApprovalReview/completed",
                  let id = params["reviewId"] as? String,
                  let turnId = params["turnId"] as? String,
                  let startedAt = (params["startedAtMs"] as? NSNumber)?.int64Value,
                  let review = params["review"] as? [String: Any],
                  let action = params["action"] as? [String: Any] {
            let status = review["status"] as? String ?? "inProgress"
            let kind = action["type"] as? String ?? "action"
            let detail = (action["command"] as? String) ?? (action["target"] as? String)
                ?? (action["toolName"] as? String) ?? (action["reason"] as? String) ?? kind
            watches.withLock { state in
                guard var watch = state[threadId] else { return }
                guard pending.isEmpty else { return }
                watch.snapshot = CodexApprovalSnapshot(id: id, kind: "auto", status: status, turnId: turnId,
                    action: String(detail.prefix(4_000)), reason: review["rationale"] as? String,
                    startedAtMs: startedAt)
                state[threadId] = watch
            }
        } else if method == "turn/completed" {
            let turnId = (params["turn"] as? [String: Any])?["id"] as? String
            for request in pending.filter({ $0.snapshot.turnId == turnId }) {
                pending.removeAll { $0.snapshot.id == request.snapshot.id }
                publish(request.ended("resolved", reason: "授权请求已随回合结束失效。"), pending: pending, threadId: threadId)
            }
            // A request may have finished on the source client during a
            // disconnect and need not be replayed on this new connection.
            if pending.isEmpty {
                watches.withLock { state in
                    guard var watch = state[threadId], let old = watch.snapshot,
                          old.kind == "manual", old.status == "reconnecting", old.turnId == turnId else { return }
                    watch.snapshot = CodexApprovalSnapshot(id: old.id, kind: old.kind, status: "resolved",
                        turnId: old.turnId, action: old.action, reason: "授权请求已随回合结束失效。",
                        startedAtMs: old.startedAtMs, requestKind: old.requestKind, options: old.options)
                    watch.decision = nil
                    state[threadId] = watch
                }
            }
        }
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
    private(set) var notifications: [[String: Any]] = []
    private(set) var receivedBytes = 0

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
            // Ordinary RPC calls do not approve server requests. The dedicated
            // observer consumes captured requests and answers after a person
            // decides in MissionGo.
            if message["method"] != nil {
                notifications.append(message)
                continue
            }
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

    fileprivate func respond(id: Any, result: [String: Any]) throws {
        try send(["jsonrpc": "2.0", "id": id, "result": result])
    }

    fileprivate func receive(timeout: TimeInterval) throws -> [String: Any] {
        try nextMessage(deadline: Date().addingTimeInterval(timeout), method: "approval events")
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
                    guard frame.payload.count <= WebSocketFrame.maxPayload - fragments.count else {
                        throw WebSocketFrame.FrameTooLarge()
                    }
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
                receivedBytes += bytes.count
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

    /// Allocation guard, not a claim about valid conversation size. Long
    /// histories use bounded summary pages instead of removing this guard.
    static let maxPayload = 16 * 1024 * 1024

    struct Frame: Equatable {
        let fin: Bool
        let opcode: UInt8
        let payload: [UInt8]
    }

    struct FrameTooLarge: LocalizedError {
        var errorDescription: String? { "Codex 返回的数据超过单条消息读取上限。" }
    }

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

/// How long a Unix socket connect may take before the daemon is called
/// unreachable (AND-220). A healthy app-server accepts instantly; a half-dead
/// one leaves the connect pending forever without this.
private let unixSocketConnectTimeout: TimeInterval = 3

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
        // Connect without blocking: a half-dead daemon can leave a blocking
        // connect() pending indefinitely, which no receive timeout ever sees
        // (AND-220). Poll for writability with its own deadline, then put the
        // socket back the blocking way the read/write paths expect.
        let originalFlags = fcntl(descriptor, F_GETFL)
        if originalFlags >= 0 {
            _ = fcntl(descriptor, F_SETFL, originalFlags | O_NONBLOCK)
        }
        let connectResult = withUnsafePointer(to: &address) { pointer in
            pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                connect(descriptor, $0, socklen_t(MemoryLayout<sockaddr_un>.size))
            }
        }
        if connectResult != 0 && errno == EINPROGRESS && originalFlags >= 0 {
            var pollDescriptor = pollfd(fd: descriptor, events: Int16(POLLOUT), revents: 0)
            let polled = poll(&pollDescriptor, 1, Int32(unixSocketConnectTimeout * 1000))
            let failure: String?
            if polled == 0 {
                failure = "连接超时（\(Int(unixSocketConnectTimeout)) 秒）"
            } else if polled < 0 {
                failure = UnixSocket.errnoText()
            } else {
                var pendingError: Int32 = 0
                var pendingLength = socklen_t(MemoryLayout<Int32>.size)
                if getsockopt(descriptor, SOL_SOCKET, SO_ERROR, &pendingError, &pendingLength) == 0 && pendingError != 0 {
                    errno = pendingError
                    failure = UnixSocket.errnoText()
                } else {
                    failure = nil
                }
            }
            _ = fcntl(descriptor, F_SETFL, originalFlags)
            if let failure {
                Darwin.close(descriptor)
                throw CodexControlError.connect(path: path, reason: failure)
            }
        } else if connectResult != 0 {
            let reason = UnixSocket.errnoText()
            if originalFlags >= 0 { _ = fcntl(descriptor, F_SETFL, originalFlags) }
            Darwin.close(descriptor)
            throw CodexControlError.connect(path: path, reason: reason)
        } else if originalFlags >= 0 {
            _ = fcntl(descriptor, F_SETFL, originalFlags)
        }
        self.descriptor = descriptor
    }

    deinit {
        close()
    }

    /// The process on the other end of this connected Unix socket.
    ///
    /// Darwin exposes this directly. Prefer it over asking `lsof` to resolve a
    /// socket path: the daemon's public control path is a symlink into its
    /// private runtime directory, and path-based inspection may be denied even
    /// though connecting to the socket is allowed.
    func peerPID() -> Int32? {
        var pid: Int32 = 0
        var size = socklen_t(MemoryLayout.size(ofValue: pid))
        guard getsockopt(descriptor, SOL_LOCAL, LOCAL_PEERPID, &pid, &size) == 0,
              size == MemoryLayout.size(ofValue: pid), pid > 0 else { return nil }
        return pid
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
