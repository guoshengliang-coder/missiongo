import Foundation

/// Device codes and the short-lived login token live in the Keychain, never
/// UserDefaults. A restarted app can resume the same browser authorization.
public struct PendingDeviceLogin: Codable, Equatable, Sendable {
    public let serverUrl: String
    public let clientId: String
    public let deviceCode: String
    public let userCode: String
    public let verificationUri: URL
    public let verificationUriComplete: URL
    public let expiresAt: Date
    public var interval: TimeInterval
    public var accessToken: String?

    public var isExpired: Bool { expiresAt <= Date() }
}

public struct DeviceLogin: Sendable {
    public static let grantType = "urn:ietf:params:oauth:grant-type:device_code"
    public let serverUrl: String
    private let transport: HTTPTransport
    private let now: @Sendable () -> Date
    private let sleep: @Sendable (TimeInterval) async throws -> Void

    public init(serverUrl: String, session: URLSession = ServerConnection.session) {
        self.init(serverUrl: serverUrl, session: session, now: { Date() }, sleep: { seconds in
            try await Task.sleep(nanoseconds: UInt64(max(0, seconds) * 1_000_000_000))
        })
    }

    init(serverUrl: String, session: URLSession, now: @escaping @Sendable () -> Date, sleep: @escaping @Sendable (TimeInterval) async throws -> Void) {
        self.serverUrl = normalizeServerUrl(serverUrl)
        transport = HTTPTransport(session: session)
        self.now = now
        self.sleep = sleep
    }

    public func begin() async throws -> PendingDeviceLogin {
        struct Client: Decodable { let client_id: String }
        var registration = try request("/oauth/register")
        registration.setValue("application/json", forHTTPHeaderField: "Content-Type")
        registration.httpBody = try JSONSerialization.data(withJSONObject: [
            "client_name": OAuthRequests.clientName, "grant_types": [Self.grantType], "token_endpoint_auth_method": "none",
        ])
        let response = try await transport.send(registration)
        guard isSuccess(response.status), let client = try? JSONDecoder().decode(Client.self, from: response.body), !client.client_id.isEmpty else {
            throw APIError.http(operation: "登记设备登录", status: response.status, detail: HTTPTransport.errorDetail(response))
        }
        struct Device: Decodable {
            let device_code: String
            let user_code: String
            let verification_uri: URL
            let verification_uri_complete: URL
            let expires_in: Double
            let interval: Double?
        }
        var start = try request("/oauth/device_authorization")
        start.httpBody = Data(OAuthRequests.formEncode([("client_id", client.client_id), ("scope", OAuthRequests.scope)]).utf8)
        let started = try await transport.send(start)
        guard isSuccess(started.status) else {
            throw APIError.http(operation: "开始设备登录", status: started.status, detail: HTTPTransport.errorDetail(started))
        }
        guard let device = try? JSONDecoder().decode(Device.self, from: started.body), !device.device_code.isEmpty,
              !device.user_code.isEmpty, device.expires_in > 0, device.expires_in <= 3600,
              validVerificationURL(device.verification_uri), validVerificationURL(device.verification_uri_complete) else {
            throw OAuthLoginError.invalidResponse("设备登录响应无效；请检查服务端版本。")
        }
        return PendingDeviceLogin(serverUrl: serverUrl, clientId: client.client_id, deviceCode: device.device_code,
            userCode: device.user_code, verificationUri: device.verification_uri, verificationUriComplete: device.verification_uri_complete,
            expiresAt: now().addingTimeInterval(device.expires_in), interval: max(5, device.interval ?? 5), accessToken: nil)
    }

    public func complete(_ pending: PendingDeviceLogin, installationId: String, name: String, hostname: String,
                         checkpoint: @escaping @Sendable (PendingDeviceLogin) async throws -> Void,
                         status: @escaping @Sendable (String) async -> Void = { _ in }) async throws -> NodeCredential {
        guard pending.serverUrl == serverUrl else { throw OAuthLoginError.invalidResponse("待续接登录属于另一个服务器，请重新登录。") }
        guard pending.expiresAt > now() else { throw OAuthLoginError.timedOut }
        var current = pending
        while current.accessToken == nil {
            try Task.checkCancellation()
            guard current.expiresAt > now() else { throw OAuthLoginError.timedOut }
            try await sleep(min(current.interval, current.expiresAt.timeIntervalSince(now())))
            try Task.checkCancellation()
            guard current.expiresAt > now() else { throw OAuthLoginError.timedOut }
            var poll = try request("/oauth/token")
            poll.httpBody = Data(OAuthRequests.formEncode([
                ("grant_type", Self.grantType), ("device_code", current.deviceCode), ("client_id", current.clientId),
            ]).utf8)
            let response: HTTPResponse
            do { response = try await transport.send(poll) }
            catch let error as APIError {
                if case .network = error {
                    current.interval = min(60, current.interval * 2)
                    await status("网络连接暂不可用，将自动重试…")
                    try await checkpoint(current)
                    continue
                }
                throw error
            }
            if isSuccess(response.status) {
                struct Token: Decodable { let access_token: String; let scope: String }
                guard let token = try? JSONDecoder().decode(Token.self, from: response.body), !token.access_token.isEmpty else {
                    throw OAuthLoginError.invalidResponse("设备登录响应缺少令牌。")
                }
                guard token.scope.split(separator: " ").contains("missiongo:node") else {
                    throw OAuthLoginError.missingNodeScope(granted: token.scope)
                }
                current.accessToken = token.access_token
                try await checkpoint(current)
            } else {
                struct Failure: Decodable { let error: String }
                let code = (try? JSONDecoder().decode(Failure.self, from: response.body))?.error
                switch code {
                case "authorization_pending":
                    await status("等待浏览器授权…")
                    continue
                case "slow_down":
                    current.interval += 5
                    await status("服务器要求稍后重试，仍在等待授权…")
                    try await checkpoint(current)
                case "expired_token": throw OAuthLoginError.timedOut
                case "invalid_grant", "invalid_client": throw OAuthLoginError.invalidResponse("这次设备登录已不可用，请重新发起登录。")
                case "access_denied": throw OAuthLoginError.authorizationDenied(error: "access_denied", description: "设备登录授权已被拒绝，请重新发起。")
                default: throw APIError.http(operation: "等待设备授权", status: response.status, detail: HTTPTransport.errorDetail(response))
                }
            }
        }
        try Task.checkCancellation()
        await status("授权已通过，正在登记设备…")
        let node = try await APIClient(serverUrl: serverUrl, session: transport.session)
            .register(accessToken: current.accessToken!, installationId: installationId, name: name, hostname: hostname)
        return NodeCredential(serverUrl: serverUrl, nodeId: node.nodeId, name: node.name, token: node.token)
    }

    private func request(_ path: String) throws -> URLRequest {
        guard let url = URL(string: serverUrl + path) else { throw OAuthLoginError.invalidResponse("服务地址不是合法的 URL。") }
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.timeoutInterval = APIClient.requestTimeout
        request.setValue("application/x-www-form-urlencoded", forHTTPHeaderField: "Content-Type")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        return request
    }

    private func validVerificationURL(_ url: URL) -> Bool {
        guard let server = URL(string: serverUrl) else { return false }
        return url.scheme == server.scheme && url.host == server.host && url.port == server.port
            && url.user == nil && url.password == nil && url.fragment == nil
    }
}
