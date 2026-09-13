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
    /// Throws with a human-readable reason; the loop reports it as the failure.
    func launch(_ job: DispatchJob) async throws -> LaunchResult
}

/// What the server hands over for one dispatch. Item keys, mode and a
/// repository path — never a command line. What the session is actually told
/// to do is decided on this machine (see `LaunchPrompt`).
public struct DispatchJob: Equatable, Sendable {
    public let dispatchId: String
    public let itemKeys: [String]
    public let repoPath: String
    public let mode: String

    public init(dispatchId: String, itemKeys: [String], repoPath: String, mode: String) {
        self.dispatchId = dispatchId
        self.itemKeys = itemKeys
        self.repoPath = repoPath
        self.mode = mode
    }
}

public struct LaunchResult: Equatable, Sendable {
    public let sessionName: String
    /// Absent when the session started but never printed its URL within the
    /// launch window; the log is then the only way to find the session.
    public let sessionUrl: String?
    public let logPath: String

    public init(sessionName: String, sessionUrl: String?, logPath: String) {
        self.sessionName = sessionName
        self.sessionUrl = sessionUrl
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

/// The Claude Code adapter: starts one remote-controllable session per dispatch.
///
/// The session is interactive on purpose — the operator approves the plan from
/// claude.ai or a phone — so this app's job ends once the session is up and
/// reachable. It does not supervise the work afterwards; the items move through
/// MCP like any other session.
public struct SessionLauncher: AgentAdapter {
    public static let sessionUrlTimeout: TimeInterval = 60
    static let sessionUrlPollInterval: UInt64 = 500_000_000

    public let kind = "claude_code"

    let environment: ShellEnvironment
    let run: CommandRunner
    let home: String
    let logsDirectory: String
    let sessionUrlTimeout: TimeInterval

    public init(
        environment: ShellEnvironment,
        run: CommandRunner? = nil,
        home: String = Paths.homeDirectory(),
        logsDirectory: String? = nil,
        sessionUrlTimeout: TimeInterval = SessionLauncher.sessionUrlTimeout
    ) {
        self.environment = environment
        self.run = run ?? Commands.runner(environment: environment)
        self.home = home
        self.logsDirectory = logsDirectory ?? SessionLauncher.defaultLogsDirectory(home: home)
        self.sessionUrlTimeout = sessionUrlTimeout
    }

    /// `~/Library/Logs/MissionGo`, where Console.app looks for an app's logs.
    public static func defaultLogsDirectory(home: String = Paths.homeDirectory()) -> String {
        return "\(home)/Library/Logs/MissionGo"
    }

    /// e.g. `MissionGo AND-37+AND-38` — the whole batch is one session.
    public static func sessionName(for itemKeys: [String]) -> String {
        return "MissionGo \(itemKeys.joined(separator: "+"))"
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
        if case let .failed(reason) = await Preflight.check(repoPath: job.repoPath, run: run, home: home) {
            throw LaunchError(reason)
        }

        let prompt = try LaunchPrompt.build(itemKeys: job.itemKeys, dispatchId: job.dispatchId)
        let sessionName = SessionLauncher.sessionName(for: job.itemKeys)
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

        // Exit status is recorded rather than thrown from the handler, for the
        // wait loop below to report.
        let exitCode = Locked<Int32?>(nil)
        let process = Process()
        process.executableURL = URL(fileURLWithPath: executable)
        process.arguments = command.args
        process.currentDirectoryURL = URL(fileURLWithPath: job.repoPath, isDirectory: true)
        process.environment = environment.environment
        process.standardInput = FileHandle.nullDevice
        process.standardOutput = logHandle
        process.standardError = logHandle
        process.terminationHandler = { finished in
            exitCode.withLock { $0 = finished.terminationStatus }
        }
        // The session must outlive this app: quitting MissionGo, logging out of
        // it or updating it never kills work already in progress. Nothing here
        // terminates the child, and `Process` starts it in its own process group,
        // so a signal aimed at the app's group does not reach it either.
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
            // The process dying before it printed a URL is the failure mode worth
            // reporting: the trust dialog and the login prompt both hang instead,
            // and the preflight above is what catches those.
            if let code = exitCode.current {
                throw LaunchError(
                    "claude 进程已退出（code=\(code)），会话没有启动。日志 \(logPath)：\n\(SessionLauncher.logTail(logPath))"
                )
            }
            // Cancelled: stop waiting, but the child keeps running and counts as
            // launched, exactly like a URL that did not show up in time.
            if Task.isCancelled { break }
            try? await Task.sleep(nanoseconds: SessionLauncher.sessionUrlPollInterval)
        }
        // Started, but no URL in time. Still launched: the session exists and can
        // be found in claude.ai/code by name.
        return LaunchResult(sessionName: sessionName, sessionUrl: nil, logPath: logPath)
    }
}
