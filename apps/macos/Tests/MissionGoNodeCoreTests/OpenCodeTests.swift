import Foundation
import XCTest
@testable import MissionGoNodeCore

private actor StubOpenCodeControl: OpenCodeControlling {
    let mcpStatus: String?
    var createdAgent: String?
    var lastPrompt: String?

    init(mcpStatus: String?) { self.mcpStatus = mcpStatus }

    func health() async throws -> String { "2.0.14" }
    func missionGoMcpStatus(directory: String?) async throws -> String? { mcpStatus }
    func createSession(directory: String, agent: String) async throws -> String {
        createdAgent = agent
        return "ses_test"
    }
    func renameSession(id: String, title: String) async throws {}
    func prompt(id: String, text: String) async throws { lastPrompt = text }
    func snapshot(id: String) async throws -> (status: String, messages: [AgentSessionMessage]) {
        ("idle", [])
    }
    func interrupt(id: String) async throws {}
    func deleteSession(id: String) async throws {}
}

final class OpenCodeTests: XCTestCase {
    func testInstalledV2HttpRoutesUsePatchRenameAndTopLevelPromptText() async throws {
        let home = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: home) }
        let registration = home.appendingPathComponent(".local/state/opencode/service.json")
        try FileManager.default.createDirectory(at: registration.deletingLastPathComponent(), withIntermediateDirectories: true)
        try Data(#"{"url":"http://127.0.0.1:9999","password":"test","version":"2.0.14"}"#.utf8).write(to: registration)
        StubURLProtocol.install { request, _ in
            switch (request.httpMethod, request.url?.path) {
            case ("PATCH", "/api/session/ses_test"):
                return .response(status: 204, body: "")
            case ("POST", "/api/session/ses_test/prompt"):
                return .response(status: 200, body: #"{"data":{"id":"msg_test"}}"#)
            default:
                return .response(status: 404, body: #"{"message":"unexpected route"}"#)
            }
        }
        let control = OpenCodeHTTPControl(home: home.path, session: StubURLProtocol.session())
        try await control.renameSession(id: "ses_test", title: "MissionGo task")
        try await control.prompt(id: "ses_test", text: "Handle AND-1")
        let requests = StubURLProtocol.recorded
        XCTAssertEqual(requests.map { $0.request.httpMethod }, ["PATCH", "POST"])
        XCTAssertEqual(jsonObject(requests[0].body)["title"] as? String, "MissionGo task")
        let prompt = jsonObject(requests[1].body)
        XCTAssertEqual(prompt["text"] as? String, "Handle AND-1")
        XCTAssertEqual(prompt["delivery"] as? String, "queue")
    }

    func testParsesV2McpAndVisibleMessagesWithoutReasoningOrTools() throws {
        let mcp: [String: Any] = ["data": [
            ["name": "missiongo", "status": ["status": "needs_auth"]],
        ]]
        XCTAssertEqual(OpenCodeProtocol.missionGoMcpStatus(mcp), "needs_auth")
        let response: [String: Any] = ["data": [
            ["id": "msg_1", "type": "user", "text": "请处理", "time": ["created": 1_000]],
            ["id": "msg_2", "type": "assistant", "agent": "plan", "content": [
                ["type": "reasoning", "text": "private"],
                ["type": "text", "text": "方案"],
                ["type": "tool", "name": "shell"],
            ], "time": ["created": 2_000]],
        ]]
        let messages = try OpenCodeProtocol.messages(response)
        XCTAssertEqual(messages.map(\.sourceId), ["msg_1", "msg_2"])
        XCTAssertEqual(messages.map(\.role), ["user", "plan"])
        XCTAssertEqual(messages.map(\.text), ["请处理", "方案"])
    }

    func testIntegrationCheckOnlyPausesForMissingConfigurationOrAuthorization() {
        XCTAssertNil(OpenCodeProtocol.integrationIssue(for: "connected"))
        XCTAssertNil(OpenCodeProtocol.integrationIssue(for: "failed"))
        XCTAssertNil(OpenCodeProtocol.integrationIssue(for: "pending"))
        XCTAssertTrue(OpenCodeProtocol.integrationIssue(for: "needs_auth")?.contains("登录") == true)
        XCTAssertTrue(OpenCodeProtocol.integrationIssue(for: nil)?.contains("配置") == true)
    }

    func testRetriesTransientFailedMcpStatusBeforeDispatch() async throws {
        let home = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: home) }
        let registration = home.appendingPathComponent(".local/state/opencode/service.json")
        try FileManager.default.createDirectory(at: registration.deletingLastPathComponent(), withIntermediateDirectories: true)
        try Data(#"{"url":"http://127.0.0.1:9999","password":"test","version":"2.0.15"}"#.utf8).write(to: registration)
        StubURLProtocol.install { _, _ in
            let status = StubURLProtocol.recorded.count == 1 ? "failed" : "connected"
            return .response(status: 200, body: #"{"data":[{"name":"missiongo","status":{"status":"\#(status)"}}]}"#)
        }
        let control = OpenCodeHTTPControl(home: home.path, session: StubURLProtocol.session())
        let status = try await control.missionGoMcpStatus(directory: "/repo")
        XCTAssertEqual(status, "connected")
        XCTAssertEqual(StubURLProtocol.recorded.count, 2)
    }

    func testNeedsMissionGoMcpBeforeCreatingSession() async throws {
        let repo = try temporaryRepo()
        defer { try? FileManager.default.removeItem(at: repo) }
        let control = StubOpenCodeControl(mcpStatus: "needs_auth")
        let launcher = OpenCodeLauncher(control: control)
        let job = DispatchJob(dispatchId: "dispatch-1", itemKeys: ["AND-1"], repoPath: repo.path,
                              mode: "default", nodeName: "Mac mini")
        do {
            _ = try await launcher.launch(job)
            XCTFail("Launch should wait for MCP authorization")
        } catch {
            XCTAssertTrue(error.localizedDescription.contains("MCP"))
        }
        let created = await control.createdAgent
        XCTAssertNil(created)
    }

    func testTransientMcpFailureIsRetryableAndDoesNotAskForLogin() async throws {
        let repo = try temporaryRepo()
        defer { try? FileManager.default.removeItem(at: repo) }
        let control = StubOpenCodeControl(mcpStatus: "failed")
        let launcher = OpenCodeLauncher(control: control)
        let job = DispatchJob(dispatchId: "dispatch-1", itemKeys: ["AND-1"], repoPath: repo.path,
                              mode: "default", nodeName: "Mac mini")
        do {
            _ = try await launcher.launch(job)
            XCTFail("Launch should wait for MCP recovery")
        } catch let error as LaunchError {
            XCTAssertEqual(error.failureCode, "mcp_timeout")
            XCTAssertEqual(error.retryAfterSeconds, 30)
            XCTAssertFalse(error.message.contains("登录"))
        }
        let created = await control.createdAgent
        XCTAssertNil(created)
    }

    func testCreatesOnePlanSessionWithTheMissionGoPrompt() async throws {
        let repo = try temporaryRepo()
        defer { try? FileManager.default.removeItem(at: repo) }
        let control = StubOpenCodeControl(mcpStatus: "connected")
        let launcher = OpenCodeLauncher(control: control)
        let job = DispatchJob(dispatchId: "dispatch-2", itemKeys: ["AND-2"], repoPath: repo.path,
                              mode: "plan", nodeName: "Mac mini")
        let result = try await launcher.launch(job)
        XCTAssertEqual(result.sessionRef, "ses_test")
        XCTAssertNil(result.sessionUrl)
        let agent = await control.createdAgent
        let prompt = await control.lastPrompt
        XCTAssertEqual(agent, "plan")
        XCTAssertTrue(prompt?.contains("get_current_account") == true)
        XCTAssertTrue(prompt?.contains("切换到 build agent") == true)
    }

    /// OpenCode 2 rejects `order` combined with a cursor
    /// ("Cursor cannot be combined with order"). The first page asks for
    /// oldest-first; later pages must follow the cursor alone, or any session
    /// with a follow-up page — which is every non-empty session, since the API
    /// returns a next cursor even for a short list — fails to synchronize.
    func testMessagePagingFollowsCursorWithoutRepeatingOrder() async throws {
        let home = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: home) }
        let registration = home.appendingPathComponent(".local/state/opencode/service.json")
        try FileManager.default.createDirectory(at: registration.deletingLastPathComponent(), withIntermediateDirectories: true)
        try Data(#"{"url":"http://127.0.0.1:9999","password":"test","version":"2.0.15"}"#.utf8).write(to: registration)
        StubURLProtocol.install { request, _ in
            let query = OpenCodeTests.query(of: request.url)
            switch (request.httpMethod, request.url?.path) {
            case ("GET", "/api/session/ses_test"):
                return .response(status: 200, body: #"{"data":{"id":"ses_test"}}"#)
            case ("GET", "/api/session/ses_test/message"):
                // Mirror the real V2 rule so a regression fails here, not on a node.
                if query["cursor"] != nil && query["order"] != nil {
                    return .response(status: 400, body: #"{"_tag":"InvalidCursorError","message":"Cursor cannot be combined with order"}"#)
                }
                if query["cursor"] != nil {
                    return .response(status: 200, body: #"{"data":[{"id":"msg_3","type":"user","text":"third","time":{"created":3000}}],"cursor":{"previous":"seen"}}"#)
                }
                return .response(status: 200, body: #"{"data":[{"id":"msg_1","type":"user","text":"first","time":{"created":1000}}],"cursor":{"next":"cursor-2"}}"#)
            case ("GET", "/api/session/active"):
                return .response(status: 200, body: #"{"data":{"ses_test":{"type":"running"}}}"#)
            default:
                return .response(status: 404, body: #"{"message":"unexpected route"}"#)
            }
        }
        let control = OpenCodeHTTPControl(home: home.path, session: StubURLProtocol.session())
        let snapshot = try await control.snapshot(id: "ses_test")
        XCTAssertEqual(snapshot.status, "active")
        XCTAssertEqual(snapshot.messages.map(\.sourceId), ["msg_1", "msg_3"])
        let pages = StubURLProtocol.recorded.filter { $0.request.url?.path == "/api/session/ses_test/message" }
        XCTAssertEqual(pages.count, 2)
        let first = OpenCodeTests.query(of: pages[0].request.url)
        XCTAssertEqual(first["order"], "asc")
        XCTAssertNil(first["cursor"])
        let second = OpenCodeTests.query(of: pages[1].request.url)
        XCTAssertEqual(second["cursor"], "cursor-2")
        XCTAssertNil(second["order"])
    }

    private static func query(of url: URL?) -> [String: String] {
        guard let url, let items = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems else { return [:] }
        return items.reduce(into: [:]) { $0[$1.name] = $1.value ?? "" }
    }

    private func temporaryRepo() throws -> URL {
        let path = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: path.appendingPathComponent(".git"), withIntermediateDirectories: true)
        return path
    }
}
