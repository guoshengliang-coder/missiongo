import CryptoKit
import Foundation

public struct ReleaseObservation: Codable, Sendable, Equatable {
    public let schemaVersion: Int
    public let id: String
    public let repository: String
    public let environment: String
    public let observedAt: String
    public let releases: [LocalReleaseEvidence.Release]
}

/// Publication files are immutable and shared by worktrees. Delivery acknowledgements are scoped
/// to the signed-in node/server, so changing accounts never silently reuses another login's ack.
public actor ReleaseObservationWorker {
    let root: URL
    let run: CommandRunner
    public init(root: URL, run: @escaping CommandRunner = Commands.runner(environment: ShellEnvironment.resolve())) {
        self.root = root; self.run = run
    }
    struct Delivery: Codable {
        var delivered = false
        var attempts = 0
        var nextAttempt = Date.distantPast
        var error: String? = nil
    }
    public func tick(api: NodeAPI, mappedRepos: [RepoMapping], now: Date = Date()) async throws {
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        var attempted = 0
        for mapping in mappedRepos {
            let common = await run("git", ["-C", mapping.repoPath, "rev-parse", "--git-common-dir"])
            guard common.code == 0 else { continue }
            let directory = common.stdout.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !directory.isEmpty else { continue }
            let outbox = URL(fileURLWithPath: Paths.join(Paths.resolve(directory, cwd: mapping.repoPath), "missiongo-release-outbox"))
            let remote = await run("git", ["-C", mapping.repoPath, "config", "--get", "remote.origin.url"])
            guard remote.code == 0, let identity = HandoverVerifier.remoteIdentity(remote.stdout) else { continue }
            let repository = "https://\(identity.host)/\(identity.path)"
            let files = (try? FileManager.default.contentsOfDirectory(at: outbox, includingPropertiesForKeys: [.isRegularFileKey,.isSymbolicLinkKey,.fileSizeKey])) ?? []
            for file in files.filter({$0.pathExtension == "json"}).sorted(by: {$0.lastPathComponent < $1.lastPathComponent}) {
                let key = SHA256.hash(data: Data("\(mapping.productId):\(file.path)".utf8)).map { String(format:"%02x",$0) }.joined()
                let journal = root.appendingPathComponent("\(key).json")
                var delivery = (try? Data(contentsOf: journal)).flatMap { try? JSONDecoder().decode(Delivery.self, from: $0) } ?? Delivery()
                if delivery.delivered || delivery.nextAttempt > now { continue }
                guard attempted < 20 else { return }
                attempted += 1
                do {
                    let metadata = try file.resourceValues(forKeys: [.isRegularFileKey,.isSymbolicLinkKey,.fileSizeKey])
                    guard metadata.isRegularFile == true, metadata.isSymbolicLink != true,
                          (metadata.fileSize ?? Int.max) <= 1024*1024 else { throw LaunchError("Invalid release observation file") }
                    let observation = try JSONDecoder().decode(ReleaseObservation.self, from: Data(contentsOf: file))
                    guard observation.schemaVersion == 2, UUID(uuidString: observation.id) != nil,
                          observation.repository == repository, observation.releases.count <= 20 else {
                        throw LaunchError("Release observation does not match the mapped repository")
                    }
                    // This endpoint only stores an observation. The leased status worker independently
                    // rechecks live proof and commit ancestry before any work item changes status.
                    try await api.uploadReleaseObservation(productId: mapping.productId, repoPath: mapping.repoPath, observation: observation)
                    delivery.delivered = true; delivery.error = nil
                } catch {
                    delivery.attempts = min(delivery.attempts + 1, 10)
                    delivery.nextAttempt = now.addingTimeInterval(min(30 * pow(2, Double(delivery.attempts-1)), 1800))
                    // Do not persist response bodies: they may contain URLs or authentication material.
                    delivery.error = "发布凭据上传未完成，将自动重试。"
                }
                try JSONEncoder().encode(delivery).write(to: journal, options: .atomic)
                try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: journal.path)
            }
        }
    }
}
