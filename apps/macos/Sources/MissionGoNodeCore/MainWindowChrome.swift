import AppKit

/// A normal window shared by the Dock and menu-bar entry points. Use AppKit's
/// actual window configuration rather than a second, test-only style mask.
@MainActor
public final class MainWindowController: NSObject, NSWindowDelegate {
    public let window: NSWindow
    private let onOpen: () -> Void
    private let onClose: () -> Void
    private let onStow: (() -> Void)?

    public init(title: String, contentView: NSView, onOpen: @escaping () -> Void = {}, onClose: @escaping () -> Void = {},
                onStow: (() -> Void)? = nil) {
        self.onOpen = onOpen
        self.onClose = onClose
        self.onStow = onStow
        let height = MainWindowSizing.contentHeight(measuredHeight: nil, availableHeight: NSScreen.main?.visibleFrame.height)
        window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 440, height: height),
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered,
            defer: false
        )
        super.init()
        window.title = title
        window.titleVisibility = .hidden
        window.titlebarAppearsTransparent = true
        // Content stays below the native title bar: neither scrolling nor
        // rounded SwiftUI clipping can cover the traffic lights.
        window.contentView = contentView
        window.contentMinSize = NSSize(width: 390, height: min(260, height))
        window.isReleasedWhenClosed = false
        window.delegate = self
        if onStow != nil {
            let button = NSButton(title: "收起到菜单栏", target: self, action: #selector(stow))
            button.bezelStyle = .rounded
            button.controlSize = .small
            button.toolTip = "隐藏窗口和 Dock 图标，后台任务继续运行；点击菜单栏图标重新打开"
            button.sizeToFit()
            let accessory = NSTitlebarAccessoryViewController()
            accessory.layoutAttribute = .right
            accessory.view = NSView(frame: NSRect(x: 0, y: 0, width: button.frame.width + 12, height: 28))
            button.setFrameOrigin(NSPoint(x: 0, y: (28 - button.frame.height) / 2))
            accessory.view.addSubview(button)
            window.addTitlebarAccessoryViewController(accessory)
        }
        window.center()
    }

    @objc private func stow() { onStow?() }

    /// Order out rather than close or minimize. The node keeps running, and a
    /// later show reuses this window, its content and its user-selected size.
    public func hide() {
        let wasVisible = window.isVisible && !window.isMiniaturized
        window.orderOut(nil)
        if wasVisible { onClose() }
    }

    public func show() {
        let wasVisible = window.isVisible && !window.isMiniaturized
        if window.isMiniaturized {
            window.deminiaturize(nil)
        } else if !wasVisible {
            onOpen()
        }
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    public func windowWillClose(_ notification: Notification) {
        onClose()
    }

    public func windowDidMiniaturize(_ notification: Notification) {
        onClose()
    }

    public func windowDidDeminiaturize(_ notification: Notification) {
        onOpen()
    }

    // Resigning key deliberately does not close the window. A settings window,
    // an external link, or another application must not dismiss the main UI.
}
