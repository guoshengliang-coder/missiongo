import XCTest
@testable import MissionGoNodeCore

final class GatewayEnvironmentTests: XCTestCase {
    private func directory() throws -> String {
        let root = try shortTemporaryDirectory()
        addTeardownBlock { try? FileManager.default.removeItem(atPath: root) }
        return root
    }
    private func write(_ text: String, _ path: String) throws {
        try FileManager.default.createDirectory(atPath: URL(fileURLWithPath: path).deletingLastPathComponent().path, withIntermediateDirectories: true)
        try Data(text.utf8).write(to: URL(fileURLWithPath: path))
    }
    private func base(_ root: String) -> ShellEnvironment {
        ShellEnvironment(path: "/usr/bin:/bin", base: ["HOME": root, "ZDOTDIR": root, "SHELL": "/bin/zsh"])
    }

    func testFinderLaunchLoadsProfileAndZshrcAndPassesValuesToChild() async throws {
        let root = try directory()
        try write("export ANTHROPIC_BASE_URL=https://gateway.example\nprint 'profile greeting'\n", "\(root)/.zprofile")
        try write("export ANTHROPIC_AUTH_TOKEN='fixture=token\nsecond line'\nprint 'rc greeting'\n", "\(root)/.zshrc")
        try write("print 'logout greeting'\n", "\(root)/.zlogout")
        var settings = ClientLaunchSettings()
        settings.automaticShell = true
        let environment = try await settings.resolve(agent: .claudeCode, base: base(root))
        XCTAssertEqual(environment.environment["ANTHROPIC_BASE_URL"], "https://gateway.example")
        XCTAssertEqual(environment.environment["ANTHROPIC_AUTH_TOKEN"], "fixture=token\nsecond line")
        let run: CommandRunner = { _, args in
            XCTAssertEqual(args, ["--version"], "recognition must not send an inference request")
            return CommandResult(code: 0, stdout: "2.1.246", stderr: "")
        }
        let status = await ClaudeCodeStatus.check(run: run, environment: environment.environment, home: root)
        XCTAssertEqual(status, .ready(version: "2.1.246"))
        let child = Commands.runSync("/usr/bin/printenv", ["ANTHROPIC_AUTH_TOKEN"], environment: environment)
        XCTAssertEqual(child.stdout, "fixture=token\nsecond line\n")
    }

    func testRefreshSeesKeyChangesAndRemovalWithoutResurrectingOldValue() async throws {
        let root = try directory()
        var settings = ClientLaunchSettings()
        settings.automaticShell = true
        try write("export ANTHROPIC_API_KEY=first-fixture\n", "\(root)/.zshrc")
        let first = try await settings.resolve(agent: .claudeCode, base: base(root))
        try write("export ANTHROPIC_API_KEY=second-fixture\n", "\(root)/.zshrc")
        let second = try await settings.resolve(agent: .claudeCode, base: base(root))
        XCTAssertNotEqual(first.environment["ANTHROPIC_API_KEY"], second.environment["ANTHROPIC_API_KEY"])
        try write("unset ANTHROPIC_API_KEY\n", "\(root)/.zshrc")
        let removed = try await settings.resolve(agent: .claudeCode, base: base(root))
        XCTAssertNil(removed.environment["ANTHROPIC_API_KEY"])
    }

    func testExplicitSetupAndLauncherPathsAreArgumentsAndNotShellSyntax() async throws {
        let root = try directory()
        let script = "\(root)/env $(false) ' config.sh"
        let launcher = "\(root)/my claude"
        try write("export ANTHROPIC_AUTH_TOKEN=fixture-wrapper-key\nexport CUSTOM_PROVIDER_KEY=fixture-custom-key\n", script)
        try write("#!/bin/sh\n/usr/bin/printenv ANTHROPIC_AUTH_TOKEN\n", launcher)
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: launcher)
        var settings = ClientLaunchSettings()
        settings.automaticShell = true
        settings.setupScript = script
        settings.executable = launcher
        let environment = try await settings.resolve(agent: .claudeCode, base: base(root))
        XCTAssertEqual(environment.which("claude"), launcher)
        XCTAssertEqual(Commands.runSync("claude", ["--version"], environment: environment).stdout, "fixture-wrapper-key\n")
        XCTAssertEqual(environment.environment["CUSTOM_PROVIDER_KEY"], "fixture-custom-key")
    }

    func testNoConsentNeverRunsASetupScriptAndErrorsNeverExposeProfileOutput() async throws {
        let root = try directory()
        let script = "\(root)/setup.sh"
        try write("echo fixture-secret >&2\nreturn 1\n", script)
        var settings = ClientLaunchSettings()
        settings.setupScript = script
        do {
            _ = try await settings.resolve(agent: .claudeCode, base: base(root))
            XCTFail("setup needs consent")
        } catch { XCTAssertFalse(error.localizedDescription.contains("fixture-secret")) }
        settings.automaticShell = true
        do {
            _ = try await settings.resolve(agent: .claudeCode, base: base(root))
            XCTFail("a failed script must not reuse old environment")
        } catch { XCTAssertFalse(error.localizedDescription.contains("fixture-secret")) }
    }

    func testShellTimeoutIsBounded() throws {
        let root = try directory()
        try write("/bin/sleep 2\n", "\(root)/.zshrc")
        let start = Date()
        XCTAssertThrowsError(try ShellEnvironment.exportedEnvironment(base: base(root).environment, timeout: 0.1))
        XCTAssertLessThan(Date().timeIntervalSince(start), 1)
    }

    func testProjectSettingsOverrideUserAndExplicitEmptyDoesNotBorrowLogin() async throws {
        let root = try directory()
        let repo = "\(root)/project"
        try write(#"{"env":{"ANTHROPIC_AUTH_TOKEN":"user-fixture"}}"#, "\(root)/custom/settings.json")
        try write(#"{"env":{"ANTHROPIC_AUTH_TOKEN":"project-fixture"}}"#, "\(repo)/.claude/settings.json")
        try write(#"{"env":{"ANTHROPIC_AUTH_TOKEN":"local-fixture"}}"#, "\(repo)/.claude/settings.local.json")
        let env = ["CLAUDE_CONFIG_DIR": "\(root)/custom"]
        XCTAssertEqual(try ClaudeAuthentication.effectiveEnvironment(env, home: root, repoPath: repo)["ANTHROPIC_AUTH_TOKEN"], "local-fixture")
        XCTAssertEqual(SkillSync.target(for: .claudeCode, home: root, codexHome: "unused", claudeConfigDirectory: "\(root)/custom"), "\(root)/custom/skills/missiongo/SKILL.md")
        try write(#"{"env":{"ANTHROPIC_AUTH_TOKEN":""}}"#, "\(repo)/.claude/settings.local.json")
        let loggedOut: CommandRunner = { _, _ in CommandResult(code: 1, stdout: #"{"loggedIn":false}"#, stderr: "") }
        let verdict = await ClaudeAuthentication.check(run: loggedOut, environment: env, home: root, repoPath: repo)
        XCTAssertEqual(verdict, .missing)
        try write("broken", "\(repo)/.claude/settings.local.json")
        let unreadable = await ClaudeAuthentication.check(run: loggedOut, environment: env, home: root, repoPath: repo)
        XCTAssertEqual(unreadable, .unreadable)
    }

    func testDaemonEnvironmentComparesCurrentProviderKeyAndRemovedCredentials() {
        let expected = ["CUSTOM_KEY": "new-fixture", "OPENAI_API_KEY": "", "CODEX_INTERNAL": "different"]
        let actual = ["CUSTOM_KEY": "old-fixture", "OPENAI_API_KEY": "old-fixture", "CODEX_INTERNAL": "internal"]
        XCTAssertEqual(CodexDaemonEnvironment.differingKeys(expected: expected, actual: actual, providerKey: "CUSTOM_KEY"), ["CUSTOM_KEY", "OPENAI_API_KEY"])
        XCTAssertTrue(CodexDaemonEnvironment.differingKeys(expected: ["HTTP_PROXY": ""], actual: [:], providerKey: nil).isEmpty)
        var argc: Int32 = 2
        var bytes = withUnsafeBytes(of: &argc) { Array($0) }
        bytes += Array("/bin/codex\0\0codex\0app-server\0CUSTOM_KEY=fixture=a\0PATH=/bin\0\0".utf8)
        XCTAssertEqual(CodexDaemonEnvironment.decode(bytes)?["CUSTOM_KEY"], "fixture=a")
        XCTAssertNil(CodexDaemonEnvironment.decode([0, 0, 0, 0]))
    }

    func testHiddenProcessEnvironmentIsUnknownRatherThanAnEmptyConfiguration() {
        var argc: Int32 = 2
        var bytes = withUnsafeBytes(of: &argc) { Array($0) }
        bytes += Array("/bin/sleep\0\0/bin/sleep\02\0".utf8)
        XCTAssertNil(CodexDaemonEnvironment.decode(bytes))
    }

    func testHeartbeatDoesNotRefreshButDispatchUsesTargetRepo() async throws {
        let refreshes = Locked<[String]>([])
        let adapter = RefreshingAgentAdapter(base: EnvironmentFixtureAdapter()) { cwd in
            refreshes.withLock { $0.append(cwd) }
            return EnvironmentFixtureAdapter()
        }
        _ = await adapter.detect()
        _ = await adapter.resourceSnapshot()
        _ = await adapter.availableModels()
        _ = await adapter.dispatchAvailability()
        XCTAssertTrue(refreshes.current.isEmpty)
        _ = try await adapter.launch(DispatchJob(dispatchId: "fixture", itemKeys: ["AND-305"], repoPath: "/repo", mode: "plan", nodeName: "fixture"))
        XCTAssertEqual(refreshes.current, ["/repo"])
    }

    func testChangingConfigurationKeepsExistingSessionOnItsOriginalAdapter() async throws {
        let cache = RefreshingAgentAdapter.SessionCache()
        let originalReads = Locked(0)
        let replacementReads = Locked(0)
        let first = RefreshingAgentAdapter(base: EnvironmentFixtureAdapter(), sessions: cache) { _ in
            EnvironmentFixtureAdapter(reads: originalReads)
        }
        _ = try await first.launch(DispatchJob(dispatchId: "fixture", itemKeys: ["AND-305"], repoPath: "/repo", mode: "plan", nodeName: "fixture"))
        let replacement = RefreshingAgentAdapter(base: EnvironmentFixtureAdapter(reads: replacementReads), sessions: cache) { _ in
            EnvironmentFixtureAdapter(reads: replacementReads)
        }
        _ = try await replacement.artifactMessages(sessionRef: "fixture")
        XCTAssertEqual(originalReads.current, 1)
        XCTAssertEqual(replacementReads.current, 0)
    }

    func testInstalledCodexParsesUserAndProjectConfigWithoutInference() async throws {
        guard let binary = ShellEnvironment.resolve().which("codex") else { throw XCTSkip("Codex CLI not installed") }
        for customHome in [false, true] {
            let root = try directory()
            let codexHome = customHome ? "\(root)/custom-codex" : "\(root)/.codex"
            let repo = "\(root)/repo"
            try FileManager.default.createDirectory(atPath: "\(repo)/.git", withIntermediateDirectories: true)
            // Trust the fixture so native project layering is enabled.
            try write("""
            model_provider = "gateway"
            [model_providers.gateway]
            name = "Fixture"
            base_url = "https://gateway.example/v1"
            env_key = "CUSTOM_PROVIDER_KEY"
            wire_api = "responses"
            [mcp_servers.missiongo]
            command = "/usr/bin/true"
            [projects."\(repo)"]
            trust_level = "trusted"
            """, "\(codexHome)/config.toml")
            try write("model = \"fixture-project-model\"\n", "\(repo)/.codex/config.toml")
            var values = ["HOME": root, "CUSTOM_PROVIDER_KEY": "fixture-key"]
            if customHome { values["CODEX_HOME"] = codexHome }
            let environment = ShellEnvironment(path: "/usr/bin:/bin", base: values)
            let config = CodexConfigurationProbe.fetchSync(binary: binary, environment: environment, location: CodexLocation(codexHome: codexHome), cwd: repo)
            XCTAssertEqual(config?["model_provider"] as? String, "gateway")
            XCTAssertEqual(config?["model"] as? String, "fixture-project-model")
            let listed = Commands.runSync(binary, ["mcp", "list", "--json"], environment: environment, directory: repo)
            XCTAssertEqual(listed.code, 0)
            XCTAssertEqual(CodexPreflight.parseMcpList(listed.stdout), .ready)
            let noLogin: CommandRunner = { _, _ in
                XCTFail("a configured custom provider needs no official login or model request")
                return CommandResult(code: 1, stdout: "", stderr: "")
            }
            let verdict = await CodexAuthentication.check(binary: binary, run: noLogin, environment: environment, location: CodexLocation(codexHome: codexHome), repoPath: repo)
            XCTAssertEqual(verdict, .apiKeyConfigured)
            // Inspect a real non-system app-server process, not a SIP-protected
            // system binary whose environment macOS deliberately hides.
            let process = Process()
            process.executableURL = URL(fileURLWithPath: binary)
            process.arguments = ["app-server"]
            process.environment = environment.environment
            let input = Pipe()
            process.standardInput = input
            process.standardOutput = FileHandle.nullDevice
            process.standardError = FileHandle.nullDevice
            try process.run()
            defer { try? input.fileHandleForWriting.close(); if process.isRunning { process.terminate() }; process.waitUntilExit() }
            let deadline = Date().addingTimeInterval(2)
            var actual: [String: String]?
            repeat {
                actual = CodexDaemonEnvironment.processEnvironment(process.processIdentifier)
                if actual?["CUSTOM_PROVIDER_KEY"] != nil { break }
                try await Task.sleep(nanoseconds: 20_000_000)
            } while process.isRunning && Date() < deadline
            XCTAssertEqual(actual?["CUSTOM_PROVIDER_KEY"], "fixture-key")
        }
    }
}

private struct EnvironmentFixtureAdapter: AgentAdapter {
    let kind = "claude_code"
    var reads: Locked<Int>? = nil
    func detect() async -> String? { "fixture" }
    func launch(_ job: DispatchJob) async throws -> LaunchResult {
        LaunchResult(sessionName: "fixture", sessionUrl: nil, sessionRef: "fixture", logPath: nil)
    }
    func artifactMessages(sessionRef: String) async throws -> [AgentSessionMessage] {
        reads?.withLock { $0 += 1 }
        return []
    }
}
