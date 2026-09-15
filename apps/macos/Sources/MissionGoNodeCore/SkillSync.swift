import Foundation

/// Keeps the missiongo Skill current in every agent on this machine.
///
/// A dispatched session is told to "use the missiongo skill"; an agent without
/// it, or with an old copy, works the items by rules the server has moved on
/// from. So the published SKILL.md is fetched from the server this Mac is logged
/// in to and written into `~/.claude/skills/missiongo` and
/// `$CODEX_HOME/skills/missiongo` — only for agents whose home directory exists,
/// and never over a newer copy or a symlink someone set up by hand.
public enum SkillSync {
    public static let downloadPath = "/downloads/missiongo-skill/SKILL.md"
    static let maxBytes = 1_000_000

    public struct Outcome: Equatable, Sendable {
        public let version: String
        /// Files written this run.
        public let updated: [String]
        /// Human-readable, one per target that could not be written.
        public let failures: [String]
    }

    public enum SyncError: Error, Equatable, LocalizedError {
        case download(String)
        case invalidSkill

        public var errorDescription: String? {
            switch self {
            case let .download(detail): return "下载 missiongo Skill 失败：\(detail)"
            case .invalidSkill: return "服务器返回的内容不是 missiongo Skill。"
            }
        }
    }

    /// The front matter between the leading `---` lines, or nil.
    static func frontMatter(_ text: String) -> [String: String]? {
        let lines = text.replacingOccurrences(of: "\r\n", with: "\n").components(separatedBy: "\n")
        guard lines.first == "---", let end = lines.dropFirst().firstIndex(of: "---") else { return nil }
        var fields: [String: String] = [:]
        for line in lines[1..<end] {
            let parts = line.split(separator: ":", maxSplits: 1)
            guard parts.count == 2 else { continue }
            fields[parts[0].trimmingCharacters(in: .whitespaces)] = parts[1].trimmingCharacters(in: .whitespaces)
        }
        return fields
    }

    /// The `version` of a missiongo SKILL.md, or nil for anything else.
    public static func version(ofSkill text: String) -> String? {
        guard let fields = frontMatter(text), fields["name"] == "missiongo",
              let version = fields["version"], Version.numericParts(version) != nil
        else { return nil }
        return version
    }

    /// Numeric, part by part: `5.10.0` is newer than `5.9.0`. The app's own
    /// updater compares its version the same way; see `Version`.
    public static func isNewer(_ candidate: String, than current: String) -> Bool {
        return Version.isNewer(candidate, than: current)
    }

    /// The SKILL.md paths to keep current: one per agent installed here.
    public static func targets(home: String, codexHome: String) -> [String] {
        return ["\(home)/.claude", codexHome]
            .filter { Paths.isDirectory($0) }
            .map { "\($0)/skills/missiongo/SKILL.md" }
    }

    static func isSymlink(_ path: String) -> Bool {
        var info = stat()
        guard lstat(path, &info) == 0 else { return false }
        return (info.st_mode & S_IFMT) == S_IFLNK
    }

    /// Writes `skill` to each target that is missing it or holds an older
    /// version. A local copy that is newer, unreadable as a version, or a symlink
    /// is left alone: that is someone working on the Skill itself.
    public static func apply(skill: String, targets: [String]) throws -> Outcome {
        guard let remote = version(ofSkill: skill) else { throw SyncError.invalidSkill }
        var updated: [String] = []
        var failures: [String] = []
        for target in targets {
            let directory = (target as NSString).deletingLastPathComponent
            if isSymlink(target) || isSymlink(directory) { continue }
            if let data = FileManager.default.contents(atPath: target) {
                let local = version(ofSkill: String(decoding: data, as: UTF8.self))
                guard let local, isNewer(remote, than: local) else { continue }
            }
            do {
                try FileManager.default.createDirectory(atPath: directory, withIntermediateDirectories: true)
                try Data(skill.utf8).write(to: URL(fileURLWithPath: target), options: .atomic)
                updated.append(target)
            } catch {
                failures.append("\(target)：\(error.localizedDescription)")
            }
        }
        return Outcome(version: remote, updated: updated, failures: failures)
    }

    public static func run(
        serverUrl: String,
        targets: [String],
        session: URLSession = .shared
    ) async throws -> Outcome {
        guard let url = URL(string: serverUrl + downloadPath) else { throw SyncError.download("地址无效") }
        var request = URLRequest(url: url, timeoutInterval: 20)
        request.cachePolicy = .reloadIgnoringLocalCacheData
        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await session.data(for: request)
        } catch {
            throw SyncError.download(error.localizedDescription)
        }
        guard let http = response as? HTTPURLResponse, http.statusCode == 200 else {
            throw SyncError.download("HTTP \((response as? HTTPURLResponse)?.statusCode ?? 0)")
        }
        guard data.count <= maxBytes, let text = String(data: data, encoding: .utf8) else { throw SyncError.invalidSkill }
        return try apply(skill: text, targets: targets)
    }
}
