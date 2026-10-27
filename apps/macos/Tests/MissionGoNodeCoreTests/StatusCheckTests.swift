import XCTest
@testable import MissionGoNodeCore

final class StatusCheckTests: XCTestCase {
    let merge = String(repeating: "a", count: 40)
    func job(required: [String]? = [], merged: Bool = false, url: String = "https://github.com/example/project/pull/42") -> StatusCheckJob {
        .init(id: UUID().uuidString, productId: "product", repoPath: "/example/repository", pullRequestUrl: url,
              requiredArtifacts: required, evidence: .init(merged: merged ? .init(commit: merge, occurredAt: "2026-10-26T01:00:00Z") : nil), leaseToken: UUID().uuidString)
    }
    func testReadsOnePRWithoutFetchAndRejectsAnotherRepository() async {
        let calls = Locked<[[String]]>([])
        let run: CommandRunner = { file,args in
            calls.withLock { $0.append([file]+args) }
            if file == "git" { return .init(code: 0, stdout: "git@github.com:example/project.git", stderr: "") }
            return .init(code: 0, stdout: "{\"state\":\"MERGED\",\"mergedAt\":\"2026-10-26T01:00:00Z\",\"mergeCommit\":{\"oid\":\"\(String(repeating: "a",count:40))\"}}", stderr: "")
        }
        let verified = await HandoverVerifier.verify(job(url:"https://github.com/example/project/pull/81"), run: run)
        XCTAssertEqual(verified.merged?.commit, merge)
        XCTAssertNil(verified.failure)
        XCTAssertEqual(calls.current.filter { $0.first == "gh" }.count, 1)
        XCTAssertFalse(calls.current.contains { $0.contains("fetch") })
        _ = await HandoverVerifier.verify(job(url:"https://github.com/example/project/pull/81"),run:run)
        XCTAssertEqual(calls.current.filter { $0.first == "gh" }.count,1)
        calls.withLock { $0.removeAll() }
        let foreign = await HandoverVerifier.verify(job(url: "https://github.com/other/project/pull/42"), run: run)
        XCTAssertEqual(foreign.failure, "permission_failed")
        XCTAssertFalse(calls.current.contains { $0.first == "gh" })
    }
    func testDoesNotQueryGitHubAgainForAnAlreadyVerifiedMerge() async {
        let calls = Locked<[[String]]>([])
        let run: CommandRunner = { file,args in
            calls.withLock { $0.append([file]+args) }
            return .init(code: 0, stdout: "https://github.com/example/project.git", stderr: "")
        }
        let result = await HandoverVerifier.verify(job(merged: true), run: run)
        XCTAssertEqual(result.merged?.commit, merge)
        XCTAssertFalse(calls.current.contains { $0.first == "gh" })
    }
    func testUnknownScopeAndOpenPRCannotBecomeCompletedWork() async {
        let run: CommandRunner = { file,_ in .init(code:0,stdout:file == "git" ? "https://github.com/example/project.git" : "{\"state\":\"OPEN\",\"mergedAt\":null,\"mergeCommit\":null}",stderr:"") }
        let open = await HandoverVerifier.verify(job(),run:run)
        XCTAssertEqual(open.failure,"waiting_merge"); XCTAssertNil(open.merged)
        let unknown = await HandoverVerifier.verify(job(required:nil,merged:true),run:run)
        XCTAssertEqual(unknown.failure,"evidence_missing")
    }
    func testRequiresPublicProofEvenWhenTheReleaseCommitEqualsTheMerge() async {
        let fixture = Data("{\"schemaVersion\":1,\"releases\":[{\"artifact\":\"web\",\"version\":\"1.0\",\"sourceCommit\":\"\(merge)\",\"proof\":{\"kind\":\"health\",\"url\":\"https://release.example.test/health\"}}]}".utf8)
        let run: CommandRunner = { _,args in .init(code:0,stdout:args.contains("config") ? "https://github.com/example/project.git" : ".git",stderr:"") }
        let denied = await HandoverVerifier.verify(job(required:["web"],merged:true),run:run,read:{ _ in fixture },prove:{ _ in false })
        XCTAssertEqual(denied.failure,"waiting_release"); XCTAssertEqual(denied.releases?.count,0)
        let accepted = await HandoverVerifier.verify(job(required:["web"],merged:true),run:run,read:{ _ in fixture },prove:{ _ in true })
        XCTAssertEqual(accepted.releases?.first?.containsMergeCommit,merge); XCTAssertNil(accepted.failure)
    }
    func testDoesNotReadUnrelatedOrAbsentPublicationFilesAsSuccess() async {
        let run: CommandRunner = { _,args in .init(code:0,stdout:args.contains("config") ? "https://github.com/example/project.git" : ".git",stderr:"") }
        let result = await HandoverVerifier.verify(job(required:["macosApp"],merged:true),run:run,read:{ _ in nil })
        XCTAssertEqual(result.failure,"waiting_release")
    }
    func testGitLabNestedProjectUsesMappedSelfHostedInstanceAndFractionalTimestamp() async {
        let calls = Locked<[[String]]>([])
        let run: CommandRunner = { file, args in
            calls.withLock { $0.append([file] + args) }
            if file == "git" { return .init(code: 0, stdout: "ssh://git@git.example.test:2222/group/sub/project.git", stderr: "") }
            return .init(code: 0, stdout: "{\"state\":\"merged\",\"merged_at\":\"2026-10-27T01:00:00.123Z\",\"merge_commit_sha\":\"\(String(repeating: "a", count: 40))\"}", stderr: "")
        }
        let result = await HandoverVerifier.verify(job(url: "https://git.example.test/group/sub/project/-/merge_requests/81"), run: run)
        XCTAssertEqual(result.merged?.commit, merge)
        XCTAssertNil(result.failure)
        XCTAssertTrue(calls.current.contains(["glab", "api", "--hostname", "git.example.test", "projects/group%2Fsub%2Fproject/merge_requests/81"]))
        XCTAssertFalse(calls.current.contains { $0.first == "gh" || $0.contains("fetch") })
    }
    func testRejectsForeignGitLabHostOrProjectBeforeUsingCredentials() async {
        let calls = Locked<[[String]]>([])
        let run: CommandRunner = { file, args in
            calls.withLock { $0.append([file] + args) }
            return .init(code: 0, stdout: "git@git.example.test:group/project.git", stderr: "")
        }
        for url in ["https://other.example.test/group/project/-/merge_requests/1", "https://git.example.test/other/project/-/merge_requests/1"] {
            let result = await HandoverVerifier.verify(job(url: url), run: run)
            XCTAssertEqual(result.failure, "permission_failed")
        }
        XCTAssertFalse(calls.current.contains { $0.first == "glab" })
    }
    func testGitLabFastForwardUsesMergedHeadWhenNoMergeCommitExists() async {
        let run: CommandRunner = { file, _ in
            if file == "git" { return .init(code: 0, stdout: "https://gitlab.com/group/project.git", stderr: "") }
            return .init(code: 0, stdout: "{\"state\":\"merged\",\"merged_at\":\"2026-10-27T01:00:00Z\",\"merge_commit_sha\":null,\"squash_commit_sha\":null,\"sha\":\"\(String(repeating: "b", count: 40))\"}", stderr: "")
        }
        let result = await HandoverVerifier.verify(job(url: "https://gitlab.com/group/project/-/merge_requests/82"), run: run)
        XCTAssertEqual(result.merged?.commit, String(repeating: "b", count: 40))
    }
    func testLocalCommitRequiresInclusionInTargetAndNeverReadsRemote() async {
        let calls = Locked<[[String]]>([])
        var local = job()
        local.completion = .init(kind: "commit", commit: merge, targetBranch: "main")
        let run: CommandRunner = { file, args in
            calls.withLock { $0.append([file] + args) }
            return .init(code: 0, stdout: args.contains("rev-parse") ? String(repeating: "b", count: 40) : "", stderr: "")
        }
        let result = await HandoverVerifier.verify(local, run: run)
        XCTAssertEqual(result.merged?.commit, merge)
        XCTAssertNil(result.failure)
        XCTAssertTrue(calls.current.contains { $0.contains("refs/heads/main^{commit}") })
        XCTAssertFalse(calls.current.contains { $0.first != "git" || $0.contains("config") || $0.contains("fetch") })
        let absent: CommandRunner = { _, args in .init(code: args.contains("merge-base") ? 1 : 0, stdout: String(repeating: "b", count: 40), stderr: "") }
        let rejected = await HandoverVerifier.verify(local, run: absent)
        XCTAssertEqual(rejected.failure, "waiting_merge")
        XCTAssertNil(rejected.merged)
    }
    func testLocalArtifactRequiresCommitContainmentAndPublicationProof() async {
        var local = job(required: ["cli"])
        local.completion = .init(kind: "commit", commit: merge, targetBranch: "main")
        let bytes = Data("{\"schemaVersion\":1,\"releases\":[{\"artifact\":\"cli\",\"version\":\"2\",\"sourceCommit\":\"\(String(repeating: "b",count:40))\",\"proof\":{\"kind\":\"sha256\",\"url\":\"https://release.example.test/cli\",\"sha256\":\"\(String(repeating:"c",count:64))\"}}]}".utf8)
        let run: CommandRunner = { _, args in
            .init(code: 0, stdout: args.contains("--git-common-dir") ? ".git" : String(repeating: "b",count:40), stderr: "")
        }
        let accepted = await HandoverVerifier.verify(local, run: run, read: { _ in bytes }, prove: { _ in true })
        XCTAssertEqual(accepted.releases?.first?.artifact, "cli")
        let denied = await HandoverVerifier.verify(local, run: run, read: { _ in bytes }, prove: { _ in false })
        XCTAssertEqual(denied.failure, "waiting_release")
    }
    func testRealLocalGitWithoutAnyRemoteRequiresIntegration() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let run = Commands.runner(environment: .init(path: "/usr/bin:/bin", base: ["GIT_CONFIG_NOSYSTEM":"1","GIT_CONFIG_GLOBAL":"/dev/null"]))
        func git(_ args: [String]) async throws -> String {
            let result = await run("git", ["-C", root.path] + args)
            guard result.code == 0 else { throw NSError(domain: "GitFixture", code: Int(result.code), userInfo: [NSLocalizedDescriptionKey:result.stderr]) }
            return result.stdout.trimmingCharacters(in: .whitespacesAndNewlines)
        }
        _ = try await git(["init", "--template=", "--initial-branch=main"])
        let identity = ["-c","user.name=Test","-c","user.email=test@example.test","-c","commit.gpgsign=false"]
        _ = try await git(identity + ["commit", "--allow-empty", "-m", "Base"])
        _ = try await git(["switch", "-c", "feature"])
        _ = try await git(identity + ["commit", "--allow-empty", "-m", "Fix"])
        let commit = try await git(["rev-parse", "HEAD"])
        _ = try await git(["switch", "main"])
        var local = StatusCheckJob(id: UUID().uuidString, productId: "product", repoPath: root.path, pullRequestUrl: "", requiredArtifacts: [], evidence: .init(), leaseToken: UUID().uuidString)
        local.completion = .init(kind: "commit", commit: commit, targetBranch: "main")
        let waiting = await HandoverVerifier.verify(local, run: run)
        XCTAssertEqual(waiting.failure, "waiting_merge")
        _ = try await git(["merge", "--ff-only", "feature"])
        let verified = await HandoverVerifier.verify(local, run: run)
        XCTAssertEqual(verified.merged?.commit, commit)
        XCTAssertNil(verified.failure)
    }
    func testManualReferenceNeverRunsAnAutomaticCheck() async {
        let calls = Locked<Int>(0)
        var manual = job()
        manual.completion = .init(kind: "manual", commit: merge, description: "Offline delivery")
        let run: CommandRunner = { _, _ in calls.withLock { $0 += 1 }; return .init(code: 0, stdout: "", stderr: "") }
        let result = await HandoverVerifier.verify(manual, run: run)
        XCTAssertNil(result.merged)
        XCTAssertEqual(calls.current, 0)
    }
    func testPersistsAnUnreportedObservationAndReplaysItAfterRestart() async throws {
        let root=FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer {try? FileManager.default.removeItem(at:root)}
        let api=CheckAPI(job:job(merged:true))
        let run:CommandRunner={_,_ in .init(code:0,stdout:"https://github.com/example/project.git",stderr:"")}
        do {try await StatusCheckWorker(root:root,run:run).tick(api:api,mappedRepos:[.init(productId:"product",productKey:"PRJ",repoPath:"/example/repository")]);XCTFail("Report should fail once")} catch {}
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath:root.path).count,1)
        await api.allowReport()
        try await StatusCheckWorker(root:root,run:run).tick(api:api,mappedRepos:[.init(productId:"product",productKey:"PRJ",repoPath:"/example/repository")])
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath:root.path).count,0)
        let count=await api.reportCount
        XCTAssertEqual(count,2)
    }
}
private actor CheckAPI: NodeAPI {
    var job:StatusCheckJob?
    var failing=true
    var reportCount=0
    init(job:StatusCheckJob){self.job=job}
    func allowReport(){failing=false}
    func claimStatusCheck() async throws -> StatusCheckJob? {defer{job=nil};return job}
    func reportStatusCheck(id:String,leaseToken:String,evidence:HandoverEvidence) async throws {
        reportCount += 1
        if failing {throw APIError.http(operation:"report",status:503,detail:"Temporary outage")}
    }
    func heartbeat(agents:[DetectedAgent],repoCandidates:[RepoCandidate]) async throws -> HeartbeatReply {fatalError("unused")}
    func claimNext(waitMs:Int,availableAgentKinds:[String]?) async throws -> DispatchRequest? {nil}
    func reportResult(dispatchId:String,report:DispatchReport) async throws {}
}
