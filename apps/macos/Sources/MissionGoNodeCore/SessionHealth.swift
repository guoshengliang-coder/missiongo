import Foundation
import CryptoKit

/// Tracks actual source changes, not successful mirror polls, settings or reply acknowledgements.
/// It never sends input or interrupts a runtime. A restart starts a fresh observation window.
public final class SessionHealthTracker: @unchecked Sendable {
    private struct Observation {
        let fingerprint: Data?
        let progressAt: Date
        let observedAt: Date
        let waitTimes: [String: String]
    }
    private struct Progress: Encodable {
        let status: String
        let messages: [AgentSessionMessage]
        let activities: [AgentSessionActivity]
        let activityAt: String?
        let lastOutputAt: String?
        let thinkingTokens: Int?
        let turnActive: Bool?
        let waitingForInput: Bool?
        let revision: String?
    }
    private let observations = Locked<[String: Observation]>([:])
    public init() {}

    public func observe(_ report: AgentSessionReport, key: String, now: Date = Date()) -> AgentSessionReport {
        let encoder = JSONEncoder()
        encoder.outputFormatting = .sortedKeys
        let data = try? encoder.encode(Progress(status: report.status, messages: report.messages,
            activities: report.activities, activityAt: report.activityAt, lastOutputAt: report.lastOutputAt,
            thinkingTokens: report.thinkingTokens, turnActive: report.turnActive,
            waitingForInput: report.waitingForInput, revision: report.progressRevision))
        let fingerprint = data.map { Data(SHA256.hash(data: $0)) }
        let observation = observations.withLock { values -> Observation in
            let previous = values[key]
            let unchanged = previous != nil && previous?.fingerprint == fingerprint
            let progress = unchanged ? previous!.progressAt : now
            let observed = unchanged && now.timeIntervalSince(previous!.observedAt) < 30 ? previous!.observedAt : now
            let nowStamp = SessionLauncher.activityTimestamp(now)
            var waitTimes = previous?.waitTimes ?? [:]
            if waitTimes.count > 160 {
                waitTimes = Dictionary(uniqueKeysWithValues: waitTimes.sorted { $0.value > $1.value }.prefix(120).map { ($0.key, $0.value) })
            }
            for activity in report.activities {
                if let wait = activity.wait {
                    let key = activity.id + ":" + (wait.sample ?? "")
                    waitTimes[key] = wait.at ?? waitTimes[key] ?? nowStamp
                }
            }
            let current = Observation(fingerprint: fingerprint, progressAt: progress, observedAt: observed, waitTimes: waitTimes)
            values[key] = current
            return current
        }
        // Keep unchanged snapshots deduplicated while confirming source access every 30 seconds.
        return report.reportingObservation(observedAt: SessionLauncher.activityTimestamp(observation.observedAt),
            lastProgressAt: SessionLauncher.activityTimestamp(observation.progressAt), activities: report.activities.map { activity in
                guard let wait = activity.wait else { return activity }
                let at = observation.waitTimes[activity.id + ":" + (wait.sample ?? "")]
                return AgentSessionActivity(id: activity.id, title: activity.title, detail: activity.detail,
                    startedAt: activity.startedAt ?? (wait.kind == "tool" ? at : nil),
                    wait: .init(kind: wait.kind, at: at, url: wait.url, status: wait.status))
            })
    }
}
