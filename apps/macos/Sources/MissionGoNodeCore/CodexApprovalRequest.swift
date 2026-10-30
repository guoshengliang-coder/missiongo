import Foundation

/// A request is bound to this transport connection, never to a reusable RPC id
/// alone. Reconnecting must not replay a person's decision on a new prompt.
struct CodexApprovalRequest {
    let rpcId: Any
    let method: String
    let params: [String: Any]
    let snapshot: CodexApprovalSnapshot
    private let results: [String: [String: Any]]

    init?(_ message: [String: Any], threadId: String) {
        guard let method = message["method"] as? String,
              let rpcId = message["id"], rpcId is String || rpcId is NSNumber,
              let params = message["params"] as? [String: Any],
              params["threadId"] as? String == threadId else { return nil }
        // MCP may ask outside a turn. Keep a local scope without inventing an upstream turn.
        guard let turnId = params["turnId"] as? String
                ?? (method == "mcpServer/elicitation/request" ? "thread-scoped" : nil) else { return nil }
        self.rpcId = rpcId
        self.method = method
        self.params = params
        let action: String
        var reason = params["reason"] as? String
        var supported = true
        var options: [CodexApprovalOption] = []
        var results: [String: [String: Any]] = [:]
        var unreviewableOption = false
        func add(_ id: String, _ kind: String, _ result: [String: Any], detail: String? = nil, label: String? = nil) {
            // Never hide part of a persistent rule behind display truncation.
            if (detail?.count ?? 0) > 4_000 { unreviewableOption = true; return }
            guard results[id] == nil else { return }
            options.append(CodexApprovalOption(id: id, kind: kind, detail: detail, label: label))
            results[id] = result
        }
        func commandDecision(_ value: Any, index: Int) {
            if params["kind"] as? String == "humanCommand" {
                guard let choice = value as? String, ["accept", "decline", "cancel"].contains(choice) else { return }
            }
            if let choice = value as? String {
                let kinds = ["accept": "once", "acceptForSession": "session", "decline": "decline", "cancel": "cancel"]
                if let kind = kinds[choice] { add(choice, kind, ["decision": choice]) }
            } else if let choice = value as? [String: Any] {
                if let rule = choice["acceptWithExecpolicyAmendment"] as? [String: Any],
                   let prefix = rule["execpolicy_amendment"] as? [String], !prefix.isEmpty {
                    add("execpolicy-\(index)", "rule", ["decision": choice],
                        detail: prefix.map(JSONValues.quote).joined(separator: " "))
                } else if let rule = choice["applyNetworkPolicyAmendment"] as? [String: Any],
                          let amendment = rule["network_policy_amendment"] as? [String: Any],
                          let host = amendment["host"] as? String,
                          let action = amendment["action"] as? String, ["allow", "deny"].contains(action) {
                    add("network-\(index)", action == "allow" ? "networkAllow" : "networkDeny",
                        ["decision": choice], detail: host)
                }
            }
        }
        switch method {
        case "item/commandExecution/requestApproval":
            action = params["command"] as? String ?? reason ?? "执行命令"
            // Honor an explicit list, including an empty list. Older servers
            // omit it; their documented command decisions remain supported.
            var decisions: [Any] = ["accept", "acceptForSession", "decline", "cancel"]
            if let offered = params["availableDecisions"] as? [Any] {
                decisions = offered
            } else if params["availableDecisions"] != nil && !(params["availableDecisions"] is NSNull) {
                decisions = []
            } else if let prefix = params["proposedExecpolicyAmendment"] as? [String], !prefix.isEmpty {
                decisions.insert(["acceptWithExecpolicyAmendment": ["execpolicy_amendment": prefix]], at: 2)
            }
            for (index, decision) in decisions.enumerated() { commandDecision(decision, index: index) }
        case "item/fileChange/requestApproval":
            action = params["grantRoot"] as? String ?? reason ?? "修改文件"
            for (index, decision) in ["accept", "acceptForSession", "decline", "cancel"].enumerated() {
                commandDecision(decision, index: index)
            }
        case "item/permissions/requestApproval":
            let data = try? JSONSerialization.data(withJSONObject: params["permissions"] ?? [:], options: [.sortedKeys])
            action = data.flatMap { String(data: $0, encoding: .utf8) } ?? "申请额外权限"
            let permissions = params["permissions"] as? [String: Any] ?? [:]
            add("accept", "turn", ["permissions": permissions, "scope": "turn"])
            add("acceptForSession", "session", ["permissions": permissions, "scope": "session"])
            add("decline", "decline", ["permissions": [String: Any](), "scope": "turn"])
        case "mcpServer/elicitation/request":
            let server = params["serverName"] as? String ?? "MCP"
            action = "\(server)：\(params["message"] as? String ?? "请求确认")"
            // Empty confirmation forms support only the persistence lifetimes
            // advertised by this request. Never copy arbitrary request metadata
            // into the answer or synthesize answers for nonempty/OAuth forms.
            let mode = params["mode"] as? String
            let schema = params["requestedSchema"] as? [String: Any]
            supported = ["form", "openai/form"].contains(mode ?? "")
                && schema?["type"] as? String == "object"
                && (schema?["properties"] as? [String: Any] ?? [:]).isEmpty
                && (schema?["required"] as? [String] ?? []).isEmpty
                && (schema?["properties"] == nil || schema?["properties"] is [String: Any])
                && (schema?["required"] == nil || schema?["required"] is [String])
                && Set(schema?.keys.map { $0 } ?? []).isSubset(of: ["type", "properties", "required", "additionalProperties", "title", "description"])
            if supported {
                add("accept", "once", ["action": "accept", "content": [String: Any]()])
                let metadata = params["_meta"] as? [String: Any] ?? [:]
                let lifetimes = (metadata["persist"] as? [String])
                    ?? (metadata["persist"] as? String).map { [$0] } ?? []
                if lifetimes.contains("session") {
                    add("acceptForSession", "session", ["action": "accept", "content": [String: Any](),
                        "_meta": ["persist": "session"]])
                }
                if lifetimes.contains("always") {
                    add("acceptAlways", "always", ["action": "accept", "content": [String: Any](),
                        "_meta": ["persist": "always"]])
                }
                add("decline", "decline", ["action": "decline", "content": NSNull()])
                reason = options.count > 2 ? "请选择此次请求的授权范围；记住授权由来源工具处理。"
                    : "来源请求仅提供单次确认。"
            } else {
                reason = "此请求需要填写表单或完成外部授权，当前控制台无法代填；可终止当前回合，不能用空内容批准。"
            }
        case "item/tool/requestUserInput", "tool/requestUserInput":
            // Older app approvals use a closed question instead of elicitation.
            // Preserve every offered label and return the exact native answer.
            let questions = params["questions"] as? [[String: Any]] ?? []
            let question = questions.first ?? [:]
            action = question["question"] as? String ?? "请求确认"
            let choices = question["options"] as? [[String: Any]] ?? []
            supported = questions.count == 1 && question["isSecret"] as? Bool != true
                && !choices.isEmpty && choices.count <= 20
                && (question["id"] as? String)?.isEmpty == false
                && choices.allSatisfy { choice in
                    guard let label = choice["label"] as? String else { return false }
                    return !label.isEmpty && label.count <= 500
                        && (choice["description"] as? String ?? "").count <= 4_000
                }
            if supported, let id = question["id"] as? String {
                if question["isOther"] as? Bool == true { reason = "可选择来源提供的选项；自定义答案请在原客户端填写。" }
                for (index, choice) in choices.enumerated() {
                    guard let label = choice["label"] as? String else { continue }
                    add("choice-\(index)", "choice", ["answers": [id: ["answers": [label]]]],
                        detail: choice["description"] as? String, label: label)
                }
            } else {
                reason = "此请求需要在原客户端填写完整答案，当前控制台无法代填。"
            }
        default: return nil
        }
        // A truncated action cannot be a reviewable permission scope.
        if action.count > 4_000 || unreviewableOption || options.count > 20 {
            supported = false
            reason = "请求范围过长，当前控制台无法完整展示；请在原客户端核对后授权。"
        }
        supported = supported && !options.isEmpty
        self.results = supported ? results : [:]
        if options.count > 20 { options = [] }
        let timestamp = (params["startedAtMs"] as? NSNumber)?.int64Value
            ?? Int64(Date().timeIntervalSince1970 * 1_000)
        snapshot = CodexApprovalSnapshot(id: UUID().uuidString, kind: "manual",
            status: supported ? "pending" : "unavailable", turnId: turnId,
            action: String(action.prefix(4_000)), reason: reason.map { String($0.prefix(2_000)) },
            startedAtMs: timestamp, options: options)
    }

    func result(decision: String) -> [String: Any] {
        if let result = results[decision] { return result }
        // Only cancellation may be synthesized; a stale/unknown choice can
        // never expand a grant. The monitor validates every human choice.
        if method == "mcpServer/elicitation/request" { return ["action": "cancel", "content": NSNull()] }
        if ["item/tool/requestUserInput", "tool/requestUserInput"].contains(method) { return ["answers": [String: Any]()] }
        if method == "item/permissions/requestApproval" { return ["permissions": [String: Any](), "scope": "turn"] }
        return ["decision": "cancel"]
    }

    func matches(rpcId other: Any) -> Bool {
        // NSNumber and String must retain their distinct JSON-RPC identities.
        if let lhs = rpcId as? String, let rhs = other as? String { return lhs == rhs }
        if let lhs = rpcId as? NSNumber, let rhs = other as? NSNumber { return lhs == rhs }
        return false
    }

    func ended(_ status: String, reason: String? = nil) -> CodexApprovalSnapshot {
        CodexApprovalSnapshot(id: snapshot.id, kind: "manual", status: status,
            turnId: snapshot.turnId, action: snapshot.action, reason: reason ?? snapshot.reason,
            startedAtMs: snapshot.startedAtMs, options: snapshot.options)
    }
}
