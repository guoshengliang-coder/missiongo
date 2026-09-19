import XCTest

@testable import MissionGoNodeCore

final class WindowSizingTests: XCTestCase {
    func testOpensAtThePreferredHeightOnAnOrdinaryScreen() {
        XCTAssertEqual(MainWindowSizing.openingHeight(availableHeight: 1200), MainWindowSizing.preferredHeight)
    }

    func testStopsAtSomeOfAShortScreenRatherThanFillingIt() {
        XCTAssertEqual(MainWindowSizing.openingHeight(availableHeight: 600), 480)
    }

    func testNeverOpensSmallerThanTheWindowsOwnMinimum() {
        // The bug this replaces: a height of zero, which showed a bare title bar.
        XCTAssertEqual(MainWindowSizing.openingHeight(availableHeight: 100), MainWindowSizing.minimumHeight)
        XCTAssertEqual(MainWindowSizing.openingHeight(availableHeight: 0), MainWindowSizing.preferredHeight)
        XCTAssertEqual(MainWindowSizing.openingHeight(availableHeight: nil), MainWindowSizing.preferredHeight)
    }
}
