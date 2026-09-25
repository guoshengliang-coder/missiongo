import XCTest
@testable import MissionGoNodeCore

final class APIClientTests: XCTestCase {
    func testOldNodeSessionPayloadDefaultsToCodex() throws {
        let session = try JSONDecoder().decode(
            NodeAgentSession.self,
            from: Data(#"{"id":"s1","sessionRef":"thread-1","status":"idle"}"#.utf8)
        )
        XCTAssertEqual(session.agentKind, "codex")
        XCTAssertEqual(session.lifecycle, "keep")
        XCTAssertFalse(session.occupiesExecutionSlot)
        XCTAssertNil(session.dispatchId)
    }

    func testNodeSessionDecodesLifecycleAndCapacityFields() throws {
        let session = try JSONDecoder().decode(
            NodeAgentSession.self,
            from: Data(#"{"id":"s1","dispatchId":"d1","agentKind":"claude_code","sessionRef":"thread-1","status":"stalled","lifecycle":"close","occupiesExecutionSlot":true}"#.utf8)
        )
        XCTAssertEqual(session.dispatchId, "d1")
        XCTAssertEqual(session.lifecycle, "close")
        XCTAssertTrue(session.occupiesExecutionSlot)
    }

    func testNodeSessionDecodesDesiredSettingsAndDefaultsThemForAnOlderServer() throws {
        let session = try JSONDecoder().decode(
            NodeAgentSession.self,
            from: Data(#"{"id":"s1","sessionRef":"t","status":"idle","desiredSettings":{"revision":3,"mode":"auto","model":"sonnet","effort":"high"},"appliedSettingsRevision":2}"#.utf8)
        )
        XCTAssertEqual(session.desiredSettings, AgentSessionSettings(revision: 3, mode: "auto", model: "sonnet", effort: "high"))
        XCTAssertEqual(session.appliedSettingsRevision, 2)
        XCTAssertEqual(session.pendingSettings?.revision, 3)

        let partial = try JSONDecoder().decode(
            NodeAgentSession.self,
            from: Data(#"{"id":"s1","sessionRef":"t","status":"idle","desiredSettings":{"revision":2,"model":null},"appliedSettingsRevision":2}"#.utf8)
        )
        XCTAssertEqual(partial.desiredSettings, AgentSessionSettings(revision: 2))
        XCTAssertNil(partial.pendingSettings, "an applied revision is not applied again")

        let older = try JSONDecoder().decode(
            NodeAgentSession.self,
            from: Data(#"{"id":"s1","sessionRef":"t","status":"idle"}"#.utf8)
        )
        XCTAssertNil(older.desiredSettings)
        XCTAssertEqual(older.appliedSettingsRevision, 0)
        XCTAssertNil(older.pendingSettings)
    }

    func testSnapshotCarriesSettingsFieldsOnlyWhenKnown() throws {
        let bare = try JSONSerialization.jsonObject(with: APIClient.encoder.encode(
            AgentSessionReport(status: "idle", messages: [])
        )) as? [String: Any]
        for key in ["model", "effort", "settingsRevision", "settingsError", "clearSessionUrl"] {
            XCTAssertNil(bare?[key], key)
        }
        let full = try JSONSerialization.jsonObject(with: APIClient.encoder.encode(
            AgentSessionReport(status: "idle", messages: [], error: "e")
                .reportingSettings(model: "sonnet", effort: "low", settingsRevision: 4, settingsError: "切换模型失败：x")
        )) as? [String: Any]
        XCTAssertEqual(full?["model"] as? String, "sonnet")
        XCTAssertEqual(full?["effort"] as? String, "low")
        XCTAssertEqual(full?["settingsRevision"] as? Int, 4)
        XCTAssertEqual(full?["settingsError"] as? String, "切换模型失败：x")
        XCTAssertEqual(full?["error"] as? String, "e", "the rest of the report is kept")
        let local = try JSONSerialization.jsonObject(with: APIClient.encoder.encode(
            AgentSessionReport(status: "idle", messages: [])
                .reportingSettings(model: nil, effort: nil, settingsRevision: nil, settingsError: nil, clearSessionUrl: true)
        )) as? [String: Any]
        XCTAssertEqual(local?["clearSessionUrl"] as? Bool, true)
        XCTAssertNil(local?["sessionUrl"])
    }

    private let server = "http://127.0.0.1:8799/"

    private func client(token: String? = "mgn_x") -> APIClient {
        return APIClient(serverUrl: server, token: token, session: StubURLProtocol.session())
    }

    func testAttentionCountUsesNodeCredentialAndReadsExactCount() async throws {
        StubURLProtocol.install { _, _ in .response(status: 200, body: #"{"attention":123}"#) }
        let count = try await client().attentionCount()
        XCTAssertEqual(count, 123)

        let sent = try XCTUnwrap(StubURLProtocol.recorded.first)
        XCTAssertEqual(sent.request.url?.path, "/api/v1/node/attention-summary")
        XCTAssertEqual(sent.request.httpMethod, "GET")
        XCTAssertEqual(sent.request.value(forHTTPHeaderField: "Authorization"), "Bearer mgn_x")
    }

    func testAttentionCountRejectsAnInvalidNumber() async throws {
        StubURLProtocol.install { _, _ in .response(status: 200, body: #"{"attention":-1}"#) }
        do {
            _ = try await client().attentionCount()
            XCTFail("A negative attention count must not reach the badge")
        } catch let error as APIError {
            guard case .invalidResponse = error else { return XCTFail("Unexpected error: \(error)") }
        }
    }

    // Every one of these was a real mismatch found by running the TypeScript
    // daemon against the server: the endpoints answer 201 and 204, and a
    // 200-only check turned a success into a reported failure.
    func testRegisterAcceptsThe201ItAnswersAndSendsTheLoginToken() async throws {
        StubURLProtocol.install { _, _ in
            .response(status: 201, body: #"{"nodeId":"n1","name":"Mac mini","token":"mgn_new"}"#)
        }
        let node = try await client(token: nil).register(
            accessToken: "mgai_login", installationId: "inst-1", name: "Mac mini", hostname: "mini.local"
        )
        XCTAssertEqual(node, RegisteredNode(nodeId: "n1", name: "Mac mini", token: "mgn_new"))

        let sent = try XCTUnwrap(StubURLProtocol.recorded.first)
        // The trailing slash of the configured server is dropped, not doubled.
        XCTAssertEqual(sent.request.url?.absoluteString, "http://127.0.0.1:8799/api/v1/node/register")
        XCTAssertEqual(sent.request.httpMethod, "POST")
        XCTAssertEqual(sent.request.value(forHTTPHeaderField: "Authorization"), "Bearer mgai_login")
        let body = jsonObject(sent.body)
        XCTAssertEqual(body["installationId"] as? String, "inst-1")
        XCTAssertEqual(body["name"] as? String, "Mac mini")
        XCTAssertEqual(body["hostname"] as? String, "mini.local")
    }

    func testReportResultAcceptsThe204ItAnswers() async throws {
        StubURLProtocol.install { _, _ in .response(status: 204, body: "") }
        try await client().reportResult(
            dispatchId: "d1", report: DispatchReport(status: .launched, sessionName: "Mac mini-AND-1")
        )
        let sent = try XCTUnwrap(StubURLProtocol.recorded.first)
        XCTAssertEqual(sent.request.url?.path, "/api/v1/node/dispatches/d1/result")
        XCTAssertEqual(sent.request.value(forHTTPHeaderField: "Authorization"), "Bearer mgn_x")
        let body = jsonObject(sent.body)
        XCTAssertEqual(body["status"] as? String, "launched")
        XCTAssertEqual(body["sessionName"] as? String, "Mac mini-AND-1")
        // Absent fields are left out rather than sent as null.
        XCTAssertNil(body["sessionUrl"])
        XCTAssertNil(body["error"])
    }

    func testClaimNextReads204AsAnEmptyQueueAndOutlastsTheLongPoll() async throws {
        StubURLProtocol.install { _, _ in .response(status: 204, body: "") }
        let request = try await client().claimNext(waitMs: 25_000, availableAgentKinds: ["claude_code"])
        XCTAssertNil(request)
        let sent = try XCTUnwrap(StubURLProtocol.recorded.first)
        XCTAssertEqual(jsonObject(sent.body)["waitMs"] as? Int, 25_000)
        XCTAssertEqual(jsonObject(sent.body)["availableAgentKinds"] as? [String], ["claude_code"])
        // The server is asked to hold the poll 25s; aborting locally at 15s would
        // turn every idle poll into a network error.
        XCTAssertEqual(sent.request.timeoutInterval, 40)
    }

    func testClaimNextDecodesADispatch() async throws {
        StubURLProtocol.install { _, _ in
            .response(status: 200, body: #"{"dispatchId":"d9","itemKeys":["AND-37","AND-38"],"repoPath":"/Users/dev/p","agentKind":"claude_code","mode":"plan"}"#)
        }
        let request = try await client().claimNext()
        XCTAssertEqual(request, DispatchRequest(
            dispatchId: "d9", itemKeys: ["AND-37", "AND-38"], repoPath: "/Users/dev/p", agentKind: "claude_code", mode: "plan"
        ))
        // A server from before nicknames sends no node name; that is not an error.
        XCTAssertNil(request?.nodeName)
        // Nor, from before rounds, a round or rework keys.
        XCTAssertNil(request?.round)
        XCTAssertNil(request?.reworkItemKeys)
    }

    func testClaimNextDecodesTheRoundAndReworkKeys() async throws {
        StubURLProtocol.install { _, _ in
            .response(status: 200, body: #"{"dispatchId":"d9","itemKeys":["HG-49","HG-50"],"repoPath":"/Users/dev/p","agentKind":"codex","mode":"plan","nodeName":"M4","round":2,"reworkItemKeys":["HG-49"]}"#)
        }
        let request = try await client().claimNext()
        XCTAssertEqual(request?.round, 2)
        XCTAssertEqual(request?.reworkItemKeys, ["HG-49"])
    }

    func testClaimNextDecodesTheNodeNameWhenTheServerSendsIt() async throws {
        StubURLProtocol.install { _, _ in
            .response(status: 200, body: #"{"dispatchId":"d9","itemKeys":["HG-49"],"repoPath":"/Users/dev/p","agentKind":"claude_code","mode":"plan","nodeName":"老王的 Mac"}"#)
        }
        let request = try await client().claimNext()
        XCTAssertEqual(request, DispatchRequest(
            dispatchId: "d9", itemKeys: ["HG-49"], repoPath: "/Users/dev/p", agentKind: "claude_code", mode: "plan",
            nodeName: "老王的 Mac"
        ))
    }

    func testOtherCallsUseTheShortTimeout() async throws {
        StubURLProtocol.install { _, _ in .response(status: 200, body: #"{"repos":[]}"#) }
        _ = try await client().heartbeat(agents: [DetectedAgent(kind: "claude_code", version: "2.1.232")])
        let sent = try XCTUnwrap(StubURLProtocol.recorded.first)
        XCTAssertEqual(sent.request.timeoutInterval, 15)
        let agents = jsonObject(sent.body)["agents"] as? [[String: Any]]
        XCTAssertEqual(agents?.first?["kind"] as? String, "claude_code")
        XCTAssertEqual(agents?.first?["version"] as? String, "2.1.232")
    }

    func testHeartbeatCarriesEachAgentsModelsAndLeavesThemOutWhenUnknown() async throws {
        StubURLProtocol.install { _, _ in .response(status: 200, body: #"{"repos":[]}"#) }
        _ = try await client().heartbeat(agents: [
            DetectedAgent(kind: "codex", version: "0.155.1", models: [
                AgentModelOption(id: "gpt-5.1-codex", label: "GPT-5.1 Codex", efforts: ["low", "high"], defaultEffort: "high", isDefault: true),
            ]),
            DetectedAgent(kind: "claude_code", version: "2.1.278", models: []),
            DetectedAgent(kind: "other", version: "1"),
        ])
        let agents = try XCTUnwrap(jsonObject(try XCTUnwrap(StubURLProtocol.recorded.first).body)["agents"] as? [[String: Any]])
        let codex = try XCTUnwrap((agents[0]["models"] as? [[String: Any]])?.first)
        XCTAssertEqual(codex["id"] as? String, "gpt-5.1-codex")
        XCTAssertEqual(codex["label"] as? String, "GPT-5.1 Codex")
        XCTAssertEqual(codex["efforts"] as? [String], ["low", "high"])
        XCTAssertEqual(codex["defaultEffort"] as? String, "high")
        XCTAssertEqual(codex["isDefault"] as? Bool, true)
        // An empty list still says "this client can choose models".
        XCTAssertEqual((agents[1]["models"] as? [Any])?.count, 0)
        XCTAssertNil(agents[2]["models"])
    }

    func testClaimNextDecodesTheChosenModelAndEffort() async throws {
        StubURLProtocol.install { _, _ in
            .response(status: 200, body: #"{"dispatchId":"d9","itemKeys":["HG-49"],"repoPath":"/p","agentKind":"claude_code","mode":"plan","model":"opus[1m]","effort":"max"}"#)
        }
        let chosen = try await client().claimNext()
        XCTAssertEqual(chosen?.model, "opus[1m]")
        XCTAssertEqual(chosen?.effort, "max")

        StubURLProtocol.install { _, _ in
            .response(status: 200, body: #"{"dispatchId":"d9","itemKeys":["HG-49"],"repoPath":"/p","agentKind":"claude_code","mode":"plan","model":null}"#)
        }
        let local = try await client().claimNext()
        XCTAssertNil(local?.model)
        XCTAssertNil(local?.effort)
    }

    func testRevokedCredentialIsDistinctForBoth401And403() async {
        for status in [401, 403] {
            StubURLProtocol.install { _, _ in
                .response(status: status, body: #"{"title":"机器已撤销","code":"node_revoked","status":\#(status)}"#)
            }
            do {
                _ = try await client().heartbeat(agents: [])
                XCTFail("expected credentialRevoked for \(status)")
            } catch let error as APIError {
                guard case let .credentialRevoked(got, detail) = error else {
                    return XCTFail("expected credentialRevoked, got \(error)")
                }
                XCTAssertEqual(got, status)
                XCTAssertEqual(detail, "机器已撤销")
            } catch {
                XCTFail("unexpected error \(error)")
            }
        }
    }

    func testServerErrorsSurfaceTheProblemTitle() async {
        StubURLProtocol.install { _, _ in
            .response(status: 409, body: #"{"title":"仓库路径不在候选列表里","code":"repo_not_candidate","status":409}"#,
                      headers: ["Content-Type": "application/problem+json"])
        }
        do {
            _ = try await client().replaceRepos([RepoAssignment(productId: "p1", repoPath: "/x")])
            XCTFail("expected an error")
        } catch {
            XCTAssertEqual(error.localizedDescription, "保存仓库映射 失败（HTTP 409）：仓库路径不在候选列表里")
        }
    }

    func testNetworkFailureNamesTheHostAndTheURLErrorCode() async {
        // The first real pairing attempt printed only "fetch failed".
        StubURLProtocol.install { _, _ in .failure(URLError(.cannotConnectToHost)) }
        do {
            _ = try await client().me()
            XCTFail("expected an error")
        } catch {
            let message = error.localizedDescription
            XCTAssertTrue(message.contains("127.0.0.1:8799"), message)
            XCTAssertTrue(message.contains("URLError.cannotConnectToHost"), message)
            XCTAssertTrue(message.hasPrefix("无法连接"), message)
        }
    }

    func testTimeoutSaysSo() async {
        StubURLProtocol.install { _, _ in .failure(URLError(.timedOut)) }
        do {
            _ = try await client().dispatches()
            XCTFail("expected an error")
        } catch {
            let message = error.localizedDescription
            XCTAssertTrue(message.contains("超时"), message)
            XCTAssertTrue(message.contains("127.0.0.1:8799"), message)
            XCTAssertTrue(message.contains("URLError.timedOut"), message)
        }
    }

    func testMeAndDispatchesDecodeTheContract() async throws {
        StubURLProtocol.install { request, _ in
            switch request.url?.path {
            case "/api/v1/node/me":
                return .response(status: 200, body: #"""
                {"node":{"id":"n1","name":"Mac mini","hostname":"mini","online":true,"lastSeenAt":"2026-09-13T00:00:00.000Z"},
                 "repos":[{"productId":"p1","productKey":"AND","repoPath":"/Users/dev/p"}],
                 "products":[{"id":"p1","keyPrefix":"AND","name":"Android"}]}
                """#)
            default:
                return .response(status: 200, body: #"""
                {"dispatches":[{"id":"d1","nodeName":"Mac mini","agentKind":"claude_code","mode":"plan","status":"launched",
                 "itemKeys":["AND-1"],"sessionName":"Mac mini-AND-1","sessionUrl":"https://claude.ai/code/session_x",
                 "createdAt":"2026-09-13T00:00:00.000Z"}]}
                """#)
            }
        }
        let profile = try await client().me()
        XCTAssertEqual(profile.node.name, "Mac mini")
        // An older server: no device name and no nickname, which is also what
        // keeps the menu from offering an edit it cannot store.
        XCTAssertNil(profile.node.deviceName)
        XCTAssertNil(profile.node.nickname)
        XCTAssertEqual(profile.repos.first?.productKey, "AND")
        XCTAssertEqual(profile.products.first?.keyPrefix, "AND")
        let dispatches = try await client().dispatches()
        XCTAssertEqual(dispatches.first?.sessionUrl, "https://claude.ai/code/session_x")
        XCTAssertNil(dispatches.first?.completedAt)
    }

    func testHeartbeatCarriesTheProductList() async throws {
        StubURLProtocol.install { _, _ in
            .response(status: 200, body: #"""
            {"repos":[{"productId":"p1","productKey":"AND","repoPath":"/Users/dev/p"}],
             "products":[{"id":"p1","keyPrefix":"AND","name":"Android"},
                         {"id":"p2","keyPrefix":"HIG","name":"HitGO"}]}
            """#)
        }
        let beat = try await client().heartbeat(agents: [])
        XCTAssertEqual(beat.repos.first?.productKey, "AND")
        XCTAssertEqual(beat.products?.map(\.keyPrefix), ["AND", "HIG"])
    }

    func testHeartbeatFromAServerWithoutProductsLeavesThemUnsaid() async throws {
        // nil rather than [], so the client keeps the list it has instead of
        // emptying the repository menu against an older server.
        StubURLProtocol.install { _, _ in .response(status: 200, body: #"{"repos":[]}"#) }
        let beat = try await client().heartbeat(agents: [])
        XCTAssertEqual(beat.repos, [])
        XCTAssertNil(beat.products)
    }

    func testMeDecodesTheDeviceNameAndTheNickname() async throws {
        StubURLProtocol.install { _, _ in
            .response(status: 200, body: #"""
            {"node":{"id":"n1","name":"二号机","deviceName":"Mac mini","nickname":"二号机","hostname":"mini","online":true},
             "repos":[],"products":[]}
            """#)
        }
        let profile = try await client().me()
        XCTAssertEqual(profile.node.name, "二号机")
        XCTAssertEqual(profile.node.deviceName, "Mac mini")
        XCTAssertEqual(profile.node.nickname, "二号机")
    }

    private static let nicknameProfile = #"""
    {"node":{"id":"n1","name":"Mac mini","deviceName":"Mac mini","hostname":"mini","online":true},"repos":[],"products":[]}
    """#

    func testUpdateNicknameSendsAPatchWithTheNickname() async throws {
        StubURLProtocol.install { _, _ in .response(status: 200, body: APIClientTests.nicknameProfile) }
        let profile = try await client().updateNickname("二号机")
        XCTAssertEqual(profile.node.deviceName, "Mac mini")
        let sent = try XCTUnwrap(StubURLProtocol.recorded.first)
        XCTAssertEqual(sent.request.httpMethod, "PATCH")
        XCTAssertEqual(sent.request.url?.absoluteString, "http://127.0.0.1:8799/api/v1/node/me")
        XCTAssertEqual(sent.request.value(forHTTPHeaderField: "Authorization"), "Bearer mgn_x")
        XCTAssertEqual(sent.request.value(forHTTPHeaderField: "Content-Type"), "application/json")
        XCTAssertEqual(String(decoding: sent.body, as: UTF8.self), #"{"nickname":"二号机"}"#)
    }

    func testClearingTheNicknameSendsAnExplicitNull() async throws {
        // Left out, the key would be refused as neither a string nor null.
        StubURLProtocol.install { _, _ in .response(status: 200, body: APIClientTests.nicknameProfile) }
        let profile = try await client().updateNickname(nil)
        XCTAssertNil(profile.node.nickname)
        let sent = try XCTUnwrap(StubURLProtocol.recorded.first)
        XCTAssertEqual(sent.request.httpMethod, "PATCH")
        XCTAssertEqual(sent.request.url?.path, "/api/v1/node/me")
        XCTAssertEqual(String(decoding: sent.body, as: UTF8.self), #"{"nickname":null}"#)
    }

    func testARefusedNicknameSurfacesTheProblemTitle() async {
        StubURLProtocol.install { _, _ in
            .response(status: 400, body: #"{"title":"Nickname must be 40 characters or fewer.","status":400}"#,
                      headers: ["Content-Type": "application/problem+json"])
        }
        do {
            _ = try await client().updateNickname(String(repeating: "x", count: 41))
            XCTFail("expected an error")
        } catch {
            XCTAssertEqual(error.localizedDescription, "保存昵称 失败（HTTP 400）：Nickname must be 40 characters or fewer.")
        }
    }

    func testReplaceReposSendsPut() async throws {
        StubURLProtocol.install { _, _ in
            .response(status: 200, body: #"{"repos":[{"productId":"p1","productKey":"AND","repoPath":"/Users/dev/p"}]}"#)
        }
        let repos = try await client().replaceRepos([RepoAssignment(productId: "p1", repoPath: "/Users/dev/p")])
        XCTAssertEqual(repos, [RepoMapping(productId: "p1", productKey: "AND", repoPath: "/Users/dev/p")])
        let sent = try XCTUnwrap(StubURLProtocol.recorded.first)
        XCTAssertEqual(sent.request.httpMethod, "PUT")
        let repo = (jsonObject(sent.body)["repos"] as? [[String: Any]])?.first
        XCTAssertEqual(repo?["repoPath"] as? String, "/Users/dev/p")
    }

    func testIsSuccessCoversEvery2xx() {
        XCTAssertTrue(isSuccess(200))
        XCTAssertTrue(isSuccess(201))
        XCTAssertTrue(isSuccess(204))
        XCTAssertFalse(isSuccess(301))
        XCTAssertFalse(isSuccess(199))
    }

    // MARK: Snapshot upload gzip (AND-182)

    private func largeReport() -> AgentSessionReport {
        return AgentSessionReport(
            status: "idle",
            messages: [AgentSessionMessage(sourceId: "u1", turnId: "t1", role: "user", text: String(repeating: "x", count: 2_000))]
        )
    }

    func testSnapshotUploadIsGzippedWhenLargeEnough() async throws {
        StubURLProtocol.install { _, _ in .response(status: 204, body: "") }
        let report = largeReport()
        try await client().reportAgentSession(sessionId: "s1", report: report)

        let sent = try XCTUnwrap(StubURLProtocol.recorded.first)
        XCTAssertEqual(sent.request.value(forHTTPHeaderField: "Content-Encoding"), "gzip")
        XCTAssertTrue(Gzip.looksLikeGzip(sent.body), "a compressed upload must carry the gzip magic bytes")
        let decoded = try XCTUnwrap(Gzip.decompress(sent.body), "the upload must decode back to the report")
        XCTAssertEqual(decoded, try APIClient.encoder.encode(report))
    }

    func testSnapshotUploadStaysPlainWhenSmall() async throws {
        StubURLProtocol.install { _, _ in .response(status: 204, body: "") }
        let report = AgentSessionReport(status: "idle", messages: [])
        try await client().reportAgentSession(sessionId: "s1", report: report)

        let sent = try XCTUnwrap(StubURLProtocol.recorded.first)
        XCTAssertNil(sent.request.value(forHTTPHeaderField: "Content-Encoding"))
        XCTAssertEqual(sent.body, try APIClient.encoder.encode(report))
    }

    func testGzipFallsBackToPlainJSONWhenTheServerRefusesIt() async throws {
        // A server from before AND-182 parses the compressed bytes as JSON and
        // answers 400; the client must retry the same body uncompressed.
        StubURLProtocol.install { _, body in
            Gzip.looksLikeGzip(body)
                ? .response(status: 400, body: #"{"title":"unsupported"}"#)
                : .response(status: 204, body: "")
        }
        let api = client()
        try await api.reportAgentSession(sessionId: "s1", report: largeReport())
        // The fallback holds for later uploads too: no third compressed try.
        try await api.reportAgentSession(sessionId: "s1", report: largeReport())

        let bodies = StubURLProtocol.recorded.map(\.body)
        XCTAssertEqual(bodies.count, 3, "one compressed try, one plain retry, one plain upload")
        XCTAssertTrue(Gzip.looksLikeGzip(bodies[0]))
        XCTAssertFalse(Gzip.looksLikeGzip(bodies[1]))
        XCTAssertFalse(Gzip.looksLikeGzip(bodies[2]))
        XCTAssertEqual(bodies[1], try APIClient.encoder.encode(largeReport()))
        XCTAssertNil(StubURLProtocol.recorded[1].request.value(forHTTPHeaderField: "Content-Encoding"))
    }

    // AND-181: a snapshot the server would refuse (over-long message, too many
    // messages, body over the route's limit) used to be uploaded as-is and fail
    // with a 413/400 the sync loop treated as a generic offline blip.

    func testSnapshotUploadCapsMessageTextToTheServerContract() throws {
        let uploadable = try APIClient.uploadableSnapshot(AgentSessionReport(status: "idle", messages: [
            AgentSessionMessage(sourceId: "m1", role: "user", text: String(repeating: "字", count: 100_050)),
        ]))
        XCTAssertEqual(uploadable.messages.count, 1)
        // The cap is 100_000 UTF-16 code units, the unit the server's `.length` counts.
        XCTAssertEqual(uploadable.messages[0].text.utf16.count, 100_000)
        XCTAssertEqual(uploadable.messages[0].text, String(repeating: "字", count: 100_000))
    }

    func testSnapshotUploadCapCountsUTF16UnitsNotGraphemes() throws {
        // One party popper is one grapheme cluster but two UTF-16 units.
        let uploadable = try APIClient.uploadableSnapshot(AgentSessionReport(status: "idle", messages: [
            AgentSessionMessage(sourceId: "m1", role: "agent", text: String(repeating: "🎉", count: 50_001)),
        ]))
        XCTAssertEqual(uploadable.messages[0].text.utf16.count, 100_000)
        // The cut lands on a whole character, never inside a surrogate pair.
        XCTAssertEqual(uploadable.messages[0].text.count, 50_000)
    }

    func testSnapshotUploadKeepsTheNewestMessagesWithinTheServerCountLimit() throws {
        let messages = (0...2_000).map { index in
            AgentSessionMessage(sourceId: "m\(index)", role: "user", text: "m\(index)")
        }
        let uploadable = try APIClient.uploadableSnapshot(
            AgentSessionReport(status: "idle", messages: messages), budget: .max
        )
        XCTAssertEqual(uploadable.messages.count, 2_000)
        XCTAssertEqual(uploadable.messages.first?.sourceId, "m1")
        XCTAssertEqual(uploadable.messages.last?.sourceId, "m2000")
    }

    func testSnapshotUploadDropsTheOldestMessagesToStayInsideTheBudget() throws {
        let messages = (0..<6).map { index in
            AgentSessionMessage(sourceId: "m\(index)", role: "user", text: String(repeating: "a", count: 1_000))
        }
        let report = AgentSessionReport(status: "idle", messages: messages)
        let budget = try APIClient.encoder.encode(report).count - 1_500
        let uploadable = try APIClient.uploadableSnapshot(report, budget: budget)
        XCTAssertFalse(uploadable.messages.contains { $0.sourceId == "m0" })
        XCTAssertTrue(uploadable.messages.contains { $0.sourceId == "m5" })
        XCTAssertLessThanOrEqual(try APIClient.encoder.encode(uploadable).count, budget)
    }

    func testReportAgentSessionSendsTheReportAsIsWhenItFits() async throws {
        StubURLProtocol.install { _, _ in .response(status: 204, body: "") }
        try await client().reportAgentSession(sessionId: "s1", report: AgentSessionReport(
            status: "idle",
            messages: [AgentSessionMessage(sourceId: "u1", role: "user", text: "处理并发布。")]
        ))
        let sent = try XCTUnwrap(StubURLProtocol.recorded.first)
        XCTAssertEqual(sent.request.url?.path, "/api/v1/node/agent-sessions/s1/snapshot")
        let body = jsonObject(sent.body)
        XCTAssertEqual((body["messages"] as? [[String: Any]])?.count, 1)
        XCTAssertEqual(body["status"] as? String, "idle")
    }
}
