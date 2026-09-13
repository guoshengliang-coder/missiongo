import Foundation
import Security

/// What this machine keeps between launches: where the server is, and the
/// credential that identifies the machine to it.
///
/// Only the node credential (`mgn_`) is ever stored. The login token (`mgai_`)
/// from the browser sign-in is used once to register and then dropped: it
/// expires in 30 days and cannot be revoked on its own, while the node
/// credential is long-lived and can be revoked from the console.
public struct NodeCredential: Codable, Equatable, Sendable {
    public let serverUrl: String
    public let nodeId: String
    public let name: String
    public let token: String

    public init(serverUrl: String, nodeId: String, name: String, token: String) {
        self.serverUrl = normalizeServerUrl(serverUrl)
        self.nodeId = nodeId
        self.name = name
        self.token = token
    }
}

public protocol CredentialStore: Sendable {
    /// `nil` means this machine has not logged in yet, which is not an error.
    func loadCredential() throws -> NodeCredential?
    func saveCredential(_ credential: NodeCredential) throws
    func deleteCredential() throws
    /// A UUID created on first use and kept from then on.
    ///
    /// The server reuses the machine record when the same installation logs in
    /// again — rotating the credential but keeping repository mappings and
    /// dispatch history — so logging out and back in must not look like a new
    /// machine. It survives `deleteCredential` for that reason.
    func installationId() throws -> String
}

public struct CredentialStoreError: Error, Equatable, LocalizedError {
    public let message: String

    public var errorDescription: String? {
        return message
    }
}

/// Keychain rather than a file: the credential is a bearer token for running
/// agents on this machine, and a JSON file in the home directory is readable by
/// anything the user runs, and ends up in backups and dotfile repositories.
public struct KeychainCredentialStore: CredentialStore {
    public static let defaultService = "io.missiongo.macos"
    static let credentialAccount = "node-credential"
    static let installationAccount = "installation-id"

    public let service: String

    public init(service: String = KeychainCredentialStore.defaultService) {
        self.service = service
    }

    public func loadCredential() throws -> NodeCredential? {
        guard let data = try read(account: KeychainCredentialStore.credentialAccount) else { return nil }
        do {
            return try JSONDecoder().decode(NodeCredential.self, from: data)
        } catch {
            // An entry from an incompatible build is as good as no login; asking
            // the user to log in again beats failing on every launch.
            return nil
        }
    }

    public func saveCredential(_ credential: NodeCredential) throws {
        let data = try JSONEncoder().encode(credential)
        try write(data, account: KeychainCredentialStore.credentialAccount)
    }

    public func deleteCredential() throws {
        try delete(account: KeychainCredentialStore.credentialAccount)
    }

    public func installationId() throws -> String {
        if let data = try read(account: KeychainCredentialStore.installationAccount),
           let existing = String(data: data, encoding: .utf8), !existing.isEmpty {
            return existing
        }
        let created = UUID().uuidString.lowercased()
        try write(Data(created.utf8), account: KeychainCredentialStore.installationAccount)
        return created
    }

    // MARK: Keychain plumbing

    private func baseQuery(account: String) -> [String: Any] {
        return [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
    }

    private func read(account: String) throws -> Data? {
        var query = baseQuery(account: account)
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess else { throw keychainError("读取", status) }
        return result as? Data
    }

    private func write(_ data: Data, account: String) throws {
        let query = baseQuery(account: account)
        let update: [String: Any] = [kSecValueData as String: data]
        let status = SecItemUpdate(query as CFDictionary, update as CFDictionary)
        if status == errSecSuccess { return }
        guard status == errSecItemNotFound else { throw keychainError("写入", status) }
        var insert = query
        insert[kSecValueData as String] = data
        // Readable after the first unlock, so the app can come up at login and go
        // online without a prompt; never migrated to another device, because the
        // credential identifies this machine and a copy elsewhere would be a
        // second machine answering as this one. (The legacy file keychain an
        // unsigned app gets may ignore this attribute; it costs nothing to ask.)
        insert[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        let added = SecItemAdd(insert as CFDictionary, nil)
        guard added == errSecSuccess else { throw keychainError("写入", added) }
    }

    private func delete(account: String) throws {
        let status = SecItemDelete(baseQuery(account: account) as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else { throw keychainError("删除", status) }
    }

    private func keychainError(_ action: String, _ status: OSStatus) -> CredentialStoreError {
        let message = SecCopyErrorMessageString(status, nil) as String? ?? "OSStatus \(status)"
        return CredentialStoreError(message: "\(action)钥匙串失败：\(message)（OSStatus \(status)）")
    }
}

/// For tests and previews: the same contract, nothing written to the Keychain.
public final class InMemoryCredentialStore: CredentialStore, @unchecked Sendable {
    private let state: Locked<(credential: NodeCredential?, installationId: String?)>

    public init(credential: NodeCredential? = nil, installationId: String? = nil) {
        state = Locked((credential, installationId))
    }

    public func loadCredential() throws -> NodeCredential? {
        return state.current.credential
    }

    public func saveCredential(_ credential: NodeCredential) throws {
        state.withLock { $0.credential = credential }
    }

    public func deleteCredential() throws {
        state.withLock { $0.credential = nil }
    }

    public func installationId() throws -> String {
        return state.withLock { value in
            if let existing = value.installationId { return existing }
            let created = UUID().uuidString.lowercased()
            value.installationId = created
            return created
        }
    }
}
