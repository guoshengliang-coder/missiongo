import Foundation

public struct ConsolePerformanceEvent: Codable, Sendable, Equatable {
    public let id: String
    public let stage: String
    public let result: String
    public let durationMs: Double?
    public init(id: String, stage: String, result: String, durationMs: Double? = nil) {
        self.id = id; self.stage = stage; self.result = result; self.durationMs = durationMs
    }
}
public struct ConsolePerformanceBatch: Codable, Sendable {
    public let commandId: String
    public let turnId: String?
    public let generation: Int?
    public let events: [ConsolePerformanceEvent]
    public let platform = "macos"
    public let version: String
}
/// Observer-local intervals only. Exact command-ID user echo and a new turn are required.
public final class ConsolePerformanceObserver: @unchecked Sendable {
    private struct Pending {
        let session: String; let command: String; let at: Double; let previousTurns: Set<String>?
        var delivered = false; var done = false; var turn: String?
    }
    private let entries = Locked<[String: Pending]>([:])
    private let known = Locked<[String: Set<String>]>([:])
    public init() {}
    public func begin(_ session: NodeAgentSession, now: Double = ProcessInfo.processInfo.systemUptime) {
        guard let command = session.command, (command.kind ?? "message") == "message", command.status == "delivering" else { return }
        let key = session.id + ":" + command.id, turns = known.current[session.id]
        entries.withLock { values in
            values = values.filter { now - $0.value.at < 86400 }
            guard values[key] == nil else { return }
            if values.count >= 256 {
                // Completed observations are deduplicated server-side; they must not block new commands for a day.
                for old in values.keys.filter({ values[$0]?.done == true }).sorted(by: { values[$0]!.at < values[$1]!.at }) {
                    values.removeValue(forKey: old)
                    if values.count < 256 { break }
                }
            }
            guard values.count < 256 else { return }
            values[key] = Pending(session: session.id, command: command.id, at: now, previousTurns: turns)
        }
    }
    public func observe(_ session: NodeAgentSession, report: AgentSessionReport, now: Double = ProcessInfo.processInfo.systemUptime) -> [ConsolePerformanceBatch] {
        var batches: [ConsolePerformanceBatch] = []
        entries.withLock { values in
            for key in Array(values.keys) {
                guard var p = values[key], p.session == session.id, !p.done else { continue }
                var events: [ConsolePerformanceEvent] = []
                if !p.delivered, report.commandId == p.command, report.commandStatus == "delivered" {
                    p.delivered = true
                    events.append(.init(id: p.command + ":native", stage: "native_delivery", result: "success", durationMs: min(86400000, max(0, now-p.at)*1000)))
                }
                if p.turn == nil,
                   let user = report.messages.first(where: { $0.role == "user" && $0.sourceId == p.command }),
                   let turn = user.turnId {
                    if session.agentKind == "claude_code", turn == p.command { p.turn = turn }
                    else if let before = p.previousTurns, !before.contains(turn) { p.turn = turn }
                }
                if p.delivered, let turn = p.turn,
                   report.messages.contains(where: { ($0.role == "agent" || $0.role == "plan") && $0.turnId == turn }) {
                    p.done = true
                    events.append(.init(id: p.command + ":output", stage: "agent_first_output", result: "success", durationMs: min(86400000, max(0, now-p.at)*1000)))
                } else if p.delivered, session.agentKind == "opencode" || (p.previousTurns == nil && session.agentKind != "claude_code") {
                    p.done = true; events.append(.init(id: p.command + ":binding", stage: "missing", result: "uncorrelated"))
                } else if report.commandId == p.command, ["failed", "delivery_unknown"].contains(report.commandStatus ?? "") {
                    p.done = true; events.append(.init(id: p.command + ":unknown", stage: "missing", result: "unconfirmed"))
                }
                if !events.isEmpty { batches.append(ConsolePerformanceBatch(commandId: p.command, turnId: p.turn, generation: session.externalBindingGeneration,
                    events: events, version: AppUpdater.currentVersion() ?? "development")) }
                values[key] = p
            }
        }
        if !report.messages.isEmpty { known.withLock { values in
            if values.count >= 256, values[session.id] == nil { values.removeValue(forKey: values.keys.first!) }
            values[session.id] = Set(report.messages.compactMap(\.turnId).suffix(128))
        }
        }
        return batches
    }
}
/// A bounded independent upload lane; failures never enter the business retry loop.
public actor ConsolePerformanceUploader {
    private var pending: [(String, ConsolePerformanceBatch, Int)] = []
    private var draining = false
    public init() {}
    public func enqueue(sessionId: String, batch: ConsolePerformanceBatch, api: any NodeAPI) {
        guard pending.count < 256 else { return }
        pending.append((sessionId,batch,0))
        guard !draining else { return }; draining = true
        Task { await drain(api: api) }
    }
    private func drain(api: any NodeAPI) async {
        while !pending.isEmpty {
            let (session,batch,attempt) = pending.removeFirst()
            do { try await api.reportPerformance(sessionId: session, batch: batch) }
            catch { if attempt < 2, pending.count < 256 { pending.append((session,batch,attempt+1)) } }
        }
        draining = false
    }
}
