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

    private func temporaryRepo() throws -> URL {
        let path = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: path.appendingPathComponent(".git"), withIntermediateDirectories: true)
        return path
    }
}
