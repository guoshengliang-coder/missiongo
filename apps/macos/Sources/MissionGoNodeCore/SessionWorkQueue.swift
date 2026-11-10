import Foundation

/// One queued replacement per identity, FIFO across identities. Slow work does
/// not hold up polling or a different session; mutations still have one owner.
actor SessionWorkQueue {
    private let limit: Int
    private var order: [String] = []
    private var pending: [String: @Sendable () async -> Void] = [:]
    private var running = Set<String>()
    private var closing = false
    private var idle: [CheckedContinuation<Void, Never>] = []
    init(limit: Int = 4) { self.limit = max(1, limit) }
    func submit(_ id: String, work: @escaping @Sendable () async -> Void) {
        guard !closing else { return }
        if pending[id] == nil { order.append(id) }
        pending[id] = work
        drain()
    }
    private func drain() {
        while running.count < limit, let index = order.firstIndex(where: { !running.contains($0) }) {
            let id = order.remove(at: index)
            guard let work = pending.removeValue(forKey: id) else { continue }
            running.insert(id)
            Task { await work(); self.finished(id) }
        }
    }
    private func finished(_ id: String) {
        running.remove(id); drain()
        if running.isEmpty && pending.isEmpty { let waiters = idle; idle = []; for waiter in waiters { waiter.resume() } }
    }
    func finish() async {
        closing = true; pending = [:]; order = []
        if !running.isEmpty { await withCheckedContinuation { idle.append($0) } }
    }
}
