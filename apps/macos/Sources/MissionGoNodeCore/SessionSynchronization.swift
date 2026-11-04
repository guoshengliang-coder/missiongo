/// Stops invalidate mirror reads already in flight. Uploads for one session are
/// ordered so a slow HTTP snapshot cannot arrive after a newer stop result.
/// Native reads themselves never hold the upload gate.
actor SessionSynchronization {
    private(set) var epoch = 0
    private var stoppedAt: [String: Int] = [:]
    private var stopping = Set<String>()
    private var uploading = Set<String>()
    private var waiters: [String: [CheckedContinuation<Void, Never>]] = [:]

    func beginStop(_ id: String) {
        epoch += 1
        stoppedAt[id] = epoch
        stopping.insert(id)
    }

    func endStop(_ id: String) { stopping.remove(id) }

    func isCurrent(_ id: String, epoch: Int) -> Bool {
        !stopping.contains(id) && (stoppedAt[id] ?? 0) <= epoch
    }

    func acquireUpload(_ id: String) async {
        if uploading.insert(id).inserted { return }
        await withCheckedContinuation { waiters[id, default: []].append($0) }
    }

    func releaseUpload(_ id: String) {
        if var queued = waiters[id], !queued.isEmpty {
            let next = queued.removeFirst()
            waiters[id] = queued.isEmpty ? nil : queued
            next.resume()
        } else {
            uploading.remove(id)
        }
    }
}
