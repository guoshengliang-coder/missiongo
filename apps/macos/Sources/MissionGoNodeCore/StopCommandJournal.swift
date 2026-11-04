import CryptoKit
import Foundation

/// A native stop is attempted at most once, including after the node restarts.
/// The journal contains only opaque hashes; absence of a result requires observation,
/// never replay. A person may issue a new stop with a new command identity.
public struct StopCommandJournal: Sendable {
    public let root: URL
    public init(root: URL) { self.root = root }
    public static var application: StopCommandJournal {
        StopCommandJournal(root: FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/Application Support/MissionGo/StopCommands", isDirectory: true))
    }
    public func reserve(sessionRef: String, commandId: String) throws -> Bool {
        let key = SHA256.hash(data: Data((sessionRef + "\n" + commandId).utf8))
            .map { String(format: "%02x", $0) }.joined()
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true,
            attributes: [.posixPermissions: 0o700])
        let path = root.appendingPathComponent(key)
        do {
            try Data("attempted\n".utf8).write(to: path, options: .withoutOverwriting)
            return true
        } catch {
            if FileManager.default.fileExists(atPath: path.path) { return false }
            throw error
        }
    }
}
