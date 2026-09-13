import Foundation

/// The environment every child process runs with.
///
/// An app started from Finder or at login does not inherit the terminal's
/// PATH; it gets launchd's bare `/usr/bin:/bin:/usr/sbin:/sbin`, where `claude`
/// — usually under `~/.local/bin` or a Homebrew prefix — is not found. This is
/// the same trap the launchd service of the command-line node fell into: the
/// machine comes up, reports no agents, and every dispatch fails with a missing
/// binary nobody at the machine sees. So the login shell is asked for its PATH
/// once, and every process this app starts uses the answer.
public struct ShellEnvironment: Sendable, Equatable {
    public let path: String
    public let environment: [String: String]

    public init(path: String, base: [String: String] = ProcessInfo.processInfo.environment) {
        self.path = path
        var environment = base
        environment["PATH"] = path
        self.environment = environment
    }

    static let loginShellTimeout: TimeInterval = 5
    static let marker = "__MISSIONGO_PATH__"

    /// The places `claude` is installed on a machine where the login shell did
    /// not answer, plus the system directories `script` lives in.
    public static func defaultPathEntries(home: String = Paths.homeDirectory()) -> [String] {
        return [
            "\(home)/.local/bin",
            "/opt/homebrew/bin",
            "/usr/local/bin",
            "/usr/bin",
            "/bin",
            "/usr/sbin",
            "/sbin",
        ]
    }

    /// Asks `/bin/zsh -l` for its PATH, with a timeout, and falls back to the
    /// default entries. It blocks for up to a few seconds, so call it once at
    /// startup, off the main thread.
    public static func resolve(home: String = Paths.homeDirectory()) -> ShellEnvironment {
        let shellPath = loginShellPath(timeout: loginShellTimeout)
        return ShellEnvironment(path: mergePath(shellPath, defaults: defaultPathEntries(home: home)))
    }

    /// The login shell's PATH first, so a machine that pins a particular
    /// `claude` keeps using it; the defaults are appended when missing because
    /// `zsh -l` does not read `.zshrc`, which is where some installers add
    /// `~/.local/bin`.
    static func mergePath(_ shellPath: String?, defaults: [String]) -> String {
        var entries: [String] = []
        for entry in (shellPath ?? "").split(separator: ":").map(String.init) + defaults {
            if entry.isEmpty || entries.contains(entry) { continue }
            entries.append(entry)
        }
        return entries.joined(separator: ":")
    }

    /// Output is taken after a marker: a `.zprofile` that prints a greeting or
    /// an update notice must not end up glued to the first PATH entry.
    static func extractPath(fromShellOutput output: String) -> String? {
        guard let range = output.range(of: marker, options: .backwards) else { return nil }
        let path = output[range.upperBound...].trimmingCharacters(in: .whitespacesAndNewlines)
        return path.isEmpty ? nil : path
    }

    static func loginShellPath(timeout: TimeInterval) -> String? {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/bin/zsh")
        process.arguments = ["-lc", "printf '%s%s' '\(marker)' \"$PATH\""]
        process.standardInput = FileHandle.nullDevice
        let stdout = Pipe()
        process.standardOutput = stdout
        process.standardError = FileHandle.nullDevice

        let finished = DispatchSemaphore(value: 0)
        process.terminationHandler = { _ in finished.signal() }
        do {
            try process.run()
        } catch {
            return nil
        }
        let output = Locked(Data())
        let reader = DispatchSemaphore(value: 0)
        DispatchQueue.global().async {
            let data = stdout.fileHandleForReading.readDataToEndOfFile()
            output.withLock { $0 = data }
            reader.signal()
        }
        // A shell profile that waits on something (a keychain prompt, a slow
        // network mount) must not keep the app from starting.
        if finished.wait(timeout: .now() + timeout) == .timedOut {
            process.terminate()
            return nil
        }
        _ = reader.wait(timeout: .now() + 1)
        guard process.terminationStatus == 0 else { return nil }
        return extractPath(fromShellOutput: String(data: output.current, encoding: .utf8) ?? "")
    }

    /// PATH lookup for a bare command name, the way `spawn("claude")` does it.
    /// `Process` needs an absolute executable; a name with a slash is used as is.
    public func which(_ command: String) -> String? {
        if command.contains("/") { return command }
        for directory in path.split(separator: ":") where !directory.isEmpty {
            let candidate = "\(directory)/\(command)"
            if FileManager.default.isExecutableFile(atPath: candidate) { return candidate }
        }
        return nil
    }
}

// MARK: - Running short commands

public struct CommandResult: Equatable, Sendable {
    public let code: Int32
    public let stdout: String
    public let stderr: String

    public init(code: Int32, stdout: String, stderr: String) {
        self.code = code
        self.stdout = stdout
        self.stderr = stderr
    }
}

/// Runs a command without a shell, so no argument can turn into shell syntax.
public typealias CommandRunner = @Sendable (_ file: String, _ args: [String]) async -> CommandResult

public enum Commands {
    static let timeout: TimeInterval = 15

    public static func runner(environment: ShellEnvironment) -> CommandRunner {
        return { file, args in
            await withCheckedContinuation { continuation in
                DispatchQueue.global().async {
                    continuation.resume(returning: runSync(file, args, environment: environment))
                }
            }
        }
    }

    static func runSync(_ file: String, _ args: [String], environment: ShellEnvironment) -> CommandResult {
        // A binary that is not installed and one that fails are the same thing to
        // every caller: not usable. Both come back as a non-zero code.
        guard let executable = environment.which(file) else {
            return CommandResult(code: -1, stdout: "", stderr: "在 PATH 中找不到 \(file)：\(environment.path)")
        }
        let process = Process()
        process.executableURL = URL(fileURLWithPath: executable)
        process.arguments = args
        process.environment = environment.environment
        process.standardInput = FileHandle.nullDevice
        let stdout = Pipe()
        let stderr = Pipe()
        process.standardOutput = stdout
        process.standardError = stderr

        let finished = DispatchSemaphore(value: 0)
        process.terminationHandler = { _ in finished.signal() }
        do {
            try process.run()
        } catch {
            return CommandResult(code: -1, stdout: "", stderr: error.localizedDescription)
        }
        // Both pipes are drained concurrently: a child that fills one pipe's
        // buffer while nobody reads it would never exit.
        let out = Locked(Data())
        let err = Locked(Data())
        let group = DispatchGroup()
        group.enter()
        DispatchQueue.global().async {
            let data = stdout.fileHandleForReading.readDataToEndOfFile()
            out.withLock { $0 = data }
            group.leave()
        }
        group.enter()
        DispatchQueue.global().async {
            let data = stderr.fileHandleForReading.readDataToEndOfFile()
            err.withLock { $0 = data }
            group.leave()
        }
        if finished.wait(timeout: .now() + timeout) == .timedOut {
            process.terminate()
            _ = group.wait(timeout: .now() + 1)
            let text = String(data: err.current, encoding: .utf8) ?? ""
            return CommandResult(
                code: -1,
                stdout: String(data: out.current, encoding: .utf8) ?? "",
                stderr: "\(text)\(file) 在 \(Int(timeout)) 秒内没有结束"
            )
        }
        // A grandchild that inherited the pipe can keep it open after the command
        // itself exited; the answer is already complete by then.
        _ = group.wait(timeout: .now() + 2)
        return CommandResult(
            code: process.terminationStatus,
            stdout: String(data: out.current, encoding: .utf8) ?? "",
            stderr: String(data: err.current, encoding: .utf8) ?? ""
        )
    }
}
