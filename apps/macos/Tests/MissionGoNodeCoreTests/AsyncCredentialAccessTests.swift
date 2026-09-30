import XCTest
@testable import MissionGoNodeCore

final class AsyncCredentialAccessTests: XCTestCase {
    func testSequentialOperationsCanRunImmediatelyAfterCompletion() async throws {
        let access = AsyncCredentialAccess()
        for i in 0..<30 {
            let result = try await access.run { i }
            XCTAssertEqual(result, i)
        }
    }

    func testDeadlineDoesNotWaitForBlockedSystemCallAndPreventsRetryPileup() async throws {
        let access = AsyncCredentialAccess()
        let gate = DispatchSemaphore(value: 0)
        defer { gate.signal() }
        let began = expectation(description: "worker entered")
        let calls = Locked(0)
        let start = Date()
        let task = Task {
            try await access.run(timeout: 0.1) {
                calls.withLock { $0 += 1 }
                began.fulfill()
                gate.wait()
                return "late credential"
            }
        }
        await fulfillment(of: [began], timeout: 1)
        do { _ = try await task.value; XCTFail("expected deadline") }
        catch { XCTAssertTrue(error.localizedDescription.contains("超时")) }
        XCTAssertLessThan(Date().timeIntervalSince(start), 1)
        for _ in 0..<10 {
            do {
                _ = try await access.run { calls.withLock { $0 += 1 }; return "should not run" }
                XCTFail("busy operation must be refused")
            } catch { XCTAssertTrue(error.localizedDescription.contains("仍未返回")) }
        }
        XCTAssertEqual(calls.current, 1)
        gate.signal()
        // The late result must not change the already returned timeout, and the
        // reservation becomes usable only when the old system call has ended.
        var recovered = false
        for _ in 0..<100 {
            if (try? await access.run { "new credential" }) == "new credential" { recovered = true; break }
            try await Task.sleep(nanoseconds: 1_000_000)
        }
        XCTAssertTrue(recovered)
    }

    func testCancellationReturnsWithoutWaitingForTheWorker() async {
        let access = AsyncCredentialAccess()
        let gate = DispatchSemaphore(value: 0)
        defer { gate.signal() }
        let began = expectation(description: "worker entered")
        let task = Task { try await access.run(timeout: 5) { began.fulfill(); gate.wait(); return "late value" } }
        await fulfillment(of: [began], timeout: 1)
        task.cancel()
        do { _ = try await task.value; XCTFail("expected cancellation") }
        catch { XCTAssertTrue(error is CancellationError) }
    }
}
