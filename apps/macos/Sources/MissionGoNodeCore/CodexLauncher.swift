import Darwin
import Foundation

public protocol CodexResourceChecking: Sendable {
    /// Returns a reason only when pressure is positively identified. Probe
    /// failures fail open: normal preflight still protects the actual launch.
    func unavailableReason(socketPath: String) async -> String?
}

/// The app-server opens files, sockets and subprocess pipes for every active
/// thread. macOS commonly gives GUI processes only 256 descriptors; keeping a
/// reserve prevents the next MCP startup from crossing that hard boundary.
public struct CodexFileDescriptorGuard: CodexResourceChecking {
    public static let minimumReserve = 64
    static let launchAgentLabel = "com.missiongo.codex-app-server-limits"

    private let run: CommandRunner
    private let softLimit: @Sendable (Int32) -> Int?
    private let openFiles: @Sendable (Int32) -> Int?

    public init(
        environment: ShellEnvironment,
        location: CodexLocation? = nil,
        home: String = Paths.homeDirectory()
    ) {
        let resolvedLocation = location ?? CodexLocation(environment: environment, home: home)
        let launchAgentPath = "\(home)/Library/LaunchAgents/\(Self.launchAgentLabel).plist"
        let launchLogPath = "\(resolvedLocation.codexHome)/app-server-control/launch-agent.log"
        self.init(
            run: Commands.runner(environment: environment),
            softLimit: { pid in
                Self.verifiedSoftLimit(
                    ownerPID: pid,
                    launchAgentPath: launchAgentPath,
                    launchLogPath: launchLogPath
                )
            },
            openFiles: { Self.processOpenFileCount($0) }
        )
    }

    init(
        run: @escaping CommandRunner,
        softLimit: @escaping @Sendable (Int32) -> Int?,
        openFiles: @escaping @Sendable (Int32) -> Int?
    ) {
        self.run = run
        self.softLimit = softLimit
        self.openFiles = openFiles
    }

    public func unavailableReason(socketPath: String) async -> String? {
        guard let pid = await ownerPID(socketPath: socketPath),
              let used = openFiles(pid), let limit = softLimit(pid)
        else { return nil }
        return Self.unavailableReason(openFiles: used, softLimit: limit)
    }

    static func unavailableReason(openFiles: Int, softLimit: Int) -> String? {
        guard softLimit > minimumReserve,
              openFiles >= softLimit - minimumReserve else { return nil }
        return "Codex 后台服务文件描述符余量不足（已用 \(openFiles)/\(softLimit)，需保留至少 \(minimumReserve) 个）。"
            + "MissionGo 已将派单留在队列、不会启动失败；请先关闭不再使用的会话，"
            + "或在确认没有任务运行后执行 codex app-server daemon restart；恢复后会自动继续领取。"
    }

    static func ownerPID(fromLsof output: String) -> Int32? {
        for line in output.split(whereSeparator: \.isNewline) where line.first == "p" {
            if let pid = Int32(line.dropFirst()) { return pid }
        }
        return nil
    }

    private func ownerPID(socketPath: String) async -> Int32? {
        let result = await run("/usr/sbin/lsof", ["-n", "-a", "-U", "-Fpc", "--", socketPath])
        guard result.code == 0 else { return nil }
        return Self.ownerPID(fromLsof: result.stdout)
    }

    /// macOS does not expose another process's per-process `RLIMIT_NOFILE` to
    /// an ordinary caller. Reading MissionGo's own limit would compare values
    /// from two different processes and can falsely pause a healthy daemon.
    /// Trust the configured limit only when the launch receipt proves that the
    /// LaunchAgent started the exact PID currently owning the control socket.
    static func verifiedSoftLimit(ownerPID: Int32, launchAgentPath: String, launchLogPath: String) -> Int? {
        guard let log = tail(path: launchLogPath), lastStartedPID(fromLaunchLog: log) == ownerPID,
              let data = try? Data(contentsOf: URL(fileURLWithPath: launchAgentPath))
        else { return nil }
        return softLimit(fromLaunchAgentPlist: data)
    }

    static func softLimit(fromLaunchAgentPlist data: Data) -> Int? {
        guard let root = try? PropertyListSerialization.propertyList(from: data, format: nil),
              let dictionary = root as? [String: Any],
              dictionary["Label"] as? String == launchAgentLabel,
              let limits = dictionary["SoftResourceLimits"] as? [String: Any],
              let number = limits["NumberOfFiles"] as? NSNumber
        else { return nil }
        let value = number.intValue
        return value > minimumReserve ? value : nil
    }

    static func lastStartedPID(fromLaunchLog log: String) -> Int32? {
        for line in log.split(whereSeparator: \.isNewline).reversed() {
            guard let data = String(line).data(using: .utf8),
                  let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  object["status"] as? String == "started",
                  let number = object["pid"] as? NSNumber,
                  number.int64Value > 0, number.int64Value <= Int64(Int32.max)
            else { continue }
            return Int32(number.int64Value)
        }
        return nil
    }

    private static func tail(path: String, maximumBytes: UInt64 = 64 * 1024) -> String? {
        guard let handle = try? FileHandle(forReadingFrom: URL(fileURLWithPath: path)) else { return nil }
        defer { try? handle.close() }
        guard let size = try? handle.seekToEnd() else { return nil }
        let offset = size > maximumBytes ? size - maximumBytes : 0
        do {
            try handle.seek(toOffset: offset)
            return String(decoding: try handle.readToEnd() ?? Data(), as: UTF8.self)
        } catch {
            return nil
        }
    }

    private static func processOpenFileCount(_ pid: Int32) -> Int? {
        var info = proc_bsdinfo()
        let size = Int32(MemoryLayout.size(ofValue: info))
        guard proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &info, size) == size else { return nil }
        return Int(info.pbi_nfiles)
    }
}

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

    /// Created by `codex app-server daemon`, which is what MissionGo talks to.
    /// The ChatGPT app does not create it: it runs its own app-server over
    /// stdio, so an open app says nothing about this socket.
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

    /// What starts the app-server whose control socket a dispatch needs.
    public static let daemonStartCommand = "codex app-server daemon start"

    public static func check(
        repoPath: String,
        environment: ShellEnvironment,
        location: CodexLocation,
        serverUrl: String?,
        run: CommandRunner
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
            return .failed(reason: "连不上 Codex 的控制通道（\(location.controlSocketPath)）：它由 codex app-server daemon 提供，在本机运行 \(daemonStartCommand) 后再派单。")
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
    let resources: CodexResourceChecking
    /// The MissionGo server this machine is logged in to, for the MCP hint.
    let serverUrl: String?
    public init(
        environment: ShellEnvironment,
        serverUrl: String?,
        run: CommandRunner? = nil,
        location: CodexLocation? = nil,
        control: CodexControl = CodexAppServerControl(),
        resources: CodexResourceChecking? = nil
    ) {
        self.environment = environment
        self.serverUrl = serverUrl
        self.run = run ?? Commands.runner(environment: environment)
        let resolvedLocation = location ?? CodexLocation(environment: environment)
        self.location = resolvedLocation
        self.control = control
        self.resources = resources ?? CodexFileDescriptorGuard(environment: environment, location: resolvedLocation)
    }

    public func detect() async -> String? {
        guard let binary = CodexLocation.binary(environment: environment) else { return nil }
        return await CodexPreflight.version(binary: binary, run: run)
    }

    public func dispatchAvailability() async -> AgentDispatchAvailability {
        if let reason = await resources.unavailableReason(socketPath: location.controlSocketPath) {
            return .unavailable(reason: reason)
        }
        return .ready
    }

    public func launch(_ job: DispatchJob) async throws -> LaunchResult {
        guard let settings = CodexModes.threadSettings(for: job.mode) else {
            throw LaunchError("不支持的 Codex 模式：\(JSONValues.quote(job.mode))")
        }
        if case let .failed(reason) = await CodexPreflight.check(
            repoPath: job.repoPath, environment: environment, location: location, serverUrl: serverUrl, run: run
        ) {
            throw LaunchError(reason)
        }
        if case let .unavailable(reason) = await dispatchAvailability() {
            throw LaunchError(reason)
        }

        let worktreePath = try CodexWorkspace.worktreePath(repoPath: job.repoPath, dispatchId: job.dispatchId)
        guard let skill = try? String(contentsOfFile: location.skillPath, encoding: .utf8),
              let skillVersion = SkillSync.version(ofSkill: skill) else {
            throw LaunchError("无法读取 Codex 的 MissionGo Skill 版本，请等待 Skill 同步完成再派单。")
        }
        let prompt = try LaunchPrompt.build(
            itemKeys: job.itemKeys, dispatchId: job.dispatchId, mode: job.mode, reworkItemKeys: job.reworkItemKeys,
            client: .codex, worktreePath: worktreePath
        )
        let sessionName = SessionLauncher.sessionName(nodeName: job.nodeName, itemKeys: job.itemKeys, round: job.round)
        let threadId: String
        do {
            threadId = try await control.startThread(CodexThreadRequest(
                socketPath: location.controlSocketPath,
                cwd: job.repoPath,
                settings: settings,
                name: sessionName,
                prompt: prompt,
                workspaceRoots: [job.repoPath, worktreePath],
                skillVersion: skillVersion
            ))
        } catch {
            throw LaunchError(CodexFailure.explain(error))
        }
        return LaunchResult(
            sessionName: sessionName,
            sessionUrl: CodexProtocol.threadLink(threadId),
            sessionRef: threadId,
            logPath: nil
        )
    }

    public func synchronize(_ session: NodeAgentSession) async throws -> AgentSessionReport {
        var snapshot = try await control.readThread(socketPath: location.controlSocketPath, threadId: session.sessionRef)
        if snapshot.archived {
            return AgentSessionReport(
                status: "unavailable",
                messages: snapshot.messages,
                error: "Codex 会话已在来源端归档；请在 Codex 中恢复后继续。",
                commandId: session.command?.id,
                commandStatus: session.command == nil ? nil : "failed",
                commandError: session.command == nil ? nil : "Codex 会话已归档，命令未发送。",
                sourceArchived: true,
                activityAt: snapshot.activityAt
            )
        }
        guard let command = session.command else {
            return AgentSessionReport(
                status: snapshot.status, messages: snapshot.messages,
                sourceArchived: false, activityAt: snapshot.activityAt
            )
        }
        if command.kind == "interrupt" {
            // The turn may have finished between the web click and this poll. In
            // that case the requested outcome is already true, so acknowledge
            // the command instead of leaving an impossible interrupt queued.
            if snapshot.status == "active" {
                guard let turnId = command.turnId else {
                    throw LaunchError("终止命令缺少 Codex turn id，未执行中断。")
                }
                try await control.interruptTurn(
                    socketPath: location.controlSocketPath,
                    threadId: session.sessionRef,
                    turnId: turnId
                )
                snapshot = CodexThreadSnapshot(
                    status: "idle", messages: snapshot.messages, activityAt: snapshot.activityAt
                )
            }
            return AgentSessionReport(
                status: snapshot.status,
                messages: snapshot.messages,
                commandId: command.id,
                commandStatus: "delivered",
                sourceArchived: false,
                activityAt: snapshot.activityAt
            )
        }
        // An active ordinary turn accepts same-turn steering. Older app-server
        // snapshots that do not identify the active turn keep the reply queued
        // and fall back to turn/start once the thread becomes idle.
        let canDeliver = snapshot.status == "idle"
            || (snapshot.status == "active" && snapshot.activeTurnId != nil)
        guard canDeliver else {
            return AgentSessionReport(
                status: snapshot.status, messages: snapshot.messages,
                sourceArchived: false, activityAt: snapshot.activityAt
            )
        }
        // Reserve the queued reply on the server before sending it. A person can
        // cancel only while it is still queued; once this acknowledgement wins,
        // the console says it is being delivered and no longer promises a
        // cancellation that could race the actual turn/start call below.
        if command.status == "queued" {
            return AgentSessionReport(
                status: snapshot.status,
                messages: snapshot.messages,
                commandId: command.id,
                commandStatus: "delivering",
                sourceArchived: false,
                activityAt: snapshot.activityAt
            )
        }
        guard command.status == "delivering" else {
            return AgentSessionReport(
                status: snapshot.status, messages: snapshot.messages,
                sourceArchived: false, activityAt: snapshot.activityAt
            )
        }
        if let activeTurnId = snapshot.activeTurnId, snapshot.status == "active" {
            try await control.steerMessage(
                socketPath: location.controlSocketPath,
                threadId: session.sessionRef,
                turnId: activeTurnId,
                text: command.text,
                clientUserMessageId: command.id
            )
        } else {
            try await control.sendMessage(
                socketPath: location.controlSocketPath,
                threadId: session.sessionRef,
                text: command.text,
                clientUserMessageId: command.id
            )
            snapshot = CodexThreadSnapshot(
                status: "active", messages: snapshot.messages, activityAt: snapshot.activityAt
            )
        }
        return AgentSessionReport(
            status: snapshot.status,
            messages: snapshot.messages,
            commandId: command.id,
            commandStatus: "delivered",
            sourceArchived: false,
            activityAt: snapshot.activityAt
        )
    }
}

enum CodexFailure {
    static func explain(_ error: Error) -> String {
        let message = error.localizedDescription
        let lower = message.lowercased()
        if lower.contains("too many open files") {
            return "Codex 后台服务的文件描述符已经耗尽，任务尚未启动。请先关闭不再使用的会话，"
                + "或在确认没有任务运行后执行 codex app-server daemon restart。"
        }
        if lower.contains("mcp startup") && lower.contains("timed out") {
            return "Codex 的 MissionGo MCP 启动超时，任务尚未启动。请先运行 codex app-server daemon restart；"
                + "若仍出现，请检查 ~/.codex/app-server-control/app-server.log 与 MCP 登录状态。"
        }
        return message
    }
}
