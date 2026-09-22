import XCTest

@testable import MissionGoNodeCore

final class WindowSizingTests: XCTestCase {
    func testFitsTheContentExactlyWhenItFitsOnTheScreen() {
        // The bug this replaces: a fixed 560 left a blank area under short content.
        XCTAssertEqual(MainWindowSizing.contentHeight(measuredHeight: 312, availableHeight: 1200), 312)
        XCTAssertEqual(MainWindowSizing.contentHeight(measuredHeight: 900, availableHeight: 1200), 900)
    }

    func testRoundsUpSoTheLastLineIsNotClipped() {
        XCTAssertEqual(MainWindowSizing.contentHeight(measuredHeight: 312.2, availableHeight: 1200), 313)
    }

    func testStopsAtSomeOfTheScreenAndLetsTheContentScroll() {
        XCTAssertEqual(MainWindowSizing.contentHeight(measuredHeight: 1000, availableHeight: 600), 480)
    }

    func testNeverShorterThanTheFloor() {
        XCTAssertEqual(MainWindowSizing.contentHeight(measuredHeight: 48, availableHeight: 1200), 48)
        XCTAssertEqual(MainWindowSizing.contentHeight(measuredHeight: 10, availableHeight: 1200), MainWindowSizing.minimumHeight)
        XCTAssertEqual(MainWindowSizing.contentHeight(measuredHeight: 400, availableHeight: 30), MainWindowSizing.minimumHeight)
    }

    func testAnUnmeasuredContentFallsBackInsteadOfOpeningAsATitleBar() {
        // The earlier bug: a height of zero, which showed a bare title bar.
        XCTAssertEqual(MainWindowSizing.contentHeight(measuredHeight: 0, availableHeight: 1200), MainWindowSizing.fallbackHeight)
        XCTAssertEqual(MainWindowSizing.contentHeight(measuredHeight: nil, availableHeight: 1200), MainWindowSizing.fallbackHeight)
        XCTAssertEqual(MainWindowSizing.contentHeight(measuredHeight: .nan, availableHeight: 1200), MainWindowSizing.fallbackHeight)
        XCTAssertEqual(MainWindowSizing.contentHeight(measuredHeight: nil, availableHeight: 600), 480)
    }

    func testWithoutAScreenOnlyTheFloorApplies() {
        XCTAssertEqual(MainWindowSizing.contentHeight(measuredHeight: 900, availableHeight: nil), 900)
        XCTAssertEqual(MainWindowSizing.contentHeight(measuredHeight: 900, availableHeight: 0), 900)
    }

    func testIgnoresRoundingSizedChanges() {
        XCTAssertFalse(MainWindowSizing.needsResize(from: 400, to: 400.4))
        XCTAssertFalse(MainWindowSizing.needsResize(from: 400, to: 400.5))
        XCTAssertTrue(MainWindowSizing.needsResize(from: 400, to: 401))
        XCTAssertTrue(MainWindowSizing.needsResize(from: 401, to: 400))
    }
}
