import Foundation

/// Foreground checks and heartbeat syncs share these per-agent results.
/// Starting another check or disabling an integration invalidates older work.
public final class AgentSkillSync: @unchecked Sendable {
    private struct Entry {
        let attempt: UUID
        var snapshot: AgentSkillSnapshot
    }
    private let entries = Locked<[String: Entry]>([:])

    public init() {}

    public var snapshots: [String: AgentSkillSnapshot] {
        entries.withLock { $0.mapValues(\.snapshot) }
    }

    public func begin(_ agent: String, localVersion: String?, expectedVersion: String?) -> UUID {
        let attempt = UUID()
        entries.withLock {
            $0[agent] = Entry(attempt: attempt, snapshot: AgentSkillSnapshot(
                localVersion: localVersion, expectedVersion: expectedVersion, syncState: "syncing"
            ))
        }
        return attempt
    }

    @discardableResult
    public func finish(_ agent: String, attempt: UUID, snapshot: AgentSkillSnapshot) -> AgentSkillSnapshot {
        entries.withLock {
            guard $0[agent]?.attempt == attempt else {
                return $0[agent]?.snapshot ?? AgentSkillSnapshot(syncState: "missing")
            }
            $0[agent]?.snapshot = snapshot
            return snapshot
        }
    }

    public func remove(_ agent: String) {
        entries.withLock { _ = $0.removeValue(forKey: agent) }
    }

    public func isCurrent(_ agent: String, attempt: UUID) -> Bool {
        entries.withLock { $0[agent]?.attempt == attempt }
    }

    public func invalidateAll() {
        entries.withLock { $0.removeAll() }
    }
}

extension SkillSync {
    /// Check the actual file after writing as well as after a no-op. Protected
    /// links, invalid files and newer local copies must not look synchronized
    /// merely because apply() did not report an I/O failure.
    public static func check(
        serverUrl: String,
        target: String,
        expectedVersion: String? = nil,
        session: URLSession = ServerConnection.session,
        shouldApply: @Sendable () -> Bool = { true }
    ) async -> AgentSkillSnapshot {
        let checkedAt = ISO8601DateFormatter().string(from: Date())
        let local = localVersion(at: target)
        if let expectedVersion, local == expectedVersion {
            return AgentSkillSnapshot(
                localVersion: local, expectedVersion: expectedVersion, syncState: "ready", checkedAt: checkedAt
            )
        }
        do {
            let outcome = try await run(
                serverUrl: serverUrl, targets: [target], expectedVersion: expectedVersion,
                session: session, shouldApply: shouldApply
            )
            let actual = localVersion(at: target)
            let expected = expectedVersion ?? outcome.version
            let reason: String?
            if !outcome.failures.isEmpty {
                reason = "写入失败：\(outcome.failures.joined(separator: "；"))"
            } else if actual != expected {
                if isSymlink(target) || isSymlink((target as NSString).deletingLastPathComponent) {
                    reason = "Skill 路径为符号链接，已保留原文件；本地版本与服务端要求不一致。"
                } else if let actual, isNewer(actual, than: expected) {
                    reason = "本地 Skill \(actual) 高于服务端要求 \(expected)，已保留本地文件。"
                } else {
                    reason = "本地 Skill 缺失或版本无法识别，未同步到服务端要求的 \(expected)。"
                }
            } else {
                reason = nil
            }
            return AgentSkillSnapshot(
                localVersion: actual, expectedVersion: expected,
                syncState: reason == nil ? "ready" : "failed", checkedAt: checkedAt, reason: reason
            )
        } catch {
            return AgentSkillSnapshot(
                localVersion: localVersion(at: target), expectedVersion: expectedVersion,
                syncState: "failed", checkedAt: checkedAt, reason: error.localizedDescription
            )
        }
    }
}

extension AgentSkillSnapshot {
    public var summary: String {
        switch syncState {
        case "ready": return "已同步"
        case "syncing": return "同步中…"
        case "failed": return "同步失败"
        case "missing": return "未启用或已暂停"
        case "stale": return "待升级"
        default: return "等待版本检查"
        }
    }
}
