import Darwin
import Foundation

public protocol CodexResourceChecking: Sendable {
    func unavailableReason(socketPath: String) async -> String?
    func snapshot(socketPath: String) async -> AgentResourceSnapshot?
}

public extension CodexResourceChecking {
    func snapshot(socketPath: String) async -> AgentResourceSnapshot? { nil }
}

/// The app-server opens files, sockets and subprocess pipes for every active
/// thread. macOS commonly gives GUI processes only 256 descriptors; keeping a
/// reserve prevents the next MCP startup from crossing that hard boundary.
public struct CodexFileDescriptorGuard: CodexResourceChecking {
    public static let minimumReserve = 64
    /// The official managed daemon raises RLIMIT_NOFILE before exec and records
    /// its PID and startup time in app-server.pid. Some CLI releases also
    /// include an executable digest. Never apply this contract to an unrelated
    /// process merely because it owns a similarly named socket.
    static let managedDaemonSoftLimit = 4096

    private let run: CommandRunner
    private let managedStatePath: String
    private let softLimit: @Sendable (Int32) -> Int?
    private let openFiles: @Sendable (Int32) -> Int?

    public init(
        environment: ShellEnvironment,
        location: CodexLocation? = nil,
        home: String = Paths.homeDirectory()
    ) {
        let resolvedLocation = location ?? CodexLocation(environment: environment, home: home)
        let statePath = "\(resolvedLocation.codexHome)/app-server-daemon/app-server.pid"
        self.init(
            run: Commands.runner(environment: environment),
            softLimit: { pid in
                guard let data = FileManager.default.contents(atPath: statePath) else { return nil }
                return Self.verifiedManagedSoftLimit(ownerPID: pid, stateData: data)
            },
            openFiles: { Self.processOpenFileCount($0) },
            managedStatePath: statePath
        )
    }

    init(
        run: @escaping CommandRunner,
        softLimit: @escaping @Sendable (Int32) -> Int?,
        openFiles: @escaping @Sendable (Int32) -> Int?,
        managedStatePath: String = "managed-daemon-state"
    ) {
        self.run = run
        self.softLimit = softLimit
        self.openFiles = openFiles
        self.managedStatePath = managedStatePath
    }

    public func unavailableReason(socketPath: String) async -> String? {
        let health = await snapshot(socketPath: socketPath)
        return health?.status == "unavailable" ? health?.reason : nil
    }

    public func snapshot(socketPath: String) async -> AgentResourceSnapshot? {
        let checkedAt = ISO8601DateFormatter().string(from: Date())
        guard let pid = await ownerPID(socketPath: socketPath) else {
            return AgentResourceSnapshot(
                source: managedStatePath, checkedAt: checkedAt, status: "unavailable",
                reason: "无法核实 Codex managed daemon 的当前进程；MissionGo 已暂停 Codex 派单。"
            )
        }
        guard let limit = softLimit(pid) else {
            return AgentResourceSnapshot(
                pid: pid, source: managedStatePath, checkedAt: checkedAt, status: "unavailable",
                reason: "Codex managed daemon 状态凭据缺失、过期或与控制 socket 的 PID 不一致；MissionGo 已暂停派单。"
            )
        }
        guard let used = openFiles(pid) else {
            return AgentResourceSnapshot(
                pid: pid, softLimit: limit, source: managedStatePath, checkedAt: checkedAt, status: "unavailable",
                reason: "无法读取 Codex managed daemon 的文件描述符数量；MissionGo 已暂停派单。"
            )
        }
        let reason = Self.unavailableReason(openFiles: used, softLimit: limit)
        return AgentResourceSnapshot(
            pid: pid, openFiles: used, softLimit: limit, source: managedStatePath, checkedAt: checkedAt,
            status: reason == nil ? "ready" : "unavailable", reason: reason
        )
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
        if let pid = Self.socketOwnerPID(socketPath) { return pid }
        // Keep lsof as a compatibility fallback. It is not the primary probe:
        // resolving Codex's symlinked socket path can be denied from a GUI app
        // even while the socket itself is reachable.
        let result = await run("/usr/sbin/lsof", ["-n", "-a", "-U", "-Fpc", "--", socketPath])
        guard result.code == 0 else { return nil }
        return Self.ownerPID(fromLsof: result.stdout)
    }

    static func socketOwnerPID(_ path: String) -> Int32? {
        guard let socket = try? UnixSocket(path: path, timeout: 1) else { return nil }
        defer { socket.close() }
        return socket.peerPID()
    }

    static func verifiedManagedSoftLimit(ownerPID: Int32, stateData: Data) -> Int? {
        guard let object = try? JSONSerialization.jsonObject(with: stateData) as? [String: Any],
              let number = object["pid"] as? NSNumber,
              number.int64Value == Int64(ownerPID),
              let started = object["processStartTime"] as? String, !started.isEmpty
        else { return nil }

        // Codex CLI 0.154 no longer writes executableIdentity. The matched PID
        // still proves that this managed daemon owns the control socket. When
        // an older daemon does provide an identity, reject a malformed one.
        if let rawIdentity = object["executableIdentity"] {
            guard let identity = rawIdentity as? [String: Any],
                  let digest = identity["digest"] as? [Any], !digest.isEmpty
            else { return nil }
        }
        return managedDaemonSoftLimit
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
    public enum Result: Equatable, Sendable {
        case ok(version: String)
        case failed(LaunchError)
    }
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

    public static func restartDaemon(
        binary: String, location: CodexLocation, run: CommandRunner,
        wait: TimeInterval = 5, pollInterval: TimeInterval = 0.2
    ) async -> DaemonStart {
        let result = await run(binary, ["app-server", "daemon", "restart"])
        let deadline = Date().addingTimeInterval(wait)
        while true {
            if CodexLocation.controlChannelIsUp(location.controlSocketPath) { return .started }
            if Date() >= deadline { break }
            try? await Task.sleep(nanoseconds: UInt64(pollInterval * 1_000_000_000))
        }
        let output = (result.stdout + "\n" + result.stderr).trimmingCharacters(in: .whitespacesAndNewlines)
        return .failed(output: "退出码 \(result.code)" + (output.isEmpty ? "，没有输出" : "：\(String(output.prefix(500)))"))
    }

    public enum DaemonStart: Equatable, Sendable {
        case alreadyUp
        case started
        /// Still nothing on the socket after the start command; what it said.
        case failed(output: String)
    }

    /// Start the daemon when nothing answers on the control socket.
    ///
    /// Nothing starts it after a reboot, and a dispatch arrives when nobody is
    /// at the machine to run the command, so a stopped daemon failed every
    /// Codex dispatch until someone came along. `daemon start` is safe to run
    /// here: it only starts a user process, answers `alreadyRunning` when there
    /// is one, and installs nothing — `daemon bootstrap`, which does install a
    /// launch agent, is left to the operator.
    ///
    /// Only callers that may already run `codex` call this: a dispatch, or a
    /// check the operator asked for. Never a heartbeat.
    public static func ensureDaemon(
        binary: String,
        location: CodexLocation,
        run: CommandRunner,
        wait: TimeInterval = 5,
        pollInterval: TimeInterval = 0.2
    ) async -> DaemonStart {
        let path = location.controlSocketPath
        if CodexLocation.controlChannelIsUp(path) { return .alreadyUp }
        let result = await run(binary, ["app-server", "daemon", "start"])
        // The command usually returns once the socket is up, but it is not
        // documented to, so give the listener a moment either way.
        let deadline = Date().addingTimeInterval(wait)
        while true {
            if CodexLocation.controlChannelIsUp(path) { return .started }
            if Date() >= deadline { break }
            try? await Task.sleep(nanoseconds: UInt64(pollInterval * 1_000_000_000))
        }
        let output = (result.stdout + "\n" + result.stderr).trimmingCharacters(in: .whitespacesAndNewlines)
        return .failed(output: "退出码 \(result.code)" + (output.isEmpty ? "，没有输出" : "：\(String(output.prefix(500)))"))
    }

    public static func check(
        repoPath: String,
        environment: ShellEnvironment,
        location: CodexLocation,
        serverUrl: String?,
        run: CommandRunner,
        daemonWait: TimeInterval = 5
    ) async -> Result {
        guard let binary = CodexLocation.binary(environment: environment),
              let version = await version(binary: binary, run: run)
        else {
            return .failed(LaunchError(
                "本机找不到可用的 codex 命令：确认已安装 ChatGPT App 或 Codex CLI。",
                failureCode: "cli_missing", failureStage: "preflight"
            ))
        }
        switch await isLoggedIn(binary: binary, run: run) {
        case true?: break
        case false?: return .failed(LaunchError(
            "Codex 未登录：在本机运行 codex login，或在 ChatGPT App 里登录后再派单。",
            failureCode: "agent_auth_invalid", failureStage: "preflight"
        ))
        case nil: return .failed(LaunchError(
            "无法读取 codex login status 的输出，无法确认登录状态。",
            failureCode: "agent_auth_invalid", failureStage: "preflight"
        ))
        }
        if let problem = Preflight.repositoryProblem(repoPath) {
            return .failed(LaunchError(problem, failureStage: "preflight"))
        }
        if case let .failed(output) = await ensureDaemon(binary: binary, location: location, run: run, wait: daemonWait) {
            return .failed(LaunchError(
                "连不上 Codex 的控制通道（\(location.controlSocketPath)）：它由 codex app-server daemon 提供，MissionGo 自动运行 \(daemonStartCommand) 后仍然没有连上（\(output)）。在本机终端运行这条命令查看原因。",
                failureCode: "daemon_down", failureStage: "daemon"
            ))
        }
        switch await mcpState(binary: binary, run: run) {
        case .ready: break
        case .missing:
            return .failed(LaunchError(
                "Codex 还没有配置 missiongo MCP：在终端运行 \(mcpSetupCommand(serverUrl: serverUrl))",
                failureCode: "mcp_auth", failureStage: "mcp"
            ))
        case .disabled:
            return .failed(LaunchError(
                "Codex 的 missiongo MCP 处于停用状态：在 ~/.codex/config.toml 里启用它。",
                failureCode: "mcp_auth", failureStage: "mcp"
            ))
        case .notLoggedIn:
            return .failed(LaunchError(
                "Codex 的 missiongo MCP 还没有登录：在终端运行 codex mcp login missiongo",
                failureCode: "mcp_auth", failureStage: "mcp"
            ))
        case .unreadable:
            return .failed(LaunchError(
                "无法读取 codex mcp list 的输出，无法确认 missiongo MCP 是否已配置。",
                failureCode: "mcp_auth", failureStage: "mcp"
            ))
        }
        guard Paths.exists(location.skillPath) else {
            return .failed(LaunchError(
                "Codex 里还没有 missiongo Skill（\(location.skillPath)）：MissionGo 会自动同步，稍后再派单。",
                failureCode: "skill_stale", failureStage: "readiness"
            ))
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
    /// How long a dispatch waits for a daemon it just started.
    let daemonWait: TimeInterval
    let modelCache: ModelListCache
    public init(
        environment: ShellEnvironment,
        serverUrl: String?,
        run: CommandRunner? = nil,
        location: CodexLocation? = nil,
        control: CodexControl = CodexAppServerControl(),
        resources: CodexResourceChecking? = nil,
        daemonWait: TimeInterval = 5,
        modelCacheTTL: TimeInterval = 10 * 60
    ) {
        self.environment = environment
        self.daemonWait = daemonWait
        self.modelCache = ModelListCache(ttl: modelCacheTTL)
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

    /// From the app-server's own `model/list`. Only asked when the control
    /// channel is already up: a heartbeat must never start the daemon. Any
    /// failure reuses the last list, else reports none rather than guessing.
    public func availableModels() async -> [AgentModelOption]? {
        if let fresh = modelCache.fresh() { return fresh }
        let socketPath = location.controlSocketPath
        guard CodexLocation.controlChannelIsUp(socketPath) else { return modelCache.last ?? [] }
        do {
            let models = try await control.listModels(socketPath: socketPath)
            modelCache.store(models)
            return models
        } catch {
            return modelCache.last ?? []
        }
    }

    public func dispatchAvailability() async -> AgentDispatchAvailability {
        if let reason = await resources.unavailableReason(socketPath: location.controlSocketPath) {
            return .unavailable(reason: reason)
        }
        return .ready
    }

    public func resourceSnapshot() async -> AgentResourceSnapshot? {
        return await resources.snapshot(socketPath: location.controlSocketPath)
    }

    public func launch(_ job: DispatchJob) async throws -> LaunchResult {
        guard let settings = CodexModes.threadSettings(for: job.mode) else {
            throw LaunchError("不支持的 Codex 模式：\(JSONValues.quote(job.mode))")
        }
        if let problem = AgentModelSettings.problem(model: job.model, effort: job.effort) {
            throw LaunchError(problem)
        }
        if case let .failed(error) = await CodexPreflight.check(
            repoPath: job.repoPath, environment: environment, location: location, serverUrl: serverUrl, run: run,
            daemonWait: daemonWait
        ) {
            throw error
        }
        if case let .unavailable(reason) = await dispatchAvailability() {
            throw LaunchError(reason, failureCode: "resource_exhausted", failureStage: "readiness")
        }

        let worktreePath = try CodexWorkspace.worktreePath(repoPath: job.repoPath, dispatchId: job.dispatchId)
        guard let skill = try? String(contentsOfFile: location.skillPath, encoding: .utf8),
              let skillVersion = SkillSync.version(ofSkill: skill) else {
            throw LaunchError(
                "无法读取 Codex 的 MissionGo Skill 版本，请等待 Skill 同步完成再派单。",
                failureCode: "skill_stale", failureStage: "readiness"
            )
        }
        let prompt = try LaunchPrompt.build(
            itemKeys: job.itemKeys, dispatchId: job.dispatchId, mode: job.mode, reworkItemKeys: job.reworkItemKeys,
            client: .codex, worktreePath: worktreePath
        )
        let sessionName = SessionLauncher.sessionName(nodeName: job.nodeName, itemKeys: job.itemKeys, round: job.round)
        let request = CodexThreadRequest(
            socketPath: location.controlSocketPath,
            cwd: job.repoPath,
            settings: settings,
            name: sessionName,
            prompt: prompt,
            workspaceRoots: [job.repoPath, worktreePath],
            skillVersion: skillVersion,
            model: job.model,
            effort: job.effort
        )
        let threadId: String
        do {
            threadId = try await control.startThread(request)
        } catch let error as CodexControlError {
            guard case let .mcpStartup(diagnostic) = error else {
                throw CodexFailure.launchError(error)
            }
            // A restart is destructive to every loaded conversation. If the
            // app-server cannot prove there are none, return this same dispatch
            // to the node queue and let the active work finish first.
            let hasLoadedThreads = (try? await control.hasLoadedThreads(socketPath: location.controlSocketPath)) ?? true
            if hasLoadedThreads {
                throw CodexFailure.retryableMcpError(error, diagnostic: diagnostic)
            }
            guard let binary = CodexLocation.binary(environment: environment) else {
                throw CodexFailure.retryableMcpError(error, diagnostic: diagnostic)
            }
            switch await CodexPreflight.restartDaemon(
                binary: binary, location: location, run: run, wait: daemonWait
            ) {
            case .started, .alreadyUp:
                do {
                    threadId = try await control.startThread(request)
                } catch {
                    throw CodexFailure.launchError(error)
                }
            case let .failed(output):
                throw LaunchError(
                    "Codex 的 MissionGo MCP 启动异常；安全重启 daemon 失败（\(output)）。任务将稍后重试。",
                    failureCode: "daemon_down", failureStage: "daemon", retryAfterSeconds: 30,
                    diagnosticSnapshot: DispatchDiagnosticSnapshot(mcp: diagnostic)
                )
            }
        } catch {
            throw CodexFailure.launchError(error)
        }
        return LaunchResult(
            sessionName: sessionName,
            sessionUrl: CodexProtocol.threadLink(threadId),
            sessionRef: threadId,
            logPath: nil
        )
    }

    public func synchronize(_ session: NodeAgentSession) async throws -> AgentSessionReport {
        let snapshot = try await control.readThread(socketPath: location.controlSocketPath, threadId: session.sessionRef)
        var model = snapshot.model
        var effort = snapshot.reasoningEffort
        var settingsRevision: Int?
        var settingsError: String?
        // Settings change only between turns: a running turn keeps what it
        // started with, so an active thread gets the change at a later idle poll.
        if let desired = session.pendingSettings, !session.archiveInSource, !snapshot.archived,
           snapshot.status == "idle" {
            settingsRevision = desired.revision
            do {
                let overrides = try CodexTurnOverrides(desired: desired)
                let applied = try await control.applySettings(
                    socketPath: location.controlSocketPath, threadId: session.sessionRef, overrides: overrides
                )
                model = applied.model ?? desired.model ?? model
                effort = applied.reasoningEffort ?? effort
            } catch {
                settingsError = CodexFailure.explain(error)
            }
        }
        let report = try await synchronize(session, snapshot: snapshot)
        return report.reportingSettings(
            model: model, effort: effort, settingsRevision: settingsRevision, settingsError: settingsError
        )
    }

    /// What a person chose for this thread, passed on every turn MissionGo
    /// starts. The server sends the desired settings on every poll, so this
    /// needs no memory of its own. A malformed value was already reported as
    /// a failed revision; the turn then goes ahead without it.
    private func turnOverrides(_ session: NodeAgentSession) -> CodexTurnOverrides? {
        guard let desired = session.desiredSettings else { return nil }
        return try? CodexTurnOverrides(desired: desired)
    }

    private func synchronize(_ session: NodeAgentSession, snapshot: CodexThreadSnapshot) async throws -> AgentSessionReport {
        var snapshot = snapshot
        if session.restoreInSource {
            // Restored in MissionGo: bring the thread back in Codex first, then
            // carry on with the fresh read so a queued reply can still go out.
            // A failure throws and is retried on the next poll.
            if snapshot.archived {
                try await control.unarchiveThread(socketPath: location.controlSocketPath, threadId: session.sessionRef)
                snapshot = try await control.readThread(socketPath: location.controlSocketPath, threadId: session.sessionRef)
            }
            let report = try await synchronize(
                NodeAgentSession(
                    id: session.id, dispatchId: session.dispatchId, agentKind: session.agentKind,
                    sessionRef: session.sessionRef, status: session.status, lifecycle: session.lifecycle,
                    occupiesExecutionSlot: session.occupiesExecutionSlot, command: session.command,
                    desiredSettings: session.desiredSettings, appliedSettingsRevision: session.appliedSettingsRevision
                ),
                snapshot: snapshot
            )
            return AgentSessionReport(
                status: report.status, messages: report.messages, activities: report.activities, error: report.error,
                commandId: report.commandId, commandStatus: report.commandStatus, commandError: report.commandError,
                sourceArchived: report.sourceArchived, sourceRestored: true,
                sessionUrl: report.sessionUrl, activityAt: report.activityAt
            )
        }
        if session.archiveInSource {
            // MissionGo archived this finished conversation; follow it at the
            // source. Report the thread as it was, without the "restore it in
            // Codex" error below: nobody is waiting on this conversation.
            if !snapshot.archived {
                do {
                    try await control.archiveThread(socketPath: location.controlSocketPath, threadId: session.sessionRef)
                } catch {
                    return AgentSessionReport(
                        status: snapshot.status, messages: snapshot.messages,
                        sourceArchiveError: CodexFailure.explain(error), activityAt: snapshot.activityAt
                    )
                }
            }
            return AgentSessionReport(
                status: snapshot.archived ? "idle" : snapshot.status, messages: snapshot.messages,
                sourceArchived: true, activityAt: snapshot.activityAt
            )
        }
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
                text: command.promptText,
                clientUserMessageId: command.id
            )
        } else {
            try await control.sendMessage(
                socketPath: location.controlSocketPath,
                threadId: session.sessionRef,
                text: command.promptText,
                clientUserMessageId: command.id,
                overrides: turnOverrides(session)
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
    static func retryableMcpError(
        _ error: CodexControlError, diagnostic: DispatchMcpDiagnostic
    ) -> LaunchError {
        return LaunchError(
            explain(error), failureCode: mcpFailureCode(diagnostic), failureStage: "mcp",
            retryAfterSeconds: 30, diagnosticSnapshot: DispatchDiagnosticSnapshot(mcp: diagnostic)
        )
    }

    private static func mcpFailureCode(_ diagnostic: DispatchMcpDiagnostic) -> String {
        if diagnostic.failureReason == "reauthenticationRequired"
            || diagnostic.runtimeStatus == "authenticationRequired"
            || diagnostic.authStatus == "notLoggedIn" { return "mcp_auth" }
        return "mcp_timeout"
    }

    static func launchError(_ error: Error) -> LaunchError {
        let message = explain(error)
        guard let control = error as? CodexControlError else {
            return LaunchError(message, failureStage: "thread_start")
        }
        switch control {
        case let .mcpStartup(diagnostic):
            return retryableMcpError(control, diagnostic: diagnostic)
        case .skillStale:
            return LaunchError(message, failureCode: "skill_stale", failureStage: "readiness")
        case .mcpAuthorization:
            return LaunchError(message, failureCode: "mcp_auth", failureStage: "mcp")
        case let .timedOut(method) where method == "mcpServer/tool/call":
            return LaunchError(message, failureCode: "mcp_timeout", failureStage: "mcp")
        case let .rpc(method, _) where method == "mcpServer/tool/call":
            return LaunchError(
                message,
                failureCode: isMissionGoStartupTimeout(control) ? "mcp_timeout" : "mcp_auth",
                failureStage: "mcp"
            )
        case .connect, .handshake, .closed:
            return LaunchError(message, failureCode: "daemon_down", failureStage: "daemon")
        default:
            return LaunchError(message, failureCode: "unknown", failureStage: "thread_start")
        }
    }

    private static func isMissionGoStartupTimeout(_ error: CodexControlError) -> Bool {
        guard case let .rpc(method, message) = error, method == "mcpServer/tool/call" else { return false }
        let normalized = message.lowercased()
        return normalized.contains("mcp startup failed") && normalized.contains("timed out")
    }

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
