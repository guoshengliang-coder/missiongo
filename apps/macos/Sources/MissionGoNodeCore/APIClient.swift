import Foundation

/// The node side of the dispatch protocol.
///
/// Every call is outbound: the machine opens no port for the server and accepts
/// no connection from it, so a developer machine never becomes reachable from
/// the network just because it can run dispatches. (The OAuth callback listener
/// is loopback-only and lives for one login.)

// MARK: - Wire types

public struct AgentSkillSnapshot: Codable, Equatable, Sendable {
    public let localVersion: String?
    public let expectedVersion: String?
    public let syncState: String
    public let checkedAt: String?

    public init(localVersion: String? = nil, expectedVersion: String? = nil, syncState: String, checkedAt: String? = nil) {
        self.localVersion = localVersion
        self.expectedVersion = expectedVersion
        self.syncState = syncState
        self.checkedAt = checkedAt
    }
}

public struct AgentResourceSnapshot: Codable, Equatable, Sendable {
    public let pid: Int32?
    public let openFiles: Int?
    public let softLimit: Int?
    public let source: String?
    public let checkedAt: String?
    public let status: String
    public let reason: String?

    public init(
        pid: Int32? = nil, openFiles: Int? = nil, softLimit: Int? = nil, source: String? = nil,
        checkedAt: String? = nil, status: String, reason: String? = nil
    ) {
        self.pid = pid
        self.openFiles = openFiles
        self.softLimit = softLimit
        self.source = source
        self.checkedAt = checkedAt
        self.status = status
        self.reason = reason
    }
}

public struct DetectedAgent: Codable, Equatable, Sendable {
    public let kind: String
    public let version: String
    /// The models a dispatch may pick for this agent. Its presence, even as an
    /// empty list, is what tells the server this client understands model and
    /// effort selection and runtime settings; nil leaves the key out, which
    /// an older server ignored anyway.
    public let models: [AgentModelOption]?
    public let ready: Bool?
    public let unavailableReason: String?
    public let skill: AgentSkillSnapshot?
    public let resource: AgentResourceSnapshot?

    public init(
        kind: String, version: String, models: [AgentModelOption]? = nil,
        ready: Bool? = nil, unavailableReason: String? = nil,
        skill: AgentSkillSnapshot? = nil, resource: AgentResourceSnapshot? = nil
    ) {
        self.kind = kind
        self.version = version
        self.models = models
        self.ready = ready
        self.unavailableReason = unavailableReason
        self.skill = skill
        self.resource = resource
    }
}

/// One model an agent offers, as the console lists it.
public struct AgentModelOption: Codable, Equatable, Sendable {
    /// What goes back to the agent: `--model` for Claude Code, `model` for Codex.
    public let id: String
    public let label: String
    /// Reasoning efforts the model accepts; empty when it takes none.
    public let efforts: [String]
    public let defaultEffort: String?
    public let isDefault: Bool?

    public init(id: String, label: String, efforts: [String] = [], defaultEffort: String? = nil, isDefault: Bool? = nil) {
        self.id = id
        self.label = label
        self.efforts = efforts
        self.defaultEffort = defaultEffort
        self.isDefault = isDefault
    }

    private enum CodingKeys: String, CodingKey {
        case id, label, efforts, defaultEffort, isDefault
    }

    public init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        id = try values.decode(String.self, forKey: .id)
        label = try values.decodeIfPresent(String.self, forKey: .label) ?? id
        efforts = try values.decodeIfPresent([String].self, forKey: .efforts) ?? []
        defaultEffort = try values.decodeIfPresent(String.self, forKey: .defaultEffort)
        isDefault = try values.decodeIfPresent(Bool.self, forKey: .isDefault)
    }
}

/// The mode, model and effort a person wants a running session to use.
/// Each field left out means "leave this one as it is".
public struct AgentSessionSettings: Codable, Equatable, Sendable {
    /// Grows with every change a person makes; the node reports back the one
    /// it has applied, so a change is applied once however often it is sent.
    public let revision: Int
    public let mode: String?
    public let model: String?
    public let effort: String?

    public init(revision: Int, mode: String? = nil, model: String? = nil, effort: String? = nil) {
        self.revision = revision
        self.mode = mode
        self.model = model
        self.effort = effort
    }

    private enum CodingKeys: String, CodingKey {
        case revision, mode, model, effort
    }

    public init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        revision = try values.decodeIfPresent(Int.self, forKey: .revision) ?? 0
        mode = try values.decodeIfPresent(String.self, forKey: .mode)
        model = try values.decodeIfPresent(String.self, forKey: .model)
        effort = try values.decodeIfPresent(String.self, forKey: .effort)
    }
}

/// Model names and efforts arrive over the wire and end up in argv or an RPC
/// field. Arguments never pass through a shell, but a value starting with `-`
/// could still be read by the CLI as another flag, so the machine checks the
/// shape itself instead of trusting the server to have checked.
public enum AgentModelSettings {
    /// Covers `opus[1m]`, `claude-fable-5-1[1m]`, `gpt-5.1-codex`, `provider/model`.
    static let modelPattern = AnchoredPattern("[A-Za-z0-9][A-Za-z0-9._:/\\[\\]-]{0,127}")
    static let effortPattern = AnchoredPattern("[a-z][a-z0-9_-]{0,31}")

    public static func isValidModel(_ value: String) -> Bool {
        modelPattern.matches(value)
    }

    public static func isValidEffort(_ value: String) -> Bool {
        effortPattern.matches(value)
    }

    /// nil when both are acceptable (or absent), else the reason to refuse.
    public static func problem(model: String?, effort: String?) -> String? {
        if let model, !isValidModel(model) { return "不支持的模型名：\(JSONValues.quote(model))" }
        if let effort, !isValidEffort(effort) { return "不支持的推理强度：\(JSONValues.quote(effort))" }
        return nil
    }
}

public struct RepoMapping: Codable, Equatable, Sendable {
    public let productId: String
    public let productKey: String
    public let repoPath: String

    public init(productId: String, productKey: String, repoPath: String) {
        self.productId = productId
        self.productKey = productKey
        self.repoPath = repoPath
    }
}

/// One entry of `PUT /api/v1/node/repos`: the product key is the server's to
/// fill in, the machine only says which folder a product points at.
public struct RepoAssignment: Codable, Equatable, Sendable {
    public let productId: String
    public let repoPath: String

    public init(productId: String, repoPath: String) {
        self.productId = productId
        self.repoPath = repoPath
    }
}

public struct RegisteredNode: Codable, Equatable, Sendable {
    public let nodeId: String
    public let name: String
    public let token: String
}

public struct DispatchRequest: Codable, Equatable, Sendable {
    public let dispatchId: String
    public let itemKeys: [String]
    public let repoPath: String
    public let agentKind: String
    public let mode: String
    /// What the session is named after: the machine's nickname, or its device
    /// name when none is set. Optional because a server from before nicknames
    /// does not send it; the loop then falls back to the name stored at login.
    public let nodeName: String?
    /// Which session on these items this is (1 for the first). Optional, like
    /// `reworkItemKeys`, because a server from before rounds does not send it.
    public let round: Int?
    /// Items sent back after their work was handed over.
    public let reworkItemKeys: [String]?
    /// The model and reasoning effort picked for this dispatch. Absent means
    /// "follow this machine's own agent configuration", which is also all a
    /// server from before model selection can mean.
    public let model: String?
    public let effort: String?

    public init(
        dispatchId: String,
        itemKeys: [String],
        repoPath: String,
        agentKind: String,
        mode: String,
        nodeName: String? = nil,
        round: Int? = nil,
        reworkItemKeys: [String]? = nil,
        model: String? = nil,
        effort: String? = nil
    ) {
        self.dispatchId = dispatchId
        self.itemKeys = itemKeys
        self.repoPath = repoPath
        self.agentKind = agentKind
        self.mode = mode
        self.nodeName = nodeName
        self.round = round
        self.reworkItemKeys = reworkItemKeys
        self.model = model
        self.effort = effort
    }
}

public struct DispatchReport: Codable, Equatable, Sendable {
    public enum Status: String, Codable, Sendable {
        case launched
        case failed
        /// The server returns this same dispatch to its queue after a bounded delay.
        case retry
    }

    public let status: Status
    public let sessionName: String?
    public let sessionUrl: String?
    public let sessionRef: String?
    public let error: String?
    public let failureCode: String?
    public let failureStage: String?
    public let retryAfterSeconds: Int?
    public let diagnosticSnapshot: DispatchDiagnosticSnapshot?

    public init(
        status: Status, sessionName: String? = nil, sessionUrl: String? = nil,
        sessionRef: String? = nil, error: String? = nil,
        failureCode: String? = nil, failureStage: String? = nil,
        retryAfterSeconds: Int? = nil, diagnosticSnapshot: DispatchDiagnosticSnapshot? = nil
    ) {
        self.status = status
        self.sessionName = sessionName
        self.sessionUrl = sessionUrl
        self.sessionRef = sessionRef
        self.error = error
        self.failureCode = failureCode
        self.failureStage = failureStage
        self.retryAfterSeconds = retryAfterSeconds
        self.diagnosticSnapshot = diagnosticSnapshot
    }
}

public struct DispatchMcpDiagnostic: Codable, Equatable, Sendable {
    public let threadId: String?
    public let name: String
    public let startupStatus: String?
    public let runtimeStatus: String?
    public let authStatus: String?
    public let error: String?
    public let failureReason: String?
    public let observedAt: String

    public init(
        threadId: String? = nil, name: String = "missiongo", startupStatus: String? = nil,
        runtimeStatus: String? = nil, authStatus: String? = nil, error: String? = nil,
        failureReason: String? = nil, observedAt: String = ISO8601DateFormatter().string(from: Date())
    ) {
        self.threadId = threadId
        self.name = name
        self.startupStatus = startupStatus
        self.runtimeStatus = runtimeStatus
        self.authStatus = authStatus
        self.error = error
        self.failureReason = failureReason
        self.observedAt = observedAt
    }
}

public struct DispatchDiagnosticSnapshot: Codable, Equatable, Sendable {
    public let mcp: DispatchMcpDiagnostic?

    public init(mcp: DispatchMcpDiagnostic? = nil) {
        self.mcp = mcp
    }
}

public struct AgentSessionCommand: Codable, Equatable, Sendable {
    public let id: String
    /// Absent when talking to a server from before interrupt commands.
    public let kind: String?
    public let text: String
    public let turnId: String?
    public let status: String
    public let error: String?
    public let createdAt: String
    public let deliveredAt: String?

    public init(id: String, kind: String? = nil, text: String, turnId: String? = nil, status: String = "queued", error: String? = nil, createdAt: String = "", deliveredAt: String? = nil) {
        self.id = id
        self.kind = kind
        self.text = text
        self.turnId = turnId
        self.status = status
        self.error = error
        self.createdAt = createdAt
        self.deliveredAt = deliveredAt
    }
}

public struct NodeAgentSession: Codable, Equatable, Sendable {
    public let id: String
    public let dispatchId: String?
    public let agentKind: String
    public let sessionRef: String
    public let status: String
    /// `close` means every item in this dispatch is done, so the node should
    /// release a Claude process without changing the
    /// work-item state. Older servers omit it and therefore keep the session.
    public let lifecycle: String
    /// The server's durable view of whether this conversation consumes one of
    /// the node's execution slots. A locally launched session is reserved until
    /// it appears in this list, closing the poll/snapshot race.
    public let occupiesExecutionSlot: Bool
    public let command: AgentSessionCommand?
    /// MissionGo archived this conversation (its work finished, or a person
    /// archived it); archive the Codex thread at the source too (AND-129).
    /// Older servers omit it.
    public let archiveInSource: Bool
    /// A person restored it in MissionGo after its Codex thread was archived;
    /// restore the thread too, or the next read would archive it again.
    public let restoreInSource: Bool
    /// What a person asked this running session to switch to. Sent on every
    /// poll, not only once, so the node needs no memory of it between polls.
    public let desiredSettings: AgentSessionSettings?
    /// The revision the server has already heard the node apply (or fail to).
    /// A change is due only while `desiredSettings.revision` is past this.
    public let appliedSettingsRevision: Int

    public init(
        id: String,
        dispatchId: String? = nil,
        agentKind: String = "codex",
        sessionRef: String,
        status: String,
        lifecycle: String = "keep",
        occupiesExecutionSlot: Bool? = nil,
        command: AgentSessionCommand? = nil,
        archiveInSource: Bool = false,
        restoreInSource: Bool = false,
        desiredSettings: AgentSessionSettings? = nil,
        appliedSettingsRevision: Int = 0
    ) {
        self.id = id
        self.dispatchId = dispatchId
        self.agentKind = agentKind
        self.sessionRef = sessionRef
        self.status = status
        self.lifecycle = lifecycle
        self.occupiesExecutionSlot = occupiesExecutionSlot ?? ["active", "stalled"].contains(status)
        self.command = command
        self.archiveInSource = archiveInSource
        self.restoreInSource = restoreInSource
        self.desiredSettings = desiredSettings
        self.appliedSettingsRevision = appliedSettingsRevision
    }

    /// The settings still to apply, or nil when there is nothing new.
    public var pendingSettings: AgentSessionSettings? {
        guard let desiredSettings, desiredSettings.revision > appliedSettingsRevision else { return nil }
        return desiredSettings
    }

    private enum CodingKeys: String, CodingKey {
        case id, dispatchId, agentKind, sessionRef, status, lifecycle, occupiesExecutionSlot, command, archiveInSource
        case restoreInSource, desiredSettings, appliedSettingsRevision
    }

    public init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        id = try values.decode(String.self, forKey: .id)
        dispatchId = try values.decodeIfPresent(String.self, forKey: .dispatchId)
        // A server from before Claude mirroring only ever lists Codex here.
        agentKind = try values.decodeIfPresent(String.self, forKey: .agentKind) ?? "codex"
        sessionRef = try values.decode(String.self, forKey: .sessionRef)
        status = try values.decode(String.self, forKey: .status)
        lifecycle = try values.decodeIfPresent(String.self, forKey: .lifecycle) ?? "keep"
        occupiesExecutionSlot = try values.decodeIfPresent(Bool.self, forKey: .occupiesExecutionSlot)
            ?? ["active", "stalled"].contains(status)
        command = try values.decodeIfPresent(AgentSessionCommand.self, forKey: .command)
        archiveInSource = try values.decodeIfPresent(Bool.self, forKey: .archiveInSource) ?? false
        restoreInSource = try values.decodeIfPresent(Bool.self, forKey: .restoreInSource) ?? false
        // A server from before runtime settings sends neither.
        desiredSettings = try values.decodeIfPresent(AgentSessionSettings.self, forKey: .desiredSettings)
        appliedSettingsRevision = try values.decodeIfPresent(Int.self, forKey: .appliedSettingsRevision) ?? 0
    }
}

public struct AgentSessionQuestion: Codable, Equatable, Sendable {
    public let header: String?
    public let title: String
    public let options: [String]?
    public let multiSelect: Bool?

    public init(header: String? = nil, title: String, options: [String]? = nil, multiSelect: Bool? = nil) {
        self.header = header
        self.title = title
        self.options = options
        self.multiSelect = multiSelect
    }
}

public struct AgentSessionActivity: Codable, Equatable, Sendable {
    public let id: String
    public let title: String
    public let detail: String?

    public init(id: String, title: String, detail: String? = nil) {
        self.id = id
        self.title = title
        self.detail = detail
    }
}

public struct AgentSessionMessage: Codable, Equatable, Sendable {
    public let sourceId: String
    public let turnId: String?
    public let role: String
    public let phase: String?
    public let text: String
    public let occurredAt: String?
    public let questions: [AgentSessionQuestion]?

    public init(sourceId: String, turnId: String? = nil, role: String, phase: String? = nil, text: String, occurredAt: String? = nil, questions: [AgentSessionQuestion]? = nil) {
        self.sourceId = sourceId
        self.turnId = turnId
        self.role = role
        self.phase = phase
        self.text = text
        self.occurredAt = occurredAt
        self.questions = questions
    }
}

public struct AgentSessionReport: Codable, Equatable, Sendable {
    public let status: String
    public let messages: [AgentSessionMessage]
    public let activities: [AgentSessionActivity]
    public let error: String?
    public let commandId: String?
    public let commandStatus: String?
    public let commandError: String?
    public let sourceArchived: Bool?
    /// The source archive MissionGo asked for failed; the server stops asking.
    public let sourceArchiveError: String?
    /// The Codex thread MissionGo asked to bring back was restored.
    public let sourceRestored: Bool?
    /// A resumed Claude session may receive a new Remote Control URL. The node
    /// reports the fresh, validated URL instead of leaving a dead link behind.
    public let sessionUrl: String?
    /// Clears a stale Remote Control URL when the resumed session uses local control.
    public let clearSessionUrl: Bool?
    /// Last activity timestamp from the source conversation, not this mirror poll.
    public let activityAt: String?
    /// The model and effort actually in use as far as this machine knows;
    /// nil when it does not know (an effort left to the agent's own default).
    public let model: String?
    public let effort: String?
    /// The desired-settings revision now applied. With `settingsError` it is
    /// the revision whose application failed, so the server stops asking.
    public let settingsRevision: Int?
    public let settingsError: String?

    public init(status: String, messages: [AgentSessionMessage], activities: [AgentSessionActivity] = [], error: String? = nil, commandId: String? = nil, commandStatus: String? = nil, commandError: String? = nil, sourceArchived: Bool? = nil, sourceArchiveError: String? = nil, sourceRestored: Bool? = nil, sessionUrl: String? = nil, clearSessionUrl: Bool? = nil, activityAt: String? = nil, model: String? = nil, effort: String? = nil, settingsRevision: Int? = nil, settingsError: String? = nil) {
        self.status = status
        self.messages = messages
        self.activities = activities
        self.error = error
        self.commandId = commandId
        self.commandStatus = commandStatus
        self.commandError = commandError
        self.sourceArchived = sourceArchived
        self.sourceArchiveError = sourceArchiveError
        self.sourceRestored = sourceRestored
        self.sessionUrl = sessionUrl
        self.clearSessionUrl = clearSessionUrl
        self.activityAt = activityAt
        self.model = model
        self.effort = effort
        self.settingsRevision = settingsRevision
        self.settingsError = settingsError
    }

    /// The same report carrying the session's settings. Kept apart so every
    /// branch that decides status and commands need not repeat them.
    public func reportingSettings(model: String?, effort: String?, settingsRevision: Int?, settingsError: String?, clearSessionUrl: Bool? = nil) -> AgentSessionReport {
        AgentSessionReport(
            status: status, messages: messages, activities: activities, error: error,
            commandId: commandId, commandStatus: commandStatus, commandError: commandError,
            sourceArchived: sourceArchived, sourceArchiveError: sourceArchiveError, sourceRestored: sourceRestored,
            sessionUrl: sessionUrl, clearSessionUrl: clearSessionUrl, activityAt: activityAt,
            model: model, effort: effort, settingsRevision: settingsRevision, settingsError: settingsError
        )
    }
}

public struct NodeProfile: Codable, Equatable, Sendable {
    public struct Node: Codable, Equatable, Sendable {
        public let id: String
        /// For display: the nickname when one is set, else the device name.
        public let name: String
        /// The name the machine registered with. Optional only so a server from
        /// before nicknames still decodes; its absence is also how the menu knows
        /// that server cannot store a nickname.
        public let deviceName: String?
        public let nickname: String?
        public let hostname: String?
        public let online: Bool
        public let lastSeenAt: String?
    }

    public struct Product: Codable, Equatable, Sendable {
        public let id: String
        public let keyPrefix: String
        public let name: String
    }

    public let node: Node
    public let repos: [RepoMapping]
    public let products: [Product]
}

/// What a heartbeat answers with: the mappings this machine has, and the
/// products it could be given one for.
///
/// `products` is nil against a server from before the heartbeat carried them;
/// the client then keeps whatever list it already had rather than emptying the
/// menu.
public struct HeartbeatReply: Equatable, Sendable {
    public let repos: [RepoMapping]
    public let products: [NodeProfile.Product]?
    public let expectedSkillVersion: String?

    public init(
        repos: [RepoMapping],
        products: [NodeProfile.Product]? = nil,
        expectedSkillVersion: String? = nil
    ) {
        self.repos = repos
        self.products = products
        self.expectedSkillVersion = expectedSkillVersion
    }
}

public struct DispatchRecord: Codable, Equatable, Sendable {
    public let id: String
    public let nodeName: String
    public let agentKind: String
    public let mode: String
    public let status: String
    public let itemKeys: [String]
    public let sessionName: String?
    public let sessionUrl: String?
    public let error: String?
    public let createdAt: String
    public let completedAt: String?
}

// MARK: - Errors

public enum APIError: Error, Equatable, LocalizedError, Sendable {
    /// The credential is gone for good: revoked, the node deleted, or the login
    /// token refused. Unlike a network blip this never fixes itself, so the loop
    /// stops instead of hammering the server with a credential that will keep
    /// being refused, and the app goes back to "请登录".
    case credentialRevoked(status: Int, detail: String?)
    /// The server answered, with something other than 2xx.
    case http(operation: String, status: Int, detail: String)
    /// The request never got an answer.
    case network(NetworkFailure)
    /// The server answered 2xx with a body this client cannot use.
    case invalidResponse(String)

    public var errorDescription: String? {
        switch self {
        case let .credentialRevoked(status, detail):
            let suffix = detail.map { "（\($0)）" } ?? ""
            return "凭证已失效（HTTP \(status)）\(suffix)：需要重新登录。"
        case let .http(operation, status, detail):
            return "\(operation) 失败（HTTP \(status)）：\(detail)"
        case let .network(failure):
            return failure.description
        case let .invalidResponse(message):
            return message
        }
    }
}

/// A request that never reached the server, described concretely.
///
/// The first real pairing attempt on a second machine printed only "fetch
/// failed", which nobody could act on: it did not say which host, or whether
/// the name did not resolve, the port refused, or the connection hung. Host and
/// `URLError` code are what tell a wrong server address from a VPN that is down.
public struct NetworkFailure: Equatable, Sendable, CustomStringConvertible {
    public let host: String
    public let code: Int
    public let codeName: String
    public let reason: String

    public var isTimeout: Bool {
        return code == URLError.Code.timedOut.rawValue
    }

    public var description: String {
        if isTimeout {
            return "连接 \(host) 超时（URLError.\(codeName)）：\(reason)"
        }
        return "无法连接 \(host)（URLError.\(codeName)）：\(reason)"
    }

    init(host: String, error: URLError) {
        self.host = host
        code = error.code.rawValue
        codeName = NetworkFailure.name(of: error.code)
        reason = error.localizedDescription
    }

    init(host: String, other error: Error) {
        self.host = host
        code = 0
        codeName = "unknown"
        reason = (error as NSError).localizedDescription
    }

    static func name(of code: URLError.Code) -> String {
        switch code {
        case .timedOut: return "timedOut"
        case .cannotFindHost: return "cannotFindHost"
        case .cannotConnectToHost: return "cannotConnectToHost"
        case .networkConnectionLost: return "networkConnectionLost"
        case .dnsLookupFailed: return "dnsLookupFailed"
        case .notConnectedToInternet: return "notConnectedToInternet"
        case .badURL: return "badURL"
        case .unsupportedURL: return "unsupportedURL"
        case .badServerResponse: return "badServerResponse"
        case .cannotParseResponse: return "cannotParseResponse"
        case .secureConnectionFailed: return "secureConnectionFailed"
        case .serverCertificateUntrusted: return "serverCertificateUntrusted"
        case .serverCertificateHasBadDate: return "serverCertificateHasBadDate"
        case .serverCertificateHasUnknownRoot: return "serverCertificateHasUnknownRoot"
        case .serverCertificateNotYetValid: return "serverCertificateNotYetValid"
        case .clientCertificateRejected: return "clientCertificateRejected"
        case .appTransportSecurityRequiresSecureConnection: return "appTransportSecurityRequiresSecureConnection"
        case .internationalRoamingOff: return "internationalRoamingOff"
        case .callIsActive: return "callIsActive"
        case .dataNotAllowed: return "dataNotAllowed"
        case .cancelled: return "cancelled"
        case .resourceUnavailable: return "resourceUnavailable"
        case .httpTooManyRedirects: return "httpTooManyRedirects"
        case .redirectToNonExistentLocation: return "redirectToNonExistentLocation"
        case .zeroByteResource: return "zeroByteResource"
        default: return "code\(code.rawValue)"
        }
    }
}

// MARK: - Transport

/// Drop trailing slashes from a server URL.
///
/// Every request path already starts with `/api` or `/oauth`, so a stored
/// trailing slash would produce `//api/...`, which some proxies answer with a
/// 404 instead of normalising.
public func normalizeServerUrl(_ value: String) -> String {
    var trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
    while trimmed.hasSuffix("/") {
        trimmed.removeLast()
    }
    return trimmed
}

struct HTTPResponse {
    let status: Int
    let body: Data

    var text: String {
        return String(data: body, encoding: .utf8) ?? ""
    }
}

/// The one place requests go out, shared by the node API and the OAuth login so
/// both describe a failure the same way.
struct HTTPTransport: Sendable {
    let session: URLSession

    func send(_ request: URLRequest) async throws -> HTTPResponse {
        let host = HTTPTransport.hostLabel(request.url)
        do {
            let (data, response) = try await session.data(for: request)
            guard let http = response as? HTTPURLResponse else {
                throw APIError.invalidResponse("\(host) 返回的不是 HTTP 响应。")
            }
            return HTTPResponse(status: http.statusCode, body: data)
        } catch let error as APIError {
            throw error
        } catch let error as URLError {
            // A cancelled task surfaces as URLError.cancelled; the caller asked for
            // that, so it is not a network failure worth reporting.
            if error.code == .cancelled, Task.isCancelled { throw CancellationError() }
            throw APIError.network(NetworkFailure(host: host, error: error))
        } catch is CancellationError {
            throw CancellationError()
        } catch {
            throw APIError.network(NetworkFailure(host: host, other: error))
        }
    }

    /// `host:port` when a port is given, so a wrong port is as visible as a wrong host.
    static func hostLabel(_ url: URL?) -> String {
        guard let url, let host = url.host else { return url?.absoluteString ?? "（无地址）" }
        if let port = url.port { return "\(host):\(port)" }
        return host
    }

    /// The most useful line out of an error body: problem+json `title` from the
    /// API, `error_description`/`error` from the OAuth endpoints, else raw text.
    static func errorDetail(_ response: HTTPResponse) -> String {
        if let object = JSONValues.parse(response.text) as? [String: Any] {
            for field in ["title", "error_description", "error"] {
                if let value = object[field] as? String, !value.isEmpty { return value }
            }
        }
        let text = response.text.trimmingCharacters(in: .whitespacesAndNewlines)
        if text.isEmpty { return "无响应内容" }
        return text.count > 300 ? String(text.prefix(300)) + "…" : text
    }

    static func problemTitle(_ response: HTTPResponse) -> String? {
        guard let object = JSONValues.parse(response.text) as? [String: Any] else { return nil }
        return object["title"] as? String
    }
}

/// Any 2xx is success. The TypeScript client once insisted on 200 and turned
/// the 201 from pairing and the 204 from result reporting into reported
/// failures — for pairing one that could never be retried.
func isSuccess(_ status: Int) -> Bool {
    return (200..<300).contains(status)
}

// MARK: - Client

public struct APIClient: Sendable {
    public static let requestTimeout: TimeInterval = 15
    public static let defaultClaimWaitMs = 25_000

    public let serverUrl: String
    /// The node credential (`mgn_`). Only `register` runs without it.
    public let token: String?
    let transport: HTTPTransport

    public init(serverUrl: String, token: String? = nil, session: URLSession = .shared) {
        self.serverUrl = normalizeServerUrl(serverUrl)
        self.token = token
        transport = HTTPTransport(session: session)
    }

    public func withToken(_ token: String) -> APIClient {
        return APIClient(serverUrl: serverUrl, token: token, session: transport.session)
    }

    // MARK: Endpoints

    /// Exchanges a login token (`mgai_`) for this machine's own credential.
    ///
    /// The login token is used for this one call and then dropped: it expires in
    /// 30 days and cannot be revoked on its own, while the node credential is
    /// long-lived and revocable from the console.
    public func register(
        accessToken: String,
        installationId: String,
        name: String,
        hostname: String
    ) async throws -> RegisteredNode {
        struct Body: Encodable {
            let installationId: String
            let name: String
            let hostname: String
        }
        let response = try await send(
            "POST", "/api/v1/node/register",
            body: Body(installationId: installationId, name: name, hostname: hostname),
            bearer: accessToken
        )
        try requireSuccess(response, operation: "登记本机")
        let node: RegisteredNode = try decode(response, operation: "登记本机")
        try requireNonEmpty(node.nodeId, field: "nodeId", operation: "登记本机")
        try requireNonEmpty(node.name, field: "name", operation: "登记本机")
        try requireNonEmpty(node.token, field: "token", operation: "登记本机")
        return node
    }

    public func heartbeat(agents: [DetectedAgent], repoCandidates: [RepoCandidate] = []) async throws -> HeartbeatReply {
        struct Body: Encodable {
            let agents: [DetectedAgent]
            let repoCandidates: [RepoCandidate]
            let clientVersion: String
        }
        struct Reply: Decodable {
            let repos: [RepoMapping]?
            let products: [NodeProfile.Product]?
            let expectedSkillVersion: String?
        }
        let response = try await send(
            "POST", "/api/v1/node/heartbeat",
            body: Body(
                agents: agents,
                repoCandidates: repoCandidates,
                clientVersion: AppUpdater.currentVersion() ?? "development"
            ),
            bearer: try nodeToken()
        )
        try requireSuccess(response, operation: "heartbeat")
        let reply: Reply = try decode(response, operation: "heartbeat")
        return HeartbeatReply(
            repos: reply.repos ?? [],
            products: reply.products,
            expectedSkillVersion: reply.expectedSkillVersion
        )
    }

    /// Long poll: `waitMs` asks the server to hold the request open until there
    /// is work. It answers 204 when the wait runs out, which is an idle poll, not
    /// an error — the loop simply asks again. `nil` means nothing was queued.
    public func claimNext(
        waitMs: Int = defaultClaimWaitMs,
        availableAgentKinds: [String]? = nil
    ) async throws -> DispatchRequest? {
        struct Body: Encodable {
            let waitMs: Int
            let availableAgentKinds: [String]?
        }
        // The client timeout has to outlast the wait the server was asked for, or
        // every long poll would abort locally just before the server answers:
        // 25s of waiting plus the usual 15s makes 40s.
        let timeout = waitMs > 0 ? TimeInterval(waitMs) / 1000 + APIClient.requestTimeout : APIClient.requestTimeout
        let response = try await send(
            "POST", "/api/v1/node/dispatches/claim-next",
            body: Body(waitMs: waitMs, availableAgentKinds: availableAgentKinds),
            bearer: try nodeToken(),
            timeout: timeout
        )
        if response.status == 204 { return nil }
        try requireSuccess(response, operation: "claim-next")
        let request: DispatchRequest = try decode(response, operation: "claim-next")
        try requireNonEmpty(request.dispatchId, field: "dispatchId", operation: "claim-next")
        try requireNonEmpty(request.repoPath, field: "repoPath", operation: "claim-next")
        try requireNonEmpty(request.agentKind, field: "agentKind", operation: "claim-next")
        try requireNonEmpty(request.mode, field: "mode", operation: "claim-next")
        return request
    }

    public func reportResult(dispatchId: String, report: DispatchReport) async throws {
        let path = "/api/v1/node/dispatches/\(APIClient.encodePathComponent(dispatchId))/result"
        let response = try await send("POST", path, body: report, bearer: try nodeToken())
        // The server answers 204 here; a 200-only check would make every launch
        // look like a failed hand-off and put the loop into a retry spiral.
        try requireSuccess(response, operation: "回报结果")
    }

    public func listAgentSessions() async throws -> [NodeAgentSession] {
        struct Reply: Decodable { let sessions: [NodeAgentSession] }
        let response = try await send(
            "GET", "/api/v1/node/agent-sessions", body: Optional<String>.none, bearer: try nodeToken()
        )
        // During a rolling update the Mac can reach a server from before
        // mirrored sessions. Dispatching must keep working until that server is
        // upgraded; a missing optional endpoint simply means there is nothing to sync.
        if response.status == 404 { return [] }
        try requireSuccess(response, operation: "读取 Agent 会话")
        let reply: Reply = try decode(response, operation: "读取 Agent 会话")
        return reply.sessions
    }

    public func reportAgentSession(sessionId: String, report: AgentSessionReport) async throws {
        let path = "/api/v1/node/agent-sessions/\(APIClient.encodePathComponent(sessionId))/snapshot"
        let response = try await send("POST", path, body: report, bearer: try nodeToken())
        try requireSuccess(response, operation: "同步 Agent 会话")
    }

    public func me() async throws -> NodeProfile {
        let response = try await send("GET", "/api/v1/node/me", body: Optional<String>.none, bearer: try nodeToken())
        try requireSuccess(response, operation: "读取本机信息")
        return try decode(response, operation: "读取本机信息")
    }

    /// Sets this machine's nickname, or clears it with `nil`. The server answers
    /// with the same body as `me()`, so the caller gets the updated profile
    /// without asking again.
    public func updateNickname(_ nickname: String?) async throws -> NodeProfile {
        struct Body: Encodable {
            let nickname: String?

            // Written out so a cleared nickname goes over the wire as an explicit
            // `null`; the synthesized encoder would leave the key out, and the
            // server refuses a body without it as neither a string nor null.
            func encode(to encoder: Encoder) throws {
                var container = encoder.container(keyedBy: CodingKeys.self)
                try container.encode(nickname, forKey: .nickname)
            }

            enum CodingKeys: String, CodingKey {
                case nickname
            }
        }
        let response = try await send("PATCH", "/api/v1/node/me", body: Body(nickname: nickname), bearer: try nodeToken())
        try requireSuccess(response, operation: "保存昵称")
        return try decode(response, operation: "保存昵称")
    }

    public func replaceRepos(_ repos: [RepoAssignment]) async throws -> [RepoMapping] {
        struct Body: Encodable {
            let repos: [RepoAssignment]
        }
        struct Reply: Decodable {
            let repos: [RepoMapping]
        }
        let response = try await send("PUT", "/api/v1/node/repos", body: Body(repos: repos), bearer: try nodeToken())
        try requireSuccess(response, operation: "保存仓库映射")
        let reply: Reply = try decode(response, operation: "保存仓库映射")
        return reply.repos
    }

    public func dispatches() async throws -> [DispatchRecord] {
        struct Reply: Decodable {
            let dispatches: [DispatchRecord]
        }
        let response = try await send(
            "GET", "/api/v1/node/dispatches", body: Optional<String>.none, bearer: try nodeToken()
        )
        try requireSuccess(response, operation: "读取派单记录")
        let reply: Reply = try decode(response, operation: "读取派单记录")
        return reply.dispatches
    }

    // MARK: Plumbing

    private func nodeToken() throws -> String {
        guard let token, !token.isEmpty else {
            throw APIError.credentialRevoked(status: 401, detail: "本机还没有登录")
        }
        return token
    }

    private func send<Body: Encodable>(
        _ method: String,
        _ path: String,
        body: Body?,
        bearer: String,
        timeout: TimeInterval = APIClient.requestTimeout
    ) async throws -> HTTPResponse {
        guard let url = URL(string: "\(serverUrl)\(path)") else {
            throw APIError.invalidResponse("服务地址不是合法的 URL：\(serverUrl)")
        }
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.timeoutInterval = timeout
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.setValue("Bearer \(bearer)", forHTTPHeaderField: "Authorization")
        if let body {
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = try APIClient.encoder.encode(body)
        }
        let response = try await transport.send(request)
        if response.status == 401 || response.status == 403 {
            throw APIError.credentialRevoked(status: response.status, detail: HTTPTransport.problemTitle(response))
        }
        return response
    }

    private func requireSuccess(_ response: HTTPResponse, operation: String) throws {
        guard isSuccess(response.status) else {
            throw APIError.http(operation: operation, status: response.status, detail: HTTPTransport.errorDetail(response))
        }
    }

    private func decode<Value: Decodable>(_ response: HTTPResponse, operation: String) throws -> Value {
        do {
            return try JSONDecoder().decode(Value.self, from: response.body)
        } catch {
            throw APIError.invalidResponse("\(operation) 返回了意外的响应体。")
        }
    }

    private func requireNonEmpty(_ value: String, field: String, operation: String) throws {
        if value.isEmpty {
            throw APIError.invalidResponse("\(operation) 的响应缺少字段 \(field)。")
        }
    }

    static let encoder: JSONEncoder = {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.withoutEscapingSlashes, .sortedKeys]
        return encoder
    }()

    /// `encodeURIComponent`: the id arrives over the wire and goes into a path.
    static func encodePathComponent(_ value: String) -> String {
        var allowed = CharacterSet(charactersIn: "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789")
        allowed.insert(charactersIn: "-_.!~*'()")
        return value.addingPercentEncoding(withAllowedCharacters: allowed) ?? value
    }
}
