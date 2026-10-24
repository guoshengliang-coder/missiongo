import XCTest

@testable import MissionGoNodeCore

/// AND-289: the local read of an agent's MissionGo token expiry.
final class McpAuthorizationHealthTests: XCTestCase {
    private func token(expiresAt secondsFromNow: Double, now: Date) -> String {
        let header = Data("{}".utf8).base64EncodedString()
            .replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_")
        let payload = Data("{\"id\":\"a\",\"username\":\"u\",\"role\":\"admin\",\"tokenId\":\"t\",\"clientId\":\"c\",\"scopes\":[\"missiongo:read\"],\"credentialsAt\":1,\"issuedAt\":1,\"expiresAt\":\(Int(now.timeIntervalSince1970 + secondsFromNow))}".utf8)
            .base64EncodedString()
            .replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_")
        return "mgai_\(payload).\(header)"
    }

    func testClassifiesValidExpiringAndInvalid() {
        let now = Date(timeIntervalSince1970: 1_800_000_000)
        XCTAssertEqual(McpAuthorizationHealth.report(token: token(expiresAt: 30 * 24 * 60 * 60, now: now), now: now)?.state, "valid")
        XCTAssertEqual(McpAuthorizationHealth.report(token: token(expiresAt: 3 * 24 * 60 * 60, now: now), now: now)?.state, "expiring")
        XCTAssertEqual(McpAuthorizationHealth.report(token: token(expiresAt: -60, now: now), now: now)?.state, "invalid")
    }

    func testStaysQuietAboutWhatItCannotRead() {
        XCTAssertNil(McpAuthorizationHealth.report(token: nil))
        XCTAssertNil(McpAuthorizationHealth.report(token: "mgpat_hashed-not-self-describing"))
        XCTAssertNil(McpAuthorizationHealth.report(token: "mgai_not-base64-at-all"))
    }

    func testExpiryDateTravelsWithTheVerdict() throws {
        let now = Date(timeIntervalSince1970: 1_800_000_000)
        let report = try XCTUnwrap(McpAuthorizationHealth.report(token: token(expiresAt: 3 * 24 * 60 * 60, now: now), now: now))
        XCTAssertEqual(report.expiresAt, now.addingTimeInterval(3 * 24 * 60 * 60))
    }
}
