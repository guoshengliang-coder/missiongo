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
              params["threadId"] as? String == threadId,
              let turnId = params["turnId"] as? String else { return nil }
        self.rpcId = rpcId
        self.method = method
        self.params = params
        let action: String
        var reason = params["reason"] as? String
        var supported = true
        var options: [CodexApprovalOption] = []
        var results: [String: [String: Any]] = [:]
        func add(_ id: String, _ kind: String, _ result: [String: Any], detail: String? = nil) {
            // Never hide part of a persistent rule behind display truncation.
            guard results[id] == nil, (detail?.count ?? 0) <= 4_000 else { return }
            options.append(CodexApprovalOption(id: id, kind: kind, detail: detail))
            results[id] = result
        }
        func commandDecision(_ value: Any, index: Int) {
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
            // The existing console offers a one-time yes/no choice. It cannot
            // invent form answers or complete an OAuth/browser URL flow.
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
                add("decline", "decline", ["action": "decline", "content": NSNull()])
            }
            reason = supported ? "仅回复这一次请求，不授予会话或永久权限。"
                : "此请求需要填写表单或完成外部授权，当前控制台无法代填；可终止当前回合，不能用空内容批准。"
        default: return nil
        }
        self.results = results
        supported = supported && !options.isEmpty
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
