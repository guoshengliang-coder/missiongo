import Foundation

public enum LocalAgent: String, CaseIterable, Sendable {
    case claudeCode = "claude_code"
    case codex

    public var title: String { self == .claudeCode ? "Claude Code" : "Codex" }
}

/// Local consent is separate from the server's dispatch settings and from TCC.
/// Only a foreground check may enable an integration. Heartbeats read cached
/// metadata, never launch a CLI or touch another app's files to discover it.
public final class LocalIntegrations: @unchecked Sendable {
    public struct State: Codable, Equatable, Sendable {
        public let attempt: UUID
        public let version: String?
        public let issue: String?
    }

    private static let key = "localIntegrations.v1"
    private let defaults: UserDefaults
    private let states: Locked<[String: State]>

    public init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        let saved = defaults.data(forKey: Self.key)
            .flatMap { try? JSONDecoder().decode([String: State].self, from: $0) } ?? [:]
        states = Locked(saved)
    }

    public func state(for agent: LocalAgent) -> State? { states.current[agent.rawValue] }

    /// Persist the pause *before* touching protected resources. A denial, crash
    /// or quit while a system prompt is open must not cause a retry at next login.
    public func begin(_ agent: LocalAgent) -> UUID {
        let attempt = UUID()
        update { $0[agent.rawValue] = State(attempt: attempt, version: nil, issue: "访问尚未完成，已暂停；请点击重新检查。") }
        return attempt
    }

    /// Atomically check consent and reserve this launch. A concurrent disable
    /// must not be overwritten between a read and a subsequent begin().
    public func beginLaunch(_ agent: LocalAgent) -> (attempt: UUID, version: String)? {
        var result: (UUID, String)?
        update {
            guard let version = $0[agent.rawValue]?.version else { return }
            let attempt = UUID()
            $0[agent.rawValue] = State(attempt: attempt, version: nil, issue: "派单启动尚未完成，已暂停后续访问。")
            result = (attempt, version)
        }
        return result
    }

    public func isCurrent(_ agent: LocalAgent, attempt: UUID) -> Bool {
        state(for: agent)?.attempt == attempt
    }

    public func finish(_ agent: LocalAgent, attempt: UUID, version: String?, issue: String? = nil) {
        update {
            guard $0[agent.rawValue]?.attempt == attempt else { return }
            $0[agent.rawValue] = State(attempt: attempt, version: version, issue: issue)
        }
    }

    public func disable(_ agent: LocalAgent) { update { $0.removeValue(forKey: agent.rawValue) } }

    private func update(_ edit: (inout [String: State]) -> Void) {
        states.withLock {
            edit(&$0)
            if let data = try? JSONEncoder().encode($0) { defaults.set(data, forKey: Self.key) }
        }
    }
}

/// Keep both native adapters intact. A queued dispatch cannot bypass a local
/// disable/pause, even if the server still has an older heartbeat snapshot.
public struct ConsentedAgentAdapter: AgentAdapter {
    public var kind: String { agent.rawValue }
    private let agent: LocalAgent
    private let base: any AgentAdapter
    private let access: LocalIntegrations

    public init(agent: LocalAgent, base: any AgentAdapter, access: LocalIntegrations) {
        self.agent = agent
        self.base = base
        self.access = access
    }

    public func detect() async -> String? { access.state(for: agent)?.version }

    public func dispatchAvailability() async -> AgentDispatchAvailability {
        guard access.state(for: agent)?.version != nil else {
            return .unavailable(reason: "\(agent.title) 集成未启用或已暂停。")
        }
        return await base.dispatchAvailability()
    }

    public func resourceSnapshot() async -> AgentResourceSnapshot? {
        guard access.state(for: agent)?.version != nil else { return nil }
        return await base.resourceSnapshot()
    }

    public func availableModels() async -> [AgentModelOption]? {
        guard access.state(for: agent)?.version != nil else { return nil }
        return await base.availableModels()
    }

    public func launch(_ job: DispatchJob) async throws -> LaunchResult {
        guard let (attempt, version) = access.beginLaunch(agent) else {
            throw LaunchError("\(agent.title) 集成未启用或已暂停；请在 MissionGo 菜单中启用或重新检查，不会自动重试权限请求。")
        }
        do {
            let result = try await base.launch(job)
            access.finish(agent, attempt: attempt, version: version)
            return result
        } catch {
            access.finish(agent, attempt: attempt, version: nil, issue: "启动失败，已暂停自动访问：\(error.localizedDescription)")
            throw error
        }
    }

    public func synchronize(_ session: NodeAgentSession) async throws -> AgentSessionReport {
        guard access.state(for: agent) != nil else {
            throw LaunchError("\(agent.title) 集成已停用；不会读取或回复现有会话。")
        }
        return try await base.synchronize(session)
    }
}
