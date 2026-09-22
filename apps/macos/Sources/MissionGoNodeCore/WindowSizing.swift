import CoreGraphics

/// How tall the main window is: exactly as tall as its content, within limits.
///
/// The window's hosting view deliberately reports no size of its own: letting it
/// size the window is what made the window resize itself to death on macOS 26,
/// so `sizingOptions` was emptied. Asking that view how tall it wants to be then
/// answers zero, and a window opened at zero height is a bare title bar whose
/// content only appears in full screen — which is what people actually saw.
///
/// So the window measures its content itself and applies the height once per
/// change, and this decides what a measurement becomes: the content's own
/// height, never taller than most of the screen (past that the content scrolls)
/// and never shorter than a floor. A measurement that is missing or zero falls
/// back to a fixed height rather than opening a title bar again.
public enum MainWindowSizing {
    /// Used only when the content could not be measured.
    public static let fallbackHeight: CGFloat = 560
    /// A floor, not a target: the content is normally taller than this, and a
    /// window this short still shows a line or two rather than a title bar.
    public static let minimumHeight: CGFloat = 40
    /// On a short screen the window stops here and the content scrolls.
    public static let maximumScreenShare: CGFloat = 0.8
    /// Height changes smaller than this are rounding, not new content; applying
    /// them would only feed layout back into itself.
    public static let changeThreshold: CGFloat = 0.5

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

    /// Whether a window whose content is `current` tall should be resized to `target`.
    public static func needsResize(from current: CGFloat, to target: CGFloat) -> Bool {
        return abs(current - target) > changeThreshold
    }
}
