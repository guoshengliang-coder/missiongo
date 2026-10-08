#if DEBUG
import AppKit
import SwiftUI
import XCTest
@testable import MissionGoNodeCore
@testable import MissionGo

final class ServerConnectionLayoutTests: XCTestCase {
    func testProxyDiagnosisAndRecoveryFitANarrowWindow() async throws {
        let unread = try JSONDecoder().decode(UnreadSessionsSnapshot.self, from: Data(#"{"totalUnread":0,"sessions":[]}"#.utf8))
        let failure = NetworkFailure(host: "missiongo.example.test", error: URLError(.secureConnectionFailed))
        try await MainActor.run {
            _ = NSApplication.shared
            let model = AppModel(
                previewCredential: NodeCredential(serverUrl: "https://missiongo.example.test", nodeId: "preview", name: "M4 preview", token: "unused"),
                unread: unread, agentVersions: [:],
                connectionDiagnosis: ServerConnection.Diagnosis(system: .failed(failure.description), direct: .reachable)
            )
            for width: CGFloat in [320, 420] {
                let host = NSHostingView(rootView: ServerConnectionSection().environmentObject(model)
                    .padding(16).frame(width: width)
                    .background(Color(nsColor: .windowBackgroundColor))
                    .environment(\.colorScheme, .light))
                let size = host.fittingSize
                XCTAssertEqual(size.width, width)
                XCTAssertLessThan(size.height, 520, "Diagnosis and recovery controls fit the window")
                let window = NSWindow(contentRect: NSRect(origin: .zero, size: size),
                                      styleMask: [.titled, .closable], backing: .buffered, defer: false)
                window.isReleasedWhenClosed = false
                window.appearance = NSAppearance(named: .aqua)
                window.contentView = host
                window.orderFront(nil)
                defer { window.close() }
                host.layoutSubtreeIfNeeded()
                window.displayIfNeeded()
                if let directory = ProcessInfo.processInfo.environment["MISSIONGO_CONNECTION_PREVIEW_DIRECTORY"] {
                    RunLoop.current.run(until: Date().addingTimeInterval(0.1))
                    let bitmap = try XCTUnwrap(host.bitmapImageRepForCachingDisplay(in: host.bounds))
                    host.cacheDisplay(in: host.bounds, to: bitmap)
                    let png = try XCTUnwrap(bitmap.representation(using: .png, properties: [:]))
                    try png.write(to: URL(fileURLWithPath: directory).appendingPathComponent("connection-\(Int(width)).png"))
                }
            }
            // Preview interactions must not change routing for the developer's app.
            let savedMode = ServerConnection.mode()
            model.setConnectionMode(.direct)
            XCTAssertEqual(model.connectionMode, .direct)
            XCTAssertEqual(ServerConnection.mode(), savedMode)
        }
    }
}
#endif
