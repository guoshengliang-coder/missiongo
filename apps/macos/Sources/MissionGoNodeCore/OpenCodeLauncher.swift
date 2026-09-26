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

/// One option of an OpenCode form field: the value the reply must carry and the
/// label a person sees and picks.
public struct OpenCodeFormOption: Equatable, Sendable {
    public let value: String
    public let label: String

    public init(value: String, label: String) {
        self.value = value
        self.label = label
    }
}

/// One field of an OpenCode form, carrying what the console renders (as a
/// question) and what the answer must be encoded back as (a form value).
public struct OpenCodeFormField: Equatable, Sendable {
    public let key: String
    public let title: String
    public let detail: String?
    public let kind: AgentSessionQuestion.Kind?
    public let options: [OpenCodeFormOption]
    public let multiSelect: Bool
    public let placeholder: String?
    public let required: Bool
    /// The field also accepts a value outside its options.
    public let custom: Bool

    public init(
        key: String, title: String, detail: String? = nil, kind: AgentSessionQuestion.Kind? = nil,
        options: [OpenCodeFormOption] = [], multiSelect: Bool = false,
        placeholder: String? = nil, required: Bool = false, custom: Bool = false
    ) {
        self.key = key
        self.title = title
        self.detail = detail
        self.kind = kind
        self.options = options
        self.multiSelect = multiSelect
        self.placeholder = placeholder
        self.required = required
        self.custom = custom
    }

    /// The question the console renders for this field. The key becomes the
    /// reply prefix so an answer routes back to the field, not to its title.
    public var question: AgentSessionQuestion {
        AgentSessionQuestion(
            title: title,
            detail: detail,
            options: options.isEmpty ? nil : options.map(\.label),
            multiSelect: multiSelect ? true : nil,
            key: key,
            kind: kind,
            placeholder: placeholder,
            custom: custom ? true : nil
        )
    }

    /// One answer value, or nil when the text does not answer this field.
    func answerValue(_ raw: String) -> OpenCodeAnswerValue? {
        let value = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        if kind == .boolean {
            switch value.lowercased() {
            case "是", "yes", "true", "1": return .boolean(true)
            case "否", "no", "false", "0": return .boolean(false)
            default: return nil
            }
        }
        if kind == .number {
            return Double(value).map(OpenCodeAnswerValue.number)
        }
        if !options.isEmpty {
            let parts = value.split(separator: "、")
                .map { $0.trimmingCharacters(in: .whitespaces) }
                .filter { !$0.isEmpty }
            let values = parts.compactMap { part in
                options.first(where: { $0.label == part || $0.value == part })?.value
            }
            if !values.isEmpty { return multiSelect ? .multiple(values) : .text(values[0]) }
            // A question field is usually open as well: an answer that is not
            // one of the listed options is the person's own wording, and
            // OpenCode takes it as the field value rather than a prompt.
            guard custom else { return nil }
            return multiSelect ? (parts.isEmpty ? nil : .multiple(parts)) : (value.isEmpty ? nil : .text(value))
        }
        return value.isEmpty ? nil : .text(value)
    }
}

/// One answer value OpenCode's form reply takes, kept off `Any` so the reply
/// can stay `Sendable`.
public enum OpenCodeAnswerValue: Equatable, Sendable {
    case text(String)
    case number(Double)
    case boolean(Bool)
    case multiple([String])

    var jsonValue: Any {
        switch self {
        case .text(let value): return value
        case .number(let value): return value
        case .boolean(let value): return value
        case .multiple(let value): return value
        }
    }
}

/// A choice OpenCode is blocked on — a form it asked or a permission it wants.
/// Both are answered through their own reply endpoint, never a prompt, so each
/// carries a synthetic message the console can render and the data that turns a
/// reply text back into that endpoint's request.
public struct OpenCodeChoice: Equatable, Sendable {
    public enum Reply: Equatable, Sendable {
        case form(id: String, fields: [OpenCodeFormField])
        case permission(id: String)
    }

    public enum Answer: Equatable, Sendable {
        case form([String: OpenCodeAnswerValue])
        case permission(decision: String)
    }

    /// What a person picks for a permission request, in OpenCode's own terms.
    public static let permissionOptions = ["允许一次", "始终允许", "拒绝"]

    private static let permissionDecisions: [String: String] = [
        "允许一次": "once", "once": "once", "批准": "once", "approve": "once", "yes": "once",
        "始终允许": "always", "always": "always",
        "拒绝": "reject", "reject": "reject", "deny": "reject",
    ]

    public let reply: Reply
    /// The synthetic message the console draws this choice on.
    public let message: AgentSessionMessage

    /// The request an answer text maps to, or nil when the text does not answer
    /// this choice — then it is an ordinary prompt for the agent.
    public func answer(from text: String) -> Answer? {
        switch reply {
        case .permission:
            let normalized = text.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
            guard let decision = Self.permissionDecisions[normalized] else { return nil }
            return .permission(decision: decision)
        case let .form(_, fields):
            guard let answer = Self.formAnswer(text: text, fields: fields) else { return nil }
            return .form(answer)
        }
    }

    static func formAnswer(text: String, fields: [OpenCodeFormField]) -> [String: OpenCodeAnswerValue]? {
        var answer: [String: OpenCodeAnswerValue] = [:]
        for line in text.split(separator: "\n").map(String.init) {
            guard let colon = line.firstIndex(where: { $0 == ":" || $0 == "：" }) else { continue }
            let label = line[..<colon].trimmingCharacters(in: .whitespaces)
            let raw = line[line.index(after: colon)...].trimmingCharacters(in: .whitespaces)
            guard let field = fields.first(where: { $0.key == label || $0.title == label }),
                  let value = field.answerValue(raw) else { continue }
            answer[field.key] = value
        }
        guard !answer.isEmpty else { return nil }
        for field in fields where field.required && answer[field.key] == nil { return nil }
        return answer
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
            // The server refuses a message whose text is blank (AND-210), so
            // whitespace-only text never becomes a mirrored message.
            if type == "user", let text = entry["text"] as? String,
               !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                return AgentSessionMessage(sourceId: id, role: "user", text: text, occurredAt: occurredAt)
            }
            guard type == "assistant", let content = entry["content"] as? [[String: Any]] else { return nil }
            let text = content.compactMap { part -> String? in
                guard part["type"] as? String == "text" else { return nil }
                return part["text"] as? String
            }.joined(separator: "\n\n").trimmingCharacters(in: .whitespacesAndNewlines)
            guard !text.isEmpty else { return nil }
            let role = entry["agent"] as? String == "plan" ? "plan" : "agent"
            return AgentSessionMessage(sourceId: id, role: role, text: text, occurredAt: occurredAt)
        }
    }

    /// One pending form as a console-renderable choice: its title is the
    /// message, each visible field is a question whose options are the labels a
    /// person picks (the reply still carries each option's value).
    static func formChoice(_ entry: [String: Any]) -> OpenCodeChoice? {
        guard let id = entry["id"] as? String, !id.isEmpty,
              let title = (entry["title"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines),
              !title.isEmpty,
              let rawFields = entry["fields"] as? [[String: Any]]
        else { return nil }
        let fields = rawFields.compactMap(formField)
        guard !fields.isEmpty else { return nil }
        // OpenCode's question tool files its ask as a form whose only title is
        // the placeholder "Questions"; the fields are the content. Lead with a
        // sentence instead of repeating that placeholder back at the person.
        let isQuestionTool = ((entry["metadata"] as? [String: Any])?["kind"] as? String) == "question"
        return OpenCodeChoice(
            reply: .form(id: id, fields: fields),
            message: AgentSessionMessage(
                sourceId: "form-\(id)", role: "agent",
                text: isQuestionTool ? "OpenCode 想请你确认以下问题。" : title,
                questions: fields.map(\.question)
            )
        )
    }

    /// One pending permission request as a choice: which action wants approval
    /// and, when the service says, why. Answered with once/always/reject.
    static func permissionChoice(_ entry: [String: Any]) -> OpenCodeChoice? {
        guard let id = entry["id"] as? String, !id.isEmpty,
              let action = (entry["action"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines),
              !action.isEmpty
        else { return nil }
        let message = (entry["message"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines)
        let resources = (entry["resources"] as? [String]) ?? []
        let detail = message.flatMap { $0.isEmpty ? nil : $0 }
            ?? resources.prefix(3).joined(separator: "、")
        let text = detail.isEmpty ? "OpenCode 需要你授权后才能继续。" : detail
        let question = AgentSessionQuestion(
            header: "授权请求",
            title: "OpenCode 请求使用 \(action)",
            options: OpenCodeChoice.permissionOptions
        )
        return OpenCodeChoice(
            reply: .permission(id: id),
            message: AgentSessionMessage(
                sourceId: "permission-\(id)", role: "agent", text: text, questions: [question]
            )
        )
    }

    /// One form field, skipped when hidden or when its type carries no answer
    /// the console can collect.
    static func formField(_ entry: [String: Any]) -> OpenCodeFormField? {
        guard let key = entry["key"] as? String, !key.isEmpty,
              let type = entry["type"] as? String,
              (entry["hidden"] as? Bool) != true
        else { return nil }
        let title = (entry["title"] as? String).flatMap { $0.isEmpty ? nil : $0 } ?? key
        let detail = (entry["description"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines)
        let placeholder = entry["placeholder"] as? String
        let required = (entry["required"] as? Bool) ?? false
        let custom = (entry["custom"] as? Bool) ?? false
        let options = (entry["options"] as? [[String: Any]] ?? []).compactMap { option -> OpenCodeFormOption? in
            guard let value = option["value"] as? String, !value.isEmpty else { return nil }
            let label = (option["label"] as? String).flatMap { $0.isEmpty ? nil : $0 } ?? value
            return OpenCodeFormOption(value: value, label: label)
        }
        let field = { (kind: AgentSessionQuestion.Kind?, multi: Bool) in
            OpenCodeFormField(
                key: key, title: title, detail: detail.flatMap { $0.isEmpty ? nil : $0 }, kind: kind,
                options: multi || !options.isEmpty ? options : [],
                multiSelect: multi, placeholder: placeholder, required: required, custom: custom
            )
        }
        switch type {
        case "multiselect": return options.isEmpty ? nil : field(nil, true)
        case "boolean": return field(.boolean, false)
        case "number", "integer": return field(.number, false)
        default:
            // string and external: a closed set of options is a pick, an open
            // one is typed.
            return options.isEmpty ? field(.text, false) : field(nil, false)
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
    /// The session's status, mirrored messages and — when the session ended
    /// badly at the source — a person-readable reason for that status.
    /// `failed` means the session is over and will not recover by itself.
    func snapshot(id: String) async throws -> (status: String, messages: [AgentSessionMessage], failure: String?)
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
    /// The forms and permission requests a session is blocked on, oldest first.
    /// A service without these routes reports none rather than failing the sync.
    func pendingChoices(id: String) async throws -> [OpenCodeChoice]
    /// Submits a form's answer, which is the reply the form was waiting on.
    func replyForm(id: String, formID: String, answer: [String: OpenCodeAnswerValue]) async throws
    /// Answers a permission request with once, always or reject.
    func replyPermission(id: String, requestID: String, decision: String) async throws
}

public struct OpenCodeHTTPControl: OpenCodeControlling {
    /// How many message pages one snapshot may read (100 messages each). The
    /// old cap of 20 pages meant a session past 2,000 messages had its newest
    /// replies silently left out (AND-222); pages are followed to the cursor's
    /// end, so ordinary sessions stop after a page or two.
    static let snapshotPageLimit = 100
    /// How many of the read messages are kept: the server refuses a snapshot
    /// with more, and the newest ones are the point of a mirror (AND-222).
    static let snapshotMessageCap = 2_000

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

    public func snapshot(id: String) async throws -> (status: String, messages: [AgentSessionMessage], failure: String?) {
        let details: [String: Any]
        do {
            details = try await call("GET", "/api/session/\(encoded(id))")
        } catch let error as OpenCodeHTTPError where error.status == 404 {
            // A session that is gone at the source — deleted by a person in
            // OpenCode, or a rebuilt service — is terminal, not a blip. Say
            // `failed` with a reason instead of letting the transport error
            // read as "temporarily unavailable", which the console keeps
            // promising will recover on its own (AND-222).
            return ("failed", [], "OpenCode 会话已不存在（可能在 OpenCode 中被删除）。")
        }
        let outcome = (try? OpenCodeProtocol.data(details))?["outcome"] as? String
        var messages: [AgentSessionMessage] = []
        var cursor: String?
        for _ in 0..<Self.snapshotPageLimit {
            // OpenCode 2 rejects `order` together with a cursor
            // (InvalidCursorError: Cursor cannot be combined with order); the
            // cursor already carries the order it was issued for. Ask for
            // oldest-first only on the first page, then follow the cursor alone.
            var path = "/api/session/\(encoded(id))/message?limit=100"
            if let cursor { path += "&cursor=\(encoded(cursor))" } else { path += "&order=asc" }
            let page = try await call("GET", path)
            messages += try OpenCodeProtocol.messages(page)
            guard let next = OpenCodeProtocol.nextCursor(page), next != cursor else { cursor = nil; break }
            cursor = next
        }
        if cursor != nil {
            // Past the page cap the newest messages may not have been reached;
            // say so in the log instead of failing silently (AND-222). The
            // newest of what was read still goes out below.
            NSLog("MissionGo：OpenCode 会话 %@ 的消息超过 %d 条，本轮仅同步到第 %d 条附近。", id, Self.snapshotPageLimit * 100, Self.snapshotPageLimit * 100)
        }
        if messages.count > Self.snapshotMessageCap {
            // Keep the newest messages — the console reads a mirror for what
            // just happened, and a head-only read meant the latest replies of a
            // long session never arrived at all (AND-222).
            messages = Array(messages.suffix(Self.snapshotMessageCap))
        }
        let active = try await call("GET", "/api/session/active")
        let running = (active["data"] as? [String: Any])?[id] != nil
        if running { return ("active", messages, nil) }
        // `interrupted` is a person's own stop, not a failure; only a failed
        // outcome is reported as one.
        if outcome == "failed" { return ("failed", messages, "OpenCode 报告该会话以失败结束。") }
        return ("idle", messages, nil)
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

    public func pendingChoices(id: String) async throws -> [OpenCodeChoice] {
        var choices: [OpenCodeChoice] = []
        // A build without these routes answers 404; a pending choice is then
        // simply not collected instead of failing the whole mirror.
        if let forms = try? await call("GET", "/api/session/\(encoded(id))/form"),
           let entries = forms["data"] as? [[String: Any]] {
            choices.append(contentsOf: entries.compactMap(OpenCodeProtocol.formChoice))
        }
        if let permissions = try? await call("GET", "/api/session/\(encoded(id))/permission"),
           let entries = permissions["data"] as? [[String: Any]] {
            choices.append(contentsOf: entries.compactMap(OpenCodeProtocol.permissionChoice))
        }
        return choices
    }

    public func replyForm(id: String, formID: String, answer: [String: OpenCodeAnswerValue]) async throws {
        let body: [String: Any] = ["answer": answer.mapValues(\.jsonValue)]
        _ = try await call("POST", "/api/session/\(encoded(id))/form/\(encoded(formID))/reply", body: body)
    }

    public func replyPermission(id: String, requestID: String, decision: String) async throws {
        _ = try await call(
            "POST", "/api/session/\(encoded(id))/permission/\(encoded(requestID))/reply",
            body: ["decision": decision]
        )
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
        // A pending choice is not in the message log: OpenCode blocks on a form
        // or a permission endpoint until it is answered there. Attach the
        // pending ones so the console can show what is being asked, with the
        // controls to answer it.
        let choices = (try? await control.pendingChoices(id: session.sessionRef)) ?? []
        let messages = snapshot.messages + choices.map(\.message)
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
        // A pending form or permission request holds the turn open without any
        // work happening: the console must read that as waiting for a person,
        // not as "running" (AND-205's OpenCode half, AND-222).
        let waitingForInput = !choices.isEmpty
        guard let command = session.command else {
            report = AgentSessionReport(status: snapshot.status, messages: messages, error: snapshot.failure,
                                        sourceRestored: session.restoreInSource ? true : nil,
                                        waitingForInput: waitingForInput)
            return report.reportingSettings(
                model: model, effort: effort, settingsRevision: settingsRevision, settingsError: settingsError
            )
        }
        if command.status == "queued" {
            report = AgentSessionReport(status: snapshot.status, messages: messages, error: snapshot.failure,
                                        commandId: command.id, commandStatus: "delivering",
                                        waitingForInput: waitingForInput)
            return report.reportingSettings(
                model: model, effort: effort, settingsRevision: settingsRevision, settingsError: settingsError
            )
        }
        guard command.status == "delivering" else {
            report = AgentSessionReport(status: snapshot.status, messages: messages, error: snapshot.failure,
                                        waitingForInput: waitingForInput)
            return report.reportingSettings(
                model: model, effort: effort, settingsRevision: settingsRevision, settingsError: settingsError
            )
        }
        if command.kind == "interrupt" {
            try await control.interrupt(id: session.sessionRef)
        } else if command.attachments?.isEmpty != false, let choice = choices.first, let answer = choice.answer(from: command.text) {
            // The reply answers what OpenCode is blocked on; anything that does
            // not parse as that answer stays an ordinary prompt.
            switch (choice.reply, answer) {
            case let (.permission(requestID), .permission(decision)):
                try await control.replyPermission(id: session.sessionRef, requestID: requestID, decision: decision)
            case let (.form(formID, _), .form(values)):
                try await control.replyForm(id: session.sessionRef, formID: formID, answer: values)
            default:
                try await control.prompt(id: session.sessionRef, text: command.promptText)
            }
        } else {
            try await control.prompt(id: session.sessionRef, text: command.promptText)
        }
        report = AgentSessionReport(status: snapshot.status, messages: messages, error: snapshot.failure,
                                    commandId: command.id, commandStatus: "delivered",
                                    waitingForInput: waitingForInput)
        return report.reportingSettings(
            model: model, effort: effort, settingsRevision: settingsRevision, settingsError: settingsError
        )
    }
}
