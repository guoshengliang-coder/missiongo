import Foundation
import Darwin

/// A source observation, never a grant or a promise that a subsequent send succeeds.
public struct CodexReplyReadiness: Codable, Equatable, Sendable {
    public let state: String
    public let checkedAt: String
    public init(state: String, checkedAt: String = ISO8601DateFormatter().string(from: Date())) {
        self.state = state; self.checkedAt = checkedAt
    }
}

public enum CodexWriterProbe {
    /// Read and briefly test the existing advisory lock. Never create, delete,
    /// truncate or replace a lock; an absent lock is not proof of a live runtime.
    public static func state(codexHome: String, threadId: String, runtimeStatus: String?, archived: Bool = false) -> String {
        guard !archived, UUID(uuidString: threadId) != nil else { return "unknown" }
        if runtimeStatus == "idle" { return "ready" } // This daemon already owns the loaded thread.
        guard runtimeStatus == "notLoaded" else { return "unknown" }
        let path = "\(codexHome)/thread-writer-locks/\(threadId).lock"
        let fd = open(path, O_RDONLY | O_NOFOLLOW)
        if fd < 0 { return errno == ENOENT ? "ready" : "unknown" }
        defer { close(fd) }
        var info = stat()
        guard fstat(fd, &info) == 0, (info.st_mode & S_IFMT) == S_IFREG else { return "unknown" }
        if flock(fd, LOCK_EX | LOCK_NB) == 0 {
            _ = flock(fd, LOCK_UN)
            return "ready"
        }
        return [EWOULDBLOCK, EAGAIN].contains(errno) ? "occupied" : "unknown"
    }
}
