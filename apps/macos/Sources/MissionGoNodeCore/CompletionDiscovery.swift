import Foundation

public struct CompletionDiscoveryJob: Codable, Sendable {
    public struct Hint: Codable, Sendable {
        public let kind: String
        public let value: String
        public let commentId: String
    }
    public let id: String
    public let productId: String
    public let itemKey: String
    public let repoPath: String
    public let leaseToken: String
    public let hints: [Hint]
}
public struct CompletionCandidate: Codable, Sendable {
    public let completion: CompletionReference
    public let title: String
    public let state: String
    public let commentId: String?
}
public struct CompletionDiscoveryResult: Codable, Sendable {
    public var repository: String? = nil
    public var candidates: [CompletionCandidate] = []
    public var failure: String? = nil
}

/// Only fixed, argument-separated Git/host commands; comment text is never executed.
public enum CompletionFinder {
    public static func find(_ job: CompletionDiscoveryJob, run: @escaping CommandRunner) async -> CompletionDiscoveryResult {
        var result = CompletionDiscoveryResult()
        guard UUID(uuidString: job.id) != nil, UUID(uuidString: job.leaseToken) != nil,
              Paths.isAbsolute(job.repoPath), !job.repoPath.contains("\0"),
              AnchoredPattern("[A-Za-z][A-Za-z0-9_]*-[1-9][0-9]*").matches(job.itemKey) else {
            result.failure = "failed"; return result
        }
        let remote = await run("git", ["-C", job.repoPath, "config", "--get", "remote.origin.url"])
        guard remote.code == 0, let repo = HandoverVerifier.remoteIdentity(remote.stdout) else {
            result.failure = "permission_failed"; return result
        }
        let repository = "https://\(repo.host)/\(repo.path)"
        result.repository = repository
        let github = repo.host == "github.com" || job.hints.contains { $0.kind == "github" && $0.value.hasPrefix(repository + "/pull/") }
        let kind = github ? "github" : "gitlab"
        let prefix = repository + (github ? "/pull/" : "/-/merge_requests/")
        var authFailed = false
        var numbers: [(String, String?)] = []
        for hint in job.hints.prefix(30) where hint.kind == kind {
            let number = hint.value.hasPrefix(prefix) ? String(hint.value.dropFirst(prefix.count)) : hint.value
            guard AnchoredPattern("[1-9][0-9]{0,9}").matches(number), !numbers.contains(where: { $0.0 == number }) else { continue }
            numbers.append((number, hint.commentId))
        }
        // Search by the exact item key in the mapped host repository, with bounded results.
        let search: CommandResult
        if github {
            search = await run("gh", ["pr", "list", "--repo", "\(repo.host)/\(repo.path)", "--state", "all", "--search", "\(job.itemKey) in:title,body", "--limit", "20", "--json", "number,title,body"])
        } else {
            search = await run("glab", ["api", "--hostname", repo.host, "projects/\(repo.path.replacingOccurrences(of: "/", with: "%2F"))/merge_requests?scope=all&state=all&search=\(job.itemKey)&per_page=20"])
        }
        if search.code == 0, let rows = try? JSONSerialization.jsonObject(with: Data(search.stdout.utf8)) as? [[String: Any]] {
            for row in rows.prefix(20) {
                let text = "\(row["title"] as? String ?? "") \(row[github ? "body" : "description"] as? String ?? "")"
                guard text.range(of: "(?<![A-Za-z0-9_-])\(NSRegularExpression.escapedPattern(for: job.itemKey))(?![A-Za-z0-9_-])", options: [.regularExpression, .caseInsensitive]) != nil,
                      let number = row[github ? "number" : "iid"] as? Int, number > 0,
                      !numbers.contains(where: { $0.0 == String(number) }) else { continue }
                numbers.append((String(number), nil))
            }
        } else { authFailed = true }
        for (number, commentId) in numbers.prefix(20) {
            let response: CommandResult
            if github {
                response = await run("gh", ["pr", "view", number, "--repo", "\(repo.host)/\(repo.path)", "--json", "url,title,state,mergedAt"])
            } else {
                response = await run("glab", ["api", "--hostname", repo.host, "projects/\(repo.path.replacingOccurrences(of: "/", with: "%2F"))/merge_requests/\(number)"])
            }
            guard response.code == 0 else { authFailed = true; continue }
            guard let row = try? JSONSerialization.jsonObject(with: Data(response.stdout.utf8)) as? [String: Any],
                  let url = row[github ? "url" : "web_url"] as? String, url == prefix + number,
                  let title = row["title"] as? String, let state = row["state"] as? String else { continue }
            let lower = state.lowercased()
            guard ["merged", "open", "opened", "closed", "locked"].contains(lower) else { continue }
            result.candidates.append(.init(completion: .init(kind: kind, url: url), title: String(title.prefix(500)),
                state: lower == "merged" ? "merged" : ["open", "opened", "locked"].contains(lower) ? "open" : "closed", commentId: commentId))
        }
        // Local commits require an explicit repository default branch; never guess the target.
        let branchResult = await run("git", ["-C", job.repoPath, "symbolic-ref", "--short", "refs/remotes/origin/HEAD"])
        let remoteBranch = branchResult.stdout.trimmingCharacters(in: .whitespacesAndNewlines)
        if branchResult.code == 0, remoteBranch.hasPrefix("origin/") {
            let branch = String(remoteBranch.dropFirst(7))
            if AnchoredPattern("[A-Za-z0-9_][A-Za-z0-9_./-]{0,199}").matches(branch) {
                var commits: [(String, String?)] = job.hints.filter { $0.kind == "commit" && AnchoredPattern("[a-f0-9]{7,40}").matches($0.value) }.prefix(10).map { ($0.value, $0.commentId) }
                let log = await run("git", ["-C", job.repoPath, "log", "--all", "-n", "20", "--fixed-strings", "--grep", job.itemKey, "--format=%H%x09%s"])
                if log.code == 0 {
                    for line in log.stdout.split(separator: "\n").prefix(20) {
                        let fields = line.split(separator: "\t", maxSplits: 1)
                        if fields.count == 2, fields[1].range(of: "(?<![A-Za-z0-9_-])\(NSRegularExpression.escapedPattern(for: job.itemKey))(?![A-Za-z0-9_-])", options: .regularExpression) != nil { commits.append((String(fields[0]), nil)) }
                    }
                }
                var seen = Set<String>()
                for (ref, commentId) in commits.prefix(20) {
                    guard AnchoredPattern("[a-f0-9]{7,40}").matches(ref) else { continue }
                    let resolved = await run("git", ["-C", job.repoPath, "rev-parse", "--verify", "\(ref)^{commit}"])
                    let commit = resolved.stdout.trimmingCharacters(in: .whitespacesAndNewlines)
                    guard resolved.code == 0, AnchoredPattern("[a-f0-9]{40}").matches(commit), seen.insert(commit).inserted else { continue }
                    let contained = await run("git", ["-C", job.repoPath, "merge-base", "--is-ancestor", commit, "refs/heads/\(branch)"])
                    guard contained.code == 0 || contained.code == 1 else { continue }
                    result.candidates.append(.init(completion: .init(kind: "commit", commit: commit, targetBranch: branch), title: commit, state: contained.code == 0 ? "integrated" : "unmerged", commentId: commentId))
                }
            }
        }
        result.candidates = Array(result.candidates.prefix(30))
        if result.candidates.isEmpty && authFailed { result.failure = "permission_failed" }
        return result
    }
}

public actor CompletionDiscoveryWorker {
    let root: URL
    let run: CommandRunner
    struct Pending: Codable { let id: String; let leaseToken: String; let result: CompletionDiscoveryResult }
    public init(root: URL, run: @escaping CommandRunner) { self.root = root; self.run = run }
    public func tick(api: NodeAPI, mappedRepos: [RepoMapping]) async throws {
        let files = FileManager.default.fileExists(atPath: root.path) ? try FileManager.default.contentsOfDirectory(at: root, includingPropertiesForKeys: nil) : []
        for file in files.filter({ $0.pathExtension == "json" }).prefix(50) {
            guard let bytes = try? Data(contentsOf: file), bytes.count <= 1024 * 1024,
                  let pending = try? JSONDecoder().decode(Pending.self, from: bytes), UUID(uuidString: pending.id) != nil,
                  UUID(uuidString: pending.leaseToken) != nil else {
                try? FileManager.default.moveItem(at: file, to: file.appendingPathExtension("invalid")); continue
            }
            do {
                try await api.reportCompletionDiscovery(id: pending.id, leaseToken: pending.leaseToken, result: pending.result)
                try FileManager.default.removeItem(at: file)
            } catch APIError.http(_, let code, _) where [400, 404, 409].contains(code) { try FileManager.default.removeItem(at: file) }
            catch { continue }
        }
        guard let job = try await api.claimCompletionDiscovery() else { return }
        guard UUID(uuidString: job.id) != nil, UUID(uuidString: job.leaseToken) != nil else { throw APIError.invalidResponse("无效的查找任务标识。") }
        let mapped = mappedRepos.contains { $0.productId == job.productId && Paths.resolve($0.repoPath) == Paths.resolve(job.repoPath) }
        let result = mapped ? await CompletionFinder.find(job, run: run) : CompletionDiscoveryResult(failure: "permission_failed")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        let file = root.appendingPathComponent("\(job.id).json")
        try JSONEncoder().encode(Pending(id: job.id, leaseToken: job.leaseToken, result: result)).write(to: file, options: .atomic)
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: file.path)
        try await api.reportCompletionDiscovery(id: job.id, leaseToken: job.leaseToken, result: result)
        try FileManager.default.removeItem(at: file)
    }
}
