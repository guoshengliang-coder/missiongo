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

/// One model of OpenCode's catalog, addressed the way its API takes it: the
/// model id and its provider separately, with the reasoning tier OpenCode
/// calls a *variant* (what MissionGo calls an effort) as the third part.
public struct OpenCodeModelRef: Equatable, Sendable {
    public let modelId: String
    public let providerId: String
    public let variant: String?

    public init(modelId: String, providerId: String, variant: String? = nil) {
        self.modelId = modelId
        self.providerId = providerId
        self.variant = variant
    }

    /// `provider/model` as the console lists it; nil when the shape is not one.
    public init?(parseCompoundId id: String) {
        guard let slash = id.firstIndex(of: "/"), slash != id.startIndex, slash != id.index(before: id.endIndex) else {
            return nil
        }
        self.init(
            modelId: String(id[id.index(after: slash)...]),
            providerId: String(id[id.startIndex..<slash])
        )
    }

    /// The same model with a reasoning tier applied. A tier the catalog knows
    /// the model does not take is dropped rather than sent — and without a
    /// catalog to ask, it is sent as chosen and the service is trusted to say
    /// no, so an unknown list never silently eats a person's pick.
    public func withVariant(_ variant: String?, efforts: [String]?) -> OpenCodeModelRef {
        guard let variant else { return OpenCodeModelRef(modelId: modelId, providerId: providerId) }
        if let efforts, !efforts.contains(variant) {
            return OpenCodeModelRef(modelId: modelId, providerId: providerId)
        }
        return OpenCodeModelRef(modelId: modelId, providerId: providerId, variant: variant)
    }

    /// The id the console lists this model under. OpenCode serves the same
    /// model name from more than one provider, so the provider is part of the
    /// name a person picks — and of the one that comes back on a dispatch.
    public var compoundId: String { "\(providerId)/\(modelId)" }
}

/// The model list `/api/model` returns, mapped to what a heartbeat reports.
public struct OpenCodeModelCatalog: Sendable {
    public let models: [AgentModelOption]
    public let defaultRef: OpenCodeModelRef?

    /// Marks the configured default among the models, so the console can say
    /// which one a dispatch lands on when nobody picks. The same catalog is
    /// built from the service and from test stubs, so the marking lives here.
    public init(models: [AgentModelOption], defaultRef: OpenCodeModelRef?) {
        let defaultId = defaultRef?.compoundId
        self.models = models.map { option in
            option.id == defaultId && option.isDefault != true
                ? AgentModelOption(
                    id: option.id, label: option.label, provider: option.provider, efforts: option.efforts,
                    isDefault: true
                )
                : option
        }
        self.defaultRef = defaultRef
    }

    /// The efforts one model accepts, when the catalog knows the model.
    public func efforts(forCompoundId id: String) -> [String]? {
        models.first(where: { $0.id == id })?.efforts
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

    /// One `/api/model` entry as the catalog needs it, with what it is listed
    /// under and which reasoning tiers (variants) it takes.
    static func modelEntry(_ value: Any?) -> (ref: OpenCodeModelRef, name: String, efforts: [String], tools: Bool)? {
        guard let entry = value as? [String: Any],
              let modelId = entry["modelID"] as? String ?? entry["id"] as? String,
              let providerId = entry["providerID"] as? String,
              !modelId.isEmpty, !providerId.isEmpty,
              providerId.first != "-"
        else { return nil }
        let name = (entry["name"] as? String).flatMap { $0.isEmpty ? nil : $0 } ?? modelId
        let variants = ((entry["variants"] as? [[String: Any]]) ?? []).compactMap { variant in
            (variant["id"] as? String).flatMap { $0.isEmpty ? nil : $0 }
        }
        let tools = ((entry["capabilities"] as? [String: Any])?["tools"] as? Bool) ?? false
        return (OpenCodeModelRef(modelId: modelId, providerId: providerId), name, Array(Set(variants)).sorted(), tools)
    }

    /// The `/api/model` page, already filtered to models a dispatch can work
    /// with: model ids repeat across providers, so the compound id is what
    /// deduplicates them, and a model without tool calls cannot run a
    /// dispatched session at all.
    static func modelCatalog(_ response: [String: Any]) -> [AgentModelOption] {
        guard let entries = response["data"] as? [Any] else { return [] }
        var seen = Set<String>()
        var models: [AgentModelOption] = []
        for entry in entries {
            guard let parsed = modelEntry(entry), parsed.tools else { continue }
            let compound = parsed.ref.compoundId
            guard seen.insert(compound).inserted else { continue }
            models.append(AgentModelOption(id: compound, label: parsed.name, provider: parsed.ref.providerId, efforts: parsed.efforts))
            if models.count >= 100 { break }
        }
        return models
    }

    /// The `/api/provider` page: which display name each provider id has.
    static func providerNames(_ response: [String: Any]) -> [String: String] {
        guard let entries = response["data"] as? [[String: Any]] else { return [:] }
        var names: [String: String] = [:]
        for entry in entries {
            if let id = entry["id"] as? String, !id.isEmpty,
               let name = entry["name"] as? String, !name.isEmpty {
                names[id] = name
            }
        }
        return names
    }

    /// `/api/model/default`, or the model a session runs with: the same shape.
    static func modelRef(_ value: Any?) -> OpenCodeModelRef? {
        guard let ref = value as? [String: Any],
              let modelId = ref["id"] as? String, !modelId.isEmpty,
              let providerId = ref["providerID"] as? String, !providerId.isEmpty,
              providerId.first != "-"
        else { return nil }
        let variant = (ref["variant"] as? String).flatMap { $0.isEmpty ? nil : $0 }
        return OpenCodeModelRef(modelId: modelId, providerId: providerId, variant: variant)
    }

    /// The model of a `/api/session/{id}` response, under `data.model`.
    static func sessionModel(_ response: [String: Any]) -> OpenCodeModelRef? {
        modelRef((try? data(response))?["model"])
    }

    /// The agent of a `/api/session/{id}` response, under `data.agent`.
    static func sessionAgent(_ response: [String: Any]) -> String? {
        guard let info = try? data(response) else { return nil }
        return (info["agent"] as? String).flatMap { $0.isEmpty ? nil : $0 }
    }
}

public protocol OpenCodeControlling: Sendable {
    func health() async throws -> String
    func missionGoMcpStatus(directory: String?) async throws -> String?
    func createSession(directory: String, agent: String, model: OpenCodeModelRef?) async throws -> String
    func renameSession(id: String, title: String) async throws
    func prompt(id: String, text: String) async throws
    func snapshot(id: String) async throws -> (status: String, messages: [AgentSessionMessage])
    func interrupt(id: String) async throws
    func deleteSession(id: String) async throws
    /// The catalog as a heartbeat reports it: one entry per model a dispatch
    /// may pick, grouped by provider, plus the model OpenCode is configured to
    /// use when nobody picks one.
    func listModels() async throws -> OpenCodeModelCatalog
    /// One session's current agent and model, for the settings a person sees.
    func sessionInfo(id: String) async throws -> (agent: String?, model: OpenCodeModelRef?)
    /// Applies a model (and reasoning tier) to a session that already exists.
    func setModel(id: String, model: OpenCodeModelRef) async throws
    /// Moves a session between the plan and build agents.
    func setAgent(id: String, agent: String) async throws
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

    public func createSession(directory: String, agent: String, model: OpenCodeModelRef?) async throws -> String {
        var body: [String: Any] = [
            "agent": agent, "location": ["directory": directory],
        ]
        if let model {
            var ref: [String: Any] = ["id": model.modelId, "providerID": model.providerId]
            if let variant = model.variant { ref["variant"] = variant }
            body["model"] = ref
        }
        return try OpenCodeProtocol.sessionId(await call("POST", "/api/session", body: body))
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
            // OpenCode 2 rejects `order` together with a cursor
            // (InvalidCursorError: Cursor cannot be combined with order); the
            // cursor already carries the order it was issued for. Ask for
            // oldest-first only on the first page, then follow the cursor alone.
            var path = "/api/session/\(encoded(id))/message?limit=100"
            if let cursor { path += "&cursor=\(encoded(cursor))" } else { path += "&order=asc" }
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

    public func listModels() async throws -> OpenCodeModelCatalog {
        let names = OpenCodeProtocol.providerNames(try await call("GET", "/api/provider"))
        let listed = OpenCodeProtocol.modelCatalog(try await call("GET", "/api/model"))
        let models = listed.map { option in
            AgentModelOption(
                id: option.id, label: option.label, provider: names[option.provider ?? ""] ?? option.provider,
                efforts: option.efforts
            )
        }
        // The default ask must not fail the whole listing: a service that
        // answers the catalog but not this route still lists its models.
        let defaultResponse = try? await call("GET", "/api/model/default")
        let defaultRef = OpenCodeProtocol.modelRef(defaultResponse?["data"])
        return OpenCodeModelCatalog(models: models, defaultRef: defaultRef)
    }

    public func sessionInfo(id: String) async throws -> (agent: String?, model: OpenCodeModelRef?) {
        let response = try await call("GET", "/api/session/\(encoded(id))")
        return (OpenCodeProtocol.sessionAgent(response), OpenCodeProtocol.sessionModel(response))
    }

    public func setModel(id: String, model: OpenCodeModelRef) async throws {
        var ref: [String: Any] = ["id": model.modelId, "providerID": model.providerId]
        if let variant = model.variant { ref["variant"] = variant }
        _ = try await call("POST", "/api/session/\(encoded(id))/model", body: ["model": ref])
    }

    public func setAgent(id: String, agent: String) async throws {
        _ = try await call("POST", "/api/session/\(encoded(id))/agent", body: ["agent": agent])
    }

    private func encoded(_ value: String) -> String {
        value.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed.subtracting(CharacterSet(charactersIn: "/?&#"))) ?? ""
    }
}

public struct OpenCodeLauncher: AgentAdapter {
    public let kind = "opencode"
    private let control: any OpenCodeControlling
    private let availabilityCache = Locked<(at: Date, result: AgentDispatchAvailability)?>(nil)
    private let modelCache = ModelListCache()
    /// The catalog as last fetched, beyond the options alone: launching needs
    /// each model's efforts and the default model, which the options carry
    /// only indirectly.
    private let catalogCache = Locked<OpenCodeModelCatalog?>(nil)

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

    /// What OpenCode's own model manager shows, so the console offers exactly
    /// what a person sees there: the catalog already carries every hide rule
    /// OpenCode applied, and asks nothing when the shared service is down —
    /// the last list stands in, as with Codex.
    public func availableModels() async -> [AgentModelOption]? {
        if let fresh = modelCache.fresh() { return fresh }
        do {
            let catalog = try await control.listModels()
            modelCache.store(catalog.models)
            catalogCache.withLock { $0 = catalog }
            return catalog.models
        } catch {
            return modelCache.last ?? []
        }
    }

    private func lastCatalog() async -> OpenCodeModelCatalog? {
        if let cached = catalogCache.current { return cached }
        guard let catalog = try? await control.listModels() else { return nil }
        modelCache.store(catalog.models)
        catalogCache.withLock { $0 = catalog }
        return catalog
    }

    /// The model reference a dispatch's model and effort choices resolve to.
    /// nil means "as configured on the Mac": neither was picked, or only an
    /// effort was, for a model nobody can name — a tier without its model is
    /// then dropped rather than guessed onto an arbitrary one.
    private func resolveModelRef(model: String?, effort: String?, catalog: OpenCodeModelCatalog?) -> OpenCodeModelRef? {
        if let model, let ref = OpenCodeModelRef(parseCompoundId: model) {
            return ref.withVariant(effort, efforts: catalog?.efforts(forCompoundId: model))
        }
        guard let effort, let defaultRef = catalog?.defaultRef else { return nil }
        let applied = defaultRef.withVariant(effort, efforts: catalog?.efforts(forCompoundId: defaultRef.compoundId))
        // Sending the default model without its tier would say the same as
        // sending nothing; a tier the default does not take changes nothing.
        return applied.variant == nil ? nil : applied
    }

    public func launch(_ job: DispatchJob) async throws -> LaunchResult {
        guard OpenCodeModes.isAllowed(job.mode) else { throw LaunchError("不支持的 OpenCode 模式：\(job.mode)") }
        if let problem = AgentModelSettings.problem(model: job.model, effort: job.effort) { throw LaunchError(problem) }
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
        let catalog = await lastCatalog()
        let modelRef = resolveModelRef(model: job.model, effort: job.effort, catalog: catalog)
        let id = try await control.createSession(
            directory: job.repoPath, agent: job.mode == "plan" ? "plan" : "build", model: modelRef
        )
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
        // The settings a person sees and changes: what the session runs with
        // now, and any change waiting for an idle moment. Failing to read the
        // info must not fail the sync — the report then just says nothing
        // about the model, as it did before settings existed.
        let info = try? await control.sessionInfo(id: session.sessionRef)
        var model = info?.model?.compoundId
        var effort = info?.model?.variant
        var settingsRevision: Int?
        var settingsError: String?
        if let desired = session.pendingSettings, snapshot.status == "idle" {
            settingsRevision = desired.revision
            do {
                if let mode = desired.mode {
                    guard OpenCodeModes.isAllowed(mode) else {
                        throw LaunchError("不支持的 OpenCode 模式：\(JSONValues.quote(mode))")
                    }
                    try await control.setAgent(id: session.sessionRef, agent: mode == "plan" ? "plan" : "build")
                }
                if desired.model != nil || desired.effort != nil {
                    if let problem = AgentModelSettings.problem(model: desired.model, effort: desired.effort) {
                        throw LaunchError(problem)
                    }
                    // An effort alone keeps the session's model; the catalog's
                    // efforts then say whether that model takes the tier.
                    let catalog = await lastCatalog()
                    let base: OpenCodeModelRef?
                    if let modelId = desired.model {
                        base = OpenCodeModelRef(parseCompoundId: modelId)
                    } else if let current = info?.model {
                        base = OpenCodeModelRef(modelId: current.modelId, providerId: current.providerId)
                    } else {
                        base = catalog?.defaultRef
                    }
                    if let base {
                        let ref = base.withVariant(desired.effort, efforts: catalog?.efforts(forCompoundId: base.compoundId))
                        try await control.setModel(id: session.sessionRef, model: ref)
                        model = ref.compoundId
                        effort = ref.variant
                    }
                }
            } catch {
                settingsError = "OpenCode 未应用该设置：\(error.localizedDescription)"
            }
        }
        let report: AgentSessionReport
        guard let command = session.command else {
            report = AgentSessionReport(status: snapshot.status, messages: snapshot.messages,
                                        sourceRestored: session.restoreInSource ? true : nil)
            return report.reportingSettings(
                model: model, effort: effort, settingsRevision: settingsRevision, settingsError: settingsError
            )
        }
        if command.status == "queued" {
            report = AgentSessionReport(status: snapshot.status, messages: snapshot.messages,
                                        commandId: command.id, commandStatus: "delivering")
            return report.reportingSettings(
                model: model, effort: effort, settingsRevision: settingsRevision, settingsError: settingsError
            )
        }
        guard command.status == "delivering" else {
            report = AgentSessionReport(status: snapshot.status, messages: snapshot.messages)
            return report.reportingSettings(
                model: model, effort: effort, settingsRevision: settingsRevision, settingsError: settingsError
            )
        }
        if command.kind == "interrupt" {
            try await control.interrupt(id: session.sessionRef)
        } else {
            try await control.prompt(id: session.sessionRef, text: command.text)
        }
        report = AgentSessionReport(status: snapshot.status, messages: snapshot.messages,
                                    commandId: command.id, commandStatus: "delivered")
        return report.reportingSettings(
            model: model, effort: effort, settingsRevision: settingsRevision, settingsError: settingsError
        )
    }
}
