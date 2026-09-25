import Foundation
import XCTest
@testable import MissionGoNodeCore

private actor StubOpenCodeControl: OpenCodeControlling {
    let mcpStatus: String?
    var createdAgent: String?
    var createdModel: OpenCodeModelRef?
    var lastPrompt: String?
    var catalog: OpenCodeModelCatalog
    var info: (agent: String?, model: OpenCodeModelRef?)
    var appliedAgents: [String] = []
    var appliedModels: [OpenCodeModelRef] = []
    var snapshotMessages: [AgentSessionMessage] = []
    var choices: [OpenCodeChoice] = []
    var repliedForm: (formID: String, answer: [String: OpenCodeAnswerValue])?
    var repliedPermission: (requestID: String, decision: String)?

    init(
        mcpStatus: String?,
        catalog: OpenCodeModelCatalog = OpenCodeModelCatalog(models: [], defaultRef: nil),
        info: (agent: String?, model: OpenCodeModelRef?) = (nil, nil),
        choices: [OpenCodeChoice] = [],
        snapshotMessages: [AgentSessionMessage] = []
    ) {
        self.mcpStatus = mcpStatus
        self.catalog = catalog
        self.info = info
        self.choices = choices
        self.snapshotMessages = snapshotMessages
    }

    func health() async throws -> String { "2.0.14" }
    func missionGoMcpStatus(directory: String?) async throws -> String? { mcpStatus }
    func createSession(directory: String, agent: String, model: OpenCodeModelRef?) async throws -> String {
        createdAgent = agent
        createdModel = model
        return "ses_test"
    }
    func renameSession(id: String, title: String) async throws {}
    func prompt(id: String, text: String) async throws { lastPrompt = text }
    func snapshot(id: String) async throws -> (status: String, messages: [AgentSessionMessage]) {
        ("idle", snapshotMessages)
    }
    func interrupt(id: String) async throws {}
    func deleteSession(id: String) async throws {}
    func listModels() async throws -> OpenCodeModelCatalog { catalog }
    func sessionInfo(id: String) async throws -> (agent: String?, model: OpenCodeModelRef?) { info }
    func setModel(id: String, model: OpenCodeModelRef) async throws { appliedModels.append(model) }
    func setAgent(id: String, agent: String) async throws { appliedAgents.append(agent) }
    func pendingChoices(id: String) async throws -> [OpenCodeChoice] { choices }
    func replyForm(id: String, formID: String, answer: [String: OpenCodeAnswerValue]) async throws {
        repliedForm = (formID, answer)
    }
    func replyPermission(id: String, requestID: String, decision: String) async throws {
        repliedPermission = (requestID, decision)
    }
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

    /// AND-190: a form OpenCode is blocked on becomes one message carrying a
    /// question per visible field, and an answer goes to the form endpoint —
    /// never a prompt, which OpenCode would not treat as the reply.
    func testFormChoiceRendersFieldsAndRoutesItsAnswerToTheFormEndpoint() async throws {
        let entry: [String: Any] = [
            "id": "frm_1", "sessionID": "ses_test", "title": "发布确认",
            "fields": [
                ["key": "scope", "title": "范围", "type": "string",
                 "options": [["value": "small", "label": "小"], ["value": "full", "label": "完整"]]],
                ["key": "note", "title": "备注", "type": "string", "required": true],
                ["key": "confirm", "title": "确认", "type": "boolean", "required": true],
            ],
        ]
        let choice = try XCTUnwrap(OpenCodeProtocol.formChoice(entry))
        XCTAssertEqual(choice.message.sourceId, "form-frm_1")
        XCTAssertEqual(choice.message.text, "发布确认")
        let questions = try XCTUnwrap(choice.message.questions)
        XCTAssertEqual(questions.map(\.key), ["scope", "note", "confirm"])
        XCTAssertEqual(questions[0].options, ["小", "完整"])
        XCTAssertEqual(questions[1].kind, .text)
        XCTAssertEqual(questions[2].kind, .boolean)

        let control = StubOpenCodeControl(mcpStatus: "connected", choices: [choice])
        let report = try await OpenCodeLauncher(control: control).synchronize(NodeAgentSession(
            id: "session-1", agentKind: "opencode", sessionRef: "ses_test", status: "idle",
            command: AgentSessionCommand(
                id: "c1", kind: "message", text: "scope: 小\nnote: 今天发布\nconfirm: 是", status: "delivering"
            )
        ))
        XCTAssertTrue(report.messages.contains { $0.sourceId == "form-frm_1" })
        XCTAssertEqual(report.commandStatus, "delivered")
        let replied = await control.repliedForm
        XCTAssertEqual(replied?.formID, "frm_1")
        XCTAssertEqual(replied?.answer["scope"], .text("small"))
        XCTAssertEqual(replied?.answer["note"], .text("今天发布"))
        XCTAssertEqual(replied?.answer["confirm"], .boolean(true))
        let prompt = await control.lastPrompt
        XCTAssertNil(prompt)
    }

    /// AND-190: a permission request carries OpenCode's three decisions, and a
    /// picked one is sent as that decision rather than as prompt text.
    func testPermissionChoiceRoutesTheDecisionNotAPrompt() async throws {
        let entry: [String: Any] = [
            "id": "per_1", "sessionID": "ses_test", "action": "bash",
            "resources": ["rm -rf build"], "message": "需要删除构建目录",
        ]
        let choice = try XCTUnwrap(OpenCodeProtocol.permissionChoice(entry))
        XCTAssertEqual(choice.message.sourceId, "permission-per_1")
        XCTAssertEqual(choice.message.text, "需要删除构建目录")
        let questions = try XCTUnwrap(choice.message.questions)
        XCTAssertEqual(questions[0].options, ["允许一次", "始终允许", "拒绝"])

        let control = StubOpenCodeControl(mcpStatus: "connected", choices: [choice])
        let report = try await OpenCodeLauncher(control: control).synchronize(NodeAgentSession(
            id: "session-1", agentKind: "opencode", sessionRef: "ses_test", status: "idle",
            command: AgentSessionCommand(id: "c1", kind: "message", text: "始终允许", status: "delivering")
        ))
        XCTAssertEqual(report.commandStatus, "delivered")
        let replied = await control.repliedPermission
        XCTAssertEqual(replied?.requestID, "per_1")
        XCTAssertEqual(replied?.decision, "always")
        let prompt = await control.lastPrompt
        XCTAssertNil(prompt)
    }

    /// A reply that does not answer the pending choice is still an ordinary
    /// prompt: the console must not swallow what a person actually typed.
    func testAReplyThatDoesNotAnswerTheChoiceStaysAPrompt() async throws {
        let entry: [String: Any] = ["id": "per_1", "action": "bash", "resources": []]
        let choice = try XCTUnwrap(OpenCodeProtocol.permissionChoice(entry))
        let control = StubOpenCodeControl(mcpStatus: "connected", choices: [choice])
        _ = try await OpenCodeLauncher(control: control).synchronize(NodeAgentSession(
            id: "session-1", agentKind: "opencode", sessionRef: "ses_test", status: "idle",
            command: AgentSessionCommand(id: "c1", kind: "message", text: "继续处理 AND-190", status: "delivering")
        ))
        let replied = await control.repliedPermission
        XCTAssertNil(replied)
        let prompt = await control.lastPrompt
        XCTAssertEqual(prompt, "继续处理 AND-190")
    }

    /// Both replies have their own routes and bodies; neither uses `/prompt`.
    func testChoiceRepliesUseTheirOwnEndpoints() async throws {
        let home = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: home) }
        let registration = home.appendingPathComponent(".local/state/opencode/service.json")
        try FileManager.default.createDirectory(at: registration.deletingLastPathComponent(), withIntermediateDirectories: true)
        try Data(#"{"url":"http://127.0.0.1:9999","password":"test","version":"2.0.15"}"#.utf8).write(to: registration)
        StubURLProtocol.install { _, _ in .response(status: 204, body: "") }
        let control = OpenCodeHTTPControl(home: home.path, session: StubURLProtocol.session())
        try await control.replyForm(
            id: "ses_test", formID: "frm_1",
            answer: ["scope": .text("small"), "confirm": .boolean(true)]
        )
        try await control.replyPermission(id: "ses_test", requestID: "per_1", decision: "always")
        let requests = StubURLProtocol.recorded
        XCTAssertEqual(requests.map { $0.request.url?.path }, [
            "/api/session/ses_test/form/frm_1/reply",
            "/api/session/ses_test/permission/per_1/reply",
        ])
        let form = jsonObject(requests[0].body)
        let answer = form["answer"] as? [String: Any]
        XCTAssertEqual(answer?["scope"] as? String, "small")
        XCTAssertEqual(answer?["confirm"] as? Bool, true)
        let permission = jsonObject(requests[1].body)
        XCTAssertEqual(permission["decision"] as? String, "always")
    }

    /// A service without the form or permission routes must not fail the sync:
    /// it simply reports no pending choices.
    func testPendingChoicesDegradeToNoneWhenTheRoutesAreMissing() async throws {
        let home = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: home) }
        let registration = home.appendingPathComponent(".local/state/opencode/service.json")
        try FileManager.default.createDirectory(at: registration.deletingLastPathComponent(), withIntermediateDirectories: true)
        try Data(#"{"url":"http://127.0.0.1:9999","password":"test","version":"2.0.0"}"#.utf8).write(to: registration)
        StubURLProtocol.install { _, _ in .response(status: 404, body: #"{"message":"not found"}"#) }
        let control = OpenCodeHTTPControl(home: home.path, session: StubURLProtocol.session())
        let choices = try await control.pendingChoices(id: "ses_test")
        XCTAssertTrue(choices.isEmpty)
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

    /// AND-189: the model list is OpenCode's own catalog — same entries its
    /// model manager shows, grouped by provider, with the reasoning tiers it
    /// calls variants mapped to the efforts MissionGo speaks of.
    func testModelCatalogDeduplicatesAcrossProvidersAndKeepsToolCapableModelsOnly() throws {
        let glm: [String: Any] = [
            "id": "glm-5.3", "modelID": "glm-5.3", "providerID": "zai-coding-plan", "name": "GLM-5.3",
            "capabilities": ["tools": true],
            "variants": [["id": "high"], ["id": "low"], ["id": "high"]],
        ]
        let chatOnly: [String: Any] = [
            "id": "glm-air", "modelID": "glm-air", "providerID": "zai-coding-plan", "name": "GLM Air",
            "capabilities": ["tools": false],
        ]
        let twin: [String: Any] = [
            "id": "glm-5.3", "modelID": "glm-5.3", "providerID": "opencode", "name": "GLM-5.3 (OpenCode)",
            "capabilities": ["tools": true], "variants": [],
        ]
        let listed = OpenCodeProtocol.modelCatalog(["data": [glm, chatOnly, twin, glm]])
        XCTAssertEqual(listed.map(\.id), ["zai-coding-plan/glm-5.3", "opencode/glm-5.3"])
        XCTAssertEqual(listed[0].efforts, ["high", "low"])
        XCTAssertEqual(listed[0].label, "GLM-5.3")
        XCTAssertEqual(listed[0].provider, "zai-coding-plan")

        let providers = OpenCodeProtocol.providerNames(["data": [
            ["id": "zai-coding-plan", "name": "Z.AI Coding Plan"],
            ["id": "", "name": "Broken"],
            ["id": "opencode", "name": ""],
        ]])
        XCTAssertEqual(providers, ["zai-coding-plan": "Z.AI Coding Plan"])

        let defaultRef = OpenCodeProtocol.modelRef(["id": "glm-5.3", "providerID": "zai-coding-plan"])
        XCTAssertEqual(defaultRef?.compoundId, "zai-coding-plan/glm-5.3")
        XCTAssertNil(defaultRef?.variant)

        let session = ["data": [
            "agent": "build",
            "model": ["id": "glm-5.3", "providerID": "zai-coding-plan", "variant": "high"],
        ] as [String: Any]]
        XCTAssertEqual(OpenCodeProtocol.sessionAgent(session), "build")
        XCTAssertEqual(OpenCodeProtocol.sessionModel(session)?.variant, "high")
        XCTAssertEqual(OpenCodeProtocol.sessionModel(session)?.compoundId, "zai-coding-plan/glm-5.3")

        // What arrives from the wire is parsed, not trusted: an id without a
        // provider names no model of this catalog.
        XCTAssertNil(OpenCodeModelRef(parseCompoundId: "glm-5.3"))
        XCTAssertNil(OpenCodeModelRef(parseCompoundId: "/glm-5.3"))
        XCTAssertNil(OpenCodeModelRef(parseCompoundId: "zai/"))
    }

    func testAvailableModelsReportsTheCatalogWithProviderNames() async throws {
        let catalog = OpenCodeModelCatalog(
            models: [
                AgentModelOption(id: "zai-coding-plan/glm-5.3", label: "GLM-5.3", provider: "zai-coding-plan",
                                 efforts: ["low", "high"]),
            ],
            defaultRef: OpenCodeModelRef(modelId: "glm-5.3", providerId: "zai-coding-plan")
        )
        let control = StubOpenCodeControl(mcpStatus: nil, catalog: catalog)
        let launcher = OpenCodeLauncher(control: control)
        let models = await launcher.availableModels()
        XCTAssertEqual(models, [
            AgentModelOption(id: "zai-coding-plan/glm-5.3", label: "GLM-5.3", provider: "zai-coding-plan",
                             efforts: ["low", "high"], isDefault: true),
        ])
    }

    func testLaunchPassesTheChosenModelAndEffortAsOneReference() async throws {
        let repo = try temporaryRepo()
        defer { try? FileManager.default.removeItem(at: repo) }
        let catalog = OpenCodeModelCatalog(
            models: [AgentModelOption(id: "zai-coding-plan/glm-5.3", label: "GLM-5.3",
                                      provider: "zai-coding-plan", efforts: ["low", "high"])],
            defaultRef: OpenCodeModelRef(modelId: "glm-5.3", providerId: "zai-coding-plan")
        )
        let control = StubOpenCodeControl(mcpStatus: "connected", catalog: catalog)
        let launcher = OpenCodeLauncher(control: control)
        let result = try await launcher.launch(DispatchJob(
            dispatchId: "d", itemKeys: ["AND-1"], repoPath: repo.path, mode: "default", nodeName: "Mac mini",
            model: "zai-coding-plan/glm-5.3", effort: "high"
        ))
        XCTAssertEqual(result.sessionRef, "ses_test")
        let model = await control.createdModel
        let agent = await control.createdAgent
        XCTAssertEqual(model, OpenCodeModelRef(modelId: "glm-5.3", providerId: "zai-coding-plan", variant: "high"))
        XCTAssertEqual(agent, "build")
    }

    /// A tier the model does not take is dropped, a model nobody can name is
    /// not guessed, and an effort alone lands on the configured default model.
    func testLaunchResolvesEffortAgainstTheModelsItAppliesTo() async throws {
        let repo = try temporaryRepo()
        defer { try? FileManager.default.removeItem(at: repo) }
        let catalog = OpenCodeModelCatalog(
            models: [
                AgentModelOption(id: "zai-coding-plan/glm-5.3", label: "GLM-5.3", efforts: ["low", "high"]),
                AgentModelOption(id: "deepseek/deepseek-v4", label: "DeepSeek V4", efforts: []),
            ],
            defaultRef: OpenCodeModelRef(modelId: "deepseek-v4", providerId: "deepseek")
        )
        var control = StubOpenCodeControl(mcpStatus: "connected", catalog: catalog)
        let launcher = OpenCodeLauncher(control: control)
        // The model's own tiers decide: an effort it does not take is not sent.
        _ = try await launcher.launch(DispatchJob(
            dispatchId: "d", itemKeys: ["AND-1"], repoPath: repo.path, mode: "default", nodeName: "Mac mini",
            model: "deepseek/deepseek-v4", effort: "high"
        ))
        var sent = await control.createdModel
        XCTAssertEqual(sent, OpenCodeModelRef(modelId: "deepseek-v4", providerId: "deepseek"))
        // An effort alone applies to the default model; this catalog's default
        // takes no tiers, so the pick falls back to the Mac's configuration.
        control = StubOpenCodeControl(mcpStatus: "connected", catalog: catalog)
        _ = try await OpenCodeLauncher(control: control).launch(DispatchJob(
            dispatchId: "d", itemKeys: ["AND-1"], repoPath: repo.path, mode: "plan", nodeName: "Mac mini",
            effort: "low"
        ))
        sent = await control.createdModel
        XCTAssertNil(sent)
        // No catalog to ask: the pick is sent as chosen, for the service to judge.
        control = StubOpenCodeControl(mcpStatus: "connected", catalog: OpenCodeModelCatalog(models: [], defaultRef: nil))
        _ = try await OpenCodeLauncher(control: control).launch(DispatchJob(
            dispatchId: "d", itemKeys: ["AND-1"], repoPath: repo.path, mode: "default", nodeName: "Mac mini",
            model: "zai-coding-plan/glm-5.3", effort: "high"
        ))
        sent = await control.createdModel
        XCTAssertEqual(sent, OpenCodeModelRef(modelId: "glm-5.3", providerId: "zai-coding-plan", variant: "high"))
    }

    /// A running session takes mode, model and effort changes the way OpenCode
    /// applies them: mode moves it between the plan and build agents, a model
    /// change re-points the session, and an effort alone keeps its model.
    func testSynchronizeAppliesPendingSettingsAndReportsWhatRuns() async throws {
        let catalog = OpenCodeModelCatalog(
            models: [AgentModelOption(id: "zai-coding-plan/glm-5.3", label: "GLM-5.3", efforts: ["low", "high"])],
            defaultRef: OpenCodeModelRef(modelId: "glm-5.3", providerId: "zai-coding-plan")
        )
        let control = StubOpenCodeControl(
            mcpStatus: "connected", catalog: catalog,
            info: ("build", OpenCodeModelRef(modelId: "glm-5.3", providerId: "zai-coding-plan", variant: "low"))
        )
        let launcher = OpenCodeLauncher(control: control)
        let report = try await launcher.synchronize(NodeAgentSession(
            id: "session-1", agentKind: "opencode", sessionRef: "ses_test", status: "idle",
            desiredSettings: AgentSessionSettings(revision: 3, mode: "plan", model: "zai-coding-plan/glm-5.3",
                                                  effort: "high"),
            appliedSettingsRevision: 2
        ))
        XCTAssertEqual(report.settingsRevision, 3)
        XCTAssertNil(report.settingsError)
        let appliedAgents = await control.appliedAgents
        let appliedModels = await control.appliedModels
        XCTAssertEqual(appliedAgents, ["plan"])
        XCTAssertEqual(appliedModels, [
            OpenCodeModelRef(modelId: "glm-5.3", providerId: "zai-coding-plan", variant: "high"),
        ])
        XCTAssertEqual(report.model, "zai-coding-plan/glm-5.3")
        XCTAssertEqual(report.effort, "high")
    }

    func testSynchronizeKeepsTheSessionsModelForAnEffortOnlyChange() async throws {
        let catalog = OpenCodeModelCatalog(
            models: [AgentModelOption(id: "deepseek/deepseek-v4", label: "DeepSeek V4", efforts: ["high"])],
            defaultRef: OpenCodeModelRef(modelId: "glm-5.3", providerId: "zai-coding-plan")
        )
        let control = StubOpenCodeControl(
            mcpStatus: "connected", catalog: catalog,
            info: ("build", OpenCodeModelRef(modelId: "deepseek-v4", providerId: "deepseek"))
        )
        let report = try await OpenCodeLauncher(control: control).synchronize(NodeAgentSession(
            id: "session-1", agentKind: "opencode", sessionRef: "ses_test", status: "idle",
            desiredSettings: AgentSessionSettings(revision: 1, effort: "high"),
            appliedSettingsRevision: 0
        ))
        let effortOnlyAgents = await control.appliedAgents
        let effortOnlyModels = await control.appliedModels
        XCTAssertEqual(effortOnlyAgents, [])
        XCTAssertEqual(effortOnlyModels, [
            OpenCodeModelRef(modelId: "deepseek-v4", providerId: "deepseek", variant: "high"),
        ])
        XCTAssertEqual(report.model, "deepseek/deepseek-v4")
        XCTAssertEqual(report.effort, "high")
    }

    /// A settings change waits for an idle session, and one that cannot be
    /// applied is reported once instead of failing the whole sync.
    func testSynchronizeDefersWhileRunningAndReportsAFailure() async throws {
        actor SyncFailingControl: OpenCodeControlling {
            let catalog: OpenCodeModelCatalog
            var snapshotStatus: String
            private(set) var agentAttempts: [String] = []

            init(catalog: OpenCodeModelCatalog, snapshotStatus: String) {
                self.catalog = catalog
                self.snapshotStatus = snapshotStatus
            }

            func health() async throws -> String { "2.0.14" }
            func missionGoMcpStatus(directory: String?) async throws -> String? { "connected" }
            func createSession(directory: String, agent: String, model: OpenCodeModelRef?) async throws -> String { "ses_test" }
            func renameSession(id: String, title: String) async throws {}
            func prompt(id: String, text: String) async throws {}
            func snapshot(id: String) async throws -> (status: String, messages: [AgentSessionMessage]) {
                (snapshotStatus, [])
            }
            func interrupt(id: String) async throws {}
            func deleteSession(id: String) async throws {}
            func listModels() async throws -> OpenCodeModelCatalog { catalog }
            func sessionInfo(id: String) async throws -> (agent: String?, model: OpenCodeModelRef?) { (nil, nil) }
            func setModel(id: String, model: OpenCodeModelRef) async throws {}
            func setAgent(id: String, agent: String) async throws {
                agentAttempts.append(agent)
                throw LaunchError("会话正忙")
            }
            func pendingChoices(id: String) async throws -> [OpenCodeChoice] { [] }
            func replyForm(id: String, formID: String, answer: [String: OpenCodeAnswerValue]) async throws {}
            func replyPermission(id: String, requestID: String, decision: String) async throws {}
        }
        let catalog = OpenCodeModelCatalog(models: [], defaultRef: nil)
        // An active session: the change waits, nothing is applied.
        let running = SyncFailingControl(catalog: catalog, snapshotStatus: "active")
        var report = try await OpenCodeLauncher(control: running).synchronize(NodeAgentSession(
            id: "session-1", agentKind: "opencode", sessionRef: "ses_test", status: "idle",
            desiredSettings: AgentSessionSettings(revision: 1, mode: "plan"),
            appliedSettingsRevision: 0
        ))
        XCTAssertNil(report.settingsRevision)
        let waitedAttempts = await running.agentAttempts
        XCTAssertTrue(waitedAttempts.isEmpty)
        // Idle, and the switch itself fails: the revision is reported with the
        // error, so the console can show it rather than resend the change.
        let idle = SyncFailingControl(catalog: catalog, snapshotStatus: "idle")
        report = try await OpenCodeLauncher(control: idle).synchronize(NodeAgentSession(
            id: "session-1", agentKind: "opencode", sessionRef: "ses_test", status: "idle",
            desiredSettings: AgentSessionSettings(revision: 1, mode: "plan"),
            appliedSettingsRevision: 0
        ))
        XCTAssertEqual(report.settingsRevision, 1)
        XCTAssertTrue(report.settingsError?.contains("未应用") == true)
        let attempts = await idle.agentAttempts
        XCTAssertEqual(attempts, ["plan"])
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
