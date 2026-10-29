import Foundation
import XCTest
@testable import MissionGoNodeCore

final class AgentArtifactTests: XCTestCase {
    func testNodeRetrievesAnArchivedArtifactWithoutLaunchingOrSynchronizingTheConversation() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("artifact-loop-" + UUID().uuidString)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let file = root.appendingPathComponent("notes.md")
        try Data("# Saved".utf8).write(to: file)
        let job = AgentArtifactJob(id: "artifact", sessionId: "archived", sessionRef: "native", agentKind: "codex", sourceId: "message", href: file.path)
        let api = ArtifactAPI(job: job)
        let adapter = ArtifactAdapter(message: AgentSessionMessage(sourceId: "message", role: "agent", text: "[说明](<\(file.path)>)"))
        let loop = NodeLoop(api: api, adapters: [adapter], fallbackNodeName: "Fixture", detectRepoCandidates: { [] }, log: { _ in })
        let task = Task { try await loop.run() }
        for _ in 0..<100 where api.results.current.isEmpty { try await Task.sleep(nanoseconds: 10_000_000) }
        task.cancel(); try await task.value
        XCTAssertEqual(api.results.current.count, 1)
        XCTAssertEqual(api.results.current.first?.bundle?.entry, "notes.md")
        XCTAssertNil(api.results.current.first?.error)
        XCTAssertEqual(adapter.refs.current, ["native"])
        XCTAssertEqual(adapter.mutations.current, 0)
    }

    func fixture(_ body: (URL) throws -> Void) throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("artifact-" + UUID().uuidString)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        try body(root)
    }
    func read(_ file: URL, text: String? = nil, role: String = "agent") throws -> AgentArtifactBundle {
        let href = file.path
        let job = AgentArtifactJob(id: "output", sessionId: "session", sessionRef: "native", agentKind: "codex", sourceId: "message", href: href)
        return try AgentArtifactReader.read(job: job, messages: [AgentSessionMessage(sourceId: "message", role: role, text: text ?? "[查看](<\(href)>)")])
    }
    func testCollectsHtmlCssScriptAndImagesWithoutExecutingThem() throws {
        try fixture { root in
            let page = root.appendingPathComponent("prototype.html")
            try Data("<link href='style.css' rel='stylesheet'><script src='app.js'></script><img src='image.png'>".utf8).write(to: page)
            try Data("body { background: url(image.png) }".utf8).write(to: root.appendingPathComponent("style.css"))
            try Data("document.body.dataset.ready='yes'".utf8).write(to: root.appendingPathComponent("app.js"))
            try Data([137, 80, 78, 71]).write(to: root.appendingPathComponent("image.png"))
            let bundle = try read(page)
            XCTAssertEqual(bundle.entry, "prototype.html")
            XCTAssertEqual(Set(bundle.files.map(\.name)), ["prototype.html", "style.css", "app.js", "image.png"])
        }
    }
    func testRequiresTheExactAgentReferenceAndRejectsSymlinkEscapes() throws {
        try fixture { root in
            let file = root.appendingPathComponent("notes.txt")
            try Data("safe".utf8).write(to: file)
            XCTAssertThrowsError(try read(file, text: "unrelated")) { XCTAssertEqual($0 as? AgentArtifactError, .referenceMissing) }
            XCTAssertThrowsError(try read(file, role: "user")) { XCTAssertEqual($0 as? AgentArtifactError, .referenceMissing) }
            let link = root.appendingPathComponent("alias.txt")
            try FileManager.default.createSymbolicLink(at: link, withDestinationURL: file)
            XCTAssertThrowsError(try read(link)) { XCTAssertEqual($0 as? AgentArtifactError, .fileDenied) }
            let page = root.appendingPathComponent("prototype.html")
            try Data("<img src='../outside.png'>".utf8).write(to: page)
            XCTAssertThrowsError(try read(page)) { XCTAssertEqual($0 as? AgentArtifactError, .fileDenied) }
        }
    }
    func testBlobDownloadScriptsDoNotBecomeCssDependencies() throws {
        try fixture { root in
            let page = root.appendingPathComponent("index.html")
            let script = "const url=URL.createObjectURL(new Blob(['notes'],{type:'text/markdown'})); URL.revokeObjectURL(url); const example=\"<img src='not-a-resource.png'>\"; const cssExample=\"url(not-a-resource.png)\";"
            try Data(("<script>" + script + "</script><script src='model.js'></script>").utf8).write(to: page)
            try Data(script.utf8).write(to: root.appendingPathComponent("model.js"))
            XCTAssertEqual(Set(try read(page).files.map(\.name)), ["index.html", "model.js"])
            XCTAssertTrue(AgentArtifactReader.references(script, type: "text/javascript").isEmpty)
        }
    }
    func testInlineStylesAndModulesStillCollectRealDependencies() throws {
        let html = "<!-- <img src='comment.png'> --><style>/* url(comment.png) */ body{background:url(real.png)}</style><div style=\"background:URL('inline.png')\"></div><script type='module'>import './model.js';</script><img data-src='lazy.png' src='image.png'>"
        XCTAssertEqual(Set(AgentArtifactReader.references(html, type: "text/html")), ["real.png", "inline.png", "./model.js", "image.png"])
    }
    func testReportsMissingFilesAndDependenciesAndRestrictsTypes() throws {
        try fixture { root in
            XCTAssertThrowsError(try read(root.appendingPathComponent("missing.pdf"))) { XCTAssertEqual($0 as? AgentArtifactError, .fileMissing) }
            XCTAssertThrowsError(try read(root.appendingPathComponent("script.sh"))) { XCTAssertEqual($0 as? AgentArtifactError, .unsupported) }
            let page = root.appendingPathComponent("prototype.html")
            try Data("<img src='missing.png'>".utf8).write(to: page)
            XCTAssertThrowsError(try read(page)) { XCTAssertEqual($0 as? AgentArtifactError, .resourceMissing) }
            XCTAssertNil(AgentArtifactReader.path("file://remote/tmp/file.txt"))
            XCTAssertNil(AgentArtifactReader.path("/tmp/%2e%2e/secrets.txt"))
        }
    }
}

private final class ArtifactAPI: NodeAPI, @unchecked Sendable {
    let job: AgentArtifactJob
    let results = Locked<[AgentArtifactResult]>([])
    init(job: AgentArtifactJob) { self.job = job }
    func artifactJobs() async throws -> [AgentArtifactJob] { results.current.isEmpty ? [job] : [] }
    func reportArtifact(id: String, result: AgentArtifactResult) async throws { results.withLock { $0.append(result) } }
    func heartbeat(agents: [DetectedAgent], repoCandidates: [RepoCandidate]) async throws -> HeartbeatReply { HeartbeatReply(repos: []) }
    func claimNext(waitMs: Int, availableAgentKinds: [String]?) async throws -> DispatchRequest? {
        try? await Task.sleep(nanoseconds: 20_000_000); return nil
    }
    func reportResult(dispatchId: String, report: DispatchReport) async throws {}
}
private final class ArtifactAdapter: AgentAdapter, @unchecked Sendable {
    let kind = "codex"
    let message: AgentSessionMessage
    let refs = Locked<[String]>([])
    let mutations = Locked(0)
    init(message: AgentSessionMessage) { self.message = message }
    func detect() async -> String? { nil }
    func artifactMessages(sessionRef: String) async throws -> [AgentSessionMessage] {
        refs.withLock { $0.append(sessionRef) }; return [message]
    }
    func launch(_ job: DispatchJob) async throws -> LaunchResult { mutations.withLock { $0 += 1 }; throw AgentArtifactError.nodeUnavailable }
    func synchronize(_ session: NodeAgentSession) async throws -> AgentSessionReport { mutations.withLock { $0 += 1 }; throw AgentArtifactError.nodeUnavailable }
}
