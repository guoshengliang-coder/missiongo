import AppKit
import Combine
import MissionGoNodeCore
import SwiftUI

@main
struct MissionGoApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var delegate
    @ObservedObject private var model = AppModel.shared

    private var appLabel: String {
        Bundle.main.object(forInfoDictionaryKey: "CFBundleDisplayName") as? String ?? "应用"
    }

    var body: some Scene {
        MenuBarExtra {
            MenuContentView()
                .environmentObject(model)
        } label: {
            HStack(spacing: 3) {
                Image(systemName: model.menuBarSymbol)
                if let count = model.attentionCount, count > 0 {
                    Text(String(count))
                        .font(.system(size: 10, weight: .bold, design: .rounded))
                        .foregroundStyle(.white)
                        .padding(.horizontal, 4)
                        .frame(minWidth: 14, minHeight: 14)
                        .background(.red, in: Capsule())
                }
            }
            .accessibilityLabel(model.attentionCount.map { $0 > 0 ? "\(appLabel)，待我处理 \($0)" : appLabel } ?? appLabel)
        }
        .menuBarExtraStyle(.window)
    }
}

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
    private let mainWindow = MainWindowController()
    private var phaseObservation: AnyCancellable?

    func applicationWillFinishLaunching(_ notification: Notification) {
        // The Dock stays visible even when the window closes, so its number
        // remains useful alongside the menu-bar badge.
        NSApp.setActivationPolicy(.regular)
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        // When signed out, open the same content as a normal window so the
        // sign-in action is immediately visible. Signed-in startup stays quiet.
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
final class MainWindowController: NSObject {
    private var window: NSWindow?
    /// The content's natural height, as last measured.
    private var measuredHeight: CGFloat?
    private var fitScheduled = false
    private var isFitting = false

    func show() {
        let window = self.window ?? makeWindow()
        self.window = window
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    private func makeWindow() -> NSWindow {
        let content = NSHostingView(
            rootView: MainWindowContent { [weak self] height in
                // Never inside the layout pass that reported it: see below.
                DispatchQueue.main.async { self?.contentDidMeasure(height) }
            }
        )
        // The window is sized by this controller, never by the hosting view.
        // Left to its default, the hosting view resizes the window to the content
        // on every layout, the new size invalidates the layout again, and AppKit
        // eventually aborts the app for exceeding its own limit on constraint
        // passes in one display cycle — which is how this window crashed on
        // macOS 26. Instead the content reports its height, and the window takes
        // it once, after the layout pass, and only when it actually changed; the
        // content's height does not depend on the window's, so nothing loops.
        if #available(macOS 13.3, *) {
            content.sizingOptions = []
        }
        // Not `content.fittingSize`: with sizingOptions emptied above, the hosting
        // view answers zero, and the window opened as a title bar with nothing
        // under it. A throwaway copy of the content is measured instead, so the
        // window opens at the right height rather than jumping to it.
        measuredHeight = Self.probeContentHeight()
        let window = NSWindow(
            contentRect: NSRect(
                origin: .zero,
                size: NSSize(width: MenuContentView.width, height: fittedHeight(on: NSScreen.main))
            ),
            // Not resizable: the window is exactly as tall as what it shows, so
            // there is nothing to drag open but blank space.
            styleMask: [.titled, .closable, .miniaturizable],
            backing: .buffered,
            defer: false
        )
        window.title = "MissionGo"
        window.contentView = content
        window.isReleasedWhenClosed = false
        window.center()
        self.window = window
        fitToContent()
        return window
    }

    /// The content's height measured off-screen, or nil when it answers nothing.
    private static func probeContentHeight() -> CGFloat? {
        let probe = NSHostingController(
            rootView: MenuContentView(tracksOpening: false)
                .environmentObject(AppModel.shared)
                .fixedSize(horizontal: false, vertical: true)
        )
        let height = probe.sizeThatFits(
            in: NSSize(width: MenuContentView.width, height: CGFloat.greatestFiniteMagnitude)
        ).height
        return height.isFinite && height > 0 ? height : nil
    }

    private func contentDidMeasure(_ height: CGFloat) {
        guard height.isFinite, height > 0 else { return }
        measuredHeight = height
        // Several reports in one pass become one resize.
        guard !fitScheduled else { return }
        fitScheduled = true
        DispatchQueue.main.async { [weak self] in
            self?.fitScheduled = false
            self?.fitToContent()
        }
    }

    private func fittedHeight(on screen: NSScreen?) -> CGFloat {
        return MainWindowSizing.contentHeight(
            measuredHeight: measuredHeight,
            availableHeight: (screen ?? NSScreen.main)?.visibleFrame.height
        )
    }

    /// Makes the window exactly as tall as its content, keeping its top edge
    /// where it is, the way a window grows or shrinks downward, and on screen.
    private func fitToContent() {
        guard let window, !isFitting else { return }
        isFitting = true
        defer { isFitting = false }
        let screen = window.screen ?? NSScreen.main
        let target = fittedHeight(on: screen)
        let current = window.contentRect(forFrameRect: window.frame).height
        guard MainWindowSizing.needsResize(from: current, to: target) else { return }
        var frame = window.frameRect(
            forContentRect: NSRect(origin: .zero, size: NSSize(width: MenuContentView.width, height: target))
        )
        frame.origin.x = window.frame.minX
        frame.origin.y = window.frame.maxY - frame.height
        if let visible = screen?.visibleFrame {
            if frame.maxY > visible.maxY { frame.origin.y = visible.maxY - frame.height }
            if frame.minY < visible.minY { frame.origin.y = visible.minY }
        }
        window.setFrame(frame, display: true)
    }
}

/// What the main window shows: the menu's content at its natural height,
/// reporting that height. The ScrollView only matters once the window has
/// stopped at its share of the screen; below that the window fits the content
/// and there is nothing to scroll. The height is taken from the content inside
/// the ScrollView, which is as tall as it wants to be, not from the ScrollView,
/// which is as tall as the window.
private struct MainWindowContent: View {
    let onHeight: (CGFloat) -> Void

    var body: some View {
        ScrollView {
            MenuContentView()
                .fixedSize(horizontal: false, vertical: true)
                .background(
                    GeometryReader { proxy in
                        Color.clear.preference(key: ContentHeightKey.self, value: proxy.size.height)
                    }
                )
        }
        .onPreferenceChange(ContentHeightKey.self, perform: onHeight)
        .environmentObject(AppModel.shared)
    }
}

private struct ContentHeightKey: PreferenceKey {
    static let defaultValue: CGFloat = 0

    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) {
        value = max(value, nextValue())
    }
}

struct MenuContentView: View {
    @EnvironmentObject private var model: AppModel

    /// One width for the menu and for the window: the content is written to be
    /// read at this width, and nothing here reflows usefully at another.
    static let width: CGFloat = 380

    /// Off only for the throwaway copy the main window measures before opening:
    /// that copy is not a menu anyone opened.
    var tracksOpening = true

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
        .onAppear { if tracksOpening { model.menuDidOpen() } }
        .onDisappear { if tracksOpening { model.menuDidClose() } }
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
