import Foundation

public enum ServerConnectionMode: String, CaseIterable, Sendable {
    case system
    case direct

    public var label: String {
        switch self {
        case .system: return "跟随系统代理"
        case .direct: return "直连服务器"
        }
    }
}

/// Applies only to this app's server traffic. Agent processes and the Mac's
/// proxy settings keep their own configuration; HTTPS trust is always checked.
public enum ServerConnection {
    static let defaultsKey = "serverConnectionMode"
    private static let systemSession = URLSession(configuration: configuration(for: .system))
    private static let directSession = URLSession(configuration: configuration(for: .direct))

    public static func mode(defaults: UserDefaults = .standard) -> ServerConnectionMode {
        ServerConnectionMode(rawValue: defaults.string(forKey: defaultsKey) ?? "") ?? .system
    }

    public static func setMode(_ mode: ServerConnectionMode, defaults: UserDefaults = .standard) {
        defaults.set(mode.rawValue, forKey: defaultsKey)
    }

    public static var session: URLSession {
        mode() == .direct ? directSession : systemSession
    }

    static func configuration(for mode: ServerConnectionMode) -> URLSessionConfiguration {
        let config = URLSessionConfiguration.default
        if mode == .direct { config.connectionProxyDictionary = [:] }
        return config
    }

    static func failureDescription(_ error: Error, url: URL?) -> String {
        let host = HTTPTransport.hostLabel(url)
        if let error = error as? URLError {
            return NetworkFailure(host: host, error: error).description
        }
        return NetworkFailure(host: host, other: error).description
    }

    public struct Diagnosis: Equatable, Sendable {
        public enum Outcome: Equatable, Sendable {
            case reachable
            case failed(String)

            public var description: String {
                switch self {
                case .reachable: return "连接正常"
                case let .failed(reason): return reason
                }
            }
        }

        public let system: Outcome
        public let direct: Outcome

        public var recommendsDirect: Bool { system != .reachable && direct == .reachable }

        public var summary: String {
            if recommendsDirect {
                return "系统连接失败，直连正常。系统代理或其网络路径可能有问题，可切换直连后重试。"
            }
            if system == .reachable && direct == .reachable {
                return "两种连接方式均正常，可保持当前设置。"
            }
            if system == .reachable {
                return "系统连接正常，直连失败。建议跟随系统代理。"
            }
            return "两种连接方式均失败。请检查网络、VPN、系统时间和服务器证书。"
        }
    }

    /// Two anonymous, read-only health requests. Neither changes routing nor
    /// retries a mutation that may already have reached the server.
    public static func diagnose(serverUrl: String) async -> Diagnosis {
        func probeSession(_ mode: ServerConnectionMode) -> URLSession {
            let config = URLSessionConfiguration.ephemeral
            config.timeoutIntervalForResource = 8
            config.httpShouldSetCookies = false
            config.httpCookieStorage = nil
            config.urlCredentialStorage = nil
            if mode == .direct { config.connectionProxyDictionary = [:] }
            return URLSession(configuration: config)
        }
        let system = probeSession(.system)
        let direct = probeSession(.direct)
        defer { system.invalidateAndCancel(); direct.invalidateAndCancel() }
        return await diagnose(serverUrl: serverUrl, systemSession: system, directSession: direct)
    }

    static func diagnose(serverUrl: String, systemSession: URLSession, directSession: URLSession) async -> Diagnosis {
        guard case let .success(origin) = ServerAddress.validate(serverUrl),
              let url = URL(string: origin + "/health") else {
            return Diagnosis(system: .failed("服务器地址无效"), direct: .failed("服务器地址无效"))
        }
        async let system = probe(url, session: systemSession)
        async let direct = probe(url, session: directSession)
        return await Diagnosis(system: system, direct: direct)
    }

    private static func probe(_ url: URL, session: URLSession) async -> Diagnosis.Outcome {
        var request = URLRequest(url: url, timeoutInterval: 5)
        request.cachePolicy = .reloadIgnoringLocalCacheData
        do {
            let (data, response) = try await session.data(for: request)
            guard let http = response as? HTTPURLResponse else { return .failed("未收到 HTTP 响应") }
            guard http.statusCode == 200 else { return .failed("健康检查返回 HTTP \(http.statusCode)") }
            guard let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  object["status"] as? String == "ok" else {
                return .failed("响应不是服务器健康信息，可能被网络登录页或代理拦截")
            }
            return .reachable
        } catch {
            return .failed(failureDescription(error, url: url))
        }
    }
}
