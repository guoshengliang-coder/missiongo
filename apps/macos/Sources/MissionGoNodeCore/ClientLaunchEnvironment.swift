import Darwin
import Foundation

/// Only consent and file paths are persisted. Resolved credentials stay in memory.
public struct ClientLaunchSettings: Codable, Equatable, Sendable {
    public var automaticShell = false
    public var setupScript = ""
    public var executable = ""
    public init() {}

    public static func load(_ agent: LocalAgent, defaults: UserDefaults = .standard) -> Self {
        guard let data = defaults.data(forKey: "clientLaunchEnvironment.v1.\(agent.rawValue)"),
              let value = try? JSONDecoder().decode(Self.self, from: data) else { return Self() }
        return value
    }

    public func save(_ agent: LocalAgent, defaults: UserDefaults = .standard) {
        if let data = try? JSONEncoder().encode(self) {
            defaults.set(data, forKey: "clientLaunchEnvironment.v1.\(agent.rawValue)")
        }
    }

    public func resolve(agent: LocalAgent, base: ShellEnvironment, cwd: String? = nil) async throws -> ShellEnvironment {
        let settings = self
        return try await Task.detached {
            var values = base.environment
            if settings.automaticShell {
                values = try ShellEnvironment.exportedEnvironment(base: values, setupScript: settings.setupScript, cwd: cwd)
            } else if !settings.setupScript.isEmpty {
                throw LaunchError("环境配置脚本需要先开启终端环境读取。")
            }
            if agent == .codex { values["MISSIONGO_CHECK_DAEMON_ENV"] = "1" }
            if !settings.executable.isEmpty {
                let path = NSString(string: settings.executable).expandingTildeInPath
                guard Paths.isAbsolute(path), FileManager.default.isExecutableFile(atPath: path) else {
                    throw LaunchError("自定义启动器必须是本机可执行文件的绝对路径。")
                }
                values[agent == .claudeCode ? "MISSIONGO_CLAUDE_EXECUTABLE" : "MISSIONGO_CODEX_EXECUTABLE"] = path
            }
            return ShellEnvironment(path: ShellEnvironment.mergePath(values["PATH"], defaults: ShellEnvironment.defaultPathEntries()), base: values)
        }.value
    }
}

extension ShellEnvironment {
    /// An interactive login shell reads .zshrc as well as .zprofile. NUL framing
    /// preserves multiline values; greetings and stderr never become credentials.
    /// No output or error text from the user's profile may reach UI or logs.
    static func exportedEnvironment(
        base: [String: String], setupScript: String = "", cwd: String? = nil, timeout: TimeInterval = 5
    ) throws -> [String: String] {
        let shell = base["SHELL"] ?? "/bin/zsh"
        guard ["zsh", "bash"].contains(URL(fileURLWithPath: shell).lastPathComponent), Paths.isAbsolute(shell) else {
            throw LaunchError("自动读取终端环境支持 zsh 和 bash；其他 Shell 可使用独立启动器。")
        }
        let marker = "__MISSIONGO_ENV_\(UUID().uuidString)__"
        let process = Process()
        process.executableURL = URL(fileURLWithPath: shell)
        // Only fixed syntax enters the shell. Local paths are positional arguments;
        // work-item content and task prompts never enter this command.
        process.arguments = ["-ilc", "if [ -n \"$1\" ]; then . \"$1\" >/dev/null || exit 1; fi; printf '\\0%s\\0' \"$2\"; /usr/bin/env -0 && printf '\\0%s\\0' \"$2\"", "missiongo", NSString(string: setupScript).expandingTildeInPath, marker]
        process.environment = base
        process.currentDirectoryURL = URL(fileURLWithPath: cwd ?? base["HOME"] ?? Paths.homeDirectory())
        process.standardInput = FileHandle.nullDevice
        process.standardError = FileHandle.nullDevice
        let output = Pipe()
        process.standardOutput = output
        let finished = DispatchSemaphore(value: 0)
        process.terminationHandler = { _ in finished.signal() }
        do { try process.run() } catch { throw LaunchError("无法启动终端环境读取；请检查本机 Shell 设置。") }
        defer {
            if process.isRunning { _ = kill(process.processIdentifier, SIGKILL) }
            try? output.fileHandleForReading.close()
        }
        let descriptor = output.fileHandleForReading.fileDescriptor
        let flags = fcntl(descriptor, F_GETFL)
        guard flags >= 0, fcntl(descriptor, F_SETFL, flags | O_NONBLOCK) >= 0 else {
            throw LaunchError("无法读取终端环境。")
        }
        let deadline = Date().addingTimeInterval(timeout)
        var data = Data()
        var chunk = [UInt8](repeating: 0, count: 8192)
        while Date() < deadline, data.count < 2_000_000 {
            var watched = pollfd(fd: descriptor, events: Int16(POLLIN), revents: 0)
            let ready = poll(&watched, 1, 50)
            if ready < 0, errno == EINTR { continue }
            if ready < 0 { break }
            if ready == 0 { continue }
            let count = read(descriptor, &chunk, chunk.count)
            if count < 0, errno == EAGAIN || errno == EINTR { continue }
            if count <= 0 {
                // EOF can precede Foundation's termination notification slightly.
                if finished.wait(timeout: .now() + 0.2) == .success, process.terminationStatus == 0,
                   let values = decodeEnvironment(data, marker: marker) { return values }
                break
            }
            data.append(contentsOf: chunk.prefix(count))
        }
        throw LaunchError("终端环境读取失败或超时；请检查 Shell 配置或环境脚本，然后重新检查。")
    }

    static func decodeEnvironment(_ data: Data, marker: String) -> [String: String]? {
        let prefix = Data([0]) + Data(marker.utf8) + Data([0])
        guard let start = data.range(of: prefix), let end = data.range(of: prefix, options: .backwards),
              start.upperBound < end.lowerBound else { return nil }
        var values: [String: String] = [:]
        for part in data[start.upperBound..<end.lowerBound].split(separator: 0) {
            guard let text = String(data: part, encoding: .utf8), let equals = text.firstIndex(of: "=") else { return nil }
            values[String(text[..<equals])] = String(text[text.index(after: equals)...])
        }
        return values["PATH"] == nil ? nil : values
    }
}

/// Refresh only on an actual launch. Heartbeats use the current adapter, and
/// existing sessions retain the adapter/configuration that created them.
public final class RefreshingAgentAdapter: AgentAdapter, @unchecked Sendable {
    public let kind: String
    private let refresh: @Sendable (String) async throws -> any AgentAdapter
    private let current: Locked<any AgentAdapter>
    public final class SessionCache: @unchecked Sendable {
        fileprivate let entries = Locked<[String: any AgentAdapter]>([:])
        public init() {}
    }
    private let sessions: SessionCache

    public init(base: any AgentAdapter, sessions: SessionCache = SessionCache(), refresh: @escaping @Sendable (String) async throws -> any AgentAdapter) {
        kind = base.kind
        current = Locked(base)
        self.refresh = refresh
        self.sessions = sessions
    }
    public func detect() async -> String? { await current.current.detect() }
    public func dispatchAvailability() async -> AgentDispatchAvailability { await current.current.dispatchAvailability() }
    public func resourceSnapshot() async -> AgentResourceSnapshot? { await current.current.resourceSnapshot() }
    public func availableModels() async -> [AgentModelOption]? { await current.current.availableModels() }
    public func launch(_ job: DispatchJob) async throws -> LaunchResult {
        let adapter = try await refresh(job.repoPath)
        try Task.checkCancellation()
        current.withLock { $0 = adapter }
        let result = try await adapter.launch(job)
        if let ref = result.sessionRef { sessions.entries.withLock { $0[ref] = adapter } }
        return result
    }
    public func launchManaged(_ job: ManagedExecutionJob) async throws -> ManagedRuntimeReceipt {
        let adapter = try await refresh(job.repoPath)
        try Task.checkCancellation()
        do {
            let result = try await adapter.launchManaged(job)
            sessions.entries.withLock { $0[result.sessionRef] = adapter }
            return result
        } catch let uncertain as ManagedLaunchUncertain {
            sessions.entries.withLock { $0[uncertain.receipt.sessionRef] = adapter }
            throw uncertain
        }
    }
    private func adapter(_ ref: String) -> any AgentAdapter { sessions.entries.current[ref] ?? current.current }
    public func startManagedTurn(_ job: ManagedExecutionJob, receipt: ManagedRuntimeReceipt) async throws {
        try await adapter(receipt.sessionRef).startManagedTurn(job, receipt: receipt)
    }
    public func synchronize(_ session: NodeAgentSession) async throws -> AgentSessionReport {
        try await adapter(session.sessionRef).synchronize(session)
    }
    public func artifactMessages(sessionRef: String) async throws -> [AgentSessionMessage] {
        try await adapter(sessionRef).artifactMessages(sessionRef: sessionRef)
    }
}
