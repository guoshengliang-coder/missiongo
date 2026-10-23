import Foundation

/// A request is bound to this transport connection, never to a reusable RPC id
/// alone. Reconnecting must not replay a person's decision on a new prompt.
struct CodexApprovalRequest {
    let rpcId: Any
    let method: String
    let params: [String: Any]
    let snapshot: CodexApprovalSnapshot

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
        switch method {
        case "item/commandExecution/requestApproval":
            action = params["command"] as? String ?? reason ?? "执行命令"
        case "item/fileChange/requestApproval":
            action = params["grantRoot"] as? String ?? reason ?? "修改文件"
        case "item/permissions/requestApproval":
            let data = try? JSONSerialization.data(withJSONObject: params["permissions"] ?? [:], options: [.sortedKeys])
            action = data.flatMap { String(data: $0, encoding: .utf8) } ?? "申请额外权限"
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
            reason = supported ? "仅回复这一次请求，不授予会话或永久权限。"
                : "此请求需要填写表单或完成外部授权，当前控制台无法代填；可终止当前回合，不能用空内容批准。"
        default: return nil
        }
        let timestamp = (params["startedAtMs"] as? NSNumber)?.int64Value
            ?? Int64(Date().timeIntervalSince1970 * 1_000)
        snapshot = CodexApprovalSnapshot(id: UUID().uuidString, kind: "manual",
            status: supported ? "pending" : "unavailable", turnId: turnId,
            action: String(action.prefix(4_000)), reason: reason.map { String($0.prefix(2_000)) },
            startedAtMs: timestamp)
    }

    func result(decision: String) -> [String: Any] {
        switch method {
        case "mcpServer/elicitation/request":
            return ["action": decision, "content": decision == "accept" ? [String: Any]() as Any : NSNull()]
        case "item/permissions/requestApproval":
            return ["permissions": decision == "accept" ? (params["permissions"] as? [String: Any] ?? [:]) : [:], "scope": "turn"]
        default: return ["decision": decision]
        }
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
            startedAtMs: snapshot.startedAtMs)
    }
}
