import CryptoKit
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

    /// The wire contract says strings: a numeric double here is what 0.4.49
    /// shipped, and the server answered every heartbeat with 400.
    func testEncodesDatesAsIso8601Strings() throws {
        let moment = Date(timeIntervalSince1970: 1_800_000_000)
        let snapshot = McpAuthSnapshot(state: "expiring", expiresAt: moment, checkedAt: moment)
        let json = String(decoding: try JSONEncoder().encode(snapshot), as: UTF8.self)
        XCTAssertTrue(json.contains("\"expiresAt\":\""), "expected a string date, got: \(json)")
        XCTAssertTrue(json.contains("\"checkedAt\":\""), "expected a string date, got: \(json)")
        XCTAssertFalse(try Regex("\\d{9,}\\},").firstMatch(in: json) != nil, "numeric date leaked into: \(json)")
        let decoded = try JSONDecoder().decode(McpAuthSnapshot.self, from: Data(json.utf8))
        XCTAssertEqual(decoded, snapshot)
    }

    // MARK: AND-306 — the OpenCode token source

    /// The environment wins when it is actually set; the config file is the
    /// fallback that survives a reboot.
    func testOpenCodeTokenPrefersTheEnvironmentThenFallsBackToConfig() {
        XCTAssertEqual(McpAuthorizationHealth.openCodeToken(environment: ["MISSIONGO_TOKEN": "mgai_env"], home: "/no/such/home", fileReader: { _ in nil }), "mgai_env")
        let jsonc = """
        {
          // 注释行会被剥掉
          "mcp": {
            "servers": {
              "missiongo": {
                "url": "https://missiongo.example/mcp",
                "headers": {"Authorization": "Bearer mgpat_inline"} // 行尾注释
              }
            }
          }
        }
        """
        XCTAssertEqual(
            McpAuthorizationHealth.openCodeToken(environment: [:], home: "/tmp/home", fileReader: { $0.hasSuffix("opencode.jsonc") ? jsonc : nil }),
            "mgpat_inline"
        )
        XCTAssertNil(McpAuthorizationHealth.openCodeToken(environment: [:], home: "/tmp/home", fileReader: { _ in nil }))
    }

    /// A `{env:…}` placeholder is the missing-injection situation, not a token:
    /// reading it as one would report a fabricated verdict.
    func testOpenCodeTokenRefusesUnresolvablePlaceholders() {
        let jsonc = #"{"mcp":{"servers":{"missiongo":{"headers":{"Authorization":"Bearer {env:MISSIONGO_TOKEN}"}}}}}"#
        XCTAssertNil(McpAuthorizationHealth.openCodeToken(environment: [:], home: "/tmp/home", fileReader: { _ in jsonc }))
        XCTAssertNil(McpAuthorizationHealth.openCodeToken(environment: ["MISSIONGO_TOKEN": "{env:MISSIONGO_TOKEN}"], home: "/tmp/home", fileReader: { _ in jsonc }))
    }

    // MARK: AND-306 — a PAT judged against the account's live authorizations

    func testPersonalAccessTokenIsMatchedLocallyByDigest() {
        let now = Date(timeIntervalSince1970: 1_800_000_000)
        let pat = "mgpat_" + String(repeating: "a", count: 43)
        let digest = SHA256.hash(data: Data(pat.utf8)).map { String(format: "%02x", $0) }.joined()
        let soon = AiAuthorizationEntry(
            id: "auth-1",
            expiresAt: now.addingTimeInterval(3 * 24 * 60 * 60),
            kind: "pat",
            name: "opencode inline",
            tokenHash: digest
        )
        XCTAssertEqual(McpAuthorizationHealth.report(personalAccessToken: pat, authorizations: [soon], now: now)?.state, "expiring")

        let dead = AiAuthorizationEntry(id: "auth-2", expiresAt: now.addingTimeInterval(-60), kind: "pat", tokenHash: digest)
        XCTAssertEqual(McpAuthorizationHealth.report(personalAccessToken: pat, authorizations: [dead], now: now)?.state, "invalid")

        let longLived = AiAuthorizationEntry(id: "auth-3", expiresAt: now.addingTimeInterval(300 * 24 * 60 * 60), kind: "pat", tokenHash: digest)
        XCTAssertEqual(McpAuthorizationHealth.report(personalAccessToken: pat, authorizations: [longLived], now: now)?.state, "valid")

        // No digest match, no list, no plaintext PAT: silence, never a guess.
        XCTAssertNil(McpAuthorizationHealth.report(personalAccessToken: pat, authorizations: [], now: now))
        XCTAssertNil(McpAuthorizationHealth.report(personalAccessToken: pat, authorizations: nil, now: now))
        XCTAssertNil(McpAuthorizationHealth.report(personalAccessToken: nil, authorizations: [soon], now: now))
        XCTAssertNil(McpAuthorizationHealth.report(personalAccessToken: "mgai_" + pat.dropFirst(5), authorizations: [soon], now: now))
    }
}
