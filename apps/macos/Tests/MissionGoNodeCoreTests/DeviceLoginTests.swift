import XCTest
@testable import MissionGoNodeCore

final class DeviceLoginTests: XCTestCase {
    private let server = "https://mg.test"
    private let now = Date(timeIntervalSince1970: 1_800_000_000)

    private func install(scope: String = "missiongo:read missiongo:node", failures: [String] = []) {
        let errors = Locked(failures)
        StubURLProtocol.install { request, _ in
            switch request.url?.path {
            case "/oauth/register": return .response(status: 201, body: #"{"client_id":"mgd_client"}"#)
            case "/oauth/device_authorization": return .response(status: 200, body: #"{"device_code":"device-secret","user_code":"BCDFG-HJKLM","verification_uri":"https://mg.test/oauth/device","verification_uri_complete":"https://mg.test/oauth/device?user_code=BCDFG-HJKLM","expires_in":600,"interval":5}"#)
            case "/oauth/token":
                if let error = errors.withLock({ $0.isEmpty ? nil : $0.removeFirst() }) {
                    return .response(status: 400, body: #"{"error":"\#(error)"}"#)
                }
                return .response(status: 200, body: #"{"access_token":"mgai_test","scope":"\#(scope)"}"#)
            case "/api/v1/node/register": return .response(status: 201, body: #"{"nodeId":"node-1","name":"Test Mac","token":"mgn_test"}"#)
            default: return .response(status: 404, body: "")
            }
        }
    }

    private func login(sleep: @escaping @Sendable (TimeInterval) async throws -> Void = { _ in }) -> DeviceLogin {
        DeviceLogin(serverUrl: server, session: StubURLProtocol.session(), now: { [now] in now }, sleep: sleep)
    }

    func testNewLoginHasNoRedirectURIAndHonoursPendingAndSlowDown() async throws {
        install(failures: ["authorization_pending", "slow_down"])
        let waits = Locked<[Double]>([])
        let checkpoints = Locked<[PendingDeviceLogin]>([])
        let flow = login(sleep: { seconds in waits.withLock { $0.append(seconds) } })
        let pending = try await flow.begin()
        let result = try await flow.complete(pending, installationId: "installation-1", name: "Test Mac", hostname: "test",
            checkpoint: { pending in checkpoints.withLock { $0.append(pending) } })
        XCTAssertEqual(result.token, "mgn_test")
        XCTAssertEqual(waits.current, [5, 5, 10])
        XCTAssertEqual(checkpoints.current.map(\.interval), [10, 10])
        XCTAssertEqual(checkpoints.current.last?.accessToken, "mgai_test")
        let registration = jsonObject(StubURLProtocol.recorded[0].body)
        XCTAssertNil(registration["redirect_uris"])
        XCTAssertEqual(registration["grant_types"] as? [String], [DeviceLogin.grantType])
        let poll = StubURLProtocol.recorded.first { $0.request.url?.path == "/oauth/token" }!
        let fields = OAuthRequests.parseQuery("?" + String(decoding: poll.body, as: UTF8.self))
        XCTAssertEqual(fields["device_code"], "device-secret")
        XCTAssertNil(fields["redirect_uri"])
        let node = StubURLProtocol.recorded.last!
        XCTAssertEqual(node.request.value(forHTTPHeaderField: "Authorization"), "Bearer mgai_test")
        XCTAssertEqual(jsonObject(node.body)["installationId"] as? String, "installation-1")
    }

    func testPersistedRequestResumesWithoutRegistrationOrNewDeviceCode() async throws {
        install()
        let pending = try await login().begin()
        let restored = try JSONDecoder().decode(PendingDeviceLogin.self, from: JSONEncoder().encode(pending))
        install() // A new app/session starts with an empty request history.
        _ = try await login().complete(restored, installationId: "existing-installation", name: "Test Mac", hostname: "test", checkpoint: { _ in })
        XCTAssertEqual(StubURLProtocol.recorded.map { $0.request.url?.path }, ["/oauth/token", "/api/v1/node/register"])
    }

    func testRegistrationFailureCanResumeCheckpointedTokenWithoutRedeemingAgain() async throws {
        install()
        var pending = try await login().begin()
        pending.accessToken = "mgai_checkpoint"
        install()
        _ = try await login().complete(pending, installationId: "installation-1", name: "Test Mac", hostname: "test", checkpoint: { _ in XCTFail("already checkpointed") })
        XCTAssertEqual(StubURLProtocol.recorded.map { $0.request.url?.path }, ["/api/v1/node/register"])
        XCTAssertEqual(StubURLProtocol.recorded[0].request.value(forHTTPHeaderField: "Authorization"), "Bearer mgai_checkpoint")
    }

    func testDenialExpiryMissingScopeAndCancellationNeverRegisterNode() async throws {
        for error in ["access_denied", "expired_token"] {
            install(failures: [error])
            let flow = login()
            let pending = try await flow.begin()
            do {
                _ = try await flow.complete(pending, installationId: "i", name: "m", hostname: "h", checkpoint: { _ in })
                XCTFail("expected \(error)")
            } catch { XCTAssertTrue(error is OAuthLoginError) }
            XCTAssertFalse(StubURLProtocol.recorded.contains { $0.request.url?.path == "/api/v1/node/register" })
        }
        install(scope: "missiongo:read")
        let pending = try await login().begin()
        do {
            _ = try await login().complete(pending, installationId: "i", name: "m", hostname: "h", checkpoint: { _ in })
            XCTFail("missing scope must fail")
        } catch { XCTAssertEqual(error as? OAuthLoginError, .missingNodeScope(granted: "missiongo:read")) }
        let entered = expectation(description: "poll sleep")
        let flow = login(sleep: { _ in entered.fulfill(); try await Task.sleep(nanoseconds: 5_000_000_000) })
        let task = Task { try await flow.complete(pending, installationId: "i", name: "m", hostname: "h", checkpoint: { _ in }) }
        await fulfillment(of: [entered], timeout: 1)
        task.cancel()
        do { _ = try await task.value; XCTFail("expected cancellation") }
        catch { XCTAssertTrue(error is CancellationError) }
        XCTAssertFalse(StubURLProtocol.recorded.contains { $0.request.url?.path == "/api/v1/node/register" })
    }

    func testLocalExpiryStopsBeforeSendingOrRegistering() async throws {
        install()
        let current = try await login().begin()
        let expired = PendingDeviceLogin(serverUrl: current.serverUrl, clientId: current.clientId,
            deviceCode: current.deviceCode, userCode: current.userCode, verificationUri: current.verificationUri,
            verificationUriComplete: current.verificationUriComplete, expiresAt: now.addingTimeInterval(-1), interval: 5, accessToken: nil)
        do {
            _ = try await login().complete(expired, installationId: "i", name: "m", hostname: "h", checkpoint: { _ in })
            XCTFail("expired login must fail")
        } catch { XCTAssertEqual(error as? OAuthLoginError, .timedOut) }
        XCTAssertEqual(StubURLProtocol.recorded.map { $0.request.url?.path }, ["/oauth/register", "/oauth/device_authorization"])
    }

    func testNetworkFailureBacksOffAndReportsRecoveryState() async throws {
        install()
        let pending = try await login().begin()
        let first = Locked(true)
        StubURLProtocol.install { request, _ in
            if request.url?.path == "/oauth/token" {
                if first.withLock({ value in let previous = value; value = false; return previous }) {
                    return .failure(URLError(.notConnectedToInternet))
                }
                return .response(status: 200, body: #"{"access_token":"mgai_test","scope":"missiongo:read missiongo:node"}"#)
            }
            return .response(status: 201, body: #"{"nodeId":"n","name":"Mac","token":"mgn_test"}"#)
        }
        let waits = Locked<[Double]>([])
        let messages = Locked<[String]>([])
        _ = try await login(sleep: { seconds in waits.withLock { $0.append(seconds) } }).complete(
            pending, installationId: "i", name: "m", hostname: "h", checkpoint: { _ in },
            status: { text in messages.withLock { $0.append(text) } })
        XCTAssertEqual(waits.current, [5, 10])
        XCTAssertTrue(messages.current.contains { $0.contains("网络连接暂不可用") })
        XCTAssertTrue(messages.current.last?.contains("正在登记设备") == true)
    }

    func testRefusesVerificationURLOnAnotherOrigin() async {
        StubURLProtocol.install { request, _ in
            if request.url?.path == "/oauth/register" { return .response(status: 201, body: #"{"client_id":"client"}"#) }
            return .response(status: 200, body: #"{"device_code":"d","user_code":"u","verification_uri":"https://evil.test/","verification_uri_complete":"https://evil.test/","expires_in":600}"#)
        }
        do { _ = try await login().begin(); XCTFail("expected rejection") }
        catch { XCTAssertTrue(error is OAuthLoginError) }
    }
}
