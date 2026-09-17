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

    /// How tall this window may open, as a share of the screen it opens on. The
    /// content scrolls past that rather than growing.
    private static let maximumScreenShare: CGFloat = 0.8

    private func makeWindow() -> NSWindow {
        let content = NSHostingView(
            rootView: ScrollView { MenuContentView().environmentObject(AppModel.shared) }
        )
        // The window keeps whatever size it is given, and the content scrolls
        // inside it. Left to its default, the hosting view resizes the window to
        // the content on every layout, the new size invalidates the layout again,
        // and AppKit eventually aborts the app for exceeding its own limit on
        // constraint passes in one display cycle — which is how this window
        // crashed on macOS 26. Nothing here needs a window that resizes itself:
        // the content is a menu, and a person can drag the edge.
        if #available(macOS 13.3, *) {
            content.sizingOptions = []
        }
        let window = NSWindow(
            contentRect: NSRect(origin: .zero, size: content.fittingSize),
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered,
            defer: false
        )
        window.title = "MissionGo"
        window.contentView = content
        window.contentMinSize = NSSize(width: MenuContentView.width, height: 220)
        window.isReleasedWhenClosed = false
        window.delegate = self
        window.center()
        window.setContentSize(openingSize(for: content, on: window.screen))
        window.center()
        return window
    }

    /// As tall as the content wants, up to a share of the screen.
    private func openingSize(for content: NSView, on screen: NSScreen?) -> NSSize {
        let wanted = content.fittingSize
        let available = (screen ?? NSScreen.main)?.visibleFrame.height ?? wanted.height
        return NSSize(
            width: MenuContentView.width,
            height: min(wanted.height, available * MainWindowController.maximumScreenShare)
        )
    }

    func windowWillClose(_ notification: Notification) {
        NSApp.setActivationPolicy(.accessory)
    }
}

struct MenuContentView: View {
    @EnvironmentObject private var model: AppModel

    /// One width for the menu and for the window: the content is written to be
    /// read at this width, and nothing here reflows usefully at another.
    static let width: CGFloat = 380

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
        .frame(width: MenuContentView.width)
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
