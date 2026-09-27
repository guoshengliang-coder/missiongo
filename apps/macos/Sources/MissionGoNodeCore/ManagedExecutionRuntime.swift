import Foundation
import Darwin

/// Coordinator-private write-ahead journal. Never stored in the worker checkout.
/// An unacknowledged native side effect is reconciled, never retried as a launch.
actor ManagedExecutionRuntime {
    struct Entry: Codable {
        let job: ManagedExecutionJob
        var nextSequence = 1
        var phase: String
        var receipt: ManagedRuntimeReceipt?
        var pending: ManagedExecutionObservation?
        var terminalObservation: ManagedExecutionObservation?
        var terminalReceipt: ManagedTerminalObservationReceipt?
    }
    private let root: URL
    private var busy = Set<String>()
    init(root: URL) { self.root = root }
    private func file(_ id: String) throws -> URL {
        guard LaunchPrompt.dispatchIdPattern.matches(id), id.count <= 100 else { throw LaunchError("Invalid journal identity") }
        return root.appendingPathComponent(id + ".json")
    }
    private func read(_ id: String) throws -> Entry? {
        let url = try file(id)
        guard FileManager.default.fileExists(atPath: url.path) else { return nil }
        return try JSONDecoder().decode(Entry.self, from: Data(contentsOf: url))
    }
    private func save(_ entry: Entry) throws {
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        let url = try file(entry.job.intent.id)
        let temporary = root.appendingPathComponent(UUID().uuidString + ".tmp")
        let fd = open(temporary.path, O_WRONLY | O_CREAT | O_EXCL, 0o600)
        guard fd >= 0 else { throw CocoaError(.fileWriteUnknown) }
        defer { close(fd); unlink(temporary.path) }
        let bytes = try JSONEncoder().encode(entry)
        try bytes.withUnsafeBytes { buffer in
            var offset = 0
            while offset < buffer.count {
                let count = Darwin.write(fd, buffer.baseAddress!.advanced(by: offset), buffer.count - offset)
                if count < 0 && errno == EINTR { continue }
                guard count > 0 else { throw CocoaError(.fileWriteUnknown) }
                offset += count
            }
        }
        guard fsync(fd) == 0, rename(temporary.path, url.path) == 0 else { throw CocoaError(.fileWriteUnknown) }
        let directory = open(root.path, O_RDONLY)
        guard directory >= 0 else { throw CocoaError(.fileWriteUnknown) }
        defer { close(directory) }
        guard fsync(directory) == 0 else { throw CocoaError(.fileWriteUnknown) }
    }
    private func flush(_ entry: inout Entry, api: NodeAPI) async throws {
        guard let pending = entry.pending else { return }
        let acknowledgement = try await api.reportManaged(id: entry.job.intent.id, observation: pending)
        guard acknowledgement.accepted else { throw LaunchError("Managed observation was not accepted") }
        if let terminal = acknowledgement.terminal {
            guard terminal.state == "terminal", terminal.intentId == entry.job.intent.id,
                  terminal.generation == entry.job.intent.generation, terminal.generation == pending.generation,
                  terminal.sequence == pending.sequence, terminal.sessionRef == pending.sessionRef,
                  terminal.resolvedModel == pending.resolvedModel,
                  terminal.sessionRef == entry.receipt?.sessionRef, terminal.resolvedModel == entry.receipt?.resolvedModel else {
                throw LaunchError("Terminal observation receipt binding differs")
            }
            entry.phase = "terminal"
            entry.terminalObservation = pending
            entry.terminalReceipt = terminal
        }
        entry.nextSequence = pending.sequence + 1
        entry.pending = nil
        try save(entry)
    }
    func observe(_ binding: ManagedSessionBinding, state: String, sessionRef: String, model: String?, api: NodeAPI) async throws {
        guard !busy.contains(binding.id), var entry = try read(binding.id), ["running", "unknown"].contains(entry.phase) else { return }
        guard entry.job.intent.generation == binding.generation, entry.job.intent.stageId == binding.stageId,
              entry.receipt?.sessionRef == sessionRef else { throw LaunchError("Observation journal binding differs") }
        busy.insert(binding.id); defer { busy.remove(binding.id) }
        try await flush(&entry, api: api)
        guard entry.phase != "terminal" else { return }
        entry.pending = ManagedExecutionObservation(sequence: entry.nextSequence, generation: binding.generation, state: state,
            sessionRef: sessionRef, resolvedModel: model ?? entry.receipt?.resolvedModel)
        try save(entry)
        try await flush(&entry, api: api)
    }
    func resumeContext(_ binding: ManagedSessionBinding, sessionRef: String) throws -> ManagedResumeContext? {
        guard let entry = try read(binding.id), entry.phase == "running",
              entry.job.intent.generation == binding.generation, entry.job.intent.stageId == binding.stageId,
              entry.job.intent.binding.runId == binding.runId, entry.job.intent.binding.role == binding.role,
              entry.receipt?.sessionRef == sessionRef else { return nil }
        return try entry.receipt?.resumeContext()
    }
    // Replay only locally durable observations even when no task payload can be fetched.
    func flushObservations(api: NodeAPI, onError: (String, Error) -> Void = { _, _ in }) async throws {
        guard FileManager.default.fileExists(atPath: root.path) else { return }
        for file in try FileManager.default.contentsOfDirectory(at: root, includingPropertiesForKeys: nil) where file.pathExtension == "json" {
            let id = file.deletingPathExtension().lastPathComponent
            do {
                guard let entry = try read(id) else { continue }
                try await process(ManagedExecutionJob(intent: entry.job.intent, repoPath: entry.job.repoPath,
                    taskContext: entry.job.taskContext, enabled: false), api: api, adapter: nil)
            } catch { onError(id, error) } // Keep failed evidence durable; continue other intents.
        }
    }
    func process(_ job: ManagedExecutionJob, api: NodeAPI, adapter: AgentAdapter?) async throws {
        try job.validate()
        let intent = job.intent
        guard !busy.contains(intent.id) else { return }
        busy.insert(intent.id); defer { busy.remove(intent.id) }
        if var entry = try read(intent.id) {
            guard entry.job.intent.binding == intent.binding, entry.job.intent.generation == intent.generation,
                  entry.job.intent.stageId == intent.stageId else { throw LaunchError("Journal binding changed") }
            try await flush(&entry, api: api)
            if ["launching", "turnPermitPending", "turnStarting"].contains(entry.phase) {
                entry.phase = "unknown"
                entry.pending = ManagedExecutionObservation(sequence: entry.nextSequence, generation: intent.generation, state: "unknown",
                    sessionRef: entry.receipt?.sessionRef, resolvedModel: entry.receipt?.resolvedModel)
                try save(entry)
                try await flush(&entry, api: api)
            }
            if entry.phase == "bound" { try await firstTurn(&entry, job: job, api: api, adapter: adapter) }
            return
        }
        guard intent.ownershipHeld, intent.sessionId == nil, intent.state != "terminal" else { return }
        if ["starting", "bound", "turn_starting", "unknown"].contains(intent.state) {
            var entry = Entry(job: job, phase: "unknown", pending: ManagedExecutionObservation(
                sequence: 1, generation: intent.generation, state: "unknown", sessionRef: nil, resolvedModel: nil))
            try save(entry); try await flush(&entry, api: api)
            return
        }
        guard job.enabled, !intent.stopRequested, ["requested", "acknowledged"].contains(intent.state),
              let adapter, await adapter.dispatchAvailability() == .ready else { return }
        _ = try await api.claimManaged(id: intent.id, generation: intent.generation)
        let permit = try await api.permitManaged(id: intent.id, generation: intent.generation)
        guard permit.mayStart else { return }
        guard permit.intent.id == intent.id, permit.intent.stageId == intent.stageId,
              permit.intent.generation == intent.generation, permit.intent.binding == intent.binding else {
            throw LaunchError("Managed permission receipt changed binding.")
        }
        var entry = Entry(job: job, phase: "launching")
        try save(entry) // Durable before any worktree or native thread side effect.
        var state = "unknown"
        do {
            entry.receipt = try await adapter.launchManaged(ManagedExecutionJob(intent: permit.intent,
                repoPath: job.repoPath, taskContext: job.taskContext, enabled: job.enabled))
            state = "bound"
        } catch let uncertain as ManagedLaunchUncertain { entry.receipt = uncertain.receipt }
        catch { /* Permission was consumed. Never assume a failed transport means no side effect. */ }
        entry.phase = state
        entry.pending = ManagedExecutionObservation(sequence: entry.nextSequence, generation: intent.generation, state: state,
            sessionRef: entry.receipt?.sessionRef, resolvedModel: entry.receipt?.resolvedModel)
        try save(entry)
        try await flush(&entry, api: api)
        if entry.phase == "bound" { try await firstTurn(&entry, job: job, api: api, adapter: adapter) }
    }
    private func firstTurn(_ entry: inout Entry, job: ManagedExecutionJob, api: NodeAPI, adapter: AgentAdapter?) async throws {
        guard job.enabled, !job.intent.stopRequested, job.intent.ownershipHeld, let adapter,
              let receipt = entry.receipt, receipt.resolvedModel != nil else { return }
        entry.phase = "turnPermitPending"
        try save(entry)
        let permit = try await api.permitManaged(id: job.intent.id, generation: job.intent.generation)
        guard permit.mayStart, permit.intent.binding == entry.job.intent.binding,
              permit.intent.id == job.intent.id, permit.intent.generation == job.intent.generation,
              permit.intent.stageId == job.intent.stageId, !permit.intent.stopRequested else {
            throw LaunchError("First-turn permission was not confirmed; reconcile without retry.")
        }
        entry.phase = "turnStarting"
        try save(entry)
        do {
            try await adapter.startManagedTurn(ManagedExecutionJob(intent: permit.intent, repoPath: entry.job.repoPath,
                taskContext: entry.job.taskContext, enabled: job.enabled), receipt: receipt)
            entry.phase = "running"
        } catch { entry.phase = "unknown" }
        entry.pending = ManagedExecutionObservation(sequence: entry.nextSequence, generation: job.intent.generation,
            state: entry.phase, sessionRef: receipt.sessionRef, resolvedModel: receipt.resolvedModel)
        try save(entry)
        try await flush(&entry, api: api)
    }
}
