import Foundation
import UserNotifications

/// AND-306: reaches the person at the machine when an agent's MissionGo
/// authorization is dying or dead. The menu shows the state whenever it is
/// open; a notification is what reaches them when it is not.
public protocol AuthorizationNoticing: Sendable {
    func notify(_ notice: AuthorizationNotice)
}

public struct AuthorizationNotice: Equatable, Sendable {
    public enum Level: String, Sendable {
        /// Inside the expiring window: there is time, say it once.
        case warning
        /// Dead or about to die within a day: sessions will break on their
        /// first MCP call.
        case critical
    }

    public let agentKind: String
    public let level: Level
    public let daysLeft: Int?

    public init(agentKind: String, level: Level, daysLeft: Int?) {
        self.agentKind = agentKind
        self.level = level
        self.daysLeft = daysLeft
    }

    /// The name the menu already uses, so a notification and a status row
    /// speak about the same program.
    public var agentName: String {
        switch agentKind {
        case "claude_code": return "Claude Code"
        case "codex": return "Codex"
        case "opencode": return "OpenCode"
        default: return agentKind
        }
    }

    public var title: String {
        switch level {
        case .warning: return "\(agentName) 的 MissionGo 授权即将到期"
        case .critical: return "\(agentName) 的 MissionGo 授权已失效"
        }
    }

    public var body: String {
        switch level {
        case .warning:
            let days = daysLeft ?? 0
            return days <= 0
                ? "令牌今天到期；请尽快在控制台换发并更新该 Agent 的配置。"
                : "令牌还有 \(days) 天到期；请安排在控制台换发并更新该 Agent 的配置。"
        case .critical:
            return "使用它的会话会在第一个 MCP 调用处中断；请换发令牌并更新该 Agent 的配置。"
        }
    }
}

/// Whether a snapshot deserves a notification, and at what level. Pure
/// judgment over values, so the schedule is testable without a notification
/// center: `invalid` is critical, `expiring` within its final day is critical
/// too, earlier days are a warning, and healthy or unknown states stay quiet.
public enum AuthorizationNoticeScheduler {
    /// How close to expiry a warning escalates to critical.
    public static let criticalWindow: TimeInterval = 24 * 60 * 60

    public static func notice(for agentKind: String, snapshot: McpAuthSnapshot?, now: Date = Date()) -> AuthorizationNotice? {
        guard let snapshot else { return nil }
        switch snapshot.state {
        case "invalid":
            return AuthorizationNotice(agentKind: agentKind, level: .critical, daysLeft: nil)
        case "expiring":
            guard let expiresAt = snapshot.expiresAt else { return nil }
            let left = expiresAt.timeIntervalSince(now)
            return AuthorizationNotice(
                agentKind: agentKind,
                level: left <= criticalWindow ? .critical : .warning,
                daysLeft: max(0, Int((left / 86_400).rounded()))
            )
        default:
            return nil
        }
    }
}

/// Remembers when each (agent, level) was last notified. A 30-second
/// heartbeat would otherwise repeat the same warning all day.
public protocol AuthorizationNoticeStore: Sendable {
    func lastSent(at key: String) -> Date?
    func markSent(at key: String, now: Date)
}

/// One notification per agent and level per day: urgent the first time,
/// background noise the tenth. Marking happens on the decision, not on
/// delivery, so a denied permission cannot turn into a retry loop.
public enum AuthorizationNoticeGate {
    public static let repeatInterval: TimeInterval = 24 * 60 * 60

    public static func shouldSend(level: AuthorizationNotice.Level, agentKind: String, now: Date = Date(), store: AuthorizationNoticeStore) -> Bool {
        let key = "missiongo.mcpAuthNotice.\(agentKind).\(level.rawValue)"
        if let last = store.lastSent(at: key), now.timeIntervalSince(last) < repeatInterval {
            return false
        }
        store.markSent(at: key, now: now)
        return true
    }
}

/// `UserDefaults`-backed store for the shipped app. The class is thread-safe
/// (NSUserDefaults is documented as such), hence the unchecked conformance.
public final class UserDefaultsAuthorizationNoticeStore: AuthorizationNoticeStore, @unchecked Sendable {
    private let defaults: UserDefaults

    public init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
    }

    public func lastSent(at key: String) -> Date? {
        defaults.object(forKey: key) as? Date
    }

    public func markSent(at key: String, now: Date) {
        defaults.set(now, forKey: key)
    }
}

/// The shipped notifier: asks the system for permission on first use — a
/// refusal degrades to silence, never to an error — and then posts one alert.
public struct SystemAuthorizationNotifier: AuthorizationNoticing {
    private let store: AuthorizationNoticeStore

    public init(store: AuthorizationNoticeStore = UserDefaultsAuthorizationNoticeStore()) {
        self.store = store
    }

    public func notify(_ notice: AuthorizationNotice) {
        guard AuthorizationNoticeGate.shouldSend(level: notice.level, agentKind: notice.agentKind, store: store) else { return }
        let center = UNUserNotificationCenter.current()
        center.requestAuthorization(options: [.alert]) { granted, _ in
            guard granted else { return }
            let content = UNMutableNotificationContent()
            content.title = notice.title
            content.body = notice.body
            content.sound = notice.level == .critical ? .default : nil
            let request = UNNotificationRequest(
                identifier: "missiongo.mcpAuth.\(notice.agentKind).\(notice.level.rawValue)",
                content: content,
                trigger: nil
            )
            center.add(request)
        }
    }
}

/// A no-op for tests and previews.
public struct SilentAuthorizationNotifier: AuthorizationNoticing {
    public init() {}
    public func notify(_ notice: AuthorizationNotice) {}
}
