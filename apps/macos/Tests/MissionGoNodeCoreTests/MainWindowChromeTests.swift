import AppKit
import XCTest

@testable import MissionGoNodeCore

final class MainWindowChromeTests: XCTestCase {
    func testActualWindowHasThreeVisibleEnabledButtonsAboveTheContent() async throws {
        try await MainActor.run {
            _ = NSApplication.shared
            let content = NSView()
            let controller = MainWindowController(title: "Window test", contentView: content)
            let window = controller.window
            defer { window.close() }
            controller.show()
            window.layoutIfNeeded()
            for kind: NSWindow.ButtonType in [.closeButton, .miniaturizeButton, .zoomButton] {
                let button = try XCTUnwrap(window.standardWindowButton(kind))
                XCTAssertFalse(button.isHiddenOrHasHiddenAncestor)
                XCTAssertTrue(button.isEnabled)
                let buttonRect = button.convert(button.bounds, to: nil)
                let contentRect = content.convert(content.bounds, to: nil)
                XCTAssertGreaterThanOrEqual(buttonRect.minY, contentRect.maxY)
            }
        }
    }

    func testCloseButtonAndBothReopenPathsReuseTheWindowAndKeepUserSize() async throws {
        try await MainActor.run {
            _ = NSApplication.shared
            var opens = 0
            var closes = 0
            let controller = MainWindowController(title: "Window test", contentView: NSView(),
                                                  onOpen: { opens += 1 }, onClose: { closes += 1 })
            let window = controller.window
            defer { window.close() }
            controller.show()
            window.setContentSize(NSSize(width: 620, height: 420))
            let resizedFrame = window.frame
            // Both entry points call show. Repeated opens do not create a new
            // window, refresh twice, or undo a manual resize.
            controller.show()
            XCTAssertEqual(opens, 1)
            XCTAssertEqual(window.frame, resizedFrame)
            try XCTUnwrap(window.standardWindowButton(.closeButton)).performClick(nil)
            XCTAssertFalse(window.isVisible)
            XCTAssertEqual(closes, 1)
            controller.show()
            XCTAssertTrue(window.isVisible)
            XCTAssertEqual(opens, 2)
            XCTAssertTrue(controller.window === window)
            XCTAssertEqual(window.frame, resizedFrame)
        }
    }

    func testLosingFocusDoesNotDismissWindowAndZoomIsNotUndone() async throws {
        try await MainActor.run {
            _ = NSApplication.shared
            let controller = MainWindowController(title: "Window test", contentView: NSView())
            let window = controller.window
            defer { window.close() }
            controller.show()
            window.resignKey()
            XCTAssertTrue(window.isVisible)
            let before = window.frame
            try XCTUnwrap(window.standardWindowButton(.zoomButton)).performClick(nil)
            XCTAssertNotEqual(window.frame.size, before.size)
            let zoomed = window.frame
            controller.show()
            XCTAssertEqual(window.frame, zoomed)
        }
    }

    func testMinimizeButtonCanMinimizeAndShowRestoresIt() async throws {
        let controller = await MainActor.run {
            _ = NSApplication.shared
            let controller = MainWindowController(title: "Window test", contentView: NSView())
            controller.show()
            return controller
        }
        try await MainActor.run {
            try XCTUnwrap(controller.window.standardWindowButton(.miniaturizeButton)).performClick(nil)
        }
        // AppKit completes miniaturization asynchronously.
        for _ in 0..<30 {
            if await MainActor.run(body: { controller.window.isMiniaturized }) { break }
            try await Task.sleep(nanoseconds: 50_000_000)
        }
        await MainActor.run {
            XCTAssertTrue(controller.window.isMiniaturized)
            controller.show()
            XCTAssertFalse(controller.window.isMiniaturized)
            XCTAssertTrue(controller.window.isVisible)
            controller.window.close()
        }
    }
}
