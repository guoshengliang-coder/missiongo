import XCTest
@testable import MissionGoNodeCore

final class CredentialStoreTests: XCTestCase {
    private let credential = NodeCredential(serverUrl: "https://missiongo.example/", nodeId: "n1", name: "Mac mini", token: "mgn_x")

    private func exercise(_ store: CredentialStore) throws {
        XCTAssertNil(try store.loadCredential())
        try store.saveCredential(credential)
        XCTAssertEqual(try store.loadCredential(), credential)
        XCTAssertEqual(try store.loadCredential()?.serverUrl, "https://missiongo.example")

        let installation = try store.installationId()
        XCTAssertNotNil(UUID(uuidString: installation))
        XCTAssertEqual(try store.installationId(), installation)

        // Logging out forgets the credential but not the installation: logging in
        // again has to land on the same machine record.
        try store.deleteCredential()
        XCTAssertNil(try store.loadCredential())
        XCTAssertEqual(try store.installationId(), installation)
        try store.deleteCredential()
    }

    func testInMemoryStoreKeepsTheContract() throws {
        try exercise(InMemoryCredentialStore())
    }

    /// Opt-in: touching the login keychain from a test binary can raise a system
    /// prompt, which would hang an unattended run. `MISSIONGO_KEYCHAIN_TESTS=1 swift test`.
    func testKeychainStoreKeepsTheContract() throws {
        try XCTSkipUnless(ProcessInfo.processInfo.environment["MISSIONGO_KEYCHAIN_TESTS"] == "1", "keychain tests are opt-in")
        let store = KeychainCredentialStore(service: "io.missiongo.macos.tests.\(UUID().uuidString)")
        defer {
            let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: store.service]
            SecItemDelete(query as CFDictionary)
        }
        try exercise(store)
    }
}
