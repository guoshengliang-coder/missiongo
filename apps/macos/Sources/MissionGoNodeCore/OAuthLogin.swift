import CryptoKit
import Foundation
import Security

/// Logging this Mac in: the browser sign-in the server already offers to MCP
/// clients, ending in a node credential instead of a pairing code.
///
/// The server only accepts https or loopback http redirect URIs — a
/// `missiongo://` scheme is refused at client registration — so the app listens
/// on `127.0.0.1` for exactly one callback. The redirect URI has to match
/// exactly at authorize and at token exchange, and the port is only known once
/// the listener is up, so a client is registered per attempt with that port.
///
/// The pure pieces (PKCE, URLs, callback parsing, form encoding) are separate
/// from the I/O so they can be pinned by tests without a browser or a server.

// MARK: - Errors

public enum OAuthLoginError: Error, Equatable, LocalizedError, Sendable {
    case listenerFailed(String)
    case authorizationDenied(error: String, description: String?)
    case stateMismatch
    case missingCode
    case timedOut
    case missingNodeScope(granted: String)
    case invalidResponse(String)

    public var errorDescription: String? {
        switch self {
        case let .listenerFailed(reason):
            return "无法在本机 127.0.0.1 上等待登录回调：\(reason)"
        case let .authorizationDenied(error, description):
            let detail = description.map { "：\($0)" } ?? ""
            return "浏览器里的授权没有完成（\(error)）\(detail)。请重新点击登录。"
        case .stateMismatch:
            // Not this attempt's callback: an old tab, or a page that tried to
            // hand the app a code of its own. Either way it is not used.
            return "登录回调与本次登录不匹配（state 不一致），已拒绝。请重新点击登录。"
        case .missingCode:
            return "登录回调里没有授权码。请重新点击登录。"
        case .timedOut:
            return "10 分钟内没有在浏览器里完成登录，本次登录已取消。请重新点击登录。"
        case let .missingNodeScope(granted):
            return "授权里缺少 missiongo:node 权限（实际授予：\(granted)）：登录时需要允许登记这台 Mac 为设备。"
        case let .invalidResponse(message):
            return message
        }
    }
}

// MARK: - PKCE

public struct PKCEPair: Equatable, Sendable {
    public let verifier: String
    public let challenge: String
}

public typealias RandomBytes = @Sendable (_ count: Int) -> [UInt8]

public enum PKCE {
    /// 32 bytes of randomness. Base64url turns them into a 43-character verifier,
    /// the shortest RFC 7636 allows, drawn only from `[A-Za-z0-9_-]`.
    static let verifierByteCount = 32

    public static let secureRandomBytes: RandomBytes = { count in
        var bytes = [UInt8](repeating: 0, count: count)
        let status = SecRandomCopyBytes(kSecRandomDefault, count, &bytes)
        // A failing system RNG is not something to paper over with a weaker one:
        // a guessable verifier or state defeats the point of both.
        precondition(status == errSecSuccess, "SecRandomCopyBytes failed: \(status)")
        return bytes
    }

    public static func generate(randomBytes: RandomBytes = PKCE.secureRandomBytes) -> PKCEPair {
        let verifier = base64URL(Data(randomBytes(verifierByteCount)))
        return PKCEPair(verifier: verifier, challenge: challenge(for: verifier))
    }

    /// S256: base64url(SHA-256(ASCII verifier)), without padding.
    public static func challenge(for verifier: String) -> String {
        return base64URL(Data(SHA256.hash(data: Data(verifier.utf8))))
    }

    public static func base64URL(_ data: Data) -> String {
        return data.base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }

    /// The `state` that ties the callback to this attempt.
    public static func state(randomBytes: RandomBytes = PKCE.secureRandomBytes) -> String {
        return base64URL(Data(randomBytes(32)))
    }
}

// MARK: - Requests

public enum OAuthRequests {
    public static let clientName = "MissionGo macOS"
    /// `missiongo:node` is what `/api/v1/node/register` requires; `read` comes
    /// along so the same token shape works wherever the account is read.
    public static let scope = "missiongo:read missiongo:node"

    public static func redirectURI(port: UInt16) -> String {
        return "http://127.0.0.1:\(port)/callback"
    }

    /// RFC 3986 unreserved characters plus `:` and `/`, which a query may carry
    /// literally. Everything else — spaces, `&`, `=`, `+`, `?` — is escaped, so a
    /// value can never split into a second parameter.
    static let queryValueAllowed: CharacterSet = {
        var set = CharacterSet(charactersIn: "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-._~")
        set.insert(charactersIn: ":/")
        return set
    }()

    static func encodeQueryValue(_ value: String) -> String {
        return value.addingPercentEncoding(withAllowedCharacters: queryValueAllowed) ?? value
    }

    public static func authorizeURL(
        serverUrl: String,
        clientId: String,
        redirectURI: String,
        codeChallenge: String,
        state: String
    ) -> URL? {
        let pairs: [(String, String)] = [
            ("response_type", "code"),
            ("client_id", clientId),
            ("redirect_uri", redirectURI),
            ("code_challenge", codeChallenge),
            ("code_challenge_method", "S256"),
            ("state", state),
            ("scope", scope),
        ]
        let query = pairs.map { "\($0.0)=\(encodeQueryValue($0.1))" }.joined(separator: "&")
        return URL(string: "\(normalizeServerUrl(serverUrl))/oauth/authorize?\(query)")
    }

    static let formAllowed = CharacterSet(
        charactersIn: "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-._*"
    )

    /// `application/x-www-form-urlencoded` as a browser writes it: space as `+`,
    /// everything outside `[A-Za-z0-9-._*]` percent-encoded.
    public static func formEncode(_ pairs: [(String, String)]) -> String {
        func encode(_ value: String) -> String {
            return value
                .split(separator: " ", omittingEmptySubsequences: false)
                .map { String($0).addingPercentEncoding(withAllowedCharacters: formAllowed) ?? String($0) }
                .joined(separator: "+")
        }
        return pairs.map { "\(encode($0.0))=\(encode($0.1))" }.joined(separator: "&")
    }

    /// The token request is form-encoded: the token endpoint rejects JSON.
    public static func tokenRequestBody(code: String, clientId: String, redirectURI: String, codeVerifier: String) -> String {
        return formEncode([
            ("grant_type", "authorization_code"),
            ("code", code),
            ("client_id", clientId),
            ("redirect_uri", redirectURI),
            ("code_verifier", codeVerifier),
        ])
    }

    /// The query of a request target, decoded the way `URLSearchParams` does:
    /// `+` is a space, and the first occurrence of a name wins.
    public static func parseQuery(_ target: String) -> [String: String] {
        guard let questionMark = target.firstIndex(of: "?") else { return [:] }
        var query = target[target.index(after: questionMark)...]
        if let hash = query.firstIndex(of: "#") { query = query[..<hash] }
        var values: [String: String] = [:]
        for part in query.split(separator: "&") where !part.isEmpty {
            let pieces = part.split(separator: "=", maxSplits: 1, omittingEmptySubsequences: false)
            let name = decodeFormComponent(String(pieces[0]))
            let value = pieces.count > 1 ? decodeFormComponent(String(pieces[1])) : ""
            if values[name] == nil { values[name] = value }
        }
        return values
    }

    static func decodeFormComponent(_ value: String) -> String {
        let spaced = value.replacingOccurrences(of: "+", with: " ")
        return spaced.removingPercentEncoding ?? spaced
    }

    /// The path of a request target, without query or fragment.
    public static func path(ofTarget target: String) -> String {
        let end = target.firstIndex(where: { $0 == "?" || $0 == "#" }) ?? target.endIndex
        return String(target[..<end])
    }

    /// Reads the callback and returns the authorization code.
    ///
    /// `error` is checked before `state` so that a denied authorization says
    /// "denied" — but a callback that carries neither a matching state nor an
    /// error is refused before its code is looked at.
    public static func parseCallback(target: String, expectedState: String) throws -> String {
        let query = parseQuery(target)
        if let error = query["error"] {
            if query["state"] != expectedState { throw OAuthLoginError.stateMismatch }
            throw OAuthLoginError.authorizationDenied(error: error, description: query["error_description"])
        }
        guard query["state"] == expectedState else { throw OAuthLoginError.stateMismatch }
        guard let code = query["code"], !code.isEmpty else { throw OAuthLoginError.missingCode }
        return code
    }
}

enum CallbackPages {
    static let success = page("登录完成，可以回到 MissionGo 客户端了。")
    static let stale = page("这次登录已经结束，请回到 MissionGo 客户端。")

    static func failure(_ message: String) -> String {
        return page("登录没有完成：\(message)")
    }

    static func page(_ message: String) -> String {
        let escaped = message
            .replacingOccurrences(of: "&", with: "&amp;")
            .replacingOccurrences(of: "<", with: "&lt;")
            .replacingOccurrences(of: ">", with: "&gt;")
        return """
        <!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>MissionGo</title></head>\
        <body style="font-family:-apple-system,BlinkMacSystemFont,sans-serif;text-align:center;padding:64px 24px">\
        <p style="font-size:18px">\(escaped)</p></body></html>
        """
    }
}

// MARK: - Flow

public typealias URLOpener = @Sendable (URL) async throws -> Void

public struct OAuthLogin: Sendable {
    /// The server keeps an authorize request alive for 10 minutes; waiting longer
    /// could only end in an expired code.
    public static let defaultTimeout: TimeInterval = 600

    public let serverUrl: String
    let session: URLSession
    let openURL: URLOpener
    let randomBytes: RandomBytes
    let timeout: TimeInterval

    public init(
        serverUrl: String,
        session: URLSession = .shared,
        timeout: TimeInterval = OAuthLogin.defaultTimeout,
        randomBytes: @escaping RandomBytes = PKCE.secureRandomBytes,
        openURL: @escaping URLOpener
    ) {
        self.serverUrl = normalizeServerUrl(serverUrl)
        self.session = session
        self.timeout = timeout
        self.randomBytes = randomBytes
        self.openURL = openURL
    }

    /// Runs the whole login and returns the node credential. Cancel the calling
    /// task to abandon it; the listener closes either way.
    public func run(installationId: String, name: String, hostname: String) async throws -> NodeCredential {
        let pkce = PKCE.generate(randomBytes: randomBytes)
        let state = PKCE.state(randomBytes: randomBytes)
        let listener = try LoopbackCallbackListener { target in
            do {
                _ = try OAuthRequests.parseCallback(target: target, expectedState: state)
                return CallbackPages.success
            } catch {
                return CallbackPages.failure(error.localizedDescription)
            }
        }
        defer { listener.cancel() }

        return try await OAuthLogin.withTimeout(timeout, onTimeout: { listener.cancel() }) {
            try await self.perform(
                listener: listener, pkce: pkce, state: state,
                installationId: installationId, name: name, hostname: hostname
            )
        }
    }

    private func perform(
        listener: LoopbackCallbackListener,
        pkce: PKCEPair,
        state: String,
        installationId: String,
        name: String,
        hostname: String
    ) async throws -> NodeCredential {
        let port = try await listener.start()
        let redirectURI = OAuthRequests.redirectURI(port: port)
        let transport = HTTPTransport(session: session)

        let clientId = try await registerClient(redirectURI: redirectURI, transport: transport)
        guard let authorizeURL = OAuthRequests.authorizeURL(
            serverUrl: serverUrl, clientId: clientId, redirectURI: redirectURI,
            codeChallenge: pkce.challenge, state: state
        ) else {
            throw OAuthLoginError.invalidResponse("服务地址不是合法的 URL：\(serverUrl)")
        }

        try await openURL(authorizeURL)

        let target = try await listener.waitForCallback()
        let code = try OAuthRequests.parseCallback(target: target, expectedState: state)

        let accessToken = try await exchangeCode(
            code, clientId: clientId, redirectURI: redirectURI, verifier: pkce.verifier, transport: transport
        )
        // The login token lives only in this stack frame: it is spent on
        // registration and never stored.
        let node = try await APIClient(serverUrl: serverUrl, session: session).register(
            accessToken: accessToken, installationId: installationId, name: name, hostname: hostname
        )
        return NodeCredential(serverUrl: serverUrl, nodeId: node.nodeId, name: node.name, token: node.token)
    }

    private func registerClient(redirectURI: String, transport: HTTPTransport) async throws -> String {
        struct Body: Encodable {
            let redirect_uris: [String]
            let client_name: String
            let token_endpoint_auth_method: String
        }
        struct Reply: Decodable {
            let client_id: String
        }
        var request = try jsonRequest(path: "/oauth/register")
        request.httpBody = try APIClient.encoder.encode(Body(
            redirect_uris: [redirectURI],
            client_name: OAuthRequests.clientName,
            token_endpoint_auth_method: "none"
        ))
        let response = try await transport.send(request)
        guard isSuccess(response.status) else {
            throw APIError.http(operation: "登记登录客户端", status: response.status, detail: HTTPTransport.errorDetail(response))
        }
        guard let reply = try? JSONDecoder().decode(Reply.self, from: response.body), !reply.client_id.isEmpty else {
            throw OAuthLoginError.invalidResponse("登记登录客户端的响应缺少字段 client_id。")
        }
        return reply.client_id
    }

    private func exchangeCode(
        _ code: String,
        clientId: String,
        redirectURI: String,
        verifier: String,
        transport: HTTPTransport
    ) async throws -> String {
        struct Reply: Decodable {
            let access_token: String
            let scope: String?
        }
        var request = try jsonRequest(path: "/oauth/token")
        request.setValue("application/x-www-form-urlencoded", forHTTPHeaderField: "Content-Type")
        request.httpBody = Data(OAuthRequests.tokenRequestBody(
            code: code, clientId: clientId, redirectURI: redirectURI, codeVerifier: verifier
        ).utf8)
        let response = try await transport.send(request)
        guard isSuccess(response.status) else {
            throw APIError.http(operation: "换取登录令牌", status: response.status, detail: HTTPTransport.errorDetail(response))
        }
        guard let reply = try? JSONDecoder().decode(Reply.self, from: response.body), !reply.access_token.isEmpty else {
            throw OAuthLoginError.invalidResponse("换取登录令牌的响应缺少字段 access_token。")
        }
        // Registration would refuse the token anyway, but only with a 403; saying
        // which permission was left out is what lets someone fix it.
        if let scope = reply.scope, !scope.split(separator: " ").contains("missiongo:node") {
            throw OAuthLoginError.missingNodeScope(granted: scope)
        }
        return reply.access_token
    }

    private func jsonRequest(path: String) throws -> URLRequest {
        guard let url = URL(string: "\(serverUrl)\(path)") else {
            throw OAuthLoginError.invalidResponse("服务地址不是合法的 URL：\(serverUrl)")
        }
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.timeoutInterval = APIClient.requestTimeout
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        return request
    }

    static func withTimeout<Value: Sendable>(
        _ seconds: TimeInterval,
        onTimeout: @escaping @Sendable () -> Void,
        _ body: @escaping @Sendable () async throws -> Value
    ) async throws -> Value {
        return try await withThrowingTaskGroup(of: Value.self) { group in
            group.addTask { try await body() }
            group.addTask {
                try await Task.sleep(nanoseconds: UInt64(seconds * 1_000_000_000))
                onTimeout()
                throw OAuthLoginError.timedOut
            }
            defer { group.cancelAll() }
            // The first child to finish decides; a timeout that fires while the body
            // is unwinding from it still reads as a timeout.
            do {
                guard let value = try await group.next() else { throw CancellationError() }
                return value
            } catch is CancellationError where !Task.isCancelled {
                throw OAuthLoginError.timedOut
            }
        }
    }
}

// MARK: - Machine identity

public enum MachineIdentity {
    /// The name shown in the console, e.g. "Mac mini". The user's own name for the
    /// Mac, the same one Finder shows, is what they will recognise in a list.
    public static func defaultName() -> String {
        let name = Host.current().localizedName ?? ""
        return name.isEmpty ? hostname() : name
    }

    public static func hostname() -> String {
        return ProcessInfo.processInfo.hostName
    }
}
