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

public struct StatusCheckJob: Codable, Equatable, Sendable {
    public let id: String
    public let productId: String
    public let repoPath: String
    public let pullRequestUrl: String
    public let requiredArtifacts: [String]?
    public let evidence: HandoverEvidence
    public let leaseToken: String
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

    /// No shell, git fetch, checkout, or server-provided command is executed.
    public static func repository(_ remote: String) -> String? {
        let value = remote.trimmingCharacters(in: .whitespacesAndNewlines)
        let prefix: String
        if value.hasPrefix("git@github.com:") { prefix = "git@github.com:" }
        else if value.hasPrefix("https://github.com/") { prefix = "https://github.com/" }
        else if value.hasPrefix("ssh://git@github.com/") { prefix = "ssh://git@github.com/" }
        else { return nil }
        var repo = String(value.dropFirst(prefix.count))
        if repo.hasSuffix(".git") { repo = String(repo.dropLast(4)) }
        guard AnchoredPattern("[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+").matches(repo) else { return nil }
        return repo
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
        let remote = await run("git", ["-C", job.repoPath, "config", "--get", "remote.origin.url"])
        guard remote.code == 0, let repo = repository(remote.stdout),
              job.pullRequestUrl.lowercased().trimmingCharacters(in: CharacterSet(charactersIn: "/"))
                .hasPrefix("https://github.com/\(repo.lowercased())/pull/") else { result.failure = "permission_failed"; return result }
        let number = job.pullRequestUrl.split(separator: "/").last.map(String.init) ?? ""
        guard AnchoredPattern("[1-9][0-9]*").matches(number) else { result.failure = "failed"; return result }
        let cacheKey = "\(repo.lowercased()):\(number)"
        var merged = job.evidence.merged ?? mergedCache.current[cacheKey]
        if merged == nil {
            let response = await run("gh", ["pr", "view", number, "--repo", repo, "--json", "state,mergedAt,mergeCommit"])
            guard response.code == 0 else { result.failure = "permission_failed"; return result }
            struct PR: Decodable { let state: String; let mergedAt: String?; let mergeCommit: Commit?; struct Commit: Decodable { let oid: String } }
            guard let pr = try? JSONDecoder().decode(PR.self, from: Data(response.stdout.utf8)) else { result.failure = "failed"; return result }
            guard pr.state == "MERGED", let at = pr.mergedAt, let commit = pr.mergeCommit?.oid,
                  commitPattern.matches(commit), ISO8601DateFormatter().date(from: at) != nil else { result.failure = "waiting_merge"; return result }
            merged = .init(commit: commit, occurredAt: at)
            mergedCache.withLock { if $0.count > 1000 { $0.removeAll() }; $0[cacheKey] = merged }
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
            let containment = await containsMerge(repo: repo, merge: merged.commit, source: release.sourceCommit, run: run)
            if containment == .unavailable { result.failure = "permission_failed"; continue }
            guard containment == .contains, await prove(release) else { continue }
            releases.append(.init(artifact: artifact, version: release.version, sourceCommit: release.sourceCommit,
                containsMergeCommit: merged.commit, verifiedAt: ISO8601DateFormatter().string(from: Date()), receiptDigest: digest))
        }
        result.releases = releases
        if releases.count != required.count && result.failure == nil { result.failure = "waiting_release" }
        return result
    }

    private enum Containment { case contains, absent, unavailable }
    private static let ancestryCache = Locked<Set<String>>([])
    private static func containsMerge(repo: String, merge: String, source: String, run: CommandRunner) async -> Containment {
        if merge == source { return .contains }
        let key = "\(repo):\(merge):\(source)"
        if ancestryCache.current.contains(key) { return .contains }
        let response = await run("gh", ["api", "repos/\(repo)/compare/\(merge)...\(source)", "--jq", ".status"])
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
