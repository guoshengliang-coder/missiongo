import Foundation

/// Shared with the background heartbeat; updating it never accesses the disk.
public final class MappedRepositorySnapshot: @unchecked Sendable {
    private let value = Locked<[RepoCandidate]>([])
    public init() {}
    public var candidates: [RepoCandidate] { value.current }
    public func update(_ repos: [RepoMapping]) { value.withLock { $0 = RepoCandidates.mapped(repos) } }
}

/// A repository offered as a mapping choice.
///
/// Typing an absolute path is both tedious and the easiest place to get a
/// dispatch wrong. The application now offers only explicit node mappings,
/// without probing their contents. The legacy history parser below is retained
/// as a utility, but is not called by startup, menus or heartbeats.
///
/// Only the path and the directory name leave the machine. Git remotes would
/// match products more reliably, but they carry private hosts and owners into
/// the server's database and its backups, and a directory name is enough to
/// sort the likely candidate to the top of a list the operator confirms anyway.
public struct RepoCandidate: Codable, Equatable, Sendable {
    public let path: String
    public let name: String
    public let lastUsedAt: String?

    public init(path: String, name: String, lastUsedAt: String? = nil) {
        self.path = path
        self.name = name
        self.lastUsedAt = lastUsedAt
    }
}

public enum RepoCandidates {
    public static let maxCandidates = 50

    /// Worktrees under `.claude/worktrees/` are per-session scratch copies —
    /// several of them are dispatched sessions' own leftovers. Offering them would
    /// let a dispatch land in a copy that is about to be deleted.
    public static func isSessionWorktree(_ path: String) -> Bool {
        return path.split(separator: "/", omittingEmptySubsequences: false).contains("worktrees")
            && path.contains("/.claude/")
    }

    public static func isGitRepository(_ path: String) -> Bool {
        // A worktree records `.git` as a file, a clone as a directory.
        return Paths.exists(Paths.join(path, ".git"))
    }

    /// Claude Code leaves `lastSessionModified` null for a project with a session
    /// still open — which is exactly the repository someone is about to dispatch
    /// to. The checkout's own mtime keeps those from sinking to the bottom.
    public static func directoryModifiedAt(_ path: String) -> Double? {
        guard let attributes = try? FileManager.default.attributesOfItem(atPath: path),
              let date = attributes[.modificationDate] as? Date
        else { return nil }
        return date.timeIntervalSince1970 * 1000
    }

    public static func parse(
        claudeJson: String?,
        isRepo: (String) -> Bool = RepoCandidates.isGitRepository,
        limit: Int = RepoCandidates.maxCandidates,
        modifiedAt: (String) -> Double? = RepoCandidates.directoryModifiedAt
    ) -> [RepoCandidate] {
        guard let claudeJson, let root = JSONValues.parse(claudeJson) as? [String: Any],
              let projects = root["projects"] as? [String: Any]
        else { return [] }

        var seen = Set<String>()
        var candidates: [(candidate: RepoCandidate, sortKey: Double)] = []

        // JavaScript walks the keys in file order; a Foundation dictionary has
        // none. Sorting the raw keys makes the one order-dependent case — two
        // keys that resolve to the same path — deterministic. Claude Code writes
        // each project path once, so in practice nothing is ever deduplicated.
        for rawPath in projects.keys.sorted() {
            let entry = projects[rawPath] as? [String: Any] ?? [:]
            // Untrusted directories are skipped rather than offered and refused
            // later: a candidate in the list reads as "this one works".
            guard JSONValues.isTrue(entry["hasTrustDialogAccepted"]) else { continue }
            let path = Paths.resolve(rawPath)
            if seen.contains(path) { continue }
            if isSessionWorktree(path) { continue }
            if !isRepo(path) { continue }
            seen.insert(path)

            let recorded: Double?
            if let number = JSONValues.number(entry["lastSessionModified"]) {
                recorded = number
            } else {
                recorded = parseDate(entry["lastSessionModified"])
            }
            let sortKey = recorded ?? modifiedAt(path) ?? 0
            candidates.append((
                RepoCandidate(
                    path: path,
                    name: Paths.basename(path),
                    lastUsedAt: sortKey != 0 ? isoString(milliseconds: sortKey) : nil
                ),
                sortKey
            ))
        }

        return candidates
            .sorted { left, right in
                if left.sortKey != right.sortKey { return left.sortKey > right.sortKey }
                return left.candidate.path.localizedCompare(right.candidate.path) == .orderedAscending
            }
            .prefix(limit)
            .map { $0.candidate }
    }

    /// No filesystem access: mappings are explicit choices, not permission to
    /// enumerate all the repositories another application has ever opened.
    public static func mapped(_ repos: [RepoMapping]) -> [RepoCandidate] {
        let paths = Set(repos.map(\.repoPath).filter { Paths.isAbsolute($0) && !isSessionWorktree($0) })
        return paths.sorted().prefix(maxCandidates).map {
            RepoCandidate(path: $0, name: Paths.basename($0))
        }
    }

    /// `Date.parse(String(value ?? ""))`, for a time that was stored as a string.
    /// Null, a missing field and anything unparseable all fall through to mtime.
    static func parseDate(_ value: Any?) -> Double? {
        guard let string = value as? String, !string.isEmpty else { return nil }
        let withFraction = ISO8601DateFormatter()
        withFraction.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let date = withFraction.date(from: string) { return date.timeIntervalSince1970 * 1000 }
        let plain = ISO8601DateFormatter()
        if let date = plain.date(from: string) { return date.timeIntervalSince1970 * 1000 }
        return nil
    }

    /// `new Date(ms).toISOString()`: always three fraction digits, and the
    /// milliseconds truncated rather than rounded (mtimes carry fractions).
    static func isoString(milliseconds: Double) -> String {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        formatter.timeZone = TimeZone(secondsFromGMT: 0)
        let whole = milliseconds.rounded(.towardZero)
        return formatter.string(from: Date(timeIntervalSince1970: whole / 1000))
    }
}

/// Claude Code's own state file, which holds both the project list and the
/// per-directory trust flag.
public enum ClaudeJson {
    public static func read(home: String = Paths.homeDirectory()) -> String? {
        let path = Paths.join(home, ".claude.json")
        guard let data = FileManager.default.contents(atPath: path) else { return nil }
        return String(data: data, encoding: .utf8)
    }
}
