#if DEBUG
import AppKit
import SwiftUI
import XCTest
import MissionGoNodeCore

@testable import MissionGo

final class MainWindowLayoutTests: XCTestCase {
    private func snapshot(sessionCount: Int) throws -> UnreadSessionsSnapshot {
        let sessions: [[String: Any]] = (0..<sessionCount).map { index in
            ["sessionId": "preview-\(index)", "agentKind": "codex", "nodeName": "UI preview",
             "activityAt": "2026-09-30T08:00:00.000Z",
             "title": "窗口布局验证：长会话标题 \(index)",
             "items": [["key": "TEST-1", "productId": "preview", "title": "主线新增条目标题：长文本应完整换行并能滚动查看"]]]
        }
        let data = try JSONSerialization.data(withJSONObject: ["totalUnread": sessionCount, "sessions": sessions])
        return try JSONDecoder().decode(UnreadSessionsSnapshot.self, from: data)
    }

    @MainActor
    private func descendants<T: NSView>(_ view: NSView, of type: T.Type) -> [T] {
        ((view as? T).map { [$0] } ?? []) + view.subviews.flatMap { descendants($0, of: type) }
    }

    func testSignedInContentHasOneScrollRegionAndFitsBothScrollerStyles() async throws {
        let unread = try snapshot(sessionCount: 12)
        try await MainActor.run {
            _ = NSApplication.shared
            let model = AppModel(
                previewCredential: NodeCredential(serverUrl: "https://example.invalid", nodeId: "preview", name: "UI preview", token: "unused"),
                unread: unread,
                agentVersions: ["claude_code": "2.1.280", "codex": "0.154.0-long-build-identifier", "opencode": "2.0.15"]
            )
            let host = NSHostingView(rootView: MenuContentView().environmentObject(model))
            if #available(macOS 13.3, *) { host.sizingOptions = [] }
            let controller = MainWindowController(title: "Window layout preview", contentView: host)
            let window = controller.window
            defer { window.close() }
            controller.show()
            for style: NSScroller.Style in [.legacy, .overlay] {
                for size in [NSSize(width: 390, height: 300), NSSize(width: 440, height: 560), NSSize(width: 720, height: 480)] {
                    window.setContentSize(size)
                    host.layoutSubtreeIfNeeded()
                    let scrolls = descendants(host, of: NSScrollView.self)
                    XCTAssertEqual(scrolls.count, 1, "No nested scroll regions")
                    let scroll = try XCTUnwrap(scrolls.first)
                    scroll.scrollerStyle = style
                    scroll.tile()
                    host.layoutSubtreeIfNeeded()
                    let document = try XCTUnwrap(scroll.documentView)
                    XCTAssertLessThanOrEqual(document.frame.width, scroll.contentView.bounds.width + 1,
                                             "Document must fit the viewport with \(style) scrollers at \(size)")
                    XCTAssertGreaterThan(document.frame.height, scroll.contentView.bounds.height,
                                         "Long content remains scrollable")
                    let viewport = scroll.convert(scroll.bounds, to: host)
                    XCTAssertGreaterThan(viewport.minY, 30, "Footer remains outside the scrolling region")
                    XCTAssertLessThan(viewport.maxY, host.bounds.maxY - 30, "Header remains outside the scrolling region")
                    let bottom = NSPoint(x: 0, y: max(0, document.bounds.height - scroll.contentView.bounds.height))
                    scroll.contentView.scroll(to: bottom)
                    scroll.reflectScrolledClipView(scroll.contentView)
                    XCTAssertGreaterThan(scroll.contentView.bounds.minY, 0, "Bottom content can be reached")
                    if let directory = ProcessInfo.processInfo.environment["MISSIONGO_UI_CAPTURE_DIRECTORY"] {
                        for (position, point) in [("bottom", bottom), ("top", NSPoint.zero)] {
                            scroll.contentView.scroll(to: point)
                            scroll.reflectScrolledClipView(scroll.contentView)
                            host.layoutSubtreeIfNeeded()
                            let bitmap = try XCTUnwrap(host.bitmapImageRepForCachingDisplay(in: host.bounds))
                            host.cacheDisplay(in: host.bounds, to: bitmap)
                            let png = try XCTUnwrap(bitmap.representation(using: .png, properties: [:]))
                            try png.write(to: URL(fileURLWithPath: directory).appendingPathComponent("signed-in-\(style.rawValue)-\(Int(size.width))x\(Int(size.height))-\(position).png"))
                        }
                    }
                }
            }
        }
    }

    func testMenuBarAndDockOpenOneWindowAndSettingsStaySeparate() async throws {
        let unread = try snapshot(sessionCount: 2)
        try await MainActor.run {
            _ = NSApplication.shared
            let model = AppModel(
                previewCredential: NodeCredential(serverUrl: "https://example.invalid", nodeId: "preview", name: "UI preview", token: "unused"),
                unread: unread, agentVersions: [:]
            )
            let delegate = AppDelegate(model: model)
            delegate.applicationDidFinishLaunching(Notification(name: NSApplication.didFinishLaunchingNotification))
            let window = delegate.mainWindow.window
            defer {
                window.close()
                delegate.settingsWindow?.close()
                if let item = delegate.statusItem { NSStatusBar.system.removeStatusItem(item) }
            }
            XCTAssertFalse(window.isVisible, "Signed-in launch must stay quiet")
            XCTAssertNil(delegate.settingsWindow, "Settings must not open at launch")
            let button = try XCTUnwrap(delegate.statusItem?.button)
            XCTAssertTrue(button.title.contains("2"), "Unread count remains in the menu bar")
            button.performClick(nil)
            XCTAssertTrue(window.isVisible, "The actual menu-bar button opens the main window")
            window.setContentSize(NSSize(width: 620, height: 420))
            let resizedFrame = window.frame
            window.performClose(nil)
            XCTAssertFalse(window.isVisible)
            XCTAssertFalse(delegate.applicationShouldHandleReopen(NSApp, hasVisibleWindows: false))
            XCTAssertTrue(window.isVisible, "Dock reopen uses the same window")
            XCTAssertTrue(delegate.mainWindow.window === window)
            XCTAssertEqual(window.frame, resizedFrame)
            button.performClick(nil)
            XCTAssertEqual(window.frame, resizedFrame)
            delegate.showLocalSettings()
            let settings = try XCTUnwrap(delegate.settingsWindow)
            XCTAssertTrue(settings.isVisible)
            XCTAssertTrue(window.isVisible, "Opening settings does not dismiss main UI")
            delegate.showLocalSettings()
            XCTAssertTrue(delegate.settingsWindow === settings)
        }
    }
}
#endif
