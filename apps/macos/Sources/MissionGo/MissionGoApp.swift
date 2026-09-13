import AppKit
import Combine
import MissionGoNodeCore
import SwiftUI

@main
struct MissionGoApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var delegate
    @ObservedObject private var model = AppModel.shared

    var body: some Scene {
        MenuBarExtra {
            MenuContentView()
                .environmentObject(model)
        } label: {
            Image(systemName: model.menuBarSymbol)
                .accessibilityLabel("MissionGo")
        }
        .menuBarExtraStyle(.window)
    }
}

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
    private let mainWindow = MainWindowController()
    private var phaseObservation: AnyCancellable?

    func applicationWillFinishLaunching(_ notification: Notification) {
        // The bundle sets LSUIElement; this covers running the bare executable
        // from `swift run` or `.build/debug`, which has no Info.plist.
        NSApp.setActivationPolicy(.accessory)
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        // A menu-bar icon alone read as "the app does not open": the first person
        // to install it double-clicked, saw nothing, and could not find the icon —
        // on a MacBook the notch hides whatever does not fit, and macOS can hide an
        // app's item from System Settings. So whenever the Mac is not signed in,
        // the same content opens as an ordinary window. A signed-in Mac starting
        // at login stays out of the way in the menu bar.
        phaseObservation = AppModel.shared.$phase
            .removeDuplicates()
            .sink { [mainWindow] phase in
                if phase == .signedOut { mainWindow.show() }
            }
        // Started here rather than from a view: the machine has to go online at
        // login even if nobody ever opens the menu.
        AppModel.shared.start()
    }

    /// Double-clicking the app again while it runs is how people look for it.
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        mainWindow.show()
        return false
    }
}

/// The menu's content in a normal window, for everyone who cannot or does not
/// know to use the menu-bar icon.
@MainActor
final class MainWindowController: NSObject, NSWindowDelegate {
    private var window: NSWindow?

    func show() {
        let window = self.window ?? makeWindow()
        self.window = window
        // A Dock icon and a place in ⌘-Tab while the window is open, so it cannot
        // get lost behind other windows; back to menu-bar-only when it closes.
        NSApp.setActivationPolicy(.regular)
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    private func makeWindow() -> NSWindow {
        let content = NSHostingView(rootView: MenuContentView().environmentObject(AppModel.shared))
        let window = NSWindow(
            contentRect: NSRect(origin: .zero, size: content.fittingSize),
            styleMask: [.titled, .closable, .miniaturizable],
            backing: .buffered,
            defer: false
        )
        window.title = "MissionGo"
        window.contentView = content
        window.isReleasedWhenClosed = false
        window.delegate = self
        window.center()
        return window
    }

    func windowWillClose(_ notification: Notification) {
        NSApp.setActivationPolicy(.accessory)
    }
}

struct MenuContentView: View {
    @EnvironmentObject private var model: AppModel

    var body: some View {
        Group {
            switch model.phase {
            case .starting:
                HStack(spacing: 8) {
                    ProgressView().controlSize(.small)
                    Text("正在启动…").foregroundStyle(.secondary)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            case .signedOut, .signingIn:
                SignedOutView()
            case let .signedIn(credential):
                SignedInView(credential: credential)
            }
        }
        .padding(14)
        .frame(width: 380)
        .onAppear { model.menuDidOpen() }
        .onDisappear { model.menuDidClose() }
    }
}

/// A caption that wraps instead of being cut off: every message in this menu
/// is a sentence someone has to be able to read to the end.
struct WrappingCaption: View {
    let text: String
    var color: Color = .secondary

    var body: some View {
        Text(text)
            .font(.caption)
            .foregroundColor(color)
            .fixedSize(horizontal: false, vertical: true)
            .textSelection(.enabled)
    }
}

struct SectionTitle: View {
    let text: String

    var body: some View {
        Text(text)
            .font(.subheadline.weight(.semibold))
            .foregroundStyle(.secondary)
    }
}
