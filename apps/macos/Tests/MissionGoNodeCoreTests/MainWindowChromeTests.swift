import XCTest

@testable import MissionGoNodeCore

final class MainWindowChromeTests: XCTestCase {
    func testTheWindowIsTitledSoTheTrafficLightsExist() {
        // The bug this replaces: `.borderless`, which draws no close, zoom or
        // minimize button at all.
        XCTAssertTrue(MainWindowChrome.styleMask.contains(.titled))
    }

    func testTheContentRunsUnderTheTitleBarSoThereIsOnlyOneHeader() {
        XCTAssertTrue(MainWindowChrome.styleMask.contains(.fullSizeContentView))
    }

    func testTheTitleBarIsHiddenRatherThanRemoved() {
        // Hiding it is what keeps the buttons while dropping the second header.
        XCTAssertTrue(MainWindowChrome.titleVisibilityHidden)
        XCTAssertTrue(MainWindowChrome.titlebarAppearsTransparent)
    }

    func testTheContentStartsBelowTheTrafficLights() {
        // `.fullSizeContentView` puts the buttons over the content, so the
        // clearance has to be tall enough to clear them.
        XCTAssertEqual(MainWindowChrome.titleBarClearance, 28)
        XCTAssertGreaterThanOrEqual(MainWindowChrome.titleBarClearance, 20)
    }

    func testStyleMaskDoesNotAskForAMaskThatDrawsNoButtons() {
        XCTAssertNotEqual(MainWindowChrome.styleMask, [])
        XCTAssertFalse(MainWindowChrome.styleMask.contains(MainWindowChrome.StyleMask(rawValue: 1 << 9)))
    }

    func testMinimizingDoesNotCloseTheWindow() {
        // Resigning key is how the window dismisses itself, but minimizing
        // resigns key too; the guard is what parks it in the Dock instead of
        // closing it. Asserted as the rule the delegate implements.
        XCTAssertTrue(MainWindowChrome.closesOnResignKey(isMiniaturized: false))
        XCTAssertFalse(MainWindowChrome.closesOnResignKey(isMiniaturized: true))
    }

    func testReopeningRestoresAMinimizedWindow() {
        XCTAssertTrue(MainWindowChrome.shouldDeminiaturize(isMiniaturized: true))
        XCTAssertFalse(MainWindowChrome.shouldDeminiaturize(isMiniaturized: false))
    }
}
