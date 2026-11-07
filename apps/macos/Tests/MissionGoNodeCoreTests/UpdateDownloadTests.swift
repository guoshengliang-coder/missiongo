import XCTest
@testable import MissionGoNodeCore

final class UpdateDownloadTests: XCTestCase {
    private var process: Process!
    private var origin = ""

    override func setUpWithError() throws {
        let fixture = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("Fixtures/update-http.py")
        let pipe = Pipe()
        process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/python3")
        process.arguments = ["-u", fixture.path]
        process.standardOutput = pipe
        process.standardError = FileHandle.nullDevice
        try process.run()
        let port = String(decoding: pipe.fileHandleForReading.availableData, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)
        XCTAssertNotNil(Int(port))
        origin = "http://127.0.0.1:\(port)"
    }
    override func tearDown() {
        process?.terminate()
        process?.waitUntilExit()
    }
    private func manifest(_ path: String) throws -> AppUpdater.Manifest {
        let sha = AppUpdater.digest(of: Data("abcdef".utf8))
        return try AppUpdater.decode(manifest: Data("""
        {"version":"1.0","sha256":"\(sha)","size":6,"downloadPath":"/\(path)"}
        """.utf8))
    }
    private func session() -> URLSession {
        let config = URLSessionConfiguration.ephemeral
        config.connectionProxyDictionary = [:]
        return URLSession(configuration: config)
    }

    func testRealChunkedDownloadReportsBoundedProgressAndVerification() async throws {
        for path in ["normal", "unknown"] {
            let events = Locked<[Int]>([])
            let stages = Locked<[UpdateActivity.Stage]>([])
            let session = session()
            defer { session.invalidateAndCancel() }
            let data = try await AppUpdater.download(try manifest(path), serverUrl: origin, session: session,
                progress: { bytes, total, _ in
                    XCTAssertEqual(total, 6)
                    events.withLock { $0.append(bytes) }
                }, stage: { stage in stages.withLock { $0.append(stage) } })
            XCTAssertEqual(data, Data("abcdef".utf8))
            XCTAssertEqual(events.current.last, 6)
            XCTAssertTrue(events.current.allSatisfy { (0...6).contains($0) })
            XCTAssertEqual(stages.current, [.verifying])
        }
    }
    func testRejectsWrongLengthOverflowAndTruncatedBodiesBeforeVerification() async throws {
        for path in ["wrong-length", "overflow", "truncated", "503"] {
            let stages = Locked<[UpdateActivity.Stage]>([])
            let session = session()
            defer { session.invalidateAndCancel() }
            do {
                _ = try await AppUpdater.download(try manifest(path), serverUrl: origin, session: session,
                    stage: { stage in stages.withLock { $0.append(stage) } })
                XCTFail("accepted \(path)")
            } catch { XCTAssertFalse(error is CancellationError) }
            XCTAssertTrue(stages.current.isEmpty, path)
        }
    }
    func testCancellationStopsOnlyUpdateAndSessionRemainsUsable() async throws {
        let session = session()
        defer { session.invalidateAndCancel() }
        let manifest = try manifest("stall")
        let task = Task { try await AppUpdater.download(manifest, serverUrl: origin, session: session) }
        try await Task.sleep(nanoseconds: 150_000_000)
        task.cancel()
        do { _ = try await task.value; XCTFail("accepted cancellation") }
        catch { XCTAssertTrue(error is CancellationError) }
        let (data, _) = try await session.data(from: URL(string: origin + "/normal")!)
        XCTAssertEqual(data, Data("abcdef".utf8))
    }
    func testAlreadyCancelledTaskNeverStartsDownload() async throws {
        let session = session()
        defer { session.invalidateAndCancel() }
        let manifest = try manifest("normal")
        let task = Task {
            withUnsafeCurrentTask { $0?.cancel() }
            return try await AppUpdater.download(manifest, serverUrl: origin, session: session)
        }
        do { _ = try await task.value; XCTFail("accepted cancellation") }
        catch { XCTAssertTrue(error is CancellationError) }
    }
    func testIdleAndResourceBudgetsBoundRealRequests() async throws {
        for path in ["stall", "first-byte", "trickle"] {
            let session = session()
            defer { session.invalidateAndCancel() }
            let start = Date()
            do {
                _ = try await AppUpdater.download(try manifest(path), serverUrl: origin, session: session,
                    idleTimeout: 1, resourceTimeout: path == "trickle" ? 1 : 5)
                XCTFail("accepted \(path)")
            } catch {
                XCTAssertTrue(error.localizedDescription.contains("超时"), "\(error)")
            }
            XCTAssertLessThan(Date().timeIntervalSince(start), 6)
        }
    }
}

final class UpdateActivityTests: XCTestCase {
    func testCompletedDownloadAndInstalledWaitAreDistinctAndLateProgressIsIgnored() {
        var activity = UpdateActivity(version: "1.0", size: 6)
        activity.move(to: .downloading)
        activity.downloadProgress(received: 2, total: 6, elapsed: 1)
        XCTAssertLessThan(activity.fraction, 1)
        activity.move(to: .verifying)
        activity.downloadProgress(received: 3, total: 6, elapsed: 2)
        XCTAssertEqual(activity.fraction, 1)
        XCTAssertTrue(activity.stage.canCancel)
        activity.move(to: .unpacking)
        XCTAssertFalse(activity.stage.canCancel)
        activity.move(to: .waiting)
        XCTAssertTrue(activity.detail(now: Date()).contains("已写入磁盘"))
        XCTAssertTrue(activity.detail(now: Date()).contains("不会强退"))
    }
    func testDiagnosticsAreBoundedAndDoNotRecordRawErrorSecrets() {
        var activity = UpdateActivity(version: "1.0", size: 6)
        for _ in 0..<100 { activity.record("阶段") }
        activity.failed(NSError(domain: "https://secret.invalid?token=secret", code: 123,
            userInfo: [NSLocalizedDescriptionKey: "/Users/private secret-token"]))
        XCTAssertEqual(activity.records.count, 32)
        XCTAssertTrue(activity.diagnostics.contains("123"))
        XCTAssertFalse(activity.diagnostics.contains("secret"))
        XCTAssertFalse(activity.diagnostics.contains("/Users/"))
    }
}
