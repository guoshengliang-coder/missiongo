import Darwin
import Foundation

/// Environment differences are diagnostic hints, not proof that a request will
/// fail. Never persist values or hashes, or restart a shared daemon to align them.
enum CodexDaemonEnvironment {
    static func differingKeys(expected: [String: String], actual: [String: String], providerKey: String?, usesOpenAI: Bool = true) -> Set<String> {
        let common: Set<String> = ["OPENAI_API_KEY", "OPENAI_BASE_URL", "OPENAI_ORG_ID", "OPENAI_PROJECT_ID", "CODEX_HOME", "CODEX_API_KEY", "CODEX_CA_CERTIFICATE", "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "all_proxy", "no_proxy", "SSL_CERT_FILE", "SSL_CERT_DIR", "NODE_EXTRA_CA_CERTS"]
        let keys = Set(expected.keys).union(actual.keys).filter {
            (common.contains($0) && (usesOpenAI || !$0.hasPrefix("OPENAI_") && $0 != "CODEX_API_KEY")) || $0 == providerKey
        }
        return Set(keys.filter { key in
            // An unset CODEX_HOME means the normal home, not a different runtime.
            if key == "CODEX_HOME" {
                let fallback = "\(Paths.homeDirectory())/.codex"
                return (expected[key] ?? fallback) != (actual[key] ?? fallback)
            }
            return (expected[key] ?? "") != (actual[key] ?? "")
        })
    }

    static func advisory(binary: String, environment: ShellEnvironment, location: CodexLocation,
                         repoPath: String? = nil) async -> String? {
        guard environment.environment["MISSIONGO_CHECK_DAEMON_ENV"] == "1" else { return nil }
        guard let pid = CodexFileDescriptorGuard.socketOwnerPID(location.controlSocketPath),
              let actual = processEnvironment(pid) else {
            return "无法核对后台服务的环境变量；不影响派单，执行结果以实际请求为准。"
        }
        let config = await CodexConfigurationProbe.fetch(binary: binary, environment: environment, location: location, cwd: repoPath)
        guard let config else { return "无法核对后台服务与当前配置的环境差异；不影响派单，执行结果以实际请求为准。" }
        return advisory(expected: environment.environment, actual: actual, configuration: config)
    }

    static func advisory(expected: [String: String], actual: [String: String], configuration: [String: Any]) -> String? {
        let selected = configuration["model_provider"] as? String ?? "openai"
        let provider = (configuration["model_providers"] as? [String: [String: Any]])?[selected]
        let usesOpenAI = selected == "openai" || JSONValues.bool(provider?["requires_openai_auth"]) == true
        let providerKey = usesOpenAI ? nil : provider?["env_key"] as? String
        guard !differingKeys(expected: expected, actual: actual, providerKey: providerKey, usesOpenAI: usesOpenAI).isEmpty else { return nil }
        return "后台服务与当前终端的部分环境变量不同；允许派单，不会自动重启服务。如执行时报认证或网络错误，请在会话结束后重启服务并重新检查。"
    }

    static func processEnvironment(_ pid: Int32) -> [String: String]? {
        var mib: [Int32] = [CTL_KERN, KERN_PROCARGS2, pid]
        var size = 0
        guard sysctl(&mib, 3, nil, &size, nil, 0) == 0, size > 4, size < 4_000_000 else { return nil }
        var bytes = [UInt8](repeating: 0, count: size)
        guard sysctl(&mib, 3, &bytes, &size, nil, 0) == 0 else { return nil }
        return decode(Array(bytes.prefix(size)))
    }

    static func decode(_ bytes: [UInt8]) -> [String: String]? {
        guard bytes.count > 4 else { return nil }
        let argc = bytes.prefix(4).withUnsafeBytes { $0.loadUnaligned(as: Int32.self) }
        guard argc > 0, argc < 100_000 else { return nil }
        var cursor = 4
        func string() -> String? {
            guard cursor < bytes.count, let end = bytes[cursor...].firstIndex(of: 0) else { return nil }
            defer { cursor = end + 1 }
            return String(bytes: bytes[cursor..<end], encoding: .utf8)
        }
        guard string() != nil else { return nil } // executable path
        while cursor < bytes.count, bytes[cursor] == 0 { cursor += 1 }
        for _ in 0..<argc { guard string() != nil else { return nil } }
        var result: [String: String] = [:]
        while cursor < bytes.count, bytes[cursor] != 0 {
            guard let entry = string(), let equals = entry.firstIndex(of: "=") else { return nil }
            result[String(entry[..<equals])] = String(entry[entry.index(after: equals)...])
        }
        // Modern macOS omits env for cs_restricted processes. Empty output is
        // unknown, not proof that a key is absent. Never restart on that guess.
        return result.isEmpty ? nil : result
    }
}
