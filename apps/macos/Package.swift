// swift-tools-version: 5.9
import PackageDescription

// A Swift Package rather than a hand-written .xcodeproj: the logic library runs
// under `swift test` from the command line and in CI, and the .app bundle is
// assembled by a script instead of by Xcode.
let package = Package(
    name: "MissionGo",
    platforms: [.macOS(.v13)],
    products: [
        .library(name: "MissionGoNodeCore", targets: ["MissionGoNodeCore"]),
        .executable(name: "MissionGo", targets: ["MissionGo"]),
        .executable(name: "MissionGoClaudeHost", targets: ["MissionGoClaudeHost"]),
    ],
    targets: [
        // Everything that talks to the server or runs a process lives here, with
        // no SwiftUI, so all of it can be tested without launching the app.
        .target(name: "MissionGoNodeCore"),
        .executableTarget(name: "MissionGo", dependencies: ["MissionGoNodeCore"]),
        .executableTarget(name: "MissionGoClaudeHost", dependencies: ["MissionGoNodeCore"]),
        .testTarget(name: "MissionGoNodeCoreTests", dependencies: ["MissionGoNodeCore"]),
    ]
)
