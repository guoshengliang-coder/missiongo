import Foundation

/// Replaces a broken connection pool without restarting NodeLoop (which owns
/// unacknowledged command results). Requests are never replayed here. Retired
/// sessions drain before invalidation, including requests acquired just before
/// a reconnect; no in-flight mutation is cancelled or replayed by recovery.
final class ServerSessionPool: @unchecked Sendable {
    struct Key: Hashable {
        let mode: ServerConnectionMode
        let resourceTimeout: TimeInterval
    }

    private final class Entry {
        let session: URLSession
        var active = 0
        var retired = false
        var failures = 0

        init(_ session: URLSession) { self.session = session }
    }

    private struct Recovery {
        var windowStart = Date.distantPast
        var attempts = 0
        var nextAttempt = Date.distantPast
    }

    private struct State {
        var entries: [Key: Entry] = [:]
        var recoveries: [Key: Recovery] = [:]
    }

    private let state = Locked(State())
    private let makeSession: @Sendable (Key) -> URLSession
    private let now: @Sendable () -> Date

    init(
        now: @escaping @Sendable () -> Date = { Date() },
        makeSession: @escaping @Sendable (Key) -> URLSession = { key in
            let config = ServerConnection.configuration(for: key.mode)
            config.timeoutIntervalForResource = key.resourceTimeout
            return URLSession(configuration: config)
        }
    ) {
        self.now = now
        self.makeSession = makeSession
    }

    func data(for request: URLRequest, mode: ServerConnectionMode) async throws -> (Data, URLResponse) {
        // Ordinary API calls (including 40s long polls) finish within 60s even
        // if a peer keeps trickling bytes. The updater retains its 600s budget.
        let key = Key(mode: mode, resourceTimeout: max(60, request.timeoutInterval))
        let entry = state.withLock { value -> Entry in
            let entry = value.entries[key] ?? Entry(makeSession(key))
            value.entries[key] = entry
            entry.active += 1
            return entry
        }
        do {
            let result = try await entry.session.data(for: request)
            complete(entry, key: key, error: nil)
            return result
        } catch {
            complete(entry, key: key, error: error)
            throw error
        }
    }

    /// Used by the explicit reconnect button and routing changes. Requests
    /// already on the old route finish; new requests get a fresh session.
    func reconnect() {
        let idle = state.withLock { value -> [URLSession] in
            let entries = Array(value.entries.values)
            entries.forEach { $0.retired = true }
            value.entries.removeAll()
            value.recoveries.removeAll()
            return entries.filter { $0.active == 0 }.map(\.session)
        }
        idle.forEach { $0.finishTasksAndInvalidate() }
    }

    private func complete(_ entry: Entry, key: Key, error: Error?) {
        let idle = state.withLock { value -> URLSession? in
            entry.active -= 1
            if value.entries[key] === entry {
                if let error {
                    if Self.isRecoverable(error) {
                        entry.failures += 1
                        var recovery = value.recoveries[key] ?? Recovery()
                        let time = now()
                        if time.timeIntervalSince(recovery.windowStart) >= 300 {
                            recovery = Recovery(windowStart: time)
                        }
                        // Three consecutive transport failures, at most three
                        // replacements per five minutes, with 15/30/60s backoff.
                        if entry.failures >= 3, recovery.attempts < 3, time >= recovery.nextAttempt {
                            recovery.nextAttempt = time.addingTimeInterval(15 * pow(2, Double(recovery.attempts)))
                            recovery.attempts += 1
                            entry.retired = true
                            value.entries.removeValue(forKey: key)
                        }
                        value.recoveries[key] = recovery
                    } else {
                        entry.failures = 0
                    }
                } else {
                    entry.failures = 0
                }
            }
            return entry.retired && entry.active == 0 ? entry.session : nil
        }
        idle?.finishTasksAndInvalidate()
    }

    private static func isRecoverable(_ error: Error) -> Bool {
        guard let error = error as? URLError else { return false }
        switch error.code {
        case .networkConnectionLost, .timedOut, .cannotConnectToHost,
             .cannotFindHost, .dnsLookupFailed, .notConnectedToInternet:
            return true
        default:
            return false
        }
    }
}
