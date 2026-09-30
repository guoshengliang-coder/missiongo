import AppKit

/// A normal window shared by the Dock and menu-bar entry points. Use AppKit's
/// actual window configuration rather than a second, test-only style mask.
@MainActor
public final class MainWindowController: NSObject, NSWindowDelegate {
    public let window: NSWindow
    private let onOpen: () -> Void
    private let onClose: () -> Void

    public init(title: String, contentView: NSView, onOpen: @escaping () -> Void = {}, onClose: @escaping () -> Void = {}) {
        self.onOpen = onOpen
        self.onClose = onClose
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
        window.center()
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
