import Foundation
import XCTest
@testable import MissionGoNodeCore

final class ServerConnectionTests: XCTestCase {
    private let server = "https://missiongo.example.test"

    private func session(route: String) -> URLSession {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [StubURLProtocol.self]
        config.httpAdditionalHeaders = ["X-Test-Route": route]
        return URLSession(configuration: config)
    }

    func testDiagnosisRecommendsDirectOnlyAfterAHealthyDirectResponse() async {
        StubURLProtocol.install { request, _ in
            if request.value(forHTTPHeaderField: "X-Test-Route") == "system" {
                return .failure(URLError(.secureConnectionFailed))
            }
            return .response(status: 200, body: #"{"status":"ok"}"#)
        }
        let system = session(route: "system"), direct = session(route: "direct")
        defer { system.invalidateAndCancel(); direct.invalidateAndCancel() }
        let result = await ServerConnection.diagnose(serverUrl: server, systemSession: system, directSession: direct)
        XCTAssertTrue(result.recommendsDirect)
        XCTAssertEqual(result.direct, .reachable)
        XCTAssertTrue(result.system.description.contains("TLS 安全连接失败"))
        XCTAssertEqual(StubURLProtocol.recorded.count, 2)
        for sent in StubURLProtocol.recorded {
            XCTAssertEqual(sent.request.url?.absoluteString, server + "/health")
            XCTAssertEqual(sent.request.httpMethod, "GET")
            XCTAssertNil(sent.request.value(forHTTPHeaderField: "Authorization"))
            XCTAssertTrue(sent.body.isEmpty)
            XCTAssertEqual(sent.request.timeoutInterval, 5)
        }
    }

    func testDiagnosisDoesNotRecommendDirectForCertificateFailureOrCaptivePortal() async {
        for directReply: StubURLProtocol.Reply in [
            .failure(URLError(.serverCertificateUntrusted)),
            .response(status: 200, body: "<html>Sign in to Wi-Fi</html>"),
            .response(status: 503, body: #"{"status":"ok"}"#),
            .response(status: 200, body: #"{"status":"error"}"#)
        ] {
            StubURLProtocol.install { request, _ in
                request.value(forHTTPHeaderField: "X-Test-Route") == "system"
                    ? .failure(URLError(.timedOut)) : directReply
            }
            let system = session(route: "system"), direct = session(route: "direct")
            let result = await ServerConnection.diagnose(serverUrl: server, systemSession: system, directSession: direct)
            system.invalidateAndCancel(); direct.invalidateAndCancel()
            XCTAssertFalse(result.recommendsDirect)
            XCTAssertNotEqual(result.direct, .reachable)
        }
    }

    func testDiagnosisPreservesWorkingSystemRouteWhenDirectFails() async {
        StubURLProtocol.install { request, _ in
            request.value(forHTTPHeaderField: "X-Test-Route") == "system"
                ? .response(status: 200, body: #"{"status":"ok"}"#)
                : .failure(URLError(.cannotConnectToHost))
        }
        let system = session(route: "system"), direct = session(route: "direct")
        defer { system.invalidateAndCancel(); direct.invalidateAndCancel() }
        let result = await ServerConnection.diagnose(serverUrl: server, systemSession: system, directSession: direct)
        XCTAssertFalse(result.recommendsDirect)
        XCTAssertEqual(result.system, .reachable)
        XCTAssertTrue(result.summary.contains("建议跟随系统代理"))
    }

    func testInvalidServerAddressDoesNotSendAProbe() async {
        StubURLProtocol.install { _, _ in XCTFail("Invalid origin must not be requested"); return .failure(URLError(.badURL)) }
        let session = StubURLProtocol.session()
        defer { session.invalidateAndCancel() }
        let result = await ServerConnection.diagnose(serverUrl: "https://user:secret@example.test", systemSession: session, directSession: session)
        XCTAssertFalse(result.recommendsDirect)
        XCTAssertTrue(StubURLProtocol.recorded.isEmpty)
        XCTAssertFalse(result.summary.contains("secret"))
    }

    func testModePersistsAndUnknownSettingsUseTheSystemRoute() throws {
        let suite = "ServerConnectionTests-" + UUID().uuidString
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        XCTAssertEqual(ServerConnection.mode(defaults: defaults), .system)
        ServerConnection.setMode(.direct, defaults: defaults)
        XCTAssertEqual(ServerConnection.mode(defaults: defaults), .direct)
        ServerConnection.setMode(.system, defaults: defaults)
        XCTAssertEqual(ServerConnection.mode(defaults: defaults), .system)
        defaults.set("unsupported", forKey: ServerConnection.defaultsKey)
        XCTAssertEqual(ServerConnection.mode(defaults: defaults), .system)
    }

    func testTLSFailureIsActionableForUpdatesAndSkillDownloads() async {
        StubURLProtocol.install { _, _ in .failure(URLError(.secureConnectionFailed)) }
        let session = StubURLProtocol.session()
        defer { session.invalidateAndCancel() }
        do {
            _ = try await AppUpdater.check(serverUrl: server, currentVersion: "0.0.1", session: session)
            XCTFail("TLS failure accepted")
        } catch {
            XCTAssertTrue(error.localizedDescription.contains("TLS 安全连接失败"))
            XCTAssertTrue(error.localizedDescription.contains("服务器连接"))
        }
        do {
            _ = try await SkillSync.run(serverUrl: server, targets: [], session: session)
            XCTFail("TLS failure accepted")
        } catch {
            XCTAssertTrue(error.localizedDescription.contains("TLS 安全连接失败"))
            XCTAssertTrue(error.localizedDescription.contains("服务器连接"))
        }
    }

    func testAPITransportDoesNotReplayAMutationAfterTLSFailure() async {
        StubURLProtocol.install { _, _ in .failure(URLError(.secureConnectionFailed)) }
        let session = StubURLProtocol.session()
        defer { session.invalidateAndCancel() }
        do {
            _ = try await APIClient(serverUrl: server, token: "test-token", session: session).updateNickname("new-name")
            XCTFail("TLS failure accepted")
        } catch {
            XCTAssertTrue(error.localizedDescription.contains("URLError.secureConnectionFailed"))
        }
        XCTAssertEqual(StubURLProtocol.recorded.count, 1)
    }
}
