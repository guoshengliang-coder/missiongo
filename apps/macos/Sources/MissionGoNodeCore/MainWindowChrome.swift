import Foundation

/// The chrome of the main window, as data so it can be asserted without a screen.
///
/// The window used to be `.borderless`, which is why it had no close, zoom or
/// minimize buttons at all (AND-262). `.titled` is what makes the traffic lights
/// exist, but a titled window also brings a visible title bar — a second header
/// stacked over the content's own header. The two are reconciled with a hidden,
/// transparent title bar: the buttons stay, the second header does not.
///
/// These are values rather than AppKit calls so a test can hold them still. The
/// button count itself is a property of `.titled` and cannot be asserted here;
/// what this pins down is the configuration that produces it.
public enum MainWindowChrome {
    /// `.titled` makes the close/zoom/minimize buttons exist. `.fullSizeContentView`
    /// lets the content run under them, so the window keeps the one-header look
    /// the old borderless mask had.
    public static let styleMask: StyleMask = [.titled, .fullSizeContentView]

    /// The title bar is hidden rather than removed: the buttons live in it.
    public static let titleVisibilityHidden = true
    public static let titlebarAppearsTransparent = true

    /// The traffic lights are drawn over the content (`.fullSizeContentView`), so
    /// the content starts below them. The height probe pads by the same amount,
    /// keeping the measured height and the drawn height one measurement.
    public static let titleBarClearance: CGFloat = 28

    /// Whether resigning key should dismiss the window.
    ///
    /// Resigning key is how this window goes away when you click elsewhere, but
    /// minimizing resigns key as well — without this distinction the minimize
    /// button closes the window instead of parking it in the Dock.
    public static func closesOnResignKey(isMiniaturized: Bool) -> Bool {
        return !isMiniaturized
    }

    /// Whether reopening should un-minimize rather than showing nothing.
    public static func shouldDeminiaturize(isMiniaturized: Bool) -> Bool {
        return isMiniaturized
    }

    /// Options, in the style of `NSWindow.StyleMask`, so the assertion reads as
    /// plainly as the call site it stands for.
    public struct StyleMask: OptionSet, Equatable {
        public let rawValue: Int
        public init(rawValue: Int) { self.rawValue = rawValue }

        public static let titled = StyleMask(rawValue: 1 << 0)
        public static let fullSizeContentView = StyleMask(rawValue: 1 << 1)
    }
}
