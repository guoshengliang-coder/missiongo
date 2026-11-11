/// Stops invalidate mirror reads already in flight. Uploads for one session are
/// ordered so a slow HTTP snapshot cannot arrive after a newer stop result.
/// Native reads themselves never hold the upload gate.
actor SessionSynchronization {
    private(set) var epoch = 0
    private var stoppedAt: [String: Int] = [:]
    private var stopping: [String: Int] = [:]
    private var uploading = Set<String>()
    private var waiters: [String: [CheckedContinuation<Void, Never>]] = [:]

    private var changedMirrors = Set<String>()
    func invalidateMirror(_ id: String) { changedMirrors.insert(id) }
    func consumeMirrorInvalidation(_ id: String) -> Bool { changedMirrors.remove(id) != nil }
    private var reservations = Set<String>()
    func reserved(_ key: String) -> Bool { reservations.contains(key) }
    func confirmReservation(_ key: String) { reservations.insert(key) }

    private var controlStates: [String: (epoch: Int, report: AgentSessionReport)] = [:]
    private var resultEpochs: [String: Int] = [:]
    @discardableResult
    func beginStop(_ id: String) -> Int {
        epoch += 1
        stoppedAt[id] = epoch
        stopping[id, default: 0] += 1
        return epoch
    }

    func endStop(_ id: String) {
        if let count = stopping[id], count > 1 { stopping[id] = count - 1 } else { stopping.removeValue(forKey: id) }
    }

    func isCurrent(_ id: String, epoch: Int) -> Bool {
        stopping[id] == nil && (stoppedAt[id] ?? 0) <= epoch
    }

    /// A cached command receipt keeps its original observation generation.
    /// It may acknowledge delivery after a stop, but cannot restore old state.
    func controlReport(_ report: AgentSessionReport, id: String, epoch: Int) -> AgentSessionReport {
        let key = report.commandId.map { id + ":" + $0 + ":" + (report.commandStatus ?? "") }
        let observed = key.flatMap { resultEpochs[$0] } ?? epoch
        if let key { resultEpochs[key] = observed }
        if let latest = controlStates[id], latest.epoch > observed {
            return AgentSessionReport(status: latest.report.status, messages: [], commandId: report.commandId,
                commandStatus: report.commandStatus, commandError: report.commandError,
                sourceArchived: report.sourceArchived, sourceArchiveError: report.sourceArchiveError, sourceRestored: report.sourceRestored,
                settingsRevision: report.settingsRevision, settingsError: report.settingsError,
                turnActive: latest.report.turnActive, waitingForInput: latest.report.waitingForInput,
                approvalRetryId: report.approvalRetryId, approvalRetryStatus: report.approvalRetryStatus,
                approvalRetryError: report.approvalRetryError)
        }
        controlStates[id] = (observed, report)
        return report
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
