import CoreGraphics

/// How tall the main window opens.
///
/// The window's hosting view deliberately reports no size of its own: letting it
/// size the window is what made the window resize itself to death on macOS 26,
/// so `sizingOptions` was emptied. Asking that view how tall it wants to be then
/// answers zero, and a window opened at zero height is a bare title bar whose
/// content only appears in full screen — which is what people actually saw.
///
/// So the opening height is decided here instead of measured: a fixed height,
/// never taller than most of the screen and never shorter than the window's own
/// minimum. The content scrolls, so opening a little short costs a drag of the
/// edge; opening at zero costs the whole window.
public enum MainWindowSizing {
    /// Tall enough for the machine's status and the repository list under it,
    /// without filling a laptop screen.
    public static let preferredHeight: CGFloat = 560
    /// Also the window's `contentMinSize`, so what opens can never be smaller
    /// than what a person is allowed to drag it down to.
    public static let minimumHeight: CGFloat = 220
    /// On a short screen the window stops here and the content scrolls.
    public static let maximumScreenShare: CGFloat = 0.8

    /// `availableHeight` is the screen's visible height, or nil when no screen
    /// answers — a Mac with the lid shut and no display attached, for instance.
    public static func openingHeight(availableHeight: CGFloat?) -> CGFloat {
        guard let available = availableHeight, available > 0 else { return preferredHeight }
        return max(minimumHeight, min(preferredHeight, available * maximumScreenShare))
    }
}
