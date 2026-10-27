import CryptoKit
import Foundation

public struct HandoverEvidence: Codable, Equatable, Sendable {
    public struct Merge: Codable, Equatable, Sendable {
        public let commit: String
        public let occurredAt: String
    }
    public struct Release: Codable, Equatable, Sendable {
        public let artifact: String
        public let version: String
        public let sourceCommit: String
        public let containsMergeCommit: String
        public let verifiedAt: String
        public let receiptDigest: String
    }
    public var merged: Merge?
    public var releases: [Release]?
    public var failure: String?
}

public struct CompletionReference: Codable, Equatable, Sendable {
    public let kind: String
    public var url: String? = nil
    public var commit: String? = nil
    public var targetBranch: String? = nil
    public var description: String? = nil
}

public struct StatusCheckJob: Codable, Equatable, Sendable {
    public let id: String
    public let productId: String
    public let repoPath: String
    public let pullRequestUrl: String
    public let requiredArtifacts: [String]?
    public let evidence: HandoverEvidence
    public let leaseToken: String
    public var completion: CompletionReference? = nil
}

/// This file is publication evidence produced by a publisher, not a file-to-artifact map.
/// Keep it in the git common directory so worktrees and the mapped checkout share it.
public struct LocalReleaseEvidence: Codable, Sendable {
    public struct Release: Codable, Sendable {
        public struct Proof: Codable, Sendable {
            public let kind: String
            public let url: String
            public let sha256: String?
        }
        public let artifact: String
        public let version: String
        public let sourceCommit: String
        public let proof: Proof
    }
    public let schemaVersion: Int
    public let releases: [Release]
}

public enum HandoverVerifier {
    static let commitPattern = AnchoredPattern("[a-f0-9]{40}")
    static let digestPattern = AnchoredPattern("[a-f0-9]{64}")

    /// Bind every hosted request to the mapped repository's remote, including self-hosted GitLab.
    static func remoteIdentity(_ remote: String) -> (host: String, path: String)? {
        let value = remote.trimmingCharacters(in: .whitespacesAndNewlines)
        let host: String
        var path: String
        if let url = URL(string: value), ["https", "ssh"].contains(url.scheme ?? ""), let name = url.host {
            host = name.lowercased() + (url.scheme == "ssh" ? "" : url.port.map { ":\($0)" } ?? "")
            path = String(url.path.drop(while: { $0 == "/" }))
        } else if value.hasPrefix("git@"), let colon = value.firstIndex(of: ":") {
            host = String(value[value.index(value.startIndex, offsetBy: 4)..<colon]).lowercased()
            path = String(value[value.index(after: colon)...])
        } else { return nil }
        if path.hasSuffix(".git") { path = String(path.dropLast(4)) }
        guard AnchoredPattern("[A-Za-z0-9.-]+(?::[0-9]+)?").matches(host),
              AnchoredPattern("[A-Za-z0-9_.-]+(?:/[A-Za-z0-9_.-]+)+").matches(path),
              !path.split(separator: "/").contains(where: { $0 == "." || $0 == ".." }) else { return nil }
        return (host, path)
    }
    public static func repository(_ remote: String) -> String? {
        guard let identity = remoteIdentity(remote), identity.host == "github.com" else { return nil }
        return identity.path
    }

    private static func currentTimestamp() -> String {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions.insert(.withFractionalSeconds)
        return formatter.string(from: Date())
    }
    private static func validTimestamp(_ value: String) -> Bool {
        let formatter = ISO8601DateFormatter()
        if formatter.date(from: value) != nil { return true }
        formatter.formatOptions.insert(.withFractionalSeconds)
        return formatter.date(from: value) != nil
    }
    private static let mergedCache = Locked<[String:HandoverEvidence.Merge]>([:])
    public static func verify(
        _ job: StatusCheckJob, run: CommandRunner,
        read: @Sendable (String) -> Data? = { path in
            guard let size = (try? FileManager.default.attributesOfItem(atPath: path)[.size]) as? NSNumber,
                  size.intValue <= 1024 * 1024 else { return nil }
            return try? Data(contentsOf: URL(fileURLWithPath: path))
        },
        prove: @Sendable (LocalReleaseEvidence.Release) async -> Bool = { await publicProof($0) }
    ) async -> HandoverEvidence {
        var result = HandoverEvidence()
        guard Paths.isAbsolute(job.repoPath), !job.repoPath.contains("\0"), UUID(uuidString: job.id) != nil,
              UUID(uuidString: job.leaseToken) != nil else { result.failure = "failed"; return result }
        let reference = job.completion ?? CompletionReference(kind: job.pullRequestUrl.contains("/-/merge_requests/") ? "gitlab" : "github", url: job.pullRequestUrl)
        if reference.kind == "manual" { result.failure = "evidence_missing"; return result }
        var identity: (host: String, path: String)?
        var merged: HandoverEvidence.Merge?
        if reference.kind == "commit" {
            guard let commit = reference.commit, commitPattern.matches(commit), let branch = reference.targetBranch,
                  AnchoredPattern("[A-Za-z0-9_][A-Za-z0-9_./-]{0,199}").matches(branch) else { result.failure = "failed"; return result }
            let ref = branch.hasPrefix("refs/heads/") ? branch : "refs/heads/\(branch)"
            let valid = await run("git", ["-C", job.repoPath, "check-ref-format", ref])
            guard valid.code == 0 else { result.failure = "failed"; return result }
            let target = await run("git", ["-C", job.repoPath, "rev-parse", "--verify", "\(ref)^{commit}"])
            let tip = target.stdout.trimmingCharacters(in: .whitespacesAndNewlines)
            guard target.code == 0, commitPattern.matches(tip) else { result.failure = "evidence_missing"; return result }
            let included = await run("git", ["-C", job.repoPath, "merge-base", "--is-ancestor", commit, tip])
            guard included.code == 0 else { result.failure = included.code == 1 ? "waiting_merge" : "evidence_missing"; return result }
            merged = job.evidence.merged ?? .init(commit: commit, occurredAt: currentTimestamp())
        } else {
            guard ["github", "gitlab"].contains(reference.kind), let rawURL = reference.url, let url = URL(string: rawURL),
                  url.scheme == "https", let host = url.host, url.user == nil, url.password == nil, url.query == nil, url.fragment == nil else { result.failure = "failed"; return result }
            let remote = await run("git", ["-C", job.repoPath, "config", "--get", "remote.origin.url"])
            guard remote.code == 0, let repo = remoteIdentity(remote.stdout),
                  repo.host == host.lowercased() + (url.port.map { ":\($0)" } ?? "") else { result.failure = "permission_failed"; return result }
            identity = repo
            let prefix = "/\(repo.path)/" + (reference.kind == "github" ? "pull/" : "-/merge_requests/")
            let pathname = url.path.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
            guard ("/" + pathname).lowercased().hasPrefix(prefix.lowercased()) else { result.failure = "permission_failed"; return result }
            let number = String(("/" + pathname).dropFirst(prefix.count))
            guard AnchoredPattern("[1-9][0-9]*").matches(number) else { result.failure = "failed"; return result }
            let cacheKey = "\(reference.kind):\(repo.host):\(repo.path.lowercased()):\(number)"
            merged = job.evidence.merged ?? mergedCache.current[cacheKey]
            if merged == nil {
                if reference.kind == "github" {
                    let response = await run("gh", ["pr", "view", number, "--repo", "\(repo.host)/\(repo.path)", "--json", "state,mergedAt,mergeCommit"])
                    guard response.code == 0 else { result.failure = "permission_failed"; return result }
                    struct PR: Decodable { let state: String; let mergedAt: String?; let mergeCommit: Commit?; struct Commit: Decodable { let oid: String } }
                    guard let pr = try? JSONDecoder().decode(PR.self, from: Data(response.stdout.utf8)) else { result.failure = "failed"; return result }
                    guard pr.state == "MERGED", let at = pr.mergedAt, let commit = pr.mergeCommit?.oid,
                          commitPattern.matches(commit), validTimestamp(at) else { result.failure = "waiting_merge"; return result }
                    merged = .init(commit: commit, occurredAt: at)
                } else {
                    let project = repo.path.replacingOccurrences(of: "/", with: "%2F")
                    let response = await run("glab", ["api", "--hostname", repo.host, "projects/\(project)/merge_requests/\(number)"])
                    guard response.code == 0 else { result.failure = "permission_failed"; return result }
                    struct MR: Decodable { let state: String; let merged_at: String?; let merge_commit_sha: String?; let squash_commit_sha: String?; let sha: String? }
                    guard let mr = try? JSONDecoder().decode(MR.self, from: Data(response.stdout.utf8)) else { result.failure = "failed"; return result }
                    guard mr.state == "merged", let at = mr.merged_at, let commit = mr.merge_commit_sha ?? mr.squash_commit_sha ?? mr.sha,
                          commitPattern.matches(commit), validTimestamp(at) else { result.failure = "waiting_merge"; return result }
                    merged = .init(commit: commit, occurredAt: at)
                }
                mergedCache.withLock { if $0.count > 1000 { $0.removeAll() }; $0[cacheKey] = merged }
            }
        }
        guard let merged, commitPattern.matches(merged.commit) else { result.failure = "evidence_missing"; return result }
        result.merged = merged
        guard let required = job.requiredArtifacts else { result.failure = "evidence_missing"; return result }
        if required.isEmpty { return result }
        let common = await run("git", ["-C", job.repoPath, "rev-parse", "--git-common-dir"])
        let directory = common.stdout.trimmingCharacters(in: .whitespacesAndNewlines)
        guard common.code == 0, !directory.isEmpty else { result.failure = "evidence_missing"; return result }
        let path = Paths.join(Paths.resolve(directory, cwd: job.repoPath), "missiongo-release-evidence.json")
        guard let bytes = read(path), let receipt = try? JSONDecoder().decode(LocalReleaseEvidence.self, from: bytes),
              receipt.schemaVersion == 1, receipt.releases.count <= 20 else { result.failure = "waiting_release"; return result }
        let digest = SHA256.hash(data: bytes).map { String(format: "%02x", $0) }.joined()
        var releases: [HandoverEvidence.Release] = []
        for artifact in required {
            guard let release = receipt.releases.first(where: { $0.artifact == artifact }),
                  commitPattern.matches(release.sourceCommit), !release.version.isEmpty, release.version.count <= 100 else { continue }
            // An immutable commit pair is checked once and shared across this node's jobs.
            let containment = await containsMerge(repoPath: job.repoPath, host: identity?.host, repo: identity?.path, kind: reference.kind, merge: merged.commit, source: release.sourceCommit, run: run)
            if containment == .unavailable { result.failure = "permission_failed"; continue }
            guard containment == .contains, await prove(release) else { continue }
            releases.append(.init(artifact: artifact, version: release.version, sourceCommit: release.sourceCommit,
                containsMergeCommit: merged.commit, verifiedAt: currentTimestamp(), receiptDigest: digest))
        }
        result.releases = releases
        if releases.count != required.count && result.failure == nil { result.failure = "waiting_release" }
        return result
    }

    private enum Containment { case contains, absent, unavailable }
    private static let ancestryCache = Locked<Set<String>>([])
    private static func containsMerge(repoPath: String, host: String?, repo: String?, kind: String, merge: String, source: String, run: CommandRunner) async -> Containment {
        if merge == source { return .contains }
        let key = "\(repoPath):\(host ?? "local"):\(repo ?? ""):\(merge):\(source)"
        if ancestryCache.current.contains(key) { return .contains }
        let local = await run("git", ["-C", repoPath, "merge-base", "--is-ancestor", merge, source])
        if local.code == 0 { ancestryCache.withLock { $0.insert(key) }; return .contains }
        if local.code == 1 { return .absent }
        guard kind == "github", let host, let repo else { return .unavailable }
        let response = await run("gh", ["api", "--hostname", host, "repos/\(repo)/compare/\(merge)...\(source)", "--jq", ".status"])
        guard response.code == 0 else { return .unavailable }
        guard ["ahead", "identical"].contains(response.stdout.trimmingCharacters(in: .whitespacesAndNewlines)) else { return .absent }
        ancestryCache.withLock { if $0.count > 1000 { $0.removeAll() }; $0.insert(key) }
        return .contains
    }

    private static let proofCache = Locked<[String: Date]>([:])
    public static func publicProof(_ release: LocalReleaseEvidence.Release) async -> Bool {
        guard let url = URL(string: release.proof.url), url.scheme == "https", url.host != nil,
              url.user == nil, url.password == nil, url.fragment == nil else { return false }
        let key = "\(url.absoluteString):\(release.sourceCommit):\(release.proof.sha256 ?? "")"
        if let checked = proofCache.current[key], Date().timeIntervalSince(checked) < 300 { return true }
        let session = URLSession(configuration: .ephemeral, delegate: HandoverNoRedirects(), delegateQueue: nil)
        defer { session.finishTasksAndInvalidate() }
        var request = URLRequest(url: url); request.timeoutInterval = 120
        do {
            if release.proof.kind == "health" {
                let (data, response) = try await session.data(for: request)
                guard (response as? HTTPURLResponse)?.statusCode == 200, data.count <= 1024 * 1024,
                      let health = try JSONSerialization.jsonObject(with: data) as? [String: Any],
                      health["status"] as? String == "ok", health["release"] as? String == release.sourceCommit else { return false }
            } else if release.proof.kind == "sha256", let expected = release.proof.sha256, digestPattern.matches(expected) {
                let (file, response) = try await session.download(for: request)
                defer { try? FileManager.default.removeItem(at: file) }
                guard (response as? HTTPURLResponse)?.statusCode == 200,
                      let size = (try FileManager.default.attributesOfItem(atPath: file.path)[.size]) as? NSNumber,
                      size.intValue <= 512 * 1024 * 1024 else { return false }
                let handle = try FileHandle(forReadingFrom: file); defer { try? handle.close() }
                var hash = SHA256()
                while let chunk = try handle.read(upToCount: 1024 * 1024), !chunk.isEmpty { hash.update(data: chunk) }
                guard hash.finalize().map({ String(format: "%02x", $0) }).joined() == expected else { return false }
            } else { return false }
            proofCache.withLock { if $0.count > 1000 { $0.removeAll() }; $0[key] = Date() }
            return true
        } catch { return false }
    }
}

private final class HandoverNoRedirects: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) { completionHandler(nil) }
}

/// Write the observation before sending it. The next run retries the same bytes after a crash.
public actor StatusCheckWorker {
    let root: URL
    let run: CommandRunner
    public init(root: URL, run: @escaping CommandRunner = Commands.runner(environment: ShellEnvironment.resolve())) {
        self.root = root; self.run = run
    }
    struct Pending: Codable { let id: String; let leaseToken: String; let evidence: HandoverEvidence }
    public func tick(api: NodeAPI, mappedRepos: [RepoMapping]) async throws {
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        let files = try FileManager.default.contentsOfDirectory(at: root, includingPropertiesForKeys: nil).filter { $0.pathExtension == "json" }
        for file in files.prefix(50) {
            guard let bytes = try? Data(contentsOf: file), bytes.count <= 1024 * 1024,
                  let pending = try? JSONDecoder().decode(Pending.self, from: bytes), UUID(uuidString: pending.id) != nil else {
                // Preserve malformed local records for inspection without stalling the queue.
                try? FileManager.default.moveItem(at:file,to:file.appendingPathExtension("invalid"))
                continue
            }
            do {
                try await api.reportStatusCheck(id: pending.id, leaseToken: pending.leaseToken, evidence: pending.evidence)
                try FileManager.default.removeItem(at: file)
            } catch APIError.http(_, let status, _) where status == 404 || status == 409 {
                // The service invalidated this lease/round. A fresh claim supplies a new lease.
                try FileManager.default.removeItem(at: file)
            }
        }
        guard let job = try await api.claimStatusCheck() else { return }
        guard UUID(uuidString: job.id) != nil, UUID(uuidString: job.leaseToken) != nil else {
            throw APIError.invalidResponse("无效的状态检查任务标识。")
        }
        let mapped = mappedRepos.contains { $0.productId == job.productId && Paths.resolve($0.repoPath) == Paths.resolve(job.repoPath) }
        let evidence = mapped ? await HandoverVerifier.verify(job, run: run) : HandoverEvidence(failure: "permission_failed")
        let file = root.appendingPathComponent("\(job.id).json")
        let bytes = try JSONEncoder().encode(Pending(id: job.id, leaseToken: job.leaseToken, evidence: evidence))
        try bytes.write(to: file, options: .atomic)
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: file.path)
        try await api.reportStatusCheck(id: job.id, leaseToken: job.leaseToken, evidence: evidence)
        try FileManager.default.removeItem(at: file)
    }
}
