import Foundation
import XCTest
@testable import MissionGoNodeCore

/// A request that stays in flight while a person presses reconnect.
private final class HeldRequestProtocol: URLProtocol {
    static let pending = Locked<HeldRequestProtocol?>(nil)
    static let cancellations = Locked(0)

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() { Self.pending.withLock { $0 = self } }
    override func stopLoading() { Self.cancellations.withLock { $0 += 1 } }

    func finish() {
        let response = HTTPURLResponse(url: request.url!, statusCode: 204, httpVersion: nil, headerFields: nil)!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocolDidFinishLoading(self)
        Self.pending.withLock { $0 = nil }
    }
}

final class ServerSessionPoolTests: XCTestCase {
    private func request(timeout: TimeInterval = 15) -> URLRequest {
        var request = URLRequest(url: URL(string: "https://missiongo.example.test/snapshot")!, timeoutInterval: timeout)
        request.httpMethod = "POST"
        request.httpBody = Data("snapshot".utf8)
        return request
    }

    private func factory(_ created: Locked<[ServerSessionPool.Key]>) -> @Sendable (ServerSessionPool.Key) -> URLSession {
        { key in
            let number = created.withLock { value in value.append(key); return value.count }
            let config = ServerConnection.configuration(for: key.mode)
            config.timeoutIntervalForResource = key.resourceTimeout
            config.protocolClasses = [StubURLProtocol.self]
            config.httpAdditionalHeaders = ["X-Session": String(number)]
            return URLSession(configuration: config)
        }
    }

    private func fail(_ pool: ServerSessionPool, times: Int = 1, mode: ServerConnectionMode = .direct) async {
        for _ in 0..<times {
            do {
                _ = try await pool.data(for: request(), mode: mode)
                XCTFail("Expected network failure")
            } catch {}
        }
    }

    func testRepeatedNetworkLossReplacesThePoolWithoutReplayingTheFailedMutation() async throws {
        let created = Locked<[ServerSessionPool.Key]>([])
        let pool = ServerSessionPool(makeSession: factory(created))
        defer { pool.reconnect() }
        StubURLProtocol.install { request, _ in
            request.value(forHTTPHeaderField: "X-Session") == "1"
                ? .failure(URLError(.networkConnectionLost)) : .response(status: 204, body: "")
        }
        await fail(pool, times: 3)
        XCTAssertEqual(StubURLProtocol.recorded.count, 3, "failed POSTs are never replayed by the transport")
        let (_, response) = try await pool.data(for: request(), mode: .direct)
        XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 204)
        XCTAssertEqual(created.current.count, 2)
        XCTAssertEqual(StubURLProtocol.recorded.count, 4)
    }

    func testManualReconnectDrainsAnInFlightMutationAndNewRequestsUseFreshConnections() async throws {
        HeldRequestProtocol.pending.withLock { $0 = nil }
        HeldRequestProtocol.cancellations.withLock { $0 = 0 }
        let created = Locked(0)
        let pool = ServerSessionPool { _ in
            let first = created.withLock { value in value += 1; return value == 1 }
            let config = URLSessionConfiguration.ephemeral
            config.protocolClasses = first ? [HeldRequestProtocol.self] : [StubURLProtocol.self]
            return URLSession(configuration: config)
        }
        defer { pool.reconnect() }
        StubURLProtocol.install { _, _ in .response(status: 200, body: "new connection") }
        let old = Task { try await pool.data(for: request(), mode: .direct) }
        let deadline = Date().addingTimeInterval(3)
        while HeldRequestProtocol.pending.current == nil && Date() < deadline {
            try await Task.sleep(nanoseconds: 10_000_000)
        }
        let held = try XCTUnwrap(HeldRequestProtocol.pending.current)
        pool.reconnect()
        let (data, _) = try await pool.data(for: request(), mode: .direct)
        XCTAssertEqual(String(data: data, encoding: .utf8), "new connection")
        XCTAssertEqual(HeldRequestProtocol.cancellations.current, 0)
        held.finish()
        let (_, response) = try await old.value
        XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 204)
        XCTAssertEqual(created.current, 2)
    }

    func testAutomaticRecoveryHasACooldownAndAFiveMinuteLimitAndManualReconnectStillWorks() async throws {
        let time = Locked(Date(timeIntervalSince1970: 10_000))
        let created = Locked<[ServerSessionPool.Key]>([])
        let pool = ServerSessionPool(now: { time.current }, makeSession: factory(created))
        defer { pool.reconnect() }
        StubURLProtocol.install { _, _ in .failure(URLError(.timedOut)) }
        await fail(pool, times: 10)
        XCTAssertEqual(created.current.count, 2, "a burst may replace a pool only once")
        time.withLock { $0 += 15 }
        await fail(pool, times: 2)
        XCTAssertEqual(created.current.count, 3)
        time.withLock { $0 += 30 }
        await fail(pool, times: 4)
        XCTAssertEqual(created.current.count, 4)
        time.withLock { $0 += 60 }
        await fail(pool, times: 10)
        XCTAssertEqual(created.current.count, 4, "at most three automatic replacements per five minutes")
        time.withLock { $0 += 200 }
        await fail(pool, times: 2)
        XCTAssertEqual(created.current.count, 5, "automatic recovery resumes in the next window")
        pool.reconnect()
        StubURLProtocol.install { _, _ in .response(status: 204, body: "") }
        _ = try await pool.data(for: request(), mode: .direct)
        XCTAssertEqual(created.current.count, 6)
    }

    func testTLSAndCancellationAndHTTPFailuresDoNotRotateOrReplayRequests() async throws {
        let created = Locked<[ServerSessionPool.Key]>([])
        let pool = ServerSessionPool(makeSession: factory(created))
        defer { pool.reconnect() }
        for code: URLError.Code in [.serverCertificateUntrusted, .secureConnectionFailed, .cancelled] {
            StubURLProtocol.install { _, _ in .failure(URLError(code)) }
            await fail(pool, times: 4)
            XCTAssertEqual(created.current.count, 1)
            XCTAssertEqual(StubURLProtocol.recorded.count, 4)
        }
        StubURLProtocol.install { _, _ in .response(status: 401, body: "unauthorized") }
        for _ in 0..<4 { _ = try await pool.data(for: request(), mode: .direct) }
        XCTAssertEqual(created.current.count, 1)
        XCTAssertEqual(StubURLProtocol.recorded.count, 4)
    }

    func testRoutesAndLargeDownloadsKeepSeparatePoolsAndFiniteResourceBudgets() async throws {
        let created = Locked<[ServerSessionPool.Key]>([])
        let pool = ServerSessionPool(makeSession: factory(created))
        defer { pool.reconnect() }
        StubURLProtocol.install { _, _ in .response(status: 200, body: "ok") }
        for mode: ServerConnectionMode in [.system, .direct] {
            _ = try await pool.data(for: request(timeout: 40), mode: mode)
            _ = try await pool.data(for: request(timeout: 600), mode: mode)
        }
        XCTAssertEqual(created.current.map(\.resourceTimeout), [60, 600, 60, 600])
        XCTAssertEqual(created.current.map(\.mode), [.system, .system, .direct, .direct])
        XCTAssertEqual(StubURLProtocol.recorded.map { $0.request.timeoutInterval }, [40, 600, 40, 600])
    }
}
