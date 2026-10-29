import Foundation

/// A local configuration verdict, never proof that a model endpoint is reachable.
/// Keep credentials out of this value: only this verdict may reach UI or logs.
public enum LocalAuthentication: Equatable, Sendable {
    case signedIn
    case apiKeyConfigured
    case missing
    case unreadable

    public var isReady: Bool { self == .signedIn || self == .apiKeyConfigured }
}

enum AuthenticationFiles {
    static func nonempty(_ value: Any?) -> String? {
        guard let value = value as? String,
              !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return nil }
        return value
    }

    /// nil means absent. An unreadable/malformed existing file throws; it must
    /// not silently become an empty configuration or expose its contents.
    static func json(_ path: String) throws -> [String: Any]? {
        guard FileManager.default.fileExists(atPath: path) else { return nil }
        let data = try Data(contentsOf: URL(fileURLWithPath: path))
        guard let object = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw CocoaError(.fileReadCorruptFile)
        }
        return object
    }
}

public enum ClaudeAuthentication {
    public static func check(
        run: CommandRunner,
        environment: [String: String],
        home: String = Paths.homeDirectory()
    ) async -> LocalAuthentication {
        let directory = AuthenticationFiles.nonempty(environment["CLAUDE_CONFIG_DIR"]) ?? "\(home)/.claude"
        var effective = environment
        do {
            if let settings = try AuthenticationFiles.json("\(directory)/settings.json"),
               let values = settings["env"] {
                guard let values = values as? [String: String] else { return .unreadable }
                // Claude applies settings.env to its process environment, including
                // explicit empty strings. Never resurrect a masked process key.
                effective.merge(values) { _, configured in configured }
            }
        } catch { return .unreadable }
        if ["ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY"].contains(where: {
            AuthenticationFiles.nonempty(effective[$0]) != nil
        }) {
            return .apiKeyConfigured
        }
        guard let auth = await Preflight.claudeAuthStatus(run: run) else { return .unreadable }
        if !auth.loggedIn { return .missing }
        return auth.authMethod.lowercased().contains("api") ? .apiKeyConfigured : .signedIn
    }
}

public enum CodexAuthentication {
    public static func check(
        binary: String, run: CommandRunner, environment: ShellEnvironment, location: CodexLocation
    ) async -> LocalAuthentication {
        // Codex owns TOML parsing and configuration layering. Do not try to
        // recognize a provider with regexes (comments/quoted tables can fool them).
        let config: [String: Any]
        if Paths.exists("\(location.codexHome)/config.toml") {
            guard let loaded = await CodexConfigurationProbe.fetch(
                binary: binary, environment: environment, location: location
            ) else { return .unreadable }
            config = loaded
        } else { config = [:] }
        let stored: [String: Any]?
        do { stored = try AuthenticationFiles.json("\(location.codexHome)/auth.json") }
        catch { return .unreadable }
        return await evaluate(config: config, stored: stored, environment: environment.environment) {
            let result = await run(binary, ["login", "status"])
            if result.code == 0 {
                return (result.stdout + result.stderr).localizedCaseInsensitiveContains("api key")
                    ? .apiKeyConfigured : .signedIn
            }
            return (result.stdout + result.stderr).localizedCaseInsensitiveContains("not logged in")
                ? .missing : .unreadable
        }
    }

    static func evaluate(
        config: [String: Any], stored: [String: Any]?, environment: [String: String],
        login: () async -> LocalAuthentication
    ) async -> LocalAuthentication {
        let providerId = AuthenticationFiles.nonempty(config["model_provider"]) ?? "openai"
        let providers = config["model_providers"] as? [String: Any] ?? [:]
        let provider = providers[providerId] as? [String: Any]
        let usesOpenAI = providerId == "openai" || JSONValues.bool(provider?["requires_openai_auth"]) == true
        let result: LocalAuthentication
        if usesOpenAI {
            if AuthenticationFiles.nonempty(environment["OPENAI_API_KEY"]) != nil {
                result = .apiKeyConfigured
            } else if stored?["auth_mode"] as? String != "chatgpt",
                      AuthenticationFiles.nonempty(stored?["OPENAI_API_KEY"]) != nil {
                result = .apiKeyConfigured
            } else { result = await login() }
        } else if let provider {
            // Only the selected provider's credential counts. A ChatGPT login
            // or an unrelated OPENAI_API_KEY cannot fill its missing env_key.
            if let key = provider["env_key"] as? String {
                result = AuthenticationFiles.nonempty(key) != nil
                    && AuthenticationFiles.nonempty(environment[key]) != nil ? .apiKeyConfigured : .missing
            } else if AuthenticationFiles.nonempty(provider["experimental_bearer_token"]) != nil {
                result = .apiKeyConfigured
            } else { result = .missing }
        } else { result = .missing }
        if config["forced_login_method"] as? String == "chatgpt", result == .apiKeyConfigured { return .missing }
        if config["forced_login_method"] as? String == "api", result == .signedIn { return .missing }
        return result
    }
}
