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
