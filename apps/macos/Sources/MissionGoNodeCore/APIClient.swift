import Foundation

/// The node side of the dispatch protocol.
///
/// Every call is outbound: the machine opens no port for the server and accepts
/// no connection from it, so a developer machine never becomes reachable from
/// the network just because it can run dispatches. (The OAuth callback listener
/// is loopback-only and lives for one login.)

// MARK: - Wire types

public struct DetectedAgent: Codable, Equatable, Sendable {
    public let kind: String
    public let version: String

    public init(kind: String, version: String) {
        self.kind = kind
        self.version = version
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

    public init(
        dispatchId: String,
        itemKeys: [String],
        repoPath: String,
        agentKind: String,
        mode: String,
        nodeName: String? = nil,
        round: Int? = nil,
        reworkItemKeys: [String]? = nil
    ) {
        self.dispatchId = dispatchId
        self.itemKeys = itemKeys
        self.repoPath = repoPath
        self.agentKind = agentKind
        self.mode = mode
        self.nodeName = nodeName
        self.round = round
        self.reworkItemKeys = reworkItemKeys
    }
}

public struct DispatchReport: Codable, Equatable, Sendable {
    public enum Status: String, Codable, Sendable {
        case launched
        case failed
    }

    public let status: Status
    public let sessionName: String?
    public let sessionUrl: String?
    public let error: String?

    public init(status: Status, sessionName: String? = nil, sessionUrl: String? = nil, error: String? = nil) {
        self.status = status
        self.sessionName = sessionName
        self.sessionUrl = sessionUrl
        self.error = error
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

    public init(repos: [RepoMapping], products: [NodeProfile.Product]? = nil) {
        self.repos = repos
        self.products = products
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
        }
        struct Reply: Decodable {
            let repos: [RepoMapping]?
            let products: [NodeProfile.Product]?
        }
        let response = try await send(
            "POST", "/api/v1/node/heartbeat",
            body: Body(agents: agents, repoCandidates: repoCandidates),
            bearer: try nodeToken()
        )
        try requireSuccess(response, operation: "heartbeat")
        let reply: Reply = try decode(response, operation: "heartbeat")
        return HeartbeatReply(repos: reply.repos ?? [], products: reply.products)
    }

    /// Long poll: `waitMs` asks the server to hold the request open until there
    /// is work. It answers 204 when the wait runs out, which is an idle poll, not
    /// an error — the loop simply asks again. `nil` means nothing was queued.
    public func claimNext(waitMs: Int = defaultClaimWaitMs) async throws -> DispatchRequest? {
        struct Body: Encodable {
            let waitMs: Int
        }
        // The client timeout has to outlast the wait the server was asked for, or
        // every long poll would abort locally just before the server answers:
        // 25s of waiting plus the usual 15s makes 40s.
        let timeout = waitMs > 0 ? TimeInterval(waitMs) / 1000 + APIClient.requestTimeout : APIClient.requestTimeout
        let response = try await send(
            "POST", "/api/v1/node/dispatches/claim-next",
            body: Body(waitMs: waitMs),
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
