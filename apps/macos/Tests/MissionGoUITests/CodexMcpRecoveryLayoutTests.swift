#if DEBUG
import AppKit
import SwiftUI
import XCTest
import MissionGoNodeCore
@testable import MissionGo

final class CodexMcpRecoveryLayoutTests: XCTestCase {
    func testReadOnlyRecoveryRemainsReadableAtNarrowWidths() async throws {
        try await MainActor.run {
            _ = NSApplication.shared
            let text = try XCTUnwrap(DispatchPresentation.failureHint(code: "mcp_auth", agentKind: "codex"))
            let command = try XCTUnwrap(DispatchPresentation.recoveryCommand(code: "mcp_auth", agentKind: "codex"))
            for width: CGFloat in [320, 580] {
                for dark in [false, true] {
                    let host = NSHostingView(rootView: CodexMcpRecoveryNotice(text: text, command: command, copy: { _ in })
                        .padding(16).frame(width: width)
                        .background(Color(nsColor: .windowBackgroundColor))
                        .environment(\.colorScheme, dark ? .dark : .light))
                    let fullText = NSHostingView(rootView: WrappingCaption(text: text, color: .red)
                        .frame(width: width - 32))
                    let size = host.fittingSize
                    XCTAssertEqual(size.width, width)
                    XCTAssertGreaterThanOrEqual(size.height, fullText.fittingSize.height + 48,
                        "The full selectable recovery text and copy action must remain visible")
                    let window = NSWindow(contentRect: NSRect(origin: .zero, size: size),
                        styleMask: [.titled, .closable], backing: .buffered, defer: false)
                    window.isReleasedWhenClosed = false
                    window.appearance = NSAppearance(named: dark ? .darkAqua : .aqua)
                    window.contentView = host
                    window.orderFront(nil)
                    defer { window.close() }
                    host.layoutSubtreeIfNeeded()
                    window.displayIfNeeded()
                    if let directory = ProcessInfo.processInfo.environment["MISSIONGO_UI_CAPTURE_DIRECTORY"] {
                        RunLoop.current.run(until: Date().addingTimeInterval(0.1))
                        let bitmap = try XCTUnwrap(host.bitmapImageRepForCachingDisplay(in: host.bounds))
                        host.cacheDisplay(in: host.bounds, to: bitmap)
                        let png = try XCTUnwrap(bitmap.representation(using: .png, properties: [:]))
                        try png.write(to: URL(fileURLWithPath: directory)
                            .appendingPathComponent("codex-mcp-recovery-\(Int(width))-\(dark ? "dark" : "light").png"))
                    }
                }
            }
        }
    }
}
#endif
