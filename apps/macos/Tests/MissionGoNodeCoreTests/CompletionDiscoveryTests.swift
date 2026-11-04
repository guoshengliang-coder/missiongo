import XCTest
@testable import MissionGoNodeCore

final class CompletionDiscoveryTests: XCTestCase {
    let comment = "00000000-0000-4000-8000-000000000001"
    func job(hints: [CompletionDiscoveryJob.Hint] = []) -> CompletionDiscoveryJob {
        .init(id: UUID().uuidString, productId: "product", itemKey: "AND-386", repoPath: "/example/repository", leaseToken: UUID().uuidString, hints: hints)
    }
    func testCommentPRIsResolvedInMappedRepositoryWithoutTrustingItsMergeClaim() async {
        let calls = Locked<[[String]]>([])
        let run: CommandRunner = { file, args in
            calls.withLock { $0.append([file] + args) }
            if args.contains("config") { return .init(code: 0, stdout: "git@github.com:example/project.git", stderr: "") }
            if args.contains("symbolic-ref") { return .init(code: 1, stdout: "", stderr: "") }
            if args.contains("list") { return .init(code: 0, stdout: "[]", stderr: "") }
            return .init(code: 0, stdout: "{\"url\":\"https://github.com/example/project/pull/385\",\"title\":\"Fix\",\"state\":\"OPEN\",\"mergedAt\":null}", stderr: "")
        }
        let result = await CompletionFinder.find(job(hints: [.init(kind: "github", value: "385", commentId: comment)]), run: run)
        XCTAssertEqual(result.candidates.count, 1)
        XCTAssertEqual(result.candidates.first?.state, "open")
        XCTAssertEqual(result.candidates.first?.commentId, comment)
        XCTAssertTrue(calls.current.contains(["gh", "pr", "view", "385", "--repo", "github.com/example/project", "--json", "url,title,state,mergedAt"]))
        XCTAssertFalse(calls.current.contains { $0.contains("sh") || $0.contains("fetch") })
    }
    func testForeignAndExecutableHintsAreIgnoredAndExactItemSearchIsUsed() async {
        let calls = Locked<[[String]]>([])
        let run: CommandRunner = { file, args in
            calls.withLock { $0.append([file] + args) }
            if args.contains("config") { return .init(code: 0, stdout: "https://github.com/example/project.git", stderr: "") }
            if args.contains("symbolic-ref") { return .init(code: 1, stdout: "", stderr: "") }
            if args.contains("list") { return .init(code: 0, stdout: "[{\"number\":42,\"title\":\"AND-3860 unrelated\",\"body\":\"\"},{\"number\":43,\"title\":\"AND-386 fix\",\"body\":\"\"}]", stderr: "") }
            return .init(code: 0, stdout: "{\"url\":\"https://github.com/example/project/pull/43\",\"title\":\"Fix\",\"state\":\"MERGED\"}", stderr: "")
        }
        let result = await CompletionFinder.find(job(hints: [
            .init(kind: "github", value: "https://github.com/other/project/pull/99", commentId: comment),
            .init(kind: "github", value: "$(touch /tmp/no)", commentId: comment)
        ]), run: run)
        XCTAssertEqual(result.candidates.first?.completion.url, "https://github.com/example/project/pull/43")
        XCTAssertNil(result.candidates.first?.commentId)
        XCTAssertFalse(calls.current.flatMap { $0 }.contains { $0.contains("touch") || $0 == "99" || $0 == "42" })
    }
    func testNestedGitLabSearchAndCommentMRUseTheMappedInstance() async {
        let calls = Locked<[[String]]>([])
        let run: CommandRunner = { file, args in
            calls.withLock { $0.append([file] + args) }
            if args.contains("config") { return .init(code: 0, stdout: "ssh://git@git.example.test/group/sub/project.git", stderr: "") }
            if args.contains("symbolic-ref") { return .init(code: 1, stdout: "", stderr: "") }
            if args.last?.contains("?") == true { return .init(code: 0, stdout: "[]", stderr: "") }
            return .init(code: 0, stdout: "{\"web_url\":\"https://git.example.test/group/sub/project/-/merge_requests/12\",\"title\":\"Fix\",\"state\":\"merged\"}", stderr: "")
        }
        let result = await CompletionFinder.find(job(hints: [.init(kind: "gitlab", value: "12", commentId: comment)]), run: run)
        XCTAssertEqual(result.candidates.first?.completion.kind, "gitlab")
        XCTAssertTrue(calls.current.contains(["glab", "api", "--hostname", "git.example.test", "projects/group%2Fsub%2Fproject/merge_requests/12"]))
    }
    func testExpandsShortCommitAndChecksItsPresenceInExplicitDefaultBranch() async {
        let full = String(repeating: "a", count: 40)
        let run: CommandRunner = { _, args in
            if args.contains("config") { return .init(code: 0, stdout: "https://github.com/example/project.git", stderr: "") }
            if args.contains("list") { return .init(code: 0, stdout: "[]", stderr: "") }
            if args.contains("symbolic-ref") { return .init(code: 0, stdout: "origin/trunk", stderr: "") }
            if args.contains("rev-parse") { return .init(code: 0, stdout: full, stderr: "") }
            return .init(code: 0, stdout: "", stderr: "")
        }
        let result = await CompletionFinder.find(job(hints: [.init(kind: "commit", value: "aaaaaaa", commentId: comment)]), run: run)
        XCTAssertEqual(result.candidates.first?.completion.commit, full)
        XCTAssertEqual(result.candidates.first?.completion.targetBranch, "trunk")
        XCTAssertEqual(result.candidates.first?.state, "integrated")
    }
    func testDiscoveryReportsSurviveRestartAndReplayBeforeClaimingAnotherJob() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let api = DiscoveryAPI(job: job())
        let run: CommandRunner = { _, args in
            if args.contains("config") { return .init(code: 0, stdout: "https://github.com/example/project.git", stderr: "") }
            if args.contains("list") { return .init(code: 0, stdout: "[]", stderr: "") }
            return .init(code: 1, stdout: "", stderr: "")
        }
        let repos = [RepoMapping(productId: "product", productKey: "AND", repoPath: "/example/repository")]
        do { try await CompletionDiscoveryWorker(root: root, run: run).tick(api: api, mappedRepos: repos); XCTFail("report should fail") } catch {}
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: root.path).count, 1)
        await api.allowReport()
        try await CompletionDiscoveryWorker(root: root, run: run).tick(api: api, mappedRepos: repos)
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: root.path).count, 0)
        let count = await api.reportCount
        XCTAssertEqual(count, 2)
    }
    func testPermissionFailureIsDistinctFromAnEmptySearch() async {
        let run: CommandRunner = { _, args in
            if args.contains("config") { return .init(code: 0, stdout: "https://github.com/example/project.git", stderr: "") }
            return .init(code: 1, stdout: "", stderr: "no login")
        }
        let result = await CompletionFinder.find(job(), run: run)
        XCTAssertEqual(result.failure, "permission_failed")
        XCTAssertTrue(result.candidates.isEmpty)
    }
}

private actor DiscoveryAPI: NodeAPI {
    var job: CompletionDiscoveryJob?
    var failing = true
    var reportCount = 0
    init(job: CompletionDiscoveryJob) { self.job = job }
    func allowReport() { failing = false }
    func claimCompletionDiscovery() async throws -> CompletionDiscoveryJob? { defer { job = nil }; return job }
    func reportCompletionDiscovery(id: String, leaseToken: String, result: CompletionDiscoveryResult) async throws {
        reportCount += 1
        if failing { throw APIError.http(operation: "discovery", status: 503, detail: "Temporary outage") }
    }
    func heartbeat(agents: [DetectedAgent], repoCandidates: [RepoCandidate]) async throws -> HeartbeatReply { fatalError("unused") }
    func claimNext(waitMs: Int, availableAgentKinds: [String]?) async throws -> DispatchRequest? { nil }
    func reportResult(dispatchId: String, report: DispatchReport) async throws {}
}
