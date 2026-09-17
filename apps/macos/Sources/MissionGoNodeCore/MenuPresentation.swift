import Foundation

/// The decisions behind what the menu bar shows, kept out of SwiftUI so each
/// one can be pinned by a test: which address to sign in to, what a connection
/// state reads as, whether a chosen folder can be saved, how a dispatch row is
/// worded.

// MARK: - Server address

public enum ServerAddress {
    /// What a build without `MISSIONGO_PUBLIC_ORIGIN` carries in its Info.plist.
    /// It is a reserved name that never resolves, so signing in to it could only
    /// end in a network error; the sign-in screen asks for an address instead.
    public static let placeholderHost = "example.invalid"

    public enum ValidationError: Error, Equatable, LocalizedError, Sendable {
        case empty
        case unsupportedScheme
        case missingHost
        case notAnOrigin
        case placeholder

        public var errorDescription: String? {
            switch self {
            case .empty: return "请填写服务器地址。"
            case .unsupportedScheme: return "服务器地址必须以 http:// 或 https:// 开头。"
            case .missingHost: return "服务器地址缺少主机名。"
            case .notAnOrigin: return "服务器地址只填协议、主机和端口，不要带路径、参数或账号。"
            case .placeholder: return "这是占位地址，不是真实的服务器，请填写你的 MissionGo 地址。"
            }
        }
    }

    /// An http(s) origin such as `https://missiongo.example.com:8443`, returned
    /// without a trailing slash. A path is refused rather than dropped: someone
    /// who pasted `…/admin/nodes` should see that the address is not what they
    /// meant, not have it silently rewritten.
    public static func validate(_ input: String) -> Result<String, ValidationError> {
        let trimmed = input.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.isEmpty { return .failure(.empty) }
        guard let components = URLComponents(string: trimmed), let scheme = components.scheme?.lowercased(),
              scheme == "http" || scheme == "https"
        else { return .failure(.unsupportedScheme) }
        guard let host = components.host, !host.isEmpty else { return .failure(.missingHost) }
        let path = components.percentEncodedPath
        if !(path.isEmpty || path == "/") || components.query != nil || components.fragment != nil
            || components.user != nil || components.password != nil {
            return .failure(.notAnOrigin)
        }
        if host.lowercased() == placeholderHost { return .failure(.placeholder) }
        return .success(normalizeServerUrl(trimmed))
    }

    /// The address to sign in to: a saved override wins, then the one the build
    /// was made with. `nil` when neither is usable, which the sign-in screen
    /// shows as "请先填写服务器地址".
    public static func effective(bundleValue: String?, override: String?) -> String? {
        for candidate in [override, bundleValue] {
            if let candidate, case let .success(origin) = validate(candidate) { return origin }
        }
        return nil
    }

    /// `host` or `host:port`, the way the menu names a server.
    public static func displayHost(_ url: String) -> String {
        guard let components = URLComponents(string: url), let host = components.host, !host.isEmpty else { return url }
        if let port = components.port { return "\(host):\(port)" }
        return host
    }
}

// MARK: - Nickname

public enum NodeNickname {
    /// The server's limit, counted the way it counts: JavaScript string length,
    /// i.e. UTF-16 code units, so an emoji takes two.
    public static let maxLength = 40

    public enum ValidationError: Error, Equatable, LocalizedError, Sendable {
        case tooLong
        case controlCharacter

        public var errorDescription: String? {
            switch self {
            case .tooLong: return "昵称最多 \(NodeNickname.maxLength) 个字符。"
            case .controlCharacter: return "昵称不能包含换行、制表符等控制字符。"
            }
        }
    }

    /// What JavaScript's `String.prototype.trim` removes. Foundation's
    /// `whitespacesAndNewlines` differs at the edges (it keeps U+FEFF and drops
    /// U+0085), and a name the menu accepted must not be refused by the server.
    static let trimmed: CharacterSet = {
        var set = CharacterSet.whitespaces
        set.insert(charactersIn: "\u{000A}\u{000B}\u{000C}\u{000D}\u{FEFF}\u{2028}\u{2029}")
        return set
    }()

    /// The server's rules, applied before sending so a mistake shows up next to
    /// the field instead of as an HTTP error. Success carries what to send:
    /// the trimmed nickname, or `nil` to clear it — an empty field means "use the
    /// device name", exactly like 恢复为设备名.
    public static func validate(_ input: String) -> Result<String?, ValidationError> {
        let value = input.trimmingCharacters(in: trimmed)
        if value.isEmpty { return .success(nil) }
        if value.utf16.count > maxLength { return .failure(.tooLong) }
        // The server refuses C0 controls and DEL, and nothing else.
        if value.unicodeScalars.contains(where: { $0.value < 0x20 || $0.value == 0x7F }) {
            return .failure(.controlCharacter)
        }
        return .success(value)
    }
}

// MARK: - Connection

public struct ConnectionSummary: Equatable, Sendable {
    public enum Tone: Equatable, Sendable {
        case good
        case pending
        case bad
        case idle
    }

    public let text: String
    public let tone: Tone

    public init(text: String, tone: Tone) {
        self.text = text
        self.tone = tone
    }

    public static func summarize(_ state: NodeLoopState) -> ConnectionSummary {
        switch state.connection {
        case .online:
            return ConnectionSummary(text: "在线", tone: .good)
        case .connecting:
            return ConnectionSummary(text: "连接中", tone: .pending)
        case .offline:
            let reason = state.lastError?.trimmingCharacters(in: .whitespacesAndNewlines)
            return ConnectionSummary(text: "离线：\(reason.flatMap { $0.isEmpty ? nil : $0 } ?? "原因未知")", tone: .bad)
        case .credentialRevoked:
            return ConnectionSummary(text: "凭证已失效，需要重新登录", tone: .bad)
        case .stopped:
            return ConnectionSummary(text: "已停止", tone: .idle)
        }
    }
}

public enum MenuBarSymbol {
    /// Readable without opening the menu: a filled plane only while the machine
    /// is actually reachable, an outline while it is still connecting, and a
    /// different glyph altogether when it cannot take work.
    public static func name(signedIn: Bool, connection: NodeLoopState.Connection?) -> String {
        guard signedIn else { return "person.crop.circle.badge.questionmark" }
        switch connection {
        case .online: return "paperplane.circle.fill"
        case .connecting, .none: return "paperplane.circle"
        case .offline, .credentialRevoked, .stopped: return "exclamationmark.circle"
        }
    }
}

// MARK: - Client version

/// The client's own version, where the menu says which server it is on
/// (AND-53). It used to sit at the foot of the agents list as a bare number,
/// and was hidden outright on a build with no version -- so "which version is
/// this Mac on?" still had no answer anyone could find.
public enum AppVersionLabel {
    /// `version` is `AppUpdater.currentVersion()`: nil for `swift run`, which
    /// has no Info.plist, and that is worth saying rather than hiding.
    public static func text(_ version: String?) -> String {
        guard let version else { return "开发构建" }
        return "版本 \(version)"
    }
}

// MARK: - missiongo Skill

/// The Skill row in the menu (AND-47). A failure used to be squeezed into two
/// trailing lines, so "The Internet connection ap…" was all anyone saw, and
/// nothing offered to try again short of waiting an hour.
public enum SkillSyncStatus: Equatable, Sendable {
    case syncing
    case synced(version: String)
    /// The whole reason, for the menu to show in full.
    case failed(reason: String)

    /// What a finished sync amounts to: any copy that could not be written
    /// is a failure, named with where it was going.
    public static func outcome(_ outcome: SkillSync.Outcome) -> SkillSyncStatus {
        guard outcome.failures.isEmpty else {
            return .failed(reason: "写入失败：\(outcome.failures.joined(separator: "；"))")
        }
        return .synced(version: outcome.version)
    }

    /// The short text beside the row's title.
    public var summary: String {
        switch self {
        case .syncing: return "同步中…"
        case let .synced(version): return version
        case .failed: return "同步失败"
        }
    }

    public var failureReason: String? {
        if case let .failed(reason) = self { return reason }
        return nil
    }
}

// MARK: - Claude Code

public enum ClaudeCodeStatus: Equatable, Sendable {
    case checking
    case ready(version: String)
    case notInstalled
    case notLoggedIn(version: String)
    /// Installed, but `claude auth status` printed nothing this client can read.
    case unreadable(version: String)

    public static func evaluate(version: String?, auth: Preflight.AuthStatus?) -> ClaudeCodeStatus {
        guard let version else { return .notInstalled }
        guard let auth else { return .unreadable(version: version) }
        return auth.loggedIn ? .ready(version: version) : .notLoggedIn(version: version)
    }

    public static func check(run: CommandRunner) async -> ClaudeCodeStatus {
        guard let version = await Preflight.claudeVersion(run: run) else { return .notInstalled }
        return evaluate(version: version, auth: await Preflight.claudeAuthStatus(run: run))
    }

    public var isReady: Bool {
        if case .ready = self { return true }
        return false
    }

    public var summary: String {
        switch self {
        case .checking: return "检查中…"
        case let .ready(version): return version
        case .notInstalled: return "未安装"
        case .notLoggedIn: return "未登录"
        case .unreadable: return "无法确认登录状态"
        }
    }

    /// What to do about it, in the words of docs/node.md.
    public var fixHint: String? {
        switch self {
        case .checking, .ready: return nil
        case .notInstalled: return "确认终端里能直接运行 claude，然后重新打开 MissionGo"
        case .notLoggedIn: return "在终端运行 claude auth login"
        case .unreadable: return "在终端运行 claude auth status 查看"
        }
    }

    /// The command the copy button puts on the clipboard.
    public var fixCommand: String? {
        switch self {
        case .notLoggedIn: return "claude auth login"
        case .unreadable: return "claude auth status"
        case .checking, .ready, .notInstalled: return nil
        }
    }
}

/// The Codex row in the menu. Codex is optional, so "not installed" is a plain
/// fact rather than a warning; everything past that is something a Codex
/// dispatch would fail on, with the fix.
public enum CodexStatus: Equatable, Sendable {
    case checking
    case notInstalled
    case notLoggedIn(version: String)
    case unreadable(version: String)
    /// Installed and logged in, but nothing answers on the control socket.
    ///
    /// That socket belongs to `codex app-server daemon`, not to the ChatGPT
    /// app: the app talks to its own app-server over stdio and never creates
    /// one. So this says to start the daemon, and does not send anybody to look
    /// at an app that is plainly already open.
    case daemonNotRunning(version: String, path: String)
    case mcpMissing(version: String)
    case mcpNotLoggedIn(version: String)
    case ready(version: String)

    public static func check(
        environment: ShellEnvironment,
        location: CodexLocation,
        run: CommandRunner
    ) async -> CodexStatus {
        guard let binary = CodexLocation.binary(environment: environment),
              let version = await CodexPreflight.version(binary: binary, run: run)
        else { return .notInstalled }
        switch await CodexPreflight.isLoggedIn(binary: binary, run: run) {
        case true?: break
        case false?: return .notLoggedIn(version: version)
        case nil: return .unreadable(version: version)
        }
        guard CodexLocation.controlChannelIsUp(location.controlSocketPath) else {
            return .daemonNotRunning(version: version, path: location.controlSocketPath)
        }
        switch await CodexPreflight.mcpState(binary: binary, run: run) {
        case .ready: return .ready(version: version)
        case .missing, .disabled: return .mcpMissing(version: version)
        case .notLoggedIn: return .mcpNotLoggedIn(version: version)
        case .unreadable: return .unreadable(version: version)
        }
    }

    public var isReady: Bool {
        if case .ready = self { return true }
        return false
    }

    /// Worth drawing attention to: installed, but a dispatch would fail.
    public var needsAttention: Bool {
        switch self {
        case .checking, .notInstalled, .ready: return false
        default: return true
        }
    }

    public var summary: String {
        switch self {
        case .checking: return "检查中…"
        case .notInstalled: return "未安装"
        case .notLoggedIn: return "未登录"
        case .unreadable: return "无法确认状态"
        case .daemonNotRunning: return "后台服务未运行"
        case .mcpMissing: return "未配置 missiongo MCP"
        case .mcpNotLoggedIn: return "missiongo MCP 未登录"
        case let .ready(version): return version
        }
    }

    public var fixHint: String? {
        switch self {
        case .checking, .notInstalled, .ready: return nil
        case .notLoggedIn: return "在 ChatGPT App 里登录，或在终端运行 codex login"
        case .unreadable: return "在终端运行 codex login status 和 codex mcp list 查看"
        case let .daemonNotRunning(_, path): return "Codex 派单要通过 app-server 的控制通道 \(path)，它由 codex app-server daemon 提供，现在没有在运行。在终端启动它；codex app-server daemon bootstrap 可以让它开机常驻。"
        case .mcpMissing: return "在终端添加 missiongo MCP 并登录"
        case .mcpNotLoggedIn: return "在终端运行 codex mcp login missiongo"
        }
    }

    public func fixCommand(serverUrl: String?) -> String? {
        switch self {
        case .notLoggedIn: return "codex login"
        case .mcpMissing: return CodexPreflight.mcpSetupCommand(serverUrl: serverUrl)
        case .mcpNotLoggedIn: return "codex mcp login missiongo"
        case .daemonNotRunning: return CodexPreflight.daemonStartCommand
        case .checking, .notInstalled, .unreadable, .ready: return nil
        }
    }
}

// MARK: - Repository folders

public enum RepoFolderVerdict: Equatable, Sendable {
    case accepted
    /// Saved, but a dispatch to it will fail until Claude Code trusts it.
    case acceptedUntrusted(warning: String)
    /// Not saved.
    case rejected(reason: String)

    public var canSave: Bool {
        if case .rejected = self { return false }
        return true
    }

    public var message: String? {
        switch self {
        case .accepted: return nil
        case let .acceptedUntrusted(warning): return warning
        case let .rejected(reason): return reason
        }
    }
}

public enum RepoFolderCheck {
    public static let untrustedWarning = "这个目录还没有被 Claude Code 信任：在该目录运行一次 claude 并选择信任，否则派单会失败"

    /// The same conditions the launch preflight enforces, checked when the folder
    /// is chosen instead of minutes later when a dispatch fails.
    public static func evaluate(
        path: String,
        claudeJson: String?,
        home: String = Paths.homeDirectory(),
        isRepo: (String) -> Bool = RepoCandidates.isGitRepository
    ) -> RepoFolderVerdict {
        let shown = PathDisplay.abbreviate(path, home: home)
        // A session's own worktree gets deleted when that session is done, and a
        // dispatch started in it is filed under the wrong project in /resume.
        if RepoCandidates.isSessionWorktree(path) {
            return .rejected(reason: "\(shown) 是 Claude Code 会话的临时 worktree，随时可能被删除：请选择仓库主目录。")
        }
        if !isRepo(path) {
            return .rejected(reason: "\(shown) 不是 git 仓库，没有保存：请选择仓库的根目录（包含 .git 的那一层）。")
        }
        guard let claudeJson, Preflight.isTrustedRepoPath(claudeJson: claudeJson, repoPath: path) else {
            return .acceptedUntrusted(warning: untrustedWarning)
        }
        return .accepted
    }

    /// Candidates worth offering for one product: those whose folder name looks
    /// like the product first, in their recency order otherwise.
    public static func suggestions(
        keyPrefix: String,
        productName: String,
        candidates: [RepoCandidate],
        excluding currentPath: String?,
        limit: Int = 8
    ) -> [RepoCandidate] {
        func squash(_ value: String) -> String {
            return value.lowercased().filter { !$0.isWhitespace && $0 != "-" && $0 != "_" }
        }
        let key = squash(keyPrefix)
        let name = squash(productName)
        func matches(_ candidate: RepoCandidate) -> Bool {
            let folder = squash(candidate.name)
            if folder.isEmpty { return false }
            return folder == key || (!name.isEmpty && (folder.contains(name) || name.contains(folder)))
        }
        let pool = candidates.filter { $0.path != currentPath }
        return Array((pool.filter(matches) + pool.filter { !matches($0) }).prefix(limit))
    }

    /// The whole list `PUT /api/v1/node/repos` expects, with one product changed.
    /// `nil` clears that product's mapping.
    public static func assignments(
        from repos: [RepoMapping],
        setting productId: String,
        to path: String?
    ) -> [RepoAssignment] {
        var result = repos
            .filter { $0.productId != productId }
            .map { RepoAssignment(productId: $0.productId, repoPath: $0.repoPath) }
        if let path { result.append(RepoAssignment(productId: productId, repoPath: path)) }
        return result
    }
}

public enum PathDisplay {
    /// `/Users/me/Projects/app` → `~/Projects/app`.
    public static func abbreviate(_ path: String, home: String = Paths.homeDirectory()) -> String {
        let trimmedHome = home.hasSuffix("/") ? String(home.dropLast()) : home
        guard !trimmedHome.isEmpty else { return path }
        if path == trimmedHome { return "~" }
        if path.hasPrefix(trimmedHome + "/") { return "~" + path.dropFirst(trimmedHome.count) }
        return path
    }
}

// MARK: - Dispatches

public enum DispatchPresentation {
    public static let menuLimit = 5

    public static func statusLabel(_ status: String) -> String {
        switch status {
        case "queued": return "排队中"
        case "delivered": return "已送达"
        case "launched": return "已启动"
        case "failed": return "失败"
        default: return status
        }
    }

    public static func itemsLabel(_ itemKeys: [String]) -> String {
        return itemKeys.isEmpty ? "（无条目）" : itemKeys.joined(separator: "、")
    }

    /// Which agent took the dispatch. An unknown kind is shown as it arrived:
    /// a server that learned a new agent should not turn into a blank row here.
    public static func agentLabel(_ agentKind: String) -> String {
        switch agentKind {
        case "claude_code": return "Claude Code"
        case "codex": return "Codex"
        case "hermes": return "Hermes"
        default: return agentKind
        }
    }

    /// The permission mode it was dispatched with, worded as the console words
    /// it. Unknown modes are shown as they arrived, for the same reason.
    public static func modeLabel(_ mode: String) -> String {
        switch mode {
        case "plan": return "计划"
        case "default": return "默认"
        case "acceptEdits": return "自动接受编辑"
        case "auto": return "自动"
        default: return mode
        }
    }

    /// The one line under the item keys: which agent, in which mode.
    public static func agentLine(agentKind: String, mode: String) -> String {
        let agent = agentLabel(agentKind)
        let mode = modeLabel(mode)
        return mode.isEmpty ? agent : "\(agent) · \(mode)"
    }

    /// The first line, cut to `limit` characters. A launch failure carries the
    /// log tail after a newline; the row only needs the reason, the full text is
    /// in the tooltip.
    public static func shortError(_ error: String?, limit: Int = 60) -> String? {
        guard let error else { return nil }
        let lines = error.split(separator: "\n", omittingEmptySubsequences: true)
            .map { $0.trimmingCharacters(in: .whitespaces) }
            .filter { !$0.isEmpty }
        guard let first = lines.first else { return nil }
        if first.count > limit { return String(first.prefix(limit)) + "…" }
        return lines.count > 1 ? first + "…" : first
    }

    public static func parseDate(_ value: String) -> Date? {
        let withFraction = ISO8601DateFormatter()
        withFraction.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let date = withFraction.date(from: value) { return date }
        return ISO8601DateFormatter().date(from: value)
    }

    public static func relativeTime(_ iso: String, now: Date = Date(), calendar: Calendar = .current) -> String {
        guard let date = parseDate(iso) else { return "" }
        let seconds = now.timeIntervalSince(date)
        // A server clock slightly ahead of this one is still "just now".
        if seconds < 60 { return "刚刚" }
        if seconds < 3600 { return "\(Int(seconds / 60)) 分钟前" }
        if seconds < 86_400 { return "\(Int(seconds / 3600)) 小时前" }
        if seconds < 7 * 86_400 { return "\(Int(seconds / 86_400)) 天前" }
        let parts = calendar.dateComponents([.year, .month, .day], from: date)
        let current = calendar.component(.year, from: now)
        let monthDay = "\(parts.month ?? 0) 月 \(parts.day ?? 0) 日"
        return parts.year == current ? monthDay : "\(parts.year ?? 0) 年 \(monthDay)"
    }
}
