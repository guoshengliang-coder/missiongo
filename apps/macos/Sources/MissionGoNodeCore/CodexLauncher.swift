import Foundation

/// Where Codex keeps its state on this machine, and how to reach it.
public struct CodexLocation: Equatable, Sendable {
    /// `$CODEX_HOME`, or `~/.codex`.
    public let codexHome: String

    public init(environment: ShellEnvironment, home: String = Paths.homeDirectory()) {
        let configured = environment.environment["CODEX_HOME"]?.trimmingCharacters(in: .whitespaces) ?? ""
        codexHome = configured.isEmpty ? "\(home)/.codex" : configured
    }

    public init(codexHome: String) {
        self.codexHome = codexHome
    }

    /// Created by the ChatGPT app's app-server while the app runs.
    public var controlSocketPath: String {
        return "\(codexHome)/app-server-control/app-server-control.sock"
    }

    public var skillPath: String {
        return "\(codexHome)/skills/missiongo/SKILL.md"
    }

    /// The CLI the ChatGPT app ships. A `codex` on PATH is preferred: it is the
    /// one the operator runs themselves, and it reads the same `CODEX_HOME`.
    public static let bundledBinary = "/Applications/ChatGPT.app/Contents/Resources/codex"

    public static func binary(environment: ShellEnvironment) -> String? {
        if let onPath = environment.which("codex") { return onPath }
        return FileManager.default.isExecutableFile(atPath: bundledBinary) ? bundledBinary : nil
    }

    public static func isSocket(_ path: String) -> Bool {
        var info = stat()
        // stat, not lstat: the path may be a symlink to the real socket, and
        // lstat would answer "this is a symlink" and be read as "not running".
        guard stat(path, &info) == 0 else { return false }
        return (info.st_mode & S_IFMT) == S_IFSOCK
    }

    /// Whether the Codex app-server is actually listening there.
    ///
    /// The file being present is not the answer in either direction: a socket
    /// file outlives the app that made it, so the menu would say ready and the
    /// dispatch would fail. The only honest check is to connect and hang up.
    public static func controlChannelIsUp(_ path: String) -> Bool {
        guard isSocket(path) else { return false }
        guard let socket = try? UnixSocket(path: path, timeout: 1) else { return false }
        socket.close()
        return true
    }
}

/// Everything that has to be true before a Codex thread can start — the Codex
/// counterpart of `Preflight`, with the same rule: say what is missing and how
/// to fix it, because nobody is at the machine to see it go wrong.
public enum CodexPreflight {
    public enum McpState: Equatable, Sendable {
        case ready
        case missing
        case disabled
        /// Configured, but Codex holds no login for it.
        case notLoggedIn
        case unreadable
    }

    /// Parse `codex mcp list --json`: an array of servers with `name`,
    /// `enabled` and `auth_status`.
    public static func parseMcpList(_ raw: String) -> McpState {
        guard let start = raw.firstIndex(of: "["), let end = raw.lastIndex(of: "]"), start < end,
              let servers = JSONValues.parse(String(raw[start...end])) as? [[String: Any]]
        else { return .unreadable }
        guard let server = servers.first(where: { $0["name"] as? String == "missiongo" }) else { return .missing }
        if JSONValues.bool(server["enabled"]) == false { return .disabled }
        if server["auth_status"] as? String == "not_logged_in" { return .notLoggedIn }
        return .ready
    }

    public static func version(binary: String, run: CommandRunner) async -> String? {
        let result = await run(binary, ["--version"])
        guard result.code == 0 else { return nil }
        return Preflight.parseClaudeVersion(result.stdout) ?? Preflight.parseClaudeVersion(result.stderr)
    }

    /// `codex login status` exits 0 when logged in and 1 with "Not logged in"
    /// otherwise. nil when the answer is neither.
    public static func isLoggedIn(binary: String, run: CommandRunner) async -> Bool? {
        let result = await run(binary, ["login", "status"])
        if result.code == 0 { return true }
        let output = result.stdout + result.stderr
        return output.localizedCaseInsensitiveContains("not logged in") ? false : nil
    }

    public static func mcpState(binary: String, run: CommandRunner) async -> McpState {
        let result = await run(binary, ["mcp", "list", "--json"])
        guard result.code == 0 else { return .unreadable }
        return parseMcpList(result.stdout)
    }

    /// The commands that connect Codex to this MissionGo server's MCP endpoint.
    public static func mcpSetupCommand(serverUrl: String?) -> String {
        let url = serverUrl.map { "\($0)/mcp" } ?? "<MissionGo 地址>/mcp"
        return "codex mcp add missiongo --url \(url) && codex mcp login missiongo"
    }

    public static func check(
        repoPath: String,
        environment: ShellEnvironment,
        location: CodexLocation,
        serverUrl: String?,
        run: CommandRunner,
        appRunning: () -> Bool = CodexApp.isRunning
    ) async -> Preflight.Result {
        guard let binary = CodexLocation.binary(environment: environment),
              let version = await version(binary: binary, run: run)
        else {
            return .failed(reason: "本机找不到可用的 codex 命令：确认已安装 ChatGPT App 或 Codex CLI。")
        }
        switch await isLoggedIn(binary: binary, run: run) {
        case true?: break
        case false?: return .failed(reason: "Codex 未登录：在本机运行 codex login，或在 ChatGPT App 里登录后再派单。")
        case nil: return .failed(reason: "无法读取 codex login status 的输出，无法确认登录状态。")
        }
        if let problem = Preflight.repositoryProblem(repoPath) {
            return .failed(reason: problem)
        }
        guard CodexLocation.controlChannelIsUp(location.controlSocketPath) else {
            // Which of the two it is decides what the operator has to do, so it
            // is worth one more question before reporting.
            return .failed(reason: appRunning()
                ? "ChatGPT App 在运行，但连不上它的 Codex 控制通道（\(location.controlSocketPath)）：确认 App 里的 Codex 已经启动，必要时重启 App 后再派单。"
                : "找不到 Codex 的控制通道（\(location.controlSocketPath)）：打开 ChatGPT App 并保持运行后再派单。")
        }
        switch await mcpState(binary: binary, run: run) {
        case .ready: break
        case .missing:
            return .failed(reason: "Codex 还没有配置 missiongo MCP：在终端运行 \(mcpSetupCommand(serverUrl: serverUrl))")
        case .disabled:
            return .failed(reason: "Codex 的 missiongo MCP 处于停用状态：在 ~/.codex/config.toml 里启用它。")
        case .notLoggedIn:
            return .failed(reason: "Codex 的 missiongo MCP 还没有登录：在终端运行 codex mcp login missiongo")
        case .unreadable:
            return .failed(reason: "无法读取 codex mcp list 的输出，无法确认 missiongo MCP 是否已配置。")
        }
        guard Paths.exists(location.skillPath) else {
            return .failed(reason: "Codex 里还没有 missiongo Skill（\(location.skillPath)）：MissionGo 会自动同步，稍后再派单。")
        }
        return .ok(version: version)
    }
}

/// The Codex adapter: starts one thread per dispatch in the ChatGPT app's
/// Codex, where the operator follows it from a Mac or the phone.
///
/// Like the Claude Code adapter, its job ends once the session is up: the
/// items move through MCP, not through this app.
public struct CodexLauncher: AgentAdapter {
    public let kind = "codex"

    let environment: ShellEnvironment
    let run: CommandRunner
    let location: CodexLocation
    let control: CodexControl
    /// The MissionGo server this machine is logged in to, for the MCP hint.
    let serverUrl: String?
    /// Only used to word a failure: see `CodexApp`.
    let appRunning: @Sendable () -> Bool

    public init(
        environment: ShellEnvironment,
        serverUrl: String?,
        run: CommandRunner? = nil,
        location: CodexLocation? = nil,
        control: CodexControl = CodexAppServerControl(),
        appRunning: @escaping @Sendable () -> Bool = CodexApp.isRunning
    ) {
        self.environment = environment
        self.serverUrl = serverUrl
        self.run = run ?? Commands.runner(environment: environment)
        self.location = location ?? CodexLocation(environment: environment)
        self.control = control
        self.appRunning = appRunning
    }

    public func detect() async -> String? {
        guard let binary = CodexLocation.binary(environment: environment) else { return nil }
        return await CodexPreflight.version(binary: binary, run: run)
    }

    public func launch(_ job: DispatchJob) async throws -> LaunchResult {
        guard let settings = CodexModes.threadSettings(for: job.mode) else {
            throw LaunchError("不支持的 Codex 模式：\(JSONValues.quote(job.mode))")
        }
        if case let .failed(reason) = await CodexPreflight.check(
            repoPath: job.repoPath, environment: environment, location: location, serverUrl: serverUrl, run: run,
            appRunning: appRunning
        ) {
            throw LaunchError(reason)
        }

        let prompt = try LaunchPrompt.build(
            itemKeys: job.itemKeys, dispatchId: job.dispatchId, mode: job.mode, reworkItemKeys: job.reworkItemKeys
        )
        let sessionName = SessionLauncher.sessionName(nodeName: job.nodeName, itemKeys: job.itemKeys, round: job.round)
        let threadId: String
        do {
            threadId = try await control.startThread(CodexThreadRequest(
                socketPath: location.controlSocketPath,
                cwd: job.repoPath,
                settings: settings,
                name: sessionName,
                prompt: prompt
            ))
        } catch {
            throw LaunchError(error.localizedDescription)
        }
        return LaunchResult(sessionName: sessionName, sessionUrl: CodexProtocol.threadLink(threadId), logPath: nil)
    }
}
