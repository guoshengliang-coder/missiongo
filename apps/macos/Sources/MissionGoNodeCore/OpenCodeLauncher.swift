import Foundation

private struct OpenCodeHTTPError: LocalizedError {
    let status: Int
    let detail: String?

    var errorDescription: String? {
        "OpenCode 请求失败（HTTP \(status)）\(detail.map { "：\($0.prefix(200))" } ?? "")"
    }
}

/// OpenCode V2 keeps one background service for the desktop, TUI and remote
/// clients. MissionGo joins that service; it never starts a second server or
/// sends its Basic Auth password to the MissionGo backend.
public struct OpenCodeRegistration: Decodable, Sendable {
    public let url: String
    public let password: String
    public let version: String

    public static func load(home: String = Paths.homeDirectory()) throws -> OpenCodeRegistration {
        let path = "\(home)/.local/state/opencode/service.json"
        guard let data = FileManager.default.contents(atPath: path),
              let registration = try? JSONDecoder().decode(OpenCodeRegistration.self, from: data),
              let url = URLComponents(string: registration.url),
              ["http", "https"].contains(url.scheme?.lowercased() ?? ""),
              url.host != nil, url.user == nil, url.password == nil,
              !registration.password.isEmpty,
              let major = Int(registration.version.split(separator: ".").first ?? ""), major >= 2
        else {
            throw LaunchError("找不到可用的 OpenCode 2 服务；请先在 OpenCode 中启动共享服务。",
                              failureCode: "daemon_down", failureStage: "preflight")
        }
        return registration
    }
}

public enum OpenCodeProtocol {
    static func object(_ value: Any?, field: String) throws -> [String: Any] {
        guard let object = value as? [String: Any] else { throw LaunchError("OpenCode 的 \(field) 响应无法识别。") }
        return object
    }

    static func data(_ response: [String: Any]) throws -> [String: Any] {
        try object(response["data"], field: "data")
    }

    public static func sessionId(_ response: [String: Any]) throws -> String {
        let session = try data(response)
        guard let id = session["id"] as? String, !id.isEmpty else {
            throw LaunchError("OpenCode 创建会话后没有返回 session ID。")
        }
        return id
    }

    public static func missionGoMcpStatus(_ response: [String: Any]) -> String? {
        guard let servers = response["data"] as? [[String: Any]],
              let server = servers.first(where: { $0["name"] as? String == "missiongo" }),
              let status = server["status"] as? [String: Any]
        else { return nil }
        return status["status"] as? String
    }

    /// Integration setup checks the service's default location. A temporary
    /// failure there must not disable dispatches whose repository location is
    /// connected; launch checks the mapped repository before sending a prompt.
    public static func integrationIssue(for status: String?) -> String? {
        switch status {
        case "connected", "failed", "pending": return nil
        case "needs_auth": return "OpenCode 的 missiongo MCP 需要授权；请在 OpenCode 的 /mcps 中登录。"
        case nil: return "OpenCode 未返回 missiongo MCP；请检查共享服务的 MCP 配置。"
        default: return "OpenCode 的 missiongo MCP 状态无法识别；请在 OpenCode 的 /mcps 中检查。"
        }
    }

    public static func messages(_ response: [String: Any]) throws -> [AgentSessionMessage] {
        guard let entries = response["data"] as? [[String: Any]] else {
            throw LaunchError("OpenCode 的消息列表无法识别。")
        }
        return entries.compactMap { entry in
            guard let id = entry["id"] as? String, let type = entry["type"] as? String else { return nil }
            let created = (entry["time"] as? [String: Any])?["created"] as? NSNumber
            let occurredAt = created.map { ISO8601DateFormatter().string(from: Date(timeIntervalSince1970: $0.doubleValue / 1000)) }
            if type == "user", let text = entry["text"] as? String, !text.isEmpty {
                return AgentSessionMessage(sourceId: id, role: "user", text: text, occurredAt: occurredAt)
            }
            guard type == "assistant", let content = entry["content"] as? [[String: Any]] else { return nil }
            let text = content.compactMap { part -> String? in
                guard part["type"] as? String == "text" else { return nil }
                return part["text"] as? String
            }.joined(separator: "\n\n")
            guard !text.isEmpty else { return nil }
            let role = entry["agent"] as? String == "plan" ? "plan" : "agent"
            return AgentSessionMessage(sourceId: id, role: role, text: text, occurredAt: occurredAt)
        }
    }

    static func nextCursor(_ response: [String: Any]) -> String? {
        (response["cursor"] as? [String: Any])?["next"] as? String
    }
}

public protocol OpenCodeControlling: Sendable {
    func health() async throws -> String
    func missionGoMcpStatus(directory: String?) async throws -> String?
    func createSession(directory: String, agent: String) async throws -> String
    func renameSession(id: String, title: String) async throws
    func prompt(id: String, text: String) async throws
    func snapshot(id: String) async throws -> (status: String, messages: [AgentSessionMessage])
    func interrupt(id: String) async throws
    func deleteSession(id: String) async throws
}

public struct OpenCodeHTTPControl: OpenCodeControlling {
    private let home: String
    private let session: URLSession

    public init(home: String = Paths.homeDirectory(), session: URLSession = .shared) {
        self.home = home
        self.session = session
    }

    private func call(_ method: String, _ path: String, body: [String: Any]? = nil) async throws -> [String: Any] {
        let registration = try OpenCodeRegistration.load(home: home)
        guard let origin = URL(string: registration.url),
              let url = URL(string: path, relativeTo: origin)?.absoluteURL else {
            throw LaunchError("OpenCode 服务地址无效。")
        }
        var request = URLRequest(url: url, timeoutInterval: 12)
        request.httpMethod = method
        request.cachePolicy = .reloadIgnoringLocalCacheData
        request.setValue("Basic \(Data("opencode:\(registration.password)".utf8).base64EncodedString())", forHTTPHeaderField: "Authorization")
        if let body {
            request.httpBody = try JSONSerialization.data(withJSONObject: body)
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }
        let data: Data
        let response: URLResponse
        do { (data, response) = try await session.data(for: request) }
        catch { throw LaunchError("无法连接 OpenCode 共享服务；请确认服务仍在运行。", failureCode: "daemon_down", failureStage: "daemon") }
        guard let http = response as? HTTPURLResponse else { throw LaunchError("OpenCode 未返回 HTTP 响应。") }
        guard (200..<300).contains(http.statusCode) else {
            let detail = (try? JSONSerialization.jsonObject(with: data) as? [String: Any])?["message"] as? String
            throw OpenCodeHTTPError(status: http.statusCode, detail: detail)
        }
        if data.isEmpty { return [:] }
        guard let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw LaunchError("OpenCode 返回的 JSON 无法识别。")
        }
        return object
    }

    public func health() async throws -> String {
        let info = try await call("GET", "/api/info")
        guard let version = info["version"] as? String,
              let major = Int(version.split(separator: ".").first ?? ""), major >= 2 else {
            throw LaunchError("连接到的不是可用的 OpenCode 2 服务。")
        }
        return version
    }

    public func missionGoMcpStatus(directory: String? = nil) async throws -> String? {
        var path = "/api/mcp"
        if let directory {
            var query = URLComponents()
            query.queryItems = [URLQueryItem(name: "location[directory]", value: directory)]
            path += "?\(query.percentEncodedQuery ?? "")"
        }
        // A cold location may have no catalog yet, and an authenticated MCP
        // can briefly report failed while its first request times out.
        var lastStatus: String?
        for attempt in 0..<3 {
            let status = OpenCodeProtocol.missionGoMcpStatus(try await call("GET", path))
            lastStatus = status
            if status != nil && status != "pending" && status != "failed" { return status }
            if attempt < 2 { try? await Task.sleep(nanoseconds: 250_000_000) }
        }
        return lastStatus
    }

    public func createSession(directory: String, agent: String) async throws -> String {
        try OpenCodeProtocol.sessionId(await call("POST", "/api/session", body: [
            "agent": agent, "location": ["directory": directory],
        ]))
    }

    public func renameSession(id: String, title: String) async throws {
        do {
            _ = try await call("PATCH", "/api/session/\(encoded(id))", body: ["title": title])
        } catch let error as OpenCodeHTTPError where error.status == 404 {
            // Newer V2 builds expose a dedicated rename route.
            _ = try await call("POST", "/api/session/\(encoded(id))/rename", body: ["title": title])
        }
    }

    public func prompt(id: String, text: String) async throws {
        let path = "/api/session/\(encoded(id))/prompt"
        do {
            _ = try await call("POST", path, body: ["text": text, "delivery": "queue"])
        } catch let error as OpenCodeHTTPError where error.status == 400 &&
                    error.detail?.contains("[\"prompt\"]") == true {
            // The newer API nests the input under `prompt`.
            _ = try await call("POST", path, body: ["prompt": ["text": text], "delivery": "queue"])
        }
    }

    public func snapshot(id: String) async throws -> (status: String, messages: [AgentSessionMessage]) {
        _ = try await call("GET", "/api/session/\(encoded(id))")
        var messages: [AgentSessionMessage] = []
        var cursor: String?
        for _ in 0..<20 {
            var path = "/api/session/\(encoded(id))/message?order=asc&limit=100"
            if let cursor { path += "&cursor=\(encoded(cursor))" }
            let page = try await call("GET", path)
            messages += try OpenCodeProtocol.messages(page)
            guard let next = OpenCodeProtocol.nextCursor(page), next != cursor else { break }
            cursor = next
        }
        let active = try await call("GET", "/api/session/active")
        let running = (active["data"] as? [String: Any])?[id] != nil
        return (running ? "active" : "idle", messages)
    }

    public func interrupt(id: String) async throws {
        _ = try await call("POST", "/api/session/\(encoded(id))/interrupt")
    }

    public func deleteSession(id: String) async throws {
        _ = try await call("DELETE", "/api/session/\(encoded(id))")
    }

    private func encoded(_ value: String) -> String {
        value.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed.subtracting(CharacterSet(charactersIn: "/?&#"))) ?? ""
    }
}

public struct OpenCodeLauncher: AgentAdapter {
    public let kind = "opencode"
    private let control: any OpenCodeControlling
    private let availabilityCache = Locked<(at: Date, result: AgentDispatchAvailability)?>(nil)

    public init(control: any OpenCodeControlling = OpenCodeHTTPControl()) {
        self.control = control
    }

    public func detect() async -> String? { try? await control.health() }

    public func dispatchAvailability() async -> AgentDispatchAvailability {
        if let cached = availabilityCache.current, Date().timeIntervalSince(cached.at) < 5 {
            return cached.result
        }
        let result: AgentDispatchAvailability
        do {
            _ = try await control.health()
            result = .ready
        } catch {
            result = .unavailable(reason: "OpenCode 共享服务未就绪：\(error.localizedDescription)")
        }
        availabilityCache.withLock { $0 = (Date(), result) }
        return result
    }

    public func launch(_ job: DispatchJob) async throws -> LaunchResult {
        guard OpenCodeModes.isAllowed(job.mode) else { throw LaunchError("不支持的 OpenCode 模式：\(job.mode)") }
        if job.model != nil || job.effort != nil {
            throw LaunchError("当前 OpenCode 接入尚不支持派单时指定模型或推理强度。")
        }
        if let problem = Preflight.repositoryProblem(job.repoPath) { throw LaunchError(problem) }
        _ = try await control.health()
        switch try await control.missionGoMcpStatus(directory: job.repoPath) {
        case "connected": break
        case "needs_auth":
            throw LaunchError("OpenCode 的 missiongo MCP 需要授权；请在 OpenCode 的 /mcps 中登录。",
                              failureCode: "mcp_auth", failureStage: "mcp")
        default:
            throw LaunchError("暂时无法确认 OpenCode 的 missiongo MCP 连接；派单将在 30 秒后自动重试。",
                              failureCode: "mcp_timeout", failureStage: "mcp", retryAfterSeconds: 30)
        }
        let prompt = try LaunchPrompt.build(
            itemKeys: job.itemKeys, dispatchId: job.dispatchId, mode: job.mode,
            reworkItemKeys: job.reworkItemKeys, client: .openCode
        )
        let name = SessionLauncher.sessionName(nodeName: job.nodeName, itemKeys: job.itemKeys, round: job.round)
        let id = try await control.createSession(directory: job.repoPath, agent: job.mode == "plan" ? "plan" : "build")
        do {
            try await control.renameSession(id: id, title: name)
        } catch {
            // No prompt was sent yet; only remove the empty session we made.
            try? await control.deleteSession(id: id)
            throw error
        }
        // A timeout after this request is ambiguous: OpenCode may already have
        // admitted the prompt, so leave the session for the user to inspect.
        try await control.prompt(id: id, text: prompt)
        return LaunchResult(sessionName: name, sessionUrl: nil, sessionRef: id, logPath: nil)
    }

    public func synchronize(_ session: NodeAgentSession) async throws -> AgentSessionReport {
        let snapshot = try await control.snapshot(id: session.sessionRef)
        guard let command = session.command else {
            return AgentSessionReport(status: snapshot.status, messages: snapshot.messages,
                                      sourceRestored: session.restoreInSource ? true : nil)
        }
        if command.status == "queued" {
            return AgentSessionReport(status: snapshot.status, messages: snapshot.messages,
                                      commandId: command.id, commandStatus: "delivering")
        }
        guard command.status == "delivering" else {
            return AgentSessionReport(status: snapshot.status, messages: snapshot.messages)
        }
        if command.kind == "interrupt" {
            try await control.interrupt(id: session.sessionRef)
        } else {
            try await control.prompt(id: session.sessionRef, text: command.text)
        }
        return AgentSessionReport(status: snapshot.status, messages: snapshot.messages,
                                  commandId: command.id, commandStatus: "delivered")
    }
}
