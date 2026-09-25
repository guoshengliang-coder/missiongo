import AppKit

/// The release notes inside the update alert, in a box that never grows past the
/// buttons.
///
/// `NSAlert.informativeText` lays everything out at once: a long release fills
/// the screen and pushes 「同意更新」 off it, exactly when a person needs it
/// most. The notes go into a text view instead, which scrolls inside a bounded
/// height while the alert keeps its buttons reachable.
enum UpdateNotesView {
    /// Wide enough to read, narrow enough that the alert stays a dialog.
    static let width: CGFloat = 440
    /// Past this the notes scroll rather than push the buttons away.
    static let maximumHeight: CGFloat = 300
    /// An empty-looking box is worse than a short one.
    static let minimumHeight: CGFloat = 60

    static func make(text: String) -> NSView {
        let inset = NSSize(width: 2, height: 6)
        let textView = NSTextView(frame: NSRect(x: 0, y: 0, width: width, height: 0))
        textView.isEditable = false
        textView.isSelectable = true
        textView.drawsBackground = false
        textView.font = .systemFont(ofSize: NSFont.smallSystemFontSize)
        textView.textContainerInset = inset
        textView.isVerticallyResizable = true
        textView.autoresizingMask = [.width]
        textView.textContainer?.widthTracksTextView = true
        textView.textContainer?.containerSize = NSSize(
            width: width - inset.width * 2,
            height: .greatestFiniteMagnitude
        )
        textView.string = text

        guard let container = textView.textContainer, let layout = textView.layoutManager else { return textView }
        layout.ensureLayout(for: container)
        let contentHeight = ceil(layout.usedRect(for: container).height) + inset.height * 2
        let visibleHeight = min(max(contentHeight, minimumHeight), maximumHeight)
        textView.frame = NSRect(x: 0, y: 0, width: width, height: max(contentHeight, visibleHeight))

        guard contentHeight > maximumHeight else { return textView }

        let scrollView = NSScrollView(frame: NSRect(x: 0, y: 0, width: width, height: visibleHeight))
        // The notes are clipped by design. On macOS the scroller that appears
        // while scrolling is the platform's own indicator, so it is left to the
        // system rather than forced: a legacy scroller is ignored while the
        // machine is set to show scroll bars only while scrolling.
        scrollView.hasVerticalScroller = true
        scrollView.drawsBackground = false
        scrollView.borderType = .noBorder
        scrollView.documentView = textView
        return scrollView
    }
}
