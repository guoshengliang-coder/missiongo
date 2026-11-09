#if DEBUG
import AppKit
import SwiftUI
import XCTest
@testable import MissionGoNodeCore
@testable import MissionGo

private actor UpdateGate {
    private var released = false
    private var waiters: [CheckedContinuation<Void, Never>] = []
    func wait() async {
        if released { return }
        await withCheckedContinuation { waiters.append($0) }
    }
    func release() {
        released = true
        waiters.forEach { $0.resume() }
        waiters.removeAll()
    }
}

private final class TestUpdateService: ClientUpdateService, @unchecked Sendable {
    let update: AppUpdater.Available
    let gate = UpdateGate()
    let began = XCTestExpectation(description: "download began")
    let finished = XCTestExpectation(description: "relaunch requested")
    let downloadReturned = XCTestExpectation(description: "download returned")
    var checkedUpdate: AppUpdater.Available?
    let checks = Locked(0)
    let installs = Locked(0)
    let progress = Locked<(@Sendable (Int, Int, TimeInterval) -> Void)?>(nil)
    var failRelaunch = false

    init(version: String = "1.1", longNotes: Bool = false) throws {
        let notes = longNotes ? String(repeating: "长更新说明，保持进度和底部操作可见。", count: 200) : "简短更新说明"
        let manifest = try AppUpdater.decode(manifest: Data("""
        {"version":"\(version)","sha256":"\(String(repeating: "a", count: 64))","size":6,"downloadPath":"/update.zip","releaseNotes":[{"pullRequestNumber":1,"title":"更新","items":[{"key":"TEST-1","title":"\(notes)"}]}]}
        """.utf8))
        update = AppUpdater.Available(current: "1.0", manifest: manifest)
        checkedUpdate = update
    }
    func check(serverUrl: String, currentVersion: String) async throws -> AppUpdater.Available? {
        checks.withLock { $0 += 1 }
        return checkedUpdate
    }
    func download(_ manifest: AppUpdater.Manifest, serverUrl: String,
                  progress: @escaping @Sendable (Int, Int, TimeInterval) -> Void,
                  stage: @escaping @Sendable (UpdateActivity.Stage) async -> Void,
                  metrics: @escaping @Sendable (String) -> Void) async throws -> Data {
        self.progress.withLock { $0 = progress }
        progress(2, 6, 1)
        began.fulfill()
        // Intentionally ignores cancellation until released: exercises late completion.
        await gate.wait()
        progress(6, 6, 2)
        await stage(.verifying)
        downloadReturned.fulfill()
        return Data("abcdef".utf8)
    }
    func install(zip: Data, manifest: AppUpdater.Manifest,
                 stage: @escaping @Sendable (UpdateActivity.Stage) async -> Void) async throws -> URL {
        installs.withLock { $0 += 1 }
        await stage(.unpacking)
        await stage(.security)
        await stage(.installing)
        return URL(fileURLWithPath: "/fixture/MissionGo.app")
    }
    @MainActor func relaunch(_ bundle: URL) throws {
        defer { finished.fulfill() }
        if failRelaunch { throw NSError(domain: "fixture", code: 1) }
    }
}

final class UpdateLifecycleTests: XCTestCase {
    @MainActor private func model(_ service: TestUpdateService, activity: UpdateActivity? = nil,
                                  loopTask: Task<Void, Never>? = nil) throws -> AppModel {
        let snapshot = try JSONDecoder().decode(UnreadSessionsSnapshot.self, from: Data(#"{"totalUnread":0,"sessions":[]}"#.utf8))
        return AppModel(previewCredential: NodeCredential(serverUrl: "https://example.invalid", nodeId: "fixture", name: "fixture", token: "unused"),
            unread: snapshot, agentVersions: [:], update: service.update, updateActivity: activity,
            updateService: service, previewLoopTask: loopTask)
    }
    @MainActor func testDuplicateClickAndSuccessfulFlowKeepInstalledAndRunningVersionsDistinct() async throws {
        let service = try TestUpdateService()
        let model = try model(service)
        model.installUpdate()
        model.installUpdate()
        await fulfillment(of: [service.began], timeout: 2)
        XCTAssertEqual(service.checks.current, 1)
        XCTAssertEqual(model.updateActivity?.stage, .downloading)
        await service.gate.release()
        await fulfillment(of: [service.finished], timeout: 2)
        XCTAssertEqual(service.installs.current, 1)
        XCTAssertEqual(model.updateActivity?.stage, .relaunching)
        XCTAssertEqual(model.updateState.current, "1.0")
        XCTAssertTrue(model.updateActivity?.diagnostics.contains("已安装，等待安全重启") == true)
        XCTAssertTrue(model.updateState.isBusy)
    }

    @MainActor func testImmediateRestartRequiresInstallationAndSkipsPendingLoop() async throws {
        let service = try TestUpdateService()
        service.finished.assertForOverFulfill = true
        let loopGate = UpdateGate()
        let drainStarted = expectation(description: "node loop was asked to stop")
        let loopTask = Task {
            await withTaskCancellationHandler {
                await loopGate.wait()
            } onCancel: {
                drainStarted.fulfill()
            }
        }
        let model = try model(service, loopTask: loopTask)
        model.installUpdate()
        await fulfillment(of: [service.began], timeout: 2)
        model.restartInstalledUpdate(immediately: true)
        XCTAssertEqual(model.updateActivity?.stage, .downloading)

        await service.gate.release()
        await fulfillment(of: [drainStarted], timeout: 2)
        XCTAssertEqual(model.updateActivity?.stage, .waiting)
        model.restartInstalledUpdate(immediately: true)
        model.restartInstalledUpdate(immediately: true)
        await fulfillment(of: [service.finished], timeout: 2)
        XCTAssertEqual(service.installs.current, 1)
        XCTAssertEqual(model.updateActivity?.stage, .relaunching)
        XCTAssertTrue(model.updateActivity?.diagnostics.contains("用户选择立即重启") == true)

        await loopGate.release()
        await loopTask.value
    }

    @MainActor func testCancelledDownloadCannotInstallOrOverwriteStateAfterLateCompletion() async throws {
        let service = try TestUpdateService()
        let model = try model(service)
        model.installUpdate()
        await fulfillment(of: [service.began], timeout: 2)
        model.cancelUpdate()
        XCTAssertEqual(model.updateActivity?.stage, .cancelled)
        XCTAssertFalse(model.updateState.isBusy)
        await service.gate.release()
        await fulfillment(of: [service.downloadReturned], timeout: 2)
        for _ in 0..<20 { await Task.yield() }
        XCTAssertEqual(service.installs.current, 0)
        XCTAssertEqual(model.updateActivity?.stage, .cancelled)
        XCTAssertEqual(model.updateState, .available(service.update))
    }
    @MainActor func testRelaunchFailureReportsAlreadyInstalledAndCannotBeCancelled() async throws {
        let service = try TestUpdateService()
        service.failRelaunch = true
        let model = try model(service)
        model.installUpdate()
        await fulfillment(of: [service.began], timeout: 2)
        await service.gate.release()
        await fulfillment(of: [service.finished], timeout: 2)
        XCTAssertEqual(model.updateActivity?.stage, .restartFailed)
        model.cancelUpdate()
        XCTAssertEqual(model.updateActivity?.stage, .restartFailed)
        guard case let .failed(_, reason) = model.updateState else { return XCTFail("missing installed failure") }
        XCTAssertTrue(reason.contains("新版本已装好"))
    }
    @MainActor func testSupersedingOrWithdrawnManifestNeverDownloadsUnderStaleApproval() async throws {
        for changed in [true, false] {
            let service = try TestUpdateService()
            let newer = try TestUpdateService(version: "1.2").update
            service.checkedUpdate = changed ? newer : nil
            let model = try model(service)
            model.installUpdate()
            for _ in 0..<100 {
                if !model.updateState.isBusy { break }
                try await Task.sleep(nanoseconds: 1_000_000)
            }
            XCTAssertFalse(model.updateState.isBusy)
            XCTAssertEqual(service.installs.current, 0)
            XCTAssertNil(service.progress.current)
            if changed { XCTAssertEqual(model.updateState, .available(newer)) }
            else { XCTAssertEqual(model.updateState, .current("1.0")) }
        }
    }

    @MainActor func testProgressAndLongRestartWaitFitNativeWindowInBothAppearances() async throws {
        _ = NSApplication.shared
        let service = try TestUpdateService()
        for stage: UpdateActivity.Stage in [.downloading, .security, .waiting, .restartFailed] {
            var activity = UpdateActivity(version: "1.1", size: 6)
            activity.move(to: stage)
            let model = try model(service, activity: activity)
            let host = NSHostingView(rootView: MenuContentView().environmentObject(model))
            if #available(macOS 13.3, *) { host.sizingOptions = [] }
            let controller = MainWindowController(title: "Update preview", contentView: host)
            controller.show()
            defer { controller.window.close() }
            for appearance in [NSAppearance.Name.aqua, .darkAqua] {
                host.appearance = NSAppearance(named: appearance)
                for size in [NSSize(width: 390, height: 300), NSSize(width: 720, height: 480)] {
                    controller.window.setContentSize(size)
                    host.layoutSubtreeIfNeeded()
                    func scrollViews(_ view: NSView) -> [NSScrollView] {
                        ((view as? NSScrollView).map { [$0] } ?? []) + view.subviews.flatMap(scrollViews)
                    }
                    let scroll = try XCTUnwrap(scrollViews(host).first)
                    let document = try XCTUnwrap(scroll.documentView)
                    XCTAssertLessThanOrEqual(document.frame.width, scroll.contentView.bounds.width + 1)
                    scroll.contentView.scroll(to: NSPoint(x: 0, y: max(0, document.bounds.height - scroll.contentView.bounds.height)))
                    scroll.reflectScrolledClipView(scroll.contentView)
                    host.layoutSubtreeIfNeeded()
                    XCTAssertLessThanOrEqual(host.fittingSize.width, size.width + 1)
                    if let directory = ProcessInfo.processInfo.environment["MISSIONGO_UI_CAPTURE_DIRECTORY"] {
                        let bitmap = try XCTUnwrap(host.bitmapImageRepForCachingDisplay(in: host.bounds))
                        host.cacheDisplay(in: host.bounds, to: bitmap)
                        let png = try XCTUnwrap(bitmap.representation(using: .png, properties: [:]))
                        try png.write(to: URL(fileURLWithPath: directory).appendingPathComponent("update-\(stage)-\(appearance.rawValue)-\(Int(size.width)).png"))
                    }
                }
            }
        }
    }
    @MainActor func testUpdateWindowKeepsConsentProgressAndRestartActionsInOneSurface() async throws {
        _ = NSApplication.shared
        let service = try TestUpdateService()
        let model = try model(service)
        XCTAssertTrue(model.canRetryClientUpdate)
        let controller = ClientUpdateWindowController(model: model)
        let originalWindow = controller.window
        model.retryClientUpdate()
        await fulfillment(of: [service.began], timeout: 2)
        XCTAssertFalse(model.canRetryClientUpdate)
        XCTAssertFalse(controller.windowShouldClose(originalWindow))
        model.cancelUpdate()
        XCTAssertTrue(controller.windowShouldClose(originalWindow))
        XCTAssertTrue(model.canRetryClientUpdate)
        XCTAssertTrue(originalWindow === controller.window)
        await service.gate.release()
        await fulfillment(of: [service.downloadReturned], timeout: 2)
    }

    @MainActor func testUpdateWindowStagesRenderAtNarrowSizesInBothThemes() async throws {
        _ = NSApplication.shared
        let service = try TestUpdateService(longNotes: true)
        for stage: UpdateActivity.Stage in [.downloading, .security, .waiting, .restartFailed, .failed, .cancelled] {
            var activity = UpdateActivity(version: "1.1", size: 6)
            activity.move(to: stage)
            let model = try model(service, activity: activity)
            let controller = ClientUpdateWindowController(model: model)
            controller.show()
            defer { controller.window.close() }
            for appearance in [NSAppearance.Name.aqua, .darkAqua] {
                controller.window.appearance = NSAppearance(named: appearance)
                for width in [390, 640] {
                    controller.window.setContentSize(NSSize(width: width, height: 440))
                    let host = try XCTUnwrap(controller.window.contentView)
                    host.layoutSubtreeIfNeeded()
                    try await Task.sleep(nanoseconds: 50_000_000)
                    controller.window.displayIfNeeded()
                    XCTAssertLessThanOrEqual(host.fittingSize.width, CGFloat(width) + 1)
                    if let directory = ProcessInfo.processInfo.environment["MISSIONGO_UI_CAPTURE_DIRECTORY"] {
                        let bitmap = try XCTUnwrap(host.bitmapImageRepForCachingDisplay(in: host.bounds))
                        host.cacheDisplay(in: host.bounds, to: bitmap)
                        let png = try XCTUnwrap(bitmap.representation(using: .png, properties: [:]))
                        try png.write(to: URL(fileURLWithPath: directory).appendingPathComponent("update-dialog-\(stage)-\(appearance.rawValue)-\(width).png"))
                    }
                }
            }
        }
    }

}
#endif
