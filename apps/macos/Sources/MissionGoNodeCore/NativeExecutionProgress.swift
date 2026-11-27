import Foundation
import CryptoKit

/// Only task labels, timestamps and an opaque revision cross the mirror boundary.
/// Tool arguments, tool output and reasoning text are never copied into diagnostics.
public struct NativeExecutionProgress: Equatable, Sendable {
    public var activities: [AgentSessionActivity] = []
    public var revision: String?
    public var turnStartedAt: String?
    public var lastOutputAt: String?
    public init() {}

    private static func digest(_ records: [[String: Any]]) -> String? {
        guard let data = try? JSONSerialization.data(withJSONObject: records, options: [.sortedKeys]) else { return nil }
        return SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    }

    fileprivate static func label(_ tool: String, command: String? = nil) -> String {
        if let command, command.contains("gh run watch") || command.contains("gh run view") { return "等待 CI" }
        switch tool {
        case "shell", "commandExecution": return "执行命令"
        case "mcpToolCall": return "执行 MCP 工具"
        case "fileChange": return "修改文件"
        case "webSearch": return "检索资料"
        default: return "执行工具"
        }
    }

    public static func codex(turns: [[String: Any]]) -> NativeExecutionProgress {
        var result = NativeExecutionProgress()
        guard let turn = turns.last else { return result }
        result.turnStartedAt = CodexProtocol.sourceActivityTimestamp(turn["startedAt"] ?? turn["createdAt"])
        var records: [[String: Any]] = [["turn": turn["id"] ?? "", "status": turn["status"] ?? ""]]
        var ci: AgentSessionActivity?
        for item in turn["items"] as? [[String: Any]] ?? [] {
            let type = item["type"] as? String ?? ""
            // Reasoning may be encrypted or private. Its payload is deliberately ignored.
            if type == "reasoning" { continue }
            let status = item["status"] as? String ?? ""
            let updated = CodexProtocol.sourceActivityTimestamp(item["updatedAt"] ?? item["completedAt"] ?? item["createdAt"])
            if type == "agentMessage", let updated, updated > (result.lastOutputAt ?? "") { result.lastOutputAt = updated }
            records.append(["id": item["id"] ?? "", "type": type, "status": status,
                "updated": updated ?? "", "output": Self.outputRevision([item["aggregatedOutput"] as? String ?? item["text"] as? String ?? ""])])
            guard turn["status"] as? String == "inProgress", let id = item["id"] as? String else { continue }
            let startedAt = CodexProtocol.sourceActivityTimestamp(item["startedAt"] ?? item["createdAt"])
            let command = item["command"] as? String
            if type == "commandExecution", let command, let query = gitHubRunQuery(command) {
                let output = item["aggregatedOutput"] as? String
                if let previousURL = ci?.wait?.url, !previousURL.hasSuffix("/runs/" + query.run) { ci = nil }
                switch query.action {
                case "view" where status == "completed" && (item["exitCode"] as? Int) == 0:
                    if let check = githubCheck(output: output, run: query.run),
                       query.repo.map({ check.url.lowercased().hasPrefix("https://github.com/" + $0.lowercased() + "/actions/") }) ?? true {
                        ci = check.status == "completed" ? nil : AgentSessionActivity(id: id, title: "等待 CI",
                            wait: .init(kind: "ci", at: updated, url: check.url, status: check.status))
                    }
                case "watch" where ["inProgress", "running"].contains(status):
                    if let repo = query.repo, let output, let sample = watchFrameRevision(output) {
                        ci = AgentSessionActivity(id: id, title: "等待 CI",
                            wait: .init(kind: "ci", at: nil, url: "https://github.com/\(repo)/actions/runs/\(query.run)",
                                        status: "waiting", sample: sample))
                        continue
                    }
                case "watch" where status == "completed":
                    ci = nil
                default:
                    break
                }
            }
            if ["inProgress", "running"].contains(status),
               ["commandExecution", "mcpToolCall", "dynamicToolCall", "fileChange", "webSearch"].contains(type) {
                result.activities.append(AgentSessionActivity(id: id, title: label(type, command: command),
                    startedAt: startedAt, wait: .init(kind: "tool", at: updated ?? startedAt, url: nil, status: nil)))
            }
        }
        if let ci { result.activities.append(ci) }
        result.activities = Array(result.activities.suffix(20))
        result.revision = digest(records)
        return result
    }

    private static func gitHubRunQuery(_ command: String) -> (action: String, run: String, repo: String?)? {
        var direct = command.trimmingCharacters(in: .whitespaces)
        if let wrapper = direct.range(of: #"^/(?:[A-Za-z0-9_-]+/)*(?:ba|z)?sh -[l]?c ["']"#, options: .regularExpression),
           let quote = direct[wrapper].last, direct.last == quote {
            direct = String(direct[wrapper.upperBound...].dropLast())
        }
        guard direct.range(of: #"^gh run (?:view|watch) [0-9]+(?: [A-Za-z0-9._,=/ -]+)?$"#, options: .regularExpression) != nil else { return nil }
        let args = direct.split(separator: " ").map(String.init)
        let action = args[2]
        var repo: String?
        var jsonFields = Set<String>()
        var index = 4
        while index < args.count {
            let option = args[index]
            index += 1
            if action == "watch", ["--exit-status", "--compact"].contains(option) { continue }
            guard index < args.count else { return nil }
            let value = args[index]
            index += 1
            switch option {
            case "-R", "--repo":
                guard value.range(of: #"^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$"#, options: .regularExpression) != nil else { return nil }
                repo = value
            case "--json" where action == "view":
                jsonFields = Set(value.split(separator: ",").map(String.init))
            case "-i", "--interval" where action == "watch":
                guard Int(value) != nil else { return nil }
            default:
                return nil
            }
        }
        guard action == "watch" || jsonFields.isSuperset(of: ["status", "url"]) else { return nil }
        return (action, args[3], repo)
    }

    private static func githubCheck(output: String?, run: String) -> (status: String, url: String)? {
        guard let output, output.utf8.count <= 32_768,
              let value = (try? JSONSerialization.jsonObject(with: Data(output.utf8))) as? [String: Any],
              let status = value["status"] as? String, ["queued", "in_progress", "completed", "waiting", "requested", "pending"].contains(status),
              let url = value["url"] as? String, url.hasSuffix("/runs/" + run),
              url.range(of: #"^https://github\.com/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+/actions/runs/[0-9]+$"#, options: .regularExpression) != nil
        else { return nil }
        return (status, url)
    }

    // gh prints this line only after a successful, nonterminal poll. Require
    // a complete frame header as well, since a captured chunk can end mid-frame.
    private static func watchFrameRevision(_ output: String) -> String? {
        guard let pattern = try? NSRegularExpression(pattern: #"(?m)^Refreshing run status every [0-9]+ seconds\. Press Ctrl\+C to quit\.\r?\n\r?\n[^\r\n]+\r?\n"#),
              let match = pattern.matches(in: output, range: NSRange(output.startIndex..., in: output)).last,
              let end = Range(match.range, in: output)?.upperBound
        else { return nil }
        return outputRevision([String(output[..<end])])
    }

    fileprivate static func outputRevision(_ parts: [String]) -> String {
        var hash = SHA256()
        for part in parts { hash.update(data: Data(part.utf8)) }
        return hash.finalize().map { String(format: "%02x", $0) }.joined()
    }

    public static func openCode(entries: [[String: Any]]) -> NativeExecutionProgress {
        var builder = OpenCodeExecutionProgressBuilder()
        builder.append(entries)
        return builder.snapshot()
    }
}

/// Incrementally summarizes pages; it never retains raw history, reasoning or tool payloads.
struct OpenCodeExecutionProgressBuilder {
    private var progress = NativeExecutionProgress()
    private var hash = SHA256()

    private mutating func record(_ fields: [String: Any]) {
        if let data = try? JSONSerialization.data(withJSONObject: fields, options: [.sortedKeys]) { hash.update(data: data) }
    }

    mutating func append(_ entries: [[String: Any]]) {
        for entry in entries {
            let type = entry["type"] as? String ?? ""
            let time = entry["time"] as? [String: Any] ?? [:]
            let created = CodexProtocol.sourceActivityTimestamp(time["created"])
            let completed = CodexProtocol.sourceActivityTimestamp(time["completed"])
            if type == "user" { progress.turnStartedAt = created }
            let content = entry["content"] as? [[String: Any]] ?? []
            if type == "assistant", content.contains(where: { $0["type"] as? String == "text" && !($0["text"] as? String ?? "").isEmpty }),
               let output = completed ?? created, output > (progress.lastOutputAt ?? "") { progress.lastOutputAt = output }
            record(["id": entry["id"] ?? "", "type": type, "created": created ?? "", "completed": completed ?? "", "finish": entry["finish"] ?? ""])
            for part in content where part["type"] as? String == "tool" {
                let state = part["state"] as? [String: Any] ?? [:]
                let status = state["status"] as? String ?? ""
                let tool = part["name"] as? String ?? ""
                let id = part["id"] as? String ?? ""
                let toolTime = part["time"] as? [String: Any] ?? [:]
                let output = (state["content"] as? [[String: Any]] ?? []).compactMap { $0["text"] as? String }
                record(["id": id, "status": status, "time": toolTime.filter { ["created", "ran", "completed"].contains($0.key) },
                    "output": NativeExecutionProgress.outputRevision(output)])
                if ["running", "pending"].contains(status), !id.isEmpty {
                    progress.activities.append(AgentSessionActivity(id: id,
                        title: NativeExecutionProgress.label(tool, command: (state["input"] as? [String: Any])?["command"] as? String),
                        startedAt: CodexProtocol.sourceActivityTimestamp(toolTime["ran"] ?? toolTime["created"])))
                    progress.activities = Array(progress.activities.suffix(20))
                }
            }
            // A real idle event clears historical unfinished tool records.
            if type == "idle" { progress.activities = []; progress.turnStartedAt = nil }
        }
    }

    func snapshot() -> NativeExecutionProgress {
        var result = progress
        result.revision = hash.finalize().map { String(format: "%02x", $0) }.joined()
        return result
    }
}
