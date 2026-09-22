import Foundation

/// The seam between the dispatch loop and whichever coding agent runs the work.
///
/// The loop only knows how to claim a dispatch, start something and report
/// back; everything specific to one agent — how it is detected, what argv it
/// takes, how a session URL shows up — belongs behind this protocol.
public protocol AgentAdapter: Sendable {
    /// Matches `agentKind` on the wire, e.g. `claude_code`.
    var kind: String { get }
    /// `nil` when this agent is not installed on the machine.
    func detect() async -> String?
    /// Whether this adapter can safely accept a new dispatch right now.
    /// Temporary pressure must pause claiming, not turn queued work into a
    /// failed dispatch after the server has already handed it over.
    func dispatchAvailability() async -> AgentDispatchAvailability
    /// Throws with a human-readable reason; the loop reports it as the failure.
    func launch(_ job: DispatchJob) async throws -> LaunchResult
    /// Mirrors an already launched session and, when it is idle, delivers the
    /// one reply the server has queued for it.
    func synchronize(_ session: NodeAgentSession) async throws -> AgentSessionReport
}

public extension AgentAdapter {
    func dispatchAvailability() async -> AgentDispatchAvailability { .ready }

    func synchronize(_ session: NodeAgentSession) async throws -> AgentSessionReport {
        throw LaunchError("\(kind) does not support mirrored sessions.")
    }
}

public enum AgentDispatchAvailability: Equatable, Sendable {
    case ready
    case unavailable(reason: String)
}

/// What the server hands over for one dispatch. Item keys, mode and a
/// repository path — never a command line. What the session is actually told
/// to do is decided on this machine (see `LaunchPrompt`).
public struct DispatchJob: Equatable, Sendable {
    public let dispatchId: String
    public let itemKeys: [String]
    public let repoPath: String
    public let mode: String
    /// The machine name the session is named after (see `SessionLauncher.sessionName`).
    public let nodeName: String
    /// Which session on these items this is; past 1 it goes into the session name.
    public let round: Int
    /// Items sent back after their work was handed over (see `LaunchPrompt`).
    public let reworkItemKeys: [String]

    public init(
        dispatchId: String,
        itemKeys: [String],
        repoPath: String,
        mode: String,
        nodeName: String,
        round: Int = 1,
        reworkItemKeys: [String] = []
    ) {
        self.dispatchId = dispatchId
        self.itemKeys = itemKeys
        self.repoPath = repoPath
        self.mode = mode
        self.nodeName = nodeName
        self.round = round
        self.reworkItemKeys = reworkItemKeys
    }
}

public struct LaunchResult: Equatable, Sendable {
    public let sessionName: String
    /// Absent only when the adapter has another positive acknowledgement that
    /// the session exists but cannot turn its identifier into a link. Claude
    /// Code has no such acknowledgement, so its launcher does not return until
    /// it has scraped the remote-control URL.
    public let sessionUrl: String?
    /// The agent-native identifier used for later reads and replies. It is not
    /// inferred from the human-facing URL.
    public let sessionRef: String?
    /// Absent for an agent whose session is not a child process of this app
    /// (Codex runs its threads inside the ChatGPT app).
    public let logPath: String?

    public init(sessionName: String, sessionUrl: String?, sessionRef: String? = nil, logPath: String?) {
        self.sessionName = sessionName
        self.sessionUrl = sessionUrl
        self.sessionRef = sessionRef
        self.logPath = logPath
    }
}

public struct LaunchError: Error, Equatable, LocalizedError {
    public let message: String

    public init(_ message: String) {
        self.message = message
    }

    public var errorDescription: String? {
        return message
    }
}

public struct LaunchCommand: Equatable, Sendable {
    public let file: String
    public let args: [String]
}

/// The Claude Code adapter: starts one remote-controllable session per dispatch
/// and exchanges user-visible messages with its detached local host. The same
/// session remains interactive on claude.ai and a phone; approvals stay there.
public struct SessionLauncher: AgentAdapter {
    /// A cold CLI may legitimately take more than a minute. Three minutes is
    /// the approved startup watchdog; the work prompt is not sent before this
    /// handshake completes, so timing out cannot interrupt real work.
    public static let sessionUrlTimeout: TimeInterval = 3 * 60
    static let sessionUrlPollInterval: UInt64 = 500_000_000

    public let kind = "claude_code"

    static func activityTimestamp(_ date: Date) -> String {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter.string(from: date)
    }

    let environment: ShellEnvironment
    let run: CommandRunner
    let home: String
    let logsDirectory: String
    let sessionUrlTimeout: TimeInterval
    let hostExecutable: String?
    let sessionsDirectory: String

    public init(
        environment: ShellEnvironment,
        run: CommandRunner? = nil,
        home: String = Paths.homeDirectory(),
        logsDirectory: String? = nil,
        sessionUrlTimeout: TimeInterval = SessionLauncher.sessionUrlTimeout,
        hostExecutable: String? = ClaudeHostLocation.executable(),
        sessionsDirectory: String? = nil
    ) {
        self.environment = environment
        self.run = run ?? Commands.runner(environment: environment)
        self.home = home
        self.logsDirectory = logsDirectory ?? SessionLauncher.defaultLogsDirectory(home: home)
        self.sessionUrlTimeout = sessionUrlTimeout
        self.hostExecutable = hostExecutable
        self.sessionsDirectory = sessionsDirectory ?? ClaudeHostStore.defaultRoot(home: home)
    }

    /// `~/Library/Logs/MissionGo`, where Console.app looks for an app's logs.
    public static func defaultLogsDirectory(home: String = Paths.homeDirectory()) -> String {
        return "\(home)/Library/Logs/MissionGo"
    }

    /// Used when the machine name is blank, so a session is never named `-HG-49`.
    public static let fallbackNodeName = "MissionGo"
    /// Past this many characters the key list stops and says how many there were.
    /// A cap on characters rather than on items: a batch of six should be
    /// readable in full, and it is length, not count, that makes a name unusable.
    static let sessionNameKeyLength = 40

    /// `HG-52` as `("HG", "52")`; nil when the key is not `<prefix>-<digits>`,
    /// and such a key is then never abbreviated.
    static func splitItemKey(_ key: String) -> (prefix: String, number: String)? {
        guard let dash = key.lastIndex(of: "-") else { return nil }
        let number = key[key.index(after: dash)...]
        let prefix = key[key.startIndex..<dash]
        guard !number.isEmpty, !prefix.isEmpty else { return nil }
        guard number.allSatisfy({ $0.isASCII && $0.isNumber }) else { return nil }
        return (String(prefix), String(number))
    }

    /// e.g. `HG-52,51,50,48+AND-43` — a run of items from one product writes the
    /// prefix once and then only the numbers, so a batch of six reads as six
    /// numbers instead of six repetitions of `HG-`. A new prefix starts a new
    /// run, written in full after a `+`.
    ///
    /// Order is the order the dispatch carried; nothing is sorted here.
    static func itemKeyList(_ itemKeys: [String]) -> String {
        var pieces: [String] = []
        var runPrefix: String?
        for key in itemKeys {
            let parts = splitItemKey(key)
            if let parts, !pieces.isEmpty, parts.prefix == runPrefix {
                pieces.append(",\(parts.number)")
            } else {
                pieces.append(pieces.isEmpty ? key : "+\(key)")
                runPrefix = parts?.prefix
            }
        }
        guard var list = pieces.first else { return "" }
        // The first key is always written in full, however long it is: a name
        // that says only "等 N 条" would not tell two sessions apart.
        for piece in pieces.dropFirst() {
            if list.count + piece.count > sessionNameKeyLength {
                return "\(list) 等 \(itemKeys.count) 条"
            }
            list += piece
        }
        return list
    }

    /// e.g. `Mac mini-AND-37,38` — the whole batch is one session.
    ///
    /// The machine comes first because that is what tells sessions apart in
    /// claude.ai/code once several Macs take dispatches: every one of them used
    /// to start with the same `MissionGo`.
    ///
    /// A second session on the same items, such as after a failed verification,
    /// ends in ` 第2轮`; otherwise it would carry exactly the first one's name.
    public static func sessionName(nodeName: String, itemKeys: [String], round: Int = 1) -> String {
        let trimmed = nodeName.trimmingCharacters(in: .whitespacesAndNewlines)
        let machine = trimmed.isEmpty ? fallbackNodeName : trimmed
        let suffix = round > 1 ? " 第\(round)轮" : ""
        return "\(machine)-\(itemKeyList(itemKeys))\(suffix)"
    }

    /// The log of one dispatch, named after the dispatch id. The id arrives over
    /// the wire, so anything that could climb out of the log directory is
    /// replaced instead of trusted.
    public static func logPath(for dispatchId: String, in directory: String) -> String {
        let safe = String(dispatchId.unicodeScalars.map { scalar -> Character in
            let isSafe = (scalar.isASCII && CharacterSet.alphanumerics.contains(scalar)) || scalar == "_" || scalar == "-"
            return isSafe ? Character(scalar) : "_"
        })
        return "\(directory)/\(safe).log"
    }

    /// The exact command that starts a session.
    ///
    /// Three details are load-bearing, all of them verified on a real machine:
    ///
    /// - `script -q /dev/null` hands the CLI a pty. Started from an app there is
    ///   no TTY, and without the wrapper the session never comes up.
    /// - `--no-chrome` is required. Without it a first run stops on the "Claude
    ///   in Chrome extension detected" prompt, with nobody there to answer it.
    /// - the arguments stay an array and never touch a shell, so an item key or
    ///   a prompt cannot become shell syntax.
    ///
    /// Deliberately no `-w`: the session starts in the repository's own
    /// directory. Claude Code files sessions by working directory and a worktree
    /// is filed as a separate project, so a session started in one is missing
    /// from `/resume` in the repository it belongs to. The prompt tells the
    /// session to create its own worktree before editing — decided by the
    /// session rather than imposed by the launcher.
    public static func launchCommand(sessionName: String, mode: String, prompt: String) throws -> LaunchCommand {
        guard ClaudeCodeModes.isAllowed(mode) else {
            throw LaunchError("不支持的 Claude Code 模式：\(JSONValues.quote(mode))")
        }
        return LaunchCommand(
            file: "script",
            args: [
                "-q",
                "/dev/null",
                "claude",
                "--no-chrome",
                "--remote-control",
                sessionName,
                "--permission-mode",
                mode,
                "-n",
                sessionName,
                prompt,
            ]
        )
    }

    private static let sessionUrlPattern = try! NSRegularExpression(
        pattern: "https://claude\\.ai/code/session_[A-Za-z0-9_-]+"
    )

    /// The session URL as it appears in the log once remote control is up, on
    /// the same lines as `/remote-control is active`. Scraping the log is the
    /// only way to learn it: the CLI prints it for the human, there is no
    /// machine-readable hand-off.
    public static func scrapeSessionUrl(_ logText: String) -> String? {
        let range = NSRange(logText.startIndex..<logText.endIndex, in: logText)
        guard let match = sessionUrlPattern.firstMatch(in: logText, range: range),
              let matched = Range(match.range, in: logText)
        else { return nil }
        return String(logText[matched])
    }

    static func readLog(_ path: String) -> String {
        // The CLI may not have written anything yet; `script` also passes raw
        // terminal bytes through, so decoding must not give up on them.
        guard let data = FileManager.default.contents(atPath: path) else { return "" }
        return String(decoding: data, as: UTF8.self)
    }

    /// The tail of the log, for a failure the operator has to diagnose.
    static func logTail(_ path: String, lines: Int = 12) -> String {
        var text = readLog(path)
        while let last = text.last, last.isWhitespace {
            text.removeLast()
        }
        if text.isEmpty { return "（日志为空）" }
        return text.split(separator: "\n", omittingEmptySubsequences: false).suffix(lines).joined(separator: "\n")
    }

    // MARK: AgentAdapter

    public func detect() async -> String? {
        return await Preflight.claudeVersion(run: run)
    }

    public func launch(_ job: DispatchJob) async throws -> LaunchResult {
        guard hostExecutable != nil else { return try await launchLegacy(job) }
        do {
            return try await launchHosted(job)
        } catch let error as HostedLaunchError {
            switch error {
            case .unsupported:
                // Remote control was rejected before the work prompt was sent,
                // so starting the established PTY launcher cannot duplicate work.
                return try await launchLegacy(job)
            case let .failed(message):
                throw LaunchError(message)
            }
        }
    }

    private enum HostedLaunchError: Error {
        case unsupported(String)
        case failed(String)
    }

    private func startHost(configPath: String, logPath: String) throws -> Process {
        guard let hostExecutable else { throw LaunchError("MissionGo 缺少 Claude 会话宿主。") }
        let descriptor = open(logPath, O_WRONLY | O_APPEND | O_CREAT, 0o600)
        guard descriptor >= 0 else {
            throw LaunchError("无法写入日志 \(logPath)：\(String(cString: strerror(errno)))")
        }
        let logHandle = FileHandle(fileDescriptor: descriptor, closeOnDealloc: true)
        defer { try? logHandle.close() }

        let process = Process()
        process.executableURL = URL(fileURLWithPath: hostExecutable)
        process.arguments = [configPath]
        process.environment = ClaudeProcessEnvironment.unattended(environment.environment)
        process.standardInput = FileHandle.nullDevice
        process.standardOutput = FileHandle.nullDevice
        process.standardError = logHandle
        try process.run()
        return process
    }

    private func launchHosted(_ job: DispatchJob) async throws -> LaunchResult {
        if case let .failed(reason) = await Preflight.check(repoPath: job.repoPath, run: run, home: home) {
            throw LaunchError(reason)
        }

        let prompt = try LaunchPrompt.build(
            itemKeys: job.itemKeys, dispatchId: job.dispatchId, mode: job.mode, reworkItemKeys: job.reworkItemKeys
        )
        let sessionName = SessionLauncher.sessionName(nodeName: job.nodeName, itemKeys: job.itemKeys, round: job.round)
        guard ClaudeCodeModes.isAllowed(job.mode) else {
            throw LaunchError("不支持的 Claude Code 模式：\(JSONValues.quote(job.mode))")
        }
        guard let claudeExecutable = environment.which("claude") else {
            throw LaunchError("无法启动 claude：在 PATH 中找不到它（\(environment.path)）")
        }
        let sessionRef = UUID().uuidString.lowercased()
        let sessionDirectory = ClaudeHostStore.sessionDirectory(root: sessionsDirectory, sessionRef: sessionRef)
        let commandsDirectory = "\(sessionDirectory)/commands"
        let logPath = SessionLauncher.logPath(for: job.dispatchId, in: logsDirectory)
        try FileManager.default.createDirectory(
            atPath: logsDirectory,
            withIntermediateDirectories: true,
            attributes: [.posixPermissions: 0o700]
        )
        try FileManager.default.createDirectory(
            atPath: commandsDirectory,
            withIntermediateDirectories: true,
            attributes: [.posixPermissions: 0o700]
        )
        let statePath = ClaudeHostStore.statePath(root: sessionsDirectory, sessionRef: sessionRef)
        let configPath = ClaudeHostStore.configPath(root: sessionsDirectory, sessionRef: sessionRef)
        try ClaudeHostFiles.write(ClaudeHostConfiguration(
            claudeExecutable: claudeExecutable,
            cwd: job.repoPath,
            mode: job.mode,
            sessionName: sessionName,
            sessionRef: sessionRef,
            prompt: prompt,
            statePath: statePath,
            commandsDirectory: commandsDirectory,
            logPath: logPath
        ), to: configPath)

        let process: Process
        do {
            process = try startHost(configPath: configPath, logPath: logPath)
        } catch {
            throw HostedLaunchError.failed("无法启动 Claude 会话宿主：\(error.localizedDescription)")
        }

        let deadline = Date().addingTimeInterval(sessionUrlTimeout)
        while Date() < deadline {
            if let state = try? ClaudeHostFiles.readState(statePath) {
                if let url = state.sessionUrl {
                    return LaunchResult(
                        sessionName: sessionName,
                        sessionUrl: url,
                        sessionRef: sessionRef,
                        logPath: logPath
                    )
                }
                if state.status == "failed" {
                    throw HostedLaunchError.unsupported(state.error ?? "Claude Code 无法建立受控 Remote Control 会话。")
                }
            }
            if !process.isRunning {
                throw HostedLaunchError.unsupported(
                    "Claude 会话宿主已退出（code=\(process.terminationStatus)），会话没有启动。日志 \(logPath)：\n\(SessionLauncher.logTail(logPath))"
                )
            }
            if Task.isCancelled { break }
            try? await Task.sleep(nanoseconds: SessionLauncher.sessionUrlPollInterval)
        }
        let seconds = max(0, Int(sessionUrlTimeout.rounded(.up)))
        // The prompt is sent only after the URL is persisted. Check once more
        // at the deadline before stopping a host that might have completed the
        // handshake between the last poll and this branch.
        if let state = try? ClaudeHostFiles.readState(statePath), let url = state.sessionUrl {
            return LaunchResult(sessionName: sessionName, sessionUrl: url, sessionRef: sessionRef, logPath: logPath)
        }
        if process.isRunning { ClaudeHostProcess.terminateGroup(process.processIdentifier) }
        throw HostedLaunchError.failed(
            "等待 Claude Code 建立受控远程会话超时（\(seconds) 秒），未启动第二个会话。日志 \(logPath)：\n\(SessionLauncher.logTail(logPath))"
        )
    }

    private func launchLegacy(_ job: DispatchJob) async throws -> LaunchResult {
        if case let .failed(reason) = await Preflight.check(repoPath: job.repoPath, run: run, home: home) {
            throw LaunchError(reason)
        }

        let prompt = try LaunchPrompt.build(
            itemKeys: job.itemKeys, dispatchId: job.dispatchId, mode: job.mode, reworkItemKeys: job.reworkItemKeys
        )
        let sessionName = SessionLauncher.sessionName(nodeName: job.nodeName, itemKeys: job.itemKeys, round: job.round)
        let command = try SessionLauncher.launchCommand(sessionName: sessionName, mode: job.mode, prompt: prompt)

        let logPath = SessionLauncher.logPath(for: job.dispatchId, in: logsDirectory)
        try FileManager.default.createDirectory(
            atPath: logsDirectory,
            withIntermediateDirectories: true,
            attributes: [.posixPermissions: 0o700]
        )
        let descriptor = open(logPath, O_WRONLY | O_APPEND | O_CREAT, 0o600)
        guard descriptor >= 0 else {
            throw LaunchError("无法写入日志 \(logPath)：\(String(cString: strerror(errno)))")
        }
        let logHandle = FileHandle(fileDescriptor: descriptor, closeOnDealloc: true)
        defer { try? logHandle.close() }

        guard let executable = environment.which(command.file) else {
            throw LaunchError("无法启动 \(command.file)：在 PATH 中找不到它（\(environment.path)）")
        }

        let exitCode = Locked<Int32?>(nil)
        let process = Process()
        process.executableURL = URL(fileURLWithPath: executable)
        process.arguments = command.args
        process.currentDirectoryURL = URL(fileURLWithPath: job.repoPath, isDirectory: true)
        process.environment = ClaudeProcessEnvironment.unattended(environment.environment)
        process.standardInput = FileHandle.nullDevice
        process.standardOutput = logHandle
        process.standardError = logHandle
        process.terminationHandler = { finished in
            exitCode.withLock { $0 = finished.terminationStatus }
        }
        do {
            try process.run()
        } catch {
            throw LaunchError("无法启动 \(command.file)：\(error.localizedDescription)")
        }

        let deadline = Date().addingTimeInterval(sessionUrlTimeout)
        while Date() < deadline {
            if let url = SessionLauncher.scrapeSessionUrl(SessionLauncher.readLog(logPath)) {
                return LaunchResult(sessionName: sessionName, sessionUrl: url, logPath: logPath)
            }
            if let code = exitCode.current {
                throw LaunchError(
                    "claude 进程已退出（code=\(code)），会话没有启动。日志 \(logPath)：\n\(SessionLauncher.logTail(logPath))"
                )
            }
            if Task.isCancelled { break }
            try? await Task.sleep(nanoseconds: SessionLauncher.sessionUrlPollInterval)
        }
        let seconds = max(0, Int(sessionUrlTimeout.rounded(.up)))
        if process.isRunning { process.terminate() }
        throw LaunchError(
            "等待 Claude Code 生成远程会话地址超时（\(seconds) 秒），无法确认会话已创建。日志 \(logPath)：\n\(SessionLauncher.logTail(logPath))"
        )
    }

    public func synchronize(_ session: NodeAgentSession) async throws -> AgentSessionReport {
        guard UUID(uuidString: session.sessionRef) != nil else {
            throw LaunchError("Claude 会话编号无效。")
        }
        let statePath = ClaudeHostStore.statePath(root: sessionsDirectory, sessionRef: session.sessionRef)
        var state = try ClaudeHostFiles.readState(statePath)
        if session.lifecycle == "close" {
            if let hostPid = state.hostPid { ClaudeHostProcess.terminateGroup(hostPid) }
            state.status = "suspended"
            state.hostPid = nil
            state.idleSince = nil
            state.error = "关联工作条目已全部完成，会话进程已关闭；如需返工请重新派单。"
            state.lastProgressAt = Date()
            try ClaudeHostFiles.write(state, to: statePath)
            return AgentSessionReport(
                status: state.status,
                messages: state.messages,
                activities: state.activities,
                error: state.error,
                sessionUrl: state.sessionUrl,
                activityAt: SessionLauncher.activityTimestamp(state.lastProgressAt)
            )
        }
        // Hosts created before lifecycle tracking did not persist a PID. Keep
        // those sessions replyable until they write a PID-bearing state; only
        // an explicit suspension or a known dead/wrong process is unavailable.
        let hostRunning = state.hostPid.map(ClaudeHostProcess.isClaudeHost) ?? (state.status != "suspended")
        if !hostRunning {
            if state.status == "suspended", let command = session.command, command.kind == "message" {
                if command.status == "queued" {
                    return AgentSessionReport(
                        status: state.status,
                        messages: state.messages,
                        activities: state.activities,
                        error: state.error,
                        commandId: command.id,
                        commandStatus: "delivering",
                        sessionUrl: state.sessionUrl,
                        activityAt: SessionLauncher.activityTimestamp(state.lastProgressAt)
                    )
                }
                let configPath = ClaudeHostStore.configPath(root: sessionsDirectory, sessionRef: session.sessionRef)
                let config = try JSONDecoder().decode(
                    ClaudeHostConfiguration.self,
                    from: Data(contentsOf: URL(fileURLWithPath: configPath))
                )
                _ = try startHost(configPath: configPath, logPath: config.logPath)
                return AgentSessionReport(
                    status: state.status,
                    messages: state.messages,
                    activities: state.activities,
                    error: "正在恢复 Claude Code 会话…",
                    sessionUrl: state.sessionUrl,
                    activityAt: SessionLauncher.activityTimestamp(state.lastProgressAt)
                )
            }
            return AgentSessionReport(
                status: "unavailable",
                messages: state.messages,
                activities: state.activities,
                error: "Claude Code 会话宿主已停止；请在外部 Remote Control 会话中继续，或重新派单。",
                sessionUrl: state.sessionUrl,
                activityAt: SessionLauncher.activityTimestamp(state.lastProgressAt)
            )
        }
        guard let command = session.command else {
            return AgentSessionReport(
                status: state.status, messages: state.messages, activities: state.activities,
                error: state.error, sessionUrl: state.sessionUrl,
                activityAt: SessionLauncher.activityTimestamp(state.lastProgressAt)
            )
        }
        if let result = state.commandResults[command.id] {
            return AgentSessionReport(
                status: state.status,
                messages: state.messages,
                activities: state.activities,
                error: state.error,
                commandId: command.id,
                commandStatus: result.status,
                commandError: result.error,
                sessionUrl: state.sessionUrl,
                activityAt: SessionLauncher.activityTimestamp(state.lastProgressAt)
            )
        }
        if command.kind == "interrupt", !["active", "stalled"].contains(state.status) {
            return AgentSessionReport(
                status: state.status,
                messages: state.messages,
                activities: state.activities,
                error: state.error,
                commandId: command.id,
                commandStatus: "delivered",
                sessionUrl: state.sessionUrl,
                activityAt: SessionLauncher.activityTimestamp(state.lastProgressAt)
            )
        }
        if command.kind == "message", ["active", "stalled"].contains(state.status), !state.waitingForInput {
            return AgentSessionReport(
                status: state.status, messages: state.messages, activities: state.activities,
                error: state.error, sessionUrl: state.sessionUrl,
                activityAt: SessionLauncher.activityTimestamp(state.lastProgressAt)
            )
        }
        if command.kind == "message", command.status == "queued" {
            return AgentSessionReport(
                status: state.status,
                messages: state.messages,
                activities: state.activities,
                error: state.error,
                commandId: command.id,
                commandStatus: "delivering",
                sessionUrl: state.sessionUrl,
                activityAt: SessionLauncher.activityTimestamp(state.lastProgressAt)
            )
        }
        let safeCommandId = command.id.filter { $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "-") }
        guard safeCommandId == command.id, !safeCommandId.isEmpty else {
            throw LaunchError("Claude 命令编号无效。")
        }
        let path = ClaudeHostStore.commandPath(
            root: sessionsDirectory,
            sessionRef: session.sessionRef,
            commandId: safeCommandId
        )
        if !FileManager.default.fileExists(atPath: path) {
            try ClaudeHostFiles.write(
                ClaudeHostCommand(
                    id: command.id, kind: command.kind ?? "message", text: command.text,
                    createdAt: command.createdAt.isEmpty ? nil : command.createdAt
                ),
                to: path
            )
        }
        return AgentSessionReport(
            status: state.status, messages: state.messages, activities: state.activities,
            error: state.error, sessionUrl: state.sessionUrl,
            activityAt: SessionLauncher.activityTimestamp(state.lastProgressAt)
        )
    }
}
