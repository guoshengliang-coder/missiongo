import Darwin
import Foundation
import CryptoKit

/// Private, same-user filesystem IPC. External hosts never share dispatch state.
public enum ClaudeExternalBridge {
    public static func root(home: String = Paths.homeDirectory()) -> String {
        ClaudeHostStore.defaultRoot(home: home) + "/external"
    }

    public static func normalizedRef(_ value: String) throws -> String {
        guard let uuid = UUID(uuidString: value) else { throw LaunchError("Claude 原生会话 ID 必须是 UUID。") }
        return uuid.uuidString.lowercased()
    }

    public static func privateDirectory(_ path: String) throws {
        let manager = FileManager.default
        if !manager.fileExists(atPath: path) {
            try manager.createDirectory(atPath: path, withIntermediateDirectories: true,
                                        attributes: [.posixPermissions: 0o700])
        }
        var info = stat()
        guard lstat(path, &info) == 0, info.st_uid == getuid(),
              (info.st_mode & S_IFMT) == S_IFDIR, (info.st_mode & 0o077) == 0 else {
            throw LaunchError("Claude 桥接目录必须属于当前用户且仅当前用户可访问。")
        }
    }

    /// Kernel lock, released on crash. Never remove the lock file to take ownership.
    public final class Lease {
        private let descriptor: Int32
        public init(directory: String, name: String = "host.lock") throws {
            try privateDirectory(directory)
            descriptor = open(directory + "/" + name, O_RDWR | O_CREAT | O_NOFOLLOW | O_CLOEXEC, 0o600)
            guard descriptor >= 0 else { throw LaunchError("无法取得 Claude 桥接锁。") }
            var info = stat()
            guard fstat(descriptor, &info) == 0, info.st_uid == getuid(),
                  (info.st_mode & 0o077) == 0, flock(descriptor, LOCK_EX | LOCK_NB) == 0 else {
                close(descriptor)
                throw LaunchError("此 Claude 会话已有本地桥接宿主；未启动第二个进程。")
            }
        }
        deinit { flock(descriptor, LOCK_UN); close(descriptor) }
    }

    /// Deliberately small local argv surface. No inline JSON credentials or provider overrides.
    public static func validateArguments(_ args: [String]) throws {
        let values: Set<String> = ["--model", "--effort", "--permission-mode", "--settings", "--mcp-config", "--add-dir", "--plugin-dir"]
        let flags: Set<String> = ["--strict-mcp-config"]
        var index = 0
        while index < args.count {
            let flag = args[index]
            if flags.contains(flag) { index += 1; continue }
            guard values.contains(flag), index + 1 < args.count, !args[index + 1].isEmpty,
                  !args[index + 1].hasPrefix("--") else {
                throw LaunchError("桥接启动参数不支持：\(flag)。")
            }
            let value = args[index + 1]
            if ["--settings", "--mcp-config"].contains(flag), value.trimmingCharacters(in: .whitespaces).hasPrefix("{") {
                throw LaunchError("桥接配置请使用本地文件，不能在参数中传入内联认证配置。")
            }
            index += 2
        }
    }

    public static func arguments(config: ClaudeHostConfiguration) throws -> [String] {
        let extra = config.externalArguments ?? []
        try validateArguments(extra)
        return ["--input-format", "stream-json", "--output-format", "stream-json", "--verbose",
                "--replay-user-messages", "--permission-prompt-tool", "stdio", "--permission-prompts", "host",
                "--no-chrome", "--disallowedTools", ClaudeHostArguments.disallowedTools.joined(separator: ","),
                "--name", config.sessionName]
            + extra + [config.externalResume == true ? "--resume" : "--session-id", config.sessionRef]
    }

    /// Detect provider drift without persisting endpoint or authentication values.
    public static func environmentFingerprint(_ environment: [String: String]) -> String {
        let keys = environment.keys.filter { key in
            key == "ANTHROPIC_BASE_URL" || key == "ANTHROPIC_MODEL" || key.hasPrefix("ANTHROPIC_DEFAULT_") || key == "CLAUDE_CONFIG_DIR"
                || ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY"].contains(key)
        }.sorted()
        let values = keys.map { [$0, environment[$0]!] }
        let data = try! JSONSerialization.data(withJSONObject: values)
        return SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    }

    /// Reads only the explicitly selected history file. Does not discover other conversations.
    public static func history(path: String, sessionRef: String, cwd: String) throws -> [AgentSessionMessage] {
        let url = URL(fileURLWithPath: path)
        let size = (try url.resourceValues(forKeys: [.fileSizeKey])).fileSize ?? 0
        guard size <= 20_000_000 else { throw LaunchError("原会话历史过大，请先在本机整理后移交。") }
        let data = try Data(contentsOf: url)
        var snapshot = ClaudeStreamSnapshot(sessionRef: sessionRef)
        var matched = false
        var pendingTools: Set<String> = []
        let expectedCwd = URL(fileURLWithPath: cwd).standardizedFileURL.resolvingSymlinksInPath().path
        for line in data.split(separator: 0x0a) {
            guard let event = try JSONSerialization.jsonObject(with: Data(line)) as? [String: Any] else { continue }
            guard let ref = event["sessionId"] as? String ?? event["session_id"] as? String else { continue }
            guard try normalizedRef(ref) == sessionRef else { throw LaunchError("历史文件包含其它会话，移交已停止。") }
            if let directory = event["cwd"] as? String {
                guard URL(fileURLWithPath: directory).standardizedFileURL.resolvingSymlinksInPath().path == expectedCwd else {
                    throw LaunchError("移交工作目录与原会话不一致。")
                }
                matched = true
            }
            if event["type"] as? String == "user" || event["type"] as? String == "assistant" {
                if let message = event["message"] as? [String: Any], let content = message["content"] as? [[String: Any]] {
                    for block in content {
                        if block["type"] as? String == "tool_use", let id = block["id"] as? String { pendingTools.insert(id) }
                        if block["type"] as? String == "tool_result", let id = block["tool_use_id"] as? String { pendingTools.remove(id) }
                    }
                }
                var frame = event
                // Saved transcript messages don't carry the SDK's human-origin marker.
                if event["type"] as? String == "user" { frame["origin"] = ["kind": "human"] }
                snapshot.consume(frame)
            }
        }
        guard matched else { throw LaunchError("无法核实原会话 ID 与工作目录。") }
        guard pendingTools.isEmpty else { throw LaunchError("原会话仍有未完成工具或审批，请先在原 CLI 处理后移交。") }
        return AgentSessionAnswerTrace.markingAnswered(snapshot.state.messages)
    }

    /// A byte written to stdin is not an acknowledgement. Keep the write journal across crashes.
    public static func uncertainWrites(_ state: ClaudeHostState) -> ClaudeHostState {
        var result = state
        for (id, command) in result.commandResults where command.status == "delivering" {
            result.commandResults[id] = ClaudeHostCommandResult(status: "delivery_unknown", error: "CLI 接收确认丢失；请核实后确认，不会自动重发。")
        }
        return result
    }

    /// Only strings known to be credentials/endpoint configuration; never enumerate or save env for diagnostics.
    public static func redact(_ object: [String: Any], environment: [String: String]) -> [String: Any] {
        let values = environment.filter { key, value in
            !value.isEmpty && (key == "ANTHROPIC_BASE_URL" || key.contains("TOKEN") || key.contains("API_KEY") || key.contains("PASSWORD"))
        }.map(\.value).sorted { $0.count > $1.count }
        func clean(_ value: Any) -> Any {
            if var text = value as? String {
                for secret in values { text = text.replacingOccurrences(of: secret, with: "[本机配置已隐藏]") }
                return text
            }
            if let list = value as? [Any] { return list.map(clean) }
            if let dict = value as? [String: Any] { return dict.mapValues(clean) }
            return value
        }
        return object.mapValues(clean)
    }
}
