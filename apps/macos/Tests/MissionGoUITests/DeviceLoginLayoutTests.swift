#if DEBUG
import AppKit
import Foundation
import SwiftUI
import XCTest
import MissionGoNodeCore
@testable import MissionGo

final class DeviceLoginLayoutTests: XCTestCase {
    func testDeviceLoginFitsANarrowWindowInBothAppearances() async throws {
        let pending = try JSONDecoder().decode(PendingDeviceLogin.self, from: Data(#"{"serverUrl":"https://missiongo.example.test","clientId":"test-client","deviceCode":"unused","userCode":"BCDFG-HJKLM","verificationUri":"https://missiongo.example.test/oauth/device","verificationUriComplete":"https://missiongo.example.test/oauth/device?user_code=BCDFG-HJKLM","expiresAt":900000000,"interval":5}"#.utf8))
        try await MainActor.run {
            _ = NSApplication.shared
            let model = AppModel(previewDeviceLogin: pending)
            for theme: ColorScheme in [.light, .dark] {
                let content = SignedOutView().environmentObject(model)
                    .padding(20).frame(width: 360)
                    .background(Color(nsColor: .windowBackgroundColor))
                    .environment(\.colorScheme, theme)
                let host = NSHostingView(rootView: content)
                let size = host.fittingSize
                XCTAssertEqual(size.width, 360)
                XCTAssertGreaterThan(size.height, 200)
                XCTAssertLessThan(size.height, 800, "Device login fits a normal window height")
                let window = NSWindow(contentRect: NSRect(origin: .zero, size: size),
                                      styleMask: [.titled, .closable], backing: .buffered, defer: false)
                window.isReleasedWhenClosed = false
                window.appearance = NSAppearance(named: theme == .light ? .aqua : .darkAqua)
                window.contentView = host
                window.orderFront(nil)
                defer { window.close() }
                host.layoutSubtreeIfNeeded()
                window.displayIfNeeded()
                if let directory = ProcessInfo.processInfo.environment["MISSIONGO_LOGIN_PREVIEW_DIRECTORY"] {
                    let bitmap = try XCTUnwrap(host.bitmapImageRepForCachingDisplay(in: host.bounds))
                    host.cacheDisplay(in: host.bounds, to: bitmap)
                    let png = try XCTUnwrap(bitmap.representation(using: .png, properties: [:]))
                    let url = URL(fileURLWithPath: directory).appendingPathComponent("macos-\(theme == .light ? "light" : "dark").png")
                    try png.write(to: url)
                }
            }
        }
    }
}
#endif
