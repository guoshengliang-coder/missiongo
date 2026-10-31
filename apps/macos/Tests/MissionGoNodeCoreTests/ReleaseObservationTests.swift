import XCTest
@testable import MissionGoNodeCore

final class ReleaseObservationTests: XCTestCase {
    let merge = String(repeating:"a",count:40), source = String(repeating:"b",count:40)
    func observation(repository: String = "https://git.example.test/group/project", environment: String = "production") -> ReleaseObservation {
        .init(schemaVersion:2,id:UUID().uuidString,repository:repository,environment:environment,observedAt:"2026-10-31T05:00:00.000Z",
              releases:[.init(artifact:"web",version:"1.0",sourceCommit:source,proof:.init(kind:"health",url:"https://release.example.test/health",sha256:nil))])
    }
    func job(_ publication: ReleaseObservation) -> StatusCheckJob {
        var value = StatusCheckJob(id:UUID().uuidString,productId:"product",repoPath:"/example/\(UUID().uuidString)",
            pullRequestUrl:"https://git.example.test/group/project/-/merge_requests/77",requiredArtifacts:["web"],
            evidence:.init(merged:.init(commit:merge,occurredAt:"2026-10-31T04:00:00.000Z")),leaseToken:UUID().uuidString)
        value.sharedRelease = publication
        return value
    }
    func testSharedProofNeedsNoLocalReceiptAndGitLabFallsBackToAPI() async {
        let calls = Locked<[[String]]>([]), reads = Locked(0)
        let expectedMerge = merge
        let run: CommandRunner = { command,args in
            calls.withLock {$0.append([command]+args)}
            if args.contains("config") {return .init(code:0,stdout:"git@git.example.test:group/project.git",stderr:"")}
            if command == "git" {return .init(code:128,stdout:"",stderr:"Object absent")}
            return .init(code:0,stdout:"{\"id\":\"\(expectedMerge)\"}",stderr:"")
        }
        let fact=observation()
        let result=await HandoverVerifier.verify(job(fact),run:run,read:{_ in reads.withLock {$0 += 1}; return nil},prove:{_ in true})
        XCTAssertNil(result.failure); XCTAssertEqual(result.sharedReleaseId,fact.id)
        XCTAssertEqual(result.releases?.first?.containsMergeCommit,merge); XCTAssertEqual(reads.current,0)
        XCTAssertTrue(calls.current.contains {$0.first == "glab" && $0.last!.contains("repository/merge_base?refs[]=")})
        XCTAssertFalse(calls.current.contains {$0.contains("fetch") || $0.first == "gh"})
    }
    func testGitLabAbsentAncestorOrUnavailableAPIDoesNotProveRelease() async {
        for (apiCode,base,expected) in [(Int32(0),source,"waiting_release"),(Int32(1),merge,"permission_failed")] {
            let run: CommandRunner = { command,args in
                if args.contains("config") {return .init(code:0,stdout:"git@git.example.test:group/project.git",stderr:"")}
                if command == "git" {return .init(code:128,stdout:"",stderr:"")}
                return .init(code:apiCode,stdout:"{\"id\":\"\(base)\"}",stderr:"")
            }
            let result=await HandoverVerifier.verify(job(observation()),run:run,prove:{_ in true})
            XCTAssertEqual(result.failure,expected); XCTAssertEqual(result.releases?.count,0)
        }
    }
    func testRepositoryEnvironmentAndLiveProofMustMatch() async {
        let run: CommandRunner = {_,args in .init(code:0,stdout:args.contains("config") ? "git@git.example.test:group/project.git" : "",stderr:"")}
        for fact in [observation(repository:"https://git.example.test/other/project"),observation(environment:"staging")] {
            let result=await HandoverVerifier.verify(job(fact),run:run,prove:{_ in true})
            XCTAssertEqual(result.detail,"repository_mismatch"); XCTAssertNil(result.releases)
        }
        let failed=await HandoverVerifier.verify(job(observation()),run:run,prove:{_ in false})
        XCTAssertEqual(failed.detail,"proof_failed"); XCTAssertEqual(failed.releases?.count,0)
        let verified=await HandoverVerifier.verify(job(observation()),run:run,prove:{_ in true})
        XCTAssertEqual(verified.releases?.count,1)
    }
    func testShallowGitDoesNotMistakeMissingHistoryForNonContainment() async {
        let expected = merge
        let calls = Locked<[String]>([])
        let run: CommandRunner = {command,args in
            if args.contains("config") {return .init(code:0,stdout:"git@git.example.test:group/project.git",stderr:"")}
            if args.contains("--is-shallow-repository") {return .init(code:0,stdout:"true",stderr:"")}
            if command == "git" {return .init(code:1,stdout:"",stderr:"")}
            calls.withLock {$0.append(command)}
            return .init(code:0,stdout:"{\"id\":\"\(expected)\"}",stderr:"")
        }
        let result = await HandoverVerifier.verify(job(observation()),run:run,prove:{_ in true})
        XCTAssertNil(result.failure); XCTAssertEqual(calls.current,["glab"])
    }

    func testDurableDeliveryRetriesAfterRestartAndDoesNotBlockOtherFiles() async throws {
        let root=FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer {try? FileManager.default.removeItem(at:root)}
        let outbox=root.appendingPathComponent("common/missiongo-release-outbox")
        try FileManager.default.createDirectory(at:outbox,withIntermediateDirectories:true)
        let first=observation(), second=observation()
        for fact in [first,second] {try JSONEncoder().encode(fact).write(to:outbox.appendingPathComponent("\(fact.id).json"))}
        let common=root.appendingPathComponent("common").path
        let run: CommandRunner = {_,args in .init(code:0,stdout:args.contains("config") ? "git@git.example.test:group/project.git" : common,stderr:"")}
        let mapping=RepoMapping(productId:"product",productKey:"PRJ",repoPath:"/example/repository")
        let api=ReleaseTestAPI(failing:first.id), journal=root.appendingPathComponent("journal"), now=Date()
        try await ReleaseObservationWorker(root:journal,run:run).tick(api:api,mappedRepos:[mapping],now:now)
        let attempts=await api.attempts; XCTAssertEqual(attempts.count,2); XCTAssertTrue(attempts.contains(second.id))
        await api.recover()
        try await ReleaseObservationWorker(root:journal,run:run).tick(api:api,mappedRepos:[mapping],now:now.addingTimeInterval(10))
        let early=await api.attempts; XCTAssertEqual(early.count,2)
        try await ReleaseObservationWorker(root:journal,run:run).tick(api:api,mappedRepos:[mapping],now:now.addingTimeInterval(31))
        let recovered=await api.attempts
        XCTAssertEqual(recovered.filter {$0 == first.id}.count,2); XCTAssertEqual(recovered.filter {$0 == second.id}.count,1)
        try await ReleaseObservationWorker(root:root.appendingPathComponent("another-login"),run:run).tick(api:api,mappedRepos:[mapping],now:now)
        let another=await api.attempts; XCTAssertEqual(another.count,5)
    }
    func testMalformedAndForeignReceiptsArePreservedWithoutUpload() async throws {
        let root=FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer {try? FileManager.default.removeItem(at:root)}
        let outbox=root.appendingPathComponent("missiongo-release-outbox")
        try FileManager.default.createDirectory(at:outbox,withIntermediateDirectories:true)
        try Data("broken".utf8).write(to:outbox.appendingPathComponent("broken.json"))
        try JSONEncoder().encode(observation(repository:"https://other.example.test/team/project")).write(to:outbox.appendingPathComponent("foreign.json"))
        let path=root.path
        let run: CommandRunner = {_,args in .init(code:0,stdout:args.contains("config") ? "git@git.example.test:group/project.git" : path,stderr:"")}
        let api=ReleaseTestAPI(failing:nil)
        try await ReleaseObservationWorker(root:root.appendingPathComponent("journal"),run:run).tick(api:api,mappedRepos:[.init(productId:"product",productKey:"PRJ",repoPath:"/example/repository")])
        let attempts=await api.attempts; XCTAssertEqual(attempts.count,0)
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath:outbox.path).count,2)
    }
}
private actor ReleaseTestAPI: NodeAPI {
    var failing: String?; var attempts: [String]=[]
    init(failing:String?) {self.failing=failing}
    func recover() {failing=nil}
    func uploadReleaseObservation(productId:String,repoPath:String,observation:ReleaseObservation) async throws {
        attempts.append(observation.id)
        if observation.id == failing {throw APIError.http(operation:"upload",status:503,detail:"temporary")}
    }
    func heartbeat(agents:[DetectedAgent],repoCandidates:[RepoCandidate]) async throws -> HeartbeatReply {fatalError("unused")}
    func claimNext(waitMs:Int,availableAgentKinds:[String]?) async throws -> DispatchRequest? {nil}
    func reportResult(dispatchId:String,report:DispatchReport) async throws {}
}
