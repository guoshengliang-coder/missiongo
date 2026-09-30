import CoreGraphics

/// The initial main-window height, bounded by the available screen. Applied
/// once when creating the window, never from a SwiftUI layout callback: later
/// changes belong to the user and must not be undone by a refresh or zoom.
public enum MainWindowSizing {
    /// Used only when the content could not be measured.
    public static let fallbackHeight: CGFloat = 560
    /// A floor, not a target: the content is normally taller than this, and a
    /// window this short still shows a line or two rather than a title bar.
    public static let minimumHeight: CGFloat = 40
    /// On a short screen the window stops here and the content scrolls.
    public static let maximumScreenShare: CGFloat = 0.8
    /// `measuredHeight` is the content's natural height, or nil when it could not
    /// be measured. `availableHeight` is the screen's visible height, or nil when
    /// no screen answers — a Mac with the lid shut and no display attached, for
    /// instance.
    public static func contentHeight(measuredHeight: CGFloat?, availableHeight: CGFloat?) -> CGFloat {
        var height = fallbackHeight
        if let measured = measuredHeight, measured.isFinite, measured > 0 {
            height = measured.rounded(.up)
        }
        if let available = availableHeight, available.isFinite, available > 0 {
            height = min(height, (available * maximumScreenShare).rounded(.down))
        }
        return max(minimumHeight, height)
    }
}
