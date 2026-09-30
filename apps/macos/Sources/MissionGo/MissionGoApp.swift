import AppKit
import Combine
import MissionGoNodeCore
import SwiftUI

@main
struct MissionGoApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var delegate
    var body: some Scene {
        // A Settings scene does not open a window at signed-in startup. All
        // explicit settings actions below reuse the same AppKit window.
        Settings {
            LocalSettingsView()
                .environmentObject(AppModel.shared)
        }
        .commands {
            CommandGroup(replacing: .appSettings) {
                Button("本机设置…") { delegate.showLocalSettings() }
                    .keyboardShortcut(",", modifiers: .command)
            }
        }
    }
}

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
    private let model: AppModel

    override convenience init() {
        self.init(model: .shared)
    }

    init(model: AppModel) {
        self.model = model
        super.init()
    }

    private(set) lazy var mainWindow: MainWindowController = {
        let content = NSHostingView(rootView: MenuContentView()
            .environmentObject(model)
            .environment(\.openLocalSettings, { [weak self] in self?.showLocalSettings() }))
        // AppKit owns the size. Letting the hosting view resize the window from
        // every SwiftUI layout caused a constraint feedback loop on macOS 26.
        if #available(macOS 13.3, *) { content.sizingOptions = [] }
        return MainWindowController(
            title: Bundle.main.object(forInfoDictionaryKey: "CFBundleDisplayName") as? String ?? "应用",
            contentView: content,
            onOpen: { [model] in model.menuDidOpen() },
            onClose: { [model] in model.menuDidClose() }
        )
    }()
    private(set) var settingsWindow: NSWindow?
    private(set) var statusItem: NSStatusItem?
    private var statusObservation: AnyCancellable?
    private var phaseObservation: AnyCancellable?

    func applicationWillFinishLaunching(_ notification: Notification) {
        // The Dock stays visible even when the window closes, so its number
        // remains useful alongside the menu-bar badge.
        NSApp.setActivationPolicy(.regular)
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        statusItem = item
        item.button?.target = self
        item.button?.action = #selector(showMainWindow)
        statusObservation = model.objectWillChange.sink { [weak self] in
            // Published values have not been assigned until after this signal.
            DispatchQueue.main.async { self?.updateStatusItem() }
        }
        updateStatusItem()
        // When signed out, open the same content as a normal window so the
        // sign-in action is immediately visible. Signed-in startup stays quiet.
        phaseObservation = model.$phase
            .removeDuplicates()
            .sink { [mainWindow] phase in
                if phase == .signedOut { mainWindow.show() }
            }
        // Started here rather than from a view: the machine has to go online at
        // login even if nobody ever opens the menu.
        model.start()
    }

    func showLocalSettings() {
        let window: NSWindow
        if let existing = settingsWindow {
            window = existing
        } else {
            let content = NSHostingView(rootView: LocalSettingsView().environmentObject(model))
            if #available(macOS 13.3, *) { content.sizingOptions = [] }
            window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 724, height: 510),
                              styleMask: [.titled, .closable, .miniaturizable, .resizable],
                              backing: .buffered, defer: false)
            window.title = "本机设置"
            window.contentView = content
            window.contentMinSize = NSSize(width: 580, height: 440)
            window.isReleasedWhenClosed = false
            window.center()
            settingsWindow = window
        }
        if window.isMiniaturized { window.deminiaturize(nil) }
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    @objc private func showMainWindow() {
        mainWindow.show()
    }

    private func updateStatusItem() {
        guard let button = statusItem?.button else { return }
        let label = Bundle.main.object(forInfoDictionaryKey: "CFBundleDisplayName") as? String ?? "应用"
        button.image = NSImage(systemSymbolName: model.menuBarSymbol, accessibilityDescription: label)
        button.image?.isTemplate = true
        button.imagePosition = .imageLeading
        button.title = UnreadBadgeLabel.text(model.unreadCount).map { " \($0)" } ?? ""
        let description = model.unreadCount.map { $0 > 0 ? "\(label)，未读会话 \($0)" : label } ?? label
        button.toolTip = description
        button.setAccessibilityLabel(description)
    }

    /// Double-clicking the app again while it runs is how people look for it.
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        mainWindow.show()
        return false
    }
}

private struct OpenLocalSettingsKey: EnvironmentKey {
    static let defaultValue: () -> Void = {}
}

extension EnvironmentValues {
    var openLocalSettings: () -> Void {
        get { self[OpenLocalSettingsKey.self] }
        set { self[OpenLocalSettingsKey.self] = newValue }
    }
}

struct MenuContentView: View {
    @EnvironmentObject private var model: AppModel

    private var contentPadding: CGFloat {
        if case .signedIn = model.phase { return 0 }
        return 14
    }

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
                ScrollView(.vertical) {
                    SignedOutView()
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.trailing, 16)
                }
            case .signedIn:
                SignedInView()
            }
        }
        .padding(contentPadding)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .background(MenuPalette.canvas)
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
