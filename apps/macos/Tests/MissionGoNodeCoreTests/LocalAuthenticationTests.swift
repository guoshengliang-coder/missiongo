import XCTest
@testable import MissionGoNodeCore

final class LocalAuthenticationTests: XCTestCase {
    private func home() throws -> String {
        let path = FileManager.default.temporaryDirectory.appendingPathComponent("mg-auth-\(UUID().uuidString)").path
        try FileManager.default.createDirectory(atPath: path, withIntermediateDirectories: true)
        addTeardownBlock { try? FileManager.default.removeItem(atPath: path) }
        return path
    }

    private func write(_ text: String, to path: String) throws {
        try FileManager.default.createDirectory(atPath: URL(fileURLWithPath: path).deletingLastPathComponent().path, withIntermediateDirectories: true)
        try Data(text.utf8).write(to: URL(fileURLWithPath: path))
    }

    private var loggedOut: CommandRunner {
        fakeClaude(auth: CommandResult(code: 1, stdout: #"{"loggedIn":false,"authMethod":"none"}"#, stderr: ""))
    }

    func testClaudeAcceptsSettingsAndProcessKeysWithoutRunningAuthOrInference() async throws {
        let root = try home()
        let onlyVersion: CommandRunner = { _, args in
            XCTAssertEqual(args, ["--version"], "configuration recognition needs no auth/model call")
            return CommandResult(code: 0, stdout: "2.1.232", stderr: "")
        }
        for name in ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"] {
            let verdict = await ClaudeAuthentication.check(run: onlyVersion, environment: [name: "fixture-key"], home: root)
            XCTAssertEqual(verdict, .apiKeyConfigured)
        }
        try write(#"{"env":{"ANTHROPIC_AUTH_TOKEN":"fixture-token","ANTHROPIC_BASE_URL":"https://gateway.example"}}"#, to: "\(root)/.claude/settings.json")
        let status = await ClaudeCodeStatus.check(run: onlyVersion, environment: [:], home: root)
        XCTAssertEqual(status, .ready(version: "2.1.232"))
        let (trustedHome, repo) = try makeTrustedRepo(trusted: true)
        defer { try? FileManager.default.removeItem(atPath: trustedHome) }
        let preflight = await Preflight.check(repoPath: repo, run: onlyVersion, home: trustedHome,
            environment: ["CLAUDE_CONFIG_DIR": "\(root)/.claude"])
        XCTAssertEqual(preflight, .ok(version: "2.1.232"))
    }

    func testClaudeExplicitEmptySettingsMaskInheritedKeyAndBaseURLIsNotAuthentication() async throws {
        let root = try home()
        try write(#"{"env":{"ANTHROPIC_API_KEY":"","ANTHROPIC_BASE_URL":"https://gateway.example"}}"#, to: "\(root)/.claude/settings.json")
        let result = await ClaudeAuthentication.check(run: loggedOut, environment: ["ANTHROPIC_API_KEY": "masked-key"], home: root)
        XCTAssertEqual(result, .missing)
        let empty = await ClaudeAuthentication.check(run: loggedOut, environment: ["ANTHROPIC_AUTH_TOKEN": " \n"], home: root)
        XCTAssertEqual(empty, .missing)
    }

    func testClaudeCustomConfigDirectoryAndMalformedSettingsFailClosed() async throws {
        let root = try home()
        let directory = "\(root)/custom"
        for content in ["{bad json", #"{"env":{"ANTHROPIC_API_KEY":123}}"#, #"{"env":[]}"#] {
            try write(content, to: "\(directory)/settings.json")
            let result = await ClaudeAuthentication.check(run: fakeClaude(),
                environment: ["CLAUDE_CONFIG_DIR": directory, "ANTHROPIC_API_KEY": "fixture-key"], home: root)
            XCTAssertEqual(result, .unreadable)
        }
    }

    private func codex(_ config: [String: Any], environment: [String: String] = [:], stored: [String: Any]? = nil,
                       login: LocalAuthentication = .missing) async -> LocalAuthentication {
        await CodexAuthentication.evaluate(config: config, stored: stored, environment: environment) { login }
    }

    func testCodexStoredAndEnvironmentKeysAndOfficialLogin() async {
        let env = await codex([:], environment: ["OPENAI_API_KEY": "fixture-key"])
        XCTAssertEqual(env, .apiKeyConfigured)
        let stored = await codex([:], stored: ["OPENAI_API_KEY": "fixture-key"])
        XCTAssertEqual(stored, .apiKeyConfigured)
        let official = await codex([:], login: .signedIn)
        XCTAssertEqual(official, .signedIn)
        let masked = await codex([:], environment: ["OPENAI_API_KEY": " \n"], stored: ["OPENAI_API_KEY": ""])
        XCTAssertEqual(masked, .missing)
        let stale = await codex([:], stored: ["auth_mode": "chatgpt", "OPENAI_API_KEY": "stale-key"])
        XCTAssertEqual(stale, .missing)
    }

    func testCodexUsesOnlySelectedProviderAndCannotBorrowOfficialLogin() async {
        let config: [String: Any] = ["model_provider": "gateway", "model_providers": [
            "gateway": ["env_key": "GATEWAY_KEY"],
            "unused": ["experimental_bearer_token": "unrelated-key"],
        ]]
        let missing = await codex(config, environment: ["OPENAI_API_KEY": "wrong-key"],
            stored: ["OPENAI_API_KEY": "stored-key"], login: .signedIn)
        XCTAssertEqual(missing, .missing)
        let empty = await codex(config, environment: ["GATEWAY_KEY": " "])
        XCTAssertEqual(empty, .missing)
        let ready = await codex(config, environment: ["GATEWAY_KEY": "fixture-key"])
        XCTAssertEqual(ready, .apiKeyConfigured)
        let unknown = await codex(["model_provider": "missing"], login: .signedIn)
        XCTAssertEqual(unknown, .missing)
    }

    func testCodexDirectTokenAndRequiresOpenAIAuthPrecedence() async {
        let direct = await codex(["model_provider": "gateway", "model_providers": [
            "gateway": ["experimental_bearer_token": "fixture-token"],
        ]])
        XCTAssertEqual(direct, .apiKeyConfigured)
        let openAI = await codex(["model_provider": "gateway", "model_providers": [
            "gateway": ["requires_openai_auth": true, "env_key": "IGNORED_KEY"],
        ]], stored: ["OPENAI_API_KEY": "fixture-key"])
        XCTAssertEqual(openAI, .apiKeyConfigured)
        let ignored = await codex(["model_provider": "gateway", "model_providers": [
            "gateway": ["requires_openai_auth": true, "env_key": "IGNORED_KEY"],
        ]], environment: ["IGNORED_KEY": "fixture-key"])
        XCTAssertEqual(ignored, .missing)
    }

    func testCodexForcedLoginMethodIsNotBypassed() async {
        let chatgpt = await codex(["forced_login_method": "chatgpt"], environment: ["OPENAI_API_KEY": "fixture-key"])
        XCTAssertEqual(chatgpt, .missing)
        let api = await codex(["forced_login_method": "api"], login: .signedIn)
        XCTAssertEqual(api, .missing)
    }

    func testCodexCustomHomeStoredKeyAndMalformedFile() async throws {
        let root = try home()
        let location = CodexLocation(codexHome: root)
        let run: CommandRunner = { _, _ in
            XCTFail("a configured file key needs no login or inference request")
            return CommandResult(code: -1, stdout: "", stderr: "")
        }
        try write(#"{"auth_mode":"apikey","OPENAI_API_KEY":"fixture-key"}"#, to: "\(root)/auth.json")
        let configured = await CodexAuthentication.check(binary: "/unused", run: run,
            environment: ShellEnvironment(path: "/bin", base: [:]), location: location)
        XCTAssertEqual(configured, .apiKeyConfigured)
        try write("{bad json", to: "\(root)/auth.json")
        let invalid = await CodexAuthentication.check(binary: "/unused", run: run,
            environment: ShellEnvironment(path: "/bin", base: ["OPENAI_API_KEY": "fixture-key"]), location: location)
        XCTAssertEqual(invalid, .unreadable)
    }

    private func configurationCLI(in root: String) throws -> String {
        let binary = "\(root)/codex"
        try write(#"""
        #!/usr/bin/python3
        import sys, json
        for line in sys.stdin:
            message = json.loads(line)
            method = message['method']
            if method == 'initialize':
                result = {}
            elif method == 'initialized':
                print(json.dumps({'method':'ignored/notification'}), flush=True)
                continue
            elif method == 'config/read':
                assert message['params'] == {'includeLayers': False}
                result = {'config': {'model_provider': 'gateway', 'model_providers': {'gateway': {'env_key': 'GATEWAY_KEY'}}}}
            else:
                sys.exit(1)
            print(json.dumps({'id':message['id'], 'result':result}), flush=True)
        """#, to: binary)
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: binary)
        return binary
    }

    func testNativeConfigurationProbeOnlyInitializesAndReadsConfig() throws {
        let root = try home()
        let binary = try configurationCLI(in: root)
        let config = CodexConfigurationProbe.fetchSync(binary: binary,
            environment: ShellEnvironment(path: "/usr/bin:/bin", base: [:]), location: CodexLocation(codexHome: root))
        XCTAssertEqual(config?["model_provider"] as? String, "gateway")
        // A hung CLI is bounded, and its output cannot become a credential.
        try write("#!/bin/sh\nsleep 2\n", to: binary)
        let start = Date()
        let hung = CodexConfigurationProbe.fetchSync(binary: binary,
            environment: ShellEnvironment(path: "/usr/bin:/bin", base: [:]), location: CodexLocation(codexHome: root), timeout: 0.1)
        XCTAssertNil(hung)
        XCTAssertLessThan(Date().timeIntervalSince(start), 1)
    }

    func testGatewayKeyPassesBothMenuAndPreflightButDoesNotBypassMcp() async throws {
        let root = try shortTemporaryDirectory()
        defer { try? FileManager.default.removeItem(atPath: root) }
        _ = try configurationCLI(in: root)
        try write("model_provider = \"gateway\"\n", to: "\(root)/config.toml")
        let location = CodexLocation(codexHome: root)
        try FileManager.default.createDirectory(atPath: "\(root)/app-server-control", withIntermediateDirectories: true)
        let listener = try listeningSocket(at: location.controlSocketPath)
        defer { _ = close(listener) }
        let environment = ShellEnvironment(path: "\(root):/usr/bin:/bin", base: ["GATEWAY_KEY": "fixture-key"])
        let run: CommandRunner = { _, args in
            if args == ["--version"] { return CommandResult(code: 0, stdout: "codex-cli 0.154.0", stderr: "") }
            if args == ["mcp", "list", "--json"] { return CommandResult(code: 0, stdout: "[]", stderr: "") }
            XCTFail("gateway authentication must not require a login or send a model request: \(args)")
            return CommandResult(code: -1, stdout: "", stderr: "")
        }
        let menu = await CodexStatus.check(environment: environment, location: location, run: run)
        XCTAssertEqual(menu, .mcpMissing(version: "0.154.0"))
        let (trustedHome, repo) = try makeTrustedRepo(trusted: true)
        defer { try? FileManager.default.removeItem(atPath: trustedHome) }
        let preflight = await CodexPreflight.check(repoPath: repo, environment: environment,
            location: location, serverUrl: nil, run: run)
        guard case let .failed(error) = preflight else { return XCTFail("missing MCP must still block dispatch") }
        XCTAssertEqual(error.failureCode, "mcp_auth")
    }

    func testNativeConfigurationErrorCannotFallBackToUnrelatedSavedLogin() async throws {
        let root = try home()
        let binary = "\(root)/codex"
        try write(#"""
        #!/usr/bin/python3
        import sys, json
        for line in sys.stdin:
            m = json.loads(line)
            if m['method'] == 'initialize':
                print(json.dumps({'id':m['id'], 'result':{}}), flush=True)
            elif m['method'] == 'config/read':
                print(json.dumps({'id':m['id'], 'error':{'message':'invalid TOML'}}), flush=True)
        """#, to: binary)
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: binary)
        try write("broken TOML", to: "\(root)/config.toml")
        let run: CommandRunner = { _, _ in
            XCTFail("invalid active config must not fall back to a saved login")
            return CommandResult(code: 0, stdout: "Logged in using ChatGPT", stderr: "")
        }
        let result = await CodexAuthentication.check(binary: binary, run: run,
            environment: ShellEnvironment(path: "/usr/bin:/bin", base: ["OPENAI_API_KEY": "unrelated-key"]),
            location: CodexLocation(codexHome: root))
        XCTAssertEqual(result, .unreadable)
    }
}
