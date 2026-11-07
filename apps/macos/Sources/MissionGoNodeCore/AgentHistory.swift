import CryptoKit
import Foundation

/// Opaque source cursor: only the exact bound node/thread may read it.
public struct AgentHistoryMetadata: Codable, Equatable, Sendable {
    public let cursor: String?
    public let complete: Bool
    public let error: String?
    public init(cursor: String? = nil, complete: Bool, error: String? = nil) {
        self.cursor = cursor; self.complete = complete; self.error = error
    }
}

public struct AgentHistoryJob: Codable, Sendable {
    public let id: String
    public let sessionRef: String
    public let agentKind: String
    public let cursor: String
}

public struct AgentHistoryResult: Codable, Sendable {
    public let messages: [AgentSessionMessage]
    public let nextCursor: String?
    public let error: String?
    public init(messages: [AgentSessionMessage] = [], nextCursor: String? = nil, error: String? = nil) {
        self.messages = messages; self.nextCursor = nextCursor; self.error = error
    }
}

/// A host-local transcript page; anchors remain stable when later messages arrive.
public enum TranscriptHistory {
    public static func page(_ messages: [AgentSessionMessage], cursor: String? = nil) throws -> AgentHistoryResult {
        func digest(_ end: Int) throws -> String {
            let encoder = JSONEncoder(); encoder.outputFormatting = [.sortedKeys]
            return SHA256.hash(data: try encoder.encode(Array(messages.prefix(end)))).map { String(format: "%02x", $0) }.joined()
        }
        var end = messages.count
        if let cursor {
            let parts = cursor.dropFirst(11).split(separator: ":", omittingEmptySubsequences: false)
            guard cursor.hasPrefix("transcript:"), parts.count == 2,
                  let anchor = String(parts[0]).removingPercentEncoding,
                  let index = messages.firstIndex(where: { $0.sourceId == anchor }),
                  try String(parts[1]) == digest(index) else {
                throw AgentArtifactError.referenceMissing
            }
            end = index
        }
        var start = end
        var bytes = 0
        while start > 0 && end - start < 50 {
            let size = try JSONEncoder().encode(messages[start - 1]).count
            if start < end && bytes + size > 512 * 1024 { break }
            start -= 1; bytes += size
        }
        let next = start > 0 ? "transcript:" + (messages[start].sourceId.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? "") + ":" + (try digest(start)) : nil
        return AgentHistoryResult(messages: Array(messages[start..<end]), nextCursor: next)
    }
    public static func metadata(_ page: AgentHistoryResult) -> AgentHistoryMetadata {
        AgentHistoryMetadata(cursor: page.nextCursor, complete: page.nextCursor == nil && page.error == nil, error: page.error)
    }
}
