import XCTest
@testable import MissionGoNodeCore

final class ReleaseObservationTests: XCTestCase {
    let source = String(repeating:"b",count:40)
    func observation(repository: String = "https://git.example.test/group/project", environment: String = "production") -> ReleaseObservation {
        .init(schemaVersion:2,id:UUID().uuidString,repository:repository,environment:environment,observedAt:"2026-10-31T05:00:00.000Z",
              releases:[.init(artifact:"web",version:"1.0",sourceCommit:source,proof:.init(kind:"health",url:"https://release.example.test/health",sha256:nil))])
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
