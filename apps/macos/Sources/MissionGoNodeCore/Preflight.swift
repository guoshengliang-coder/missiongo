import Foundation

/// Everything that has to be true on this machine before a session can start.
///
/// A dispatched session runs with nobody at the keyboard, so every condition
/// that would normally show up as an interactive prompt has to be checked here
/// instead: a missing login, an untrusted directory and a first-run dialog all
/// look identical from the outside — a process that sits there forever — and
/// the console would keep saying "已启动" while nothing happens.
public enum Preflight {
    public struct AuthStatus: Equatable, Sendable {
        public let loggedIn: Bool
        public let authMethod: String
        public let apiProvider: String
    }

    public enum Result: Equatable, Sendable {
        case ok(version: String)
        case failed(reason: String)
    }

    /// Parse `claude auth status`, which prints a JSON object such as
    /// `{"loggedIn":false,"authMethod":"none","apiProvider":"firstParty"}`.
    ///
    /// The object is cut out of the surrounding output rather than parsed whole:
    /// the CLI is free to print update notices or warnings around it, and a
    /// warning must not read as "not logged in".
    public static func parseAuthStatus(_ raw: String) -> AuthStatus? {
        guard let start = raw.firstIndex(of: "{"), let end = raw.lastIndex(of: "}"), start < end else { return nil }
        guard let record = JSONValues.parse(String(raw[start...end])) as? [String: Any] else { return nil }
        // Missing loggedIn is not a login: guessing either way would be wrong.
        guard let loggedIn = JSONValues.bool(record["loggedIn"]) else { return nil }
        return AuthStatus(
            loggedIn: loggedIn,
            authMethod: record["authMethod"] as? String ?? "unknown",
            apiProvider: record["apiProvider"] as? String ?? "unknown"
        )
    }

    private static let versionPattern = try! NSRegularExpression(pattern: "[0-9]+\\.[0-9]+\\.[0-9]+(?:[A-Za-z0-9_.-]*)?")

    /// `claude --version` prints something like `2.1.232 (Claude Code)`.
    public static func parseClaudeVersion(_ raw: String) -> String? {
        let range = NSRange(raw.startIndex..<raw.endIndex, in: raw)
        guard let match = versionPattern.firstMatch(in: raw, range: range),
              let matched = Range(match.range, in: raw)
        else { return nil }
        return String(raw[matched])
    }

    public static func claudeVersion(run: CommandRunner) async -> String? {
        let result = await run("claude", ["--version"])
        guard result.code == 0 else { return nil }
        return parseClaudeVersion(result.stdout)
    }

    public static func claudeAuthStatus(run: CommandRunner) async -> AuthStatus? {
        let result = await run("claude", ["auth", "status"])
        // The command prints its JSON on stdout; a non-zero exit still carries a
        // usable answer on some versions, so both streams are considered.
        return parseAuthStatus(result.stdout) ?? parseAuthStatus(result.stderr)
    }

    /// Whether Claude Code has recorded the workspace-trust confirmation for a path.
    ///
    /// Trust lives per absolute path in `~/.claude.json` under
    /// `projects["<path>"].hasTrustDialogAccepted`. Without it the session stops
    /// on the trust dialog and waits forever, which is indistinguishable from a
    /// session that is thinking. Keys are compared after resolution so a stored
    /// trailing slash still matches.
    ///
    /// A git worktree that the CLI creates itself under a trusted repository
    /// inherits that trust, so only the mapped repository path needs checking.
    public static func isTrustedRepoPath(claudeJson: String, repoPath: String) -> Bool {
        guard let root = JSONValues.parse(claudeJson) as? [String: Any],
              let projects = root["projects"] as? [String: Any]
        else { return false }
        let wanted = Paths.resolve(repoPath)
        // Sorted for the same reason as in RepoCandidates: the first key that
        // resolves to the path decides, and Foundation keeps no file order.
        for key in projects.keys.sorted() where Paths.resolve(key) == wanted {
            guard let project = projects[key] as? [String: Any] else { return false }
            return JSONValues.isTrue(project["hasTrustDialogAccepted"])
        }
        return false
    }

    /// Reasons are written for the person reading them, not for code: each one
    /// says what is missing and what to do about it, because the operator is the
    /// only one who can fix a login or a trust dialog.
    public static func check(
        repoPath: String,
        run: CommandRunner,
        home: String = Paths.homeDirectory()
    ) async -> Result {
        guard let version = await claudeVersion(run: run) else {
            return .failed(reason: "本机找不到可用的 claude 命令：确认 Claude Code 已安装，且 claude --version 能正常运行。")
        }

        guard let auth = await claudeAuthStatus(run: run) else {
            return .failed(reason: "无法读取 claude auth status 的输出，无法确认登录状态。")
        }
        if !auth.loggedIn {
            return .failed(reason: "Claude Code 未登录（authMethod=\(auth.authMethod)）：在本机运行一次 claude 完成登录后再派单。")
        }

        if !Paths.isAbsolute(repoPath) {
            return .failed(reason: "仓库路径必须是绝对路径：\(repoPath)")
        }
        if !Paths.isDirectory(repoPath) {
            return .failed(reason: "仓库目录不存在：\(repoPath)")
        }
        // A worktree records `.git` as a file, a normal clone as a directory; both
        // are fine, only the absence matters.
        if !Paths.exists(Paths.join(repoPath, ".git")) {
            return .failed(reason: "目录不是 git 仓库：\(repoPath)")
        }

        guard let claudeJson = ClaudeJson.read(home: home),
              isTrustedRepoPath(claudeJson: claudeJson, repoPath: repoPath)
        else {
            return .failed(
                reason: "\(repoPath) 还没有在本机通过 Claude Code 的信任确认：先在该目录手动运行一次 claude 并选择信任，否则会话会一直停在信任对话框上。"
            )
        }

        return .ok(version: version)
    }
}
