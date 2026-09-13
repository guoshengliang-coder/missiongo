import MissionGoNodeCore
import SwiftUI

// Placeholder so the executable target builds; the menu bar UI replaces it.
@main
struct MissionGoApp: App {
    var body: some Scene {
        MenuBarExtra("MissionGo", systemImage: "circle.dotted") {
            Text("MissionGo")
            Divider()
            Button("退出") { NSApplication.shared.terminate(nil) }
        }
    }
}
