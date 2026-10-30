import Darwin
import Foundation

/// Compare only runtime configuration. Neither values nor their hashes are
/// persisted or reported. A changed environment cannot be applied to an
/// already running process; never restart one with loaded conversations.
enum CodexDaemonEnvironment {
    struct Issue: Sendable {
        let reason: String
        let retryAfterSeconds: Int?
        init(_ reason: String, retryAfterSeconds: Int? = nil) {
            self.reason = reason
            self.retryAfterSeconds = retryAfterSeconds
        }
    }
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

    static func ensure(binary: String, environment: ShellEnvironment, location: CodexLocation,
                       run: CommandRunner, repoPath: String? = nil) async -> Issue? {
        guard environment.environment["MISSIONGO_CHECK_DAEMON_ENV"] == "1" else { return nil }
        guard let pid = CodexFileDescriptorGuard.socketOwnerPID(location.controlSocketPath),
              let actual = processEnvironment(pid) else {
            return Issue("无法核对 Codex 后台服务的认证环境；请在同一终端环境启动服务后重新检查。")
        }
        let config = await CodexConfigurationProbe.fetch(binary: binary, environment: environment, location: location, cwd: repoPath)
        guard let config else { return Issue("无法读取 Codex 有效配置，尚未刷新后台服务。") }
        let selected = config["model_provider"] as? String ?? "openai"
        let provider = (config["model_providers"] as? [String: [String: Any]])?[selected]
        let usesOpenAI = selected == "openai" || JSONValues.bool(provider?["requires_openai_auth"]) == true
        let providerKey = usesOpenAI ? nil : provider?["env_key"] as? String
        guard !differingKeys(expected: environment.environment, actual: actual, providerKey: providerKey, usesOpenAI: usesOpenAI).isEmpty else { return nil }
        guard CodexFileDescriptorGuard.managedSoftLimit(ownerPID: pid, stateDirectory: "\(location.codexHome)/app-server-daemon", codexHome: location.codexHome) != nil else {
            return Issue("Codex 后台服务环境已变化，但无法核实服务身份；请在终端手动重启后重新检查。")
        }
        let control = CodexAppServerControl()
        guard (try? await control.hasLoadedThreads(socketPath: location.controlSocketPath)) == false else {
            return Issue("Codex 后台服务仍使用旧终端环境，且有活动会话或无法确认空闲；请结束会话后点击重新检查，避免中断工作。", retryAfterSeconds: 30)
        }
        switch await CodexPreflight.restartDaemon(binary: binary, location: location, run: run) {
        case .failed: return Issue("Codex 后台服务环境刷新失败；请在已配置认证的终端重启服务后重新检查。")
        case .started, .alreadyUp:
            guard let nextPID = CodexFileDescriptorGuard.socketOwnerPID(location.controlSocketPath),
                  let refreshed = processEnvironment(nextPID),
                  differingKeys(expected: environment.environment, actual: refreshed, providerKey: providerKey, usesOpenAI: usesOpenAI).isEmpty else {
                return Issue("Codex 后台服务重启后仍未取得一致的认证环境；请检查其启动器和登录项配置。")
            }
            return nil
        }
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
