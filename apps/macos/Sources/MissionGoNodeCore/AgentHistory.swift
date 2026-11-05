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
