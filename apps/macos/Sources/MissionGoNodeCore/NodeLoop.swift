import CryptoKit
import Foundation

/// The protocol calls the loop makes, so a test can stand in for the server.
public protocol NodeAPI: Sendable {
    func reportPerformance(sessionId: String, batch: ConsolePerformanceBatch) async throws
    func releaseObservationJournalScope() throws -> String?
    func uploadReleaseObservation(productId: String, repoPath: String, observation: ReleaseObservation) async throws
    func managedJobs() async throws -> [ManagedExecutionJob]
    func claimManaged(id: String, generation: Int) async throws -> ManagedExecutionIntent
    func permitManaged(id: String, generation: Int) async throws -> ManagedExecutionPermit
    func reportManaged(id: String, observation: ManagedExecutionObservation) async throws -> ManagedObservationReceipt
    func heartbeat(agents: [DetectedAgent], repoCandidates: [RepoCandidate]) async throws -> HeartbeatReply
    func permitDispatchStart(dispatchId: String) async throws -> Bool
    func claimNext(waitMs: Int, availableAgentKinds: [String]?) async throws -> DispatchRequest?
    func reportResult(dispatchId: String, report: DispatchReport) async throws
    func waitForAgentControl(cursor: String?, waitMs: Int) async throws -> NodeControlChange?
    func listAgentSessions() async throws -> [NodeAgentSession]
    func listAgentInterrupts() async throws -> [NodeAgentSession]
    func historyJobs() async throws -> [AgentHistoryJob]
    func reportHistory(id: String, result: AgentHistoryResult) async throws
    func artifactJobs() async throws -> [AgentArtifactJob]
    func reportArtifact(id: String, result: AgentArtifactResult) async throws
    func downloadAgentSessionAttachment(sessionId: String, attachmentId: String) async throws -> Data
    func reportAgentSession(sessionId: String, report: AgentSessionReport) async throws
    func reportExternalAgentSession(sessionId: String, generation: Int, report: AgentSessionReport) async throws
    func reportAutomaticExternalSession(sessionId: String, generation: Int, nativeSessionRef: String, report: AgentSessionReport) async throws
}

public extension NodeAPI {
    func reportPerformance(sessionId: String, batch: ConsolePerformanceBatch) async throws {}
    func waitForAgentControl(cursor: String?, waitMs: Int) async throws -> NodeControlChange? { nil }
    func permitDispatchStart(dispatchId: String) async throws -> Bool { true }
    func historyJobs() async throws -> [AgentHistoryJob] { [] }
    func reportHistory(id: String, result: AgentHistoryResult) async throws {}
    func artifactJobs() async throws -> [AgentArtifactJob] { [] }
    func reportArtifact(id: String, result: AgentArtifactResult) async throws {}
    func releaseObservationJournalScope() throws -> String? { nil }
    func uploadReleaseObservation(productId: String, repoPath: String, observation: ReleaseObservation) async throws { throw LaunchError("Release upload unsupported") }
    func managedJobs() async throws -> [ManagedExecutionJob] { [] }
    func claimManaged(id: String, generation: Int) async throws -> ManagedExecutionIntent { throw LaunchError("Managed API unsupported") }
    func permitManaged(id: String, generation: Int) async throws -> ManagedExecutionPermit { throw LaunchError("Managed API unsupported") }
    func reportManaged(id: String, observation: ManagedExecutionObservation) async throws -> ManagedObservationReceipt { throw LaunchError("Managed API unsupported") }
    func listAgentSessions() async throws -> [NodeAgentSession] { [] }
    func listAgentInterrupts() async throws -> [NodeAgentSession] {
        try await listAgentSessions().filter { $0.agentKind == "codex" && $0.managedExecution == nil && $0.command?.kind == "interrupt" }
    }
    func downloadAgentSessionAttachment(sessionId: String, attachmentId: String) async throws -> Data {
        throw CocoaError(.fileNoSuchFile)
    }
    func reportAgentSession(sessionId: String, report: AgentSessionReport) async throws {}
    func reportExternalAgentSession(sessionId: String, generation: Int, report: AgentSessionReport) async throws {
        throw LaunchError("External native sessions require an updated node API.")
    }
    func reportAutomaticExternalSession(sessionId: String, generation: Int, nativeSessionRef: String, report: AgentSessionReport) async throws {
        throw LaunchError("Automatic external sessions require an updated node API.")
    }
}

extension APIClient: NodeAPI {}

/// What the menu bar shows about the loop.
public struct NodeLoopState: Equatable, Sendable {
    public enum Connection: Equatable, Sendable {
        /// Started, nothing has answered yet.
        case connecting
        /// Requests are succeeding, with no outstanding operation errors.
        case online
        /// Some requests reach the server, but an operation has not recovered.
        case degraded
        /// Network failures with no recent server response; keeps trying.
        case offline
        /// The credential was refused. Terminal: the app has to log in again.
        /// Carries the problem code when the server sent one, so "revoked in
        /// the console" and "replaced by a newer sign-in" can be told apart
        /// wherever the state is presented (AND-291).
        case credentialRevoked(code: String?)
        case stopped
    }

    public var connection: Connection = .connecting
    public var lastError: String?
    /// Cleared only by recovery of the operation that failed.
    public var requestErrors: [String: String] = [:]
    /// Recent successful traffic distinguishes a failed operation from a
    /// server-wide outage; errors remain until their own operation recovers.
    var lastServerResponseAt: Date?
    var unreachableOperations: Set<String> = []
    public var lastHeartbeatAt: Date?
    public var agents: [DetectedAgent] = []
    public var repos: [RepoMapping] = []
    /// The products this machine can be given a repository for. Carried by the
    /// heartbeat so a product created in the console reaches the menu without
    /// the client being restarted. nil means no server has said yet — an empty
    /// array is a real answer and means there are none.
    public var products: [NodeProfile.Product]?
    /// The Skill version the server will require when the next dispatch starts.
    /// nil keeps compatibility with a server from before heartbeat sync.
    public var expectedSkillVersion: String?
    /// Most recent first, capped at `NodeLoop.recentLaunchLimit`.
    public var recentLaunches: [LocalLaunch] = []

    public init() {}
}

/// One dispatch this machine picked up, as it looked from here.
public struct LocalLaunch: Equatable, Sendable, Identifiable {
    public var id: String { dispatchId }
    public let dispatchId: String
    public let itemKeys: [String]
    public let agentKind: String
    public let mode: String
    public let repoPath: String
    public let startedAt: Date
    public let report: DispatchReport
    public let logPath: String?
    /// False when the server did not acknowledge the result, after every retry.
    public let reported: Bool
    public var resultReportError: String? = nil
}

/// Stops the loops the way an `AbortSignal` did: sleeps end early, but a request
/// or a launch already under way is left to finish.
final class StopSignal: @unchecked Sendable {
    private let state = Locked<(stopped: Bool, generation: Int, sleepers: [UUID: CheckedContinuation<Void, Never>])>((false, 0, [:]))

    var isStopped: Bool {
        return state.current.stopped
    }

    var generation: Int { state.current.generation }

    func stop() {
        let sleepers = state.withLock { value -> [CheckedContinuation<Void, Never>] in
            value.stopped = true
            defer { value.sleepers = [:] }
            return Array(value.sleepers.values)
        }
        sleepers.forEach { $0.resume() }
    }

    /// Resumes every sleeper without stopping: the loops run their next round
    /// at once instead of waiting out the interval. This is the reconnect
    /// button (AND-177) — a person should not wait out the heartbeat interval
    /// to learn whether the network came back. Safe when nothing sleeps, and a
    /// no-op once the loop has stopped.
    func wake() {
        let sleepers = state.withLock { value -> [CheckedContinuation<Void, Never>] in
            guard !value.stopped else { return [] }
            value.generation += 1
            defer { value.sleepers = [:] }
            return Array(value.sleepers.values)
        }
        sleepers.forEach { $0.resume() }
    }

    /// A reconnect during an in-flight request must also skip the next sleep.
    /// Each loop supplies the generation it observed before starting its work.
    func sleep(_ seconds: TimeInterval, unlessWokenSince generation: Int? = nil) async {
        let id = UUID()
        await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
            let stopped = state.withLock { value -> Bool in
                if value.stopped || generation.map({ $0 != value.generation }) == true { return true }
                value.sleepers[id] = continuation
                return false
            }
            if stopped { return continuation.resume() }
            DispatchQueue.global().asyncAfter(deadline: .now() + seconds) { [weak self] in
                let pending = self?.state.withLock { $0.sleepers.removeValue(forKey: id) }
                pending?.resume()
            }
        }
    }
}

/// The client loop: check in, ask for work, start a session, say what happened.
///
/// Both loops keep running through failures. A developer machine sleeps,
/// changes network and loses VPN routes all day long; a loop that stopped on
/// the first failed request would be down long before anyone noticed, and the
/// console would only show the machine as offline hours later.
public final class NodeLoop: @unchecked Sendable {
    public typealias SkillReadiness = @Sendable (_ agentKind: String, _ expectedVersion: String?) async -> AgentSkillSnapshot
    public struct Timing: Sendable {
        public var heartbeatInterval: TimeInterval = 30
        /// How long the server is asked to hold a poll open. Work is handed over
        /// the moment it is queued; this only bounds how long an idle connection lives.
        public var claimWaitMs: Int = APIClient.defaultClaimWaitMs
        /// Only used between polls that came back empty or failed, so a server
        /// answering instantly cannot spin the loop. Short on purpose: it is the one
        /// window in which the machine is not listening, and a dispatch created
        /// inside it waits this long — measured at 813ms of the delay when this was
        /// a full second.
        public var claimInterval: TimeInterval = 0.25
        /// Failed polls back off instead of making four failing requests a second.
        public var claimFailureInterval: TimeInterval = 3
        /// A locally unavailable agent cannot become claimable because the
        /// server answered. Probe slowly instead of spawning a health command
        /// four times a second while every adapter is paused.
        public var agentUnavailableInterval: TimeInterval = 5
        /// Mirrored agent conversations are snapshots, not an event stream. This is
        /// short enough for a reply to feel immediate. Codex approvals use a
        /// separate persistent observer to answer on the request's socket.
        public var sessionInterval: TimeInterval = 2
        /// Detection starts a process, which is wasteful every 30 seconds, but a CLI
        /// upgrade should still show up in the console without restarting the app.
        public var agentDetectTTL: TimeInterval = 5 * 60
        /// The server marked the dispatch as delivered before it reached us, so a
        /// result that never arrives leaves it delivered forever. Worth a few retries.
        public var resultReportAttempts = 5
        public var resultRetryDelay: TimeInterval = 3

        public init() {}
    }

    public static let recentLaunchLimit = 20
    public static let maximumExecutingSessions = 10

    private let sessionHealth = SessionHealthTracker()
    private let performanceObserver = ConsolePerformanceObserver()
    private let performanceUploader = ConsolePerformanceUploader()
    let managedRuntime: ManagedExecutionRuntime
    let managedExecutionEnabled: Bool
    let api: NodeAPI
    let adapters: [AgentAdapter]
    /// The name sessions carry when the server does not say (one from before
    /// nicknames). Such a server has no nickname to offer, so the name stored at
    /// login is exactly what it would have sent.
    let fallbackNodeName: String
    let detectRepoCandidates: @Sendable () -> [RepoCandidate]
    let timing: Timing
    let log: @Sendable (String) -> Void
    let onState: @Sendable (NodeLoopState) -> Void
    let skillReadiness: SkillReadiness?
    let attachmentCacheRoot: URL
    let authorizationNotifier: AuthorizationNoticing

    private let state = Locked(NodeLoopState())
    private let stateContinuation: AsyncStream<NodeLoopState>.Continuation
    /// Every state change, starting with the current one. Also delivered to
    /// `onState`; use whichever suits the caller.
    public let states: AsyncStream<NodeLoopState>
    /// The signal the running loops sleep on. Held as an instance property so
    /// `retryNow()` can wake them; created once because `run()` runs once.
    private let stopSignal = StopSignal()
    private let sessionSynchronization = SessionSynchronization()
    private let separatedControl = Locked(false)
    private let controlCursor = Locked<String?>(nil)

    private let agentCache = Locked<(agents: [DetectedAgent], at: Date)?>(nil)
    private let unconfirmedDetections = Locked<Set<String>>([])
    private let lastReposFingerprint = Locked<[RepoMapping]?>(nil)
    /// The account's live AI authorizations from the latest heartbeat (AND-306),
    /// used to judge a `mgpat_` token found in an agent config: the node hashes
    /// it locally and matches the digest. One heartbeat old at most.
    private let knownAuthorizations = Locked<[AiAuthorizationEntry]?>(nil)
    private struct CapacityState {
        var sessions: [NodeAgentSession] = []
        var reservations: [String: Date] = [:]
    }
    private let capacity = Locked(CapacityState())
    private let unavailableAgents = Locked<[String: String]>([:])
    private let skillReadyAgents = Locked<Set<String>>([])

    public init(
        api: NodeAPI,
        managedExecutionEnabled: Bool = false,
        adapters: [AgentAdapter],
        fallbackNodeName: String,
        detectRepoCandidates: @escaping @Sendable () -> [RepoCandidate] = { [] },
        timing: Timing = Timing(),
        skillReadiness: SkillReadiness? = nil,
        attachmentCacheRoot: URL? = nil,
        log: @escaping @Sendable (String) -> Void = { NSLog("%@", $0) },
        authorizationNotifier: AuthorizationNoticing = SystemAuthorizationNotifier(),
        onState: @escaping @Sendable (NodeLoopState) -> Void = { _ in }
    ) {
        self.managedRuntime = ManagedExecutionRuntime(root: (attachmentCacheRoot ?? FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/Application Support/MissionGo", isDirectory: true))
            .appendingPathComponent("ManagedExecutionRuntime", isDirectory: true))
        self.managedExecutionEnabled = managedExecutionEnabled
        self.api = api
        self.adapters = adapters
        self.fallbackNodeName = fallbackNodeName
        self.detectRepoCandidates = detectRepoCandidates
        self.timing = timing
        self.skillReadiness = skillReadiness
        self.attachmentCacheRoot = attachmentCacheRoot ?? FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/Application Support/MissionGo/ChatAttachments", isDirectory: true)
        self.log = log
        self.authorizationNotifier = authorizationNotifier
        self.onState = onState
        let (stream, continuation) = AsyncStream.makeStream(of: NodeLoopState.self, bufferingPolicy: .bufferingNewest(1))
        states = stream
        stateContinuation = continuation
        continuation.yield(NodeLoopState())
    }

    public var currentState: NodeLoopState {
        return state.current
    }

    /// Runs both loops' next round now instead of waiting out their intervals
    /// (AND-177). A heartbeat or claim already under way is left to finish;
    /// a loop that has ended ignores this.
    public func retryNow() {
        stopSignal.wake()
    }

    /// Runs both loops until the calling task is cancelled or the credential is
    /// refused, in which case it throws `APIError.credentialRevoked`.
    ///
    /// Cancelling ends the sleeps at once, but a long poll, a launch or a result
    /// report already under way finishes first: a dispatch the server handed over
    /// has to be started and reported, or it stays "delivered" forever. So a
    /// cancelled run can take up to one long poll (about 25s) to return.
    ///
    /// A loop runs once: `states` finishes when `run()` returns, so logging in
    /// again means creating a new `NodeLoop` with the new credential.
    public func run() async throws {
        let stop = stopSignal
        let fatal = Locked<APIError?>(nil)
        update { $0.connection = .connecting }

        // Negotiate before starting mirrors: no combined request may race the
        // new control lane during the first connection.
        do {
            if let change = try await api.waitForAgentControl(cursor: nil, waitMs: 0) {
                separatedControl.withLock { $0 = true }; controlCursor.withLock { $0 = change.cursor }
            }
        } catch { handle(error, what: "等待节点控制请求出错", stop: stop, fatal: fatal) }
        await withTaskCancellationHandler {
            async let heartbeat: Void = heartbeatLoop(stop: stop, fatal: fatal)
            async let claim: Void = claimLoop(stop: stop, fatal: fatal)
            async let sessions: Void = sessionLoop(stop: stop, fatal: fatal)
            async let interrupts: Void = interruptLoop(stop: stop, fatal: fatal)
            async let controls: Void = controlLoop(stop: stop, fatal: fatal)
            async let managed: Void = managedLoop(stop: stop)
            async let artifacts: Void = artifactLoop(stop: stop)
            async let history: Void = historyLoop(stop: stop)
            async let releases: Void = releaseObservationLoop(stop: stop)
            _ = await (heartbeat, claim, sessions, interrupts, controls, managed, artifacts, history, releases)
        } onCancel: {
            stop.stop()
        }

        if let error = fatal.current {
            update { $0.connection = .credentialRevoked(code: Self.revokedCode(of: error)) }
            stateContinuation.finish()
            throw error
        }
        update { $0.connection = .stopped }
        stateContinuation.finish()
    }

    // MARK: Loops

    /// Historical reads have their own lane; they cannot hold up input or stops.
    private func historyLoop(stop: StopSignal) async {
        while !stop.isStopped {
            let generation = stop.generation
            do {
                for job in try await api.historyJobs() {
                    let result: AgentHistoryResult
                    do {
                        guard let adapter = adapters.first(where: { $0.kind == job.agentKind }) else {
                            throw AgentArtifactError.unsupported
                        }
                        result = try await adapter.historyPage(sessionRef: job.sessionRef, cursor: job.cursor)
                    } catch { result = AgentHistoryResult(error: "node_unavailable") }
                    try await api.reportHistory(id: job.id, result: result)
                }
            } catch { log("读取旧会话历史未完成，稍后重试。") }
            await stop.sleep(timing.sessionInterval, unlessWokenSince: generation)
        }
    }

    private func artifactLoop(stop: StopSignal) async {
        while !stop.isStopped {
            let generation = stop.generation
            do {
                for job in try await api.artifactJobs() {
                    let result: AgentArtifactResult
                    do {
                        guard let adapter = adapters.first(where: { $0.kind == job.agentKind }) else { throw AgentArtifactError.nodeUnavailable }
                        let messages = try await adapter.artifactMessages(sessionRef: job.sessionRef, sourceId: job.sourceId)
                        result = AgentArtifactResult(bundle: try AgentArtifactReader.read(job: job, messages: messages))
                    } catch {
                        let failure = error as? AgentArtifactFailure
                        result = AgentArtifactResult(error: failure?.code.rawValue ?? (error as? AgentArtifactError)?.rawValue ?? "node_unavailable",
                            errorResource: job.diagnosticsProtocol == 1 ? failure?.resource : nil)
                    }
                    try await api.reportArtifact(id: job.id, result: result)
                }
            } catch { log("读取会话产物未完成：\(error.localizedDescription)") }
            await stop.sleep(timing.sessionInterval, unlessWokenSince: generation)
        }
    }

    private func releaseObservationLoop(stop: StopSignal) async {
        guard let scope = try? api.releaseObservationJournalScope() else { return }
        let worker = ReleaseObservationWorker(root: attachmentCacheRoot.deletingLastPathComponent()
            .appendingPathComponent("ReleaseDeliveryOutbox").appendingPathComponent(scope))
        while !stop.isStopped {
            let generation = stop.generation
            do { try await worker.tick(api: api, mappedRepos: currentState.repos) }
            catch { log("发布凭据上传队列暂不可用，稍后重试。") }
            await stop.sleep(timing.heartbeatInterval, unlessWokenSince: generation)
        }
    }

    private func heartbeatLoop(stop: StopSignal, fatal: Locked<APIError?>) async {
        while !stop.isStopped {
            let wakeGeneration = stop.generation
            await shielded {
                do {
                    let detectedAgents = await self.detectAgents()
                    var agents = await self.heartbeatAgents(
                        detectedAgents,
                        expectedSkillVersion: self.currentState.expectedSkillVersion,
                        authorizations: self.knownAuthorizations.current
                    )
                    // The app supplies an in-memory list of mapped repositories.
                    // Heartbeats must not probe historical project directories.
                    let candidates = self.detectRepoCandidates()
                    var beat = try await self.api.heartbeat(agents: agents, repoCandidates: candidates)
                    // The first response after a server upgrade carries the new
                    // required version. Synchronize inside the loop and publish
                    // the corrected readiness immediately, rather than leaving a
                    // 30-second window in which claimLoop can take stale work.
                    if beat.expectedSkillVersion != self.currentState.expectedSkillVersion {
                        agents = await self.heartbeatAgents(
                            detectedAgents,
                            expectedSkillVersion: beat.expectedSkillVersion,
                            authorizations: beat.authorizations ?? self.knownAuthorizations.current
                        )
                        beat = try await self.api.heartbeat(agents: agents, repoCandidates: candidates)
                    }
                    // AND-306: remember the account's live authorizations for the
                    // next round's token judgment — one heartbeat old at most.
                    if let authorizations = beat.authorizations {
                        self.knownAuthorizations.withLock { $0 = authorizations }
                    }
                    self.noteReposChanged(beat.repos)
                    self.noteSuccess("上报心跳出错")
                    self.update {
                        $0.lastHeartbeatAt = Date()
                        $0.agents = agents
                        $0.repos = beat.repos
                        // A server from before this field keeps the list it had:
                        // an older server must not empty the repository menu.
                        if let products = beat.products { $0.products = products }
                        if let expected = beat.expectedSkillVersion { $0.expectedSkillVersion = expected }
                    }
                } catch {
                    self.handle(error, what: "上报心跳出错", stop: stop, fatal: fatal)
                }
            }
            await stop.sleep(timing.heartbeatInterval, unlessWokenSince: wakeGeneration)
        }
    }

    private func managedLoop(stop: StopSignal) async {
        while !stop.isStopped {
            let wakeGeneration = stop.generation
            do {
                try await managedRuntime.flushObservations(api: api, onError: { id, error in
                    log("Managed observation \(id): \(error.localizedDescription)")
                })
            } catch { log("Managed journal: \(error.localizedDescription)") }
            do {
                let jobs = try await api.managedJobs()
                for job in jobs {
                    do {
                        try await managedRuntime.process(ManagedExecutionJob(intent: job.intent, repoPath: job.repoPath,
                            taskContext: job.taskContext, enabled: job.enabled && managedExecutionEnabled),
                            api: api, adapter: adapters.first(where: { $0.kind == "codex" }))
                    } catch { log("Managed intent \(job.intent.id): \(error.localizedDescription)") }
                }
            } catch { log("Managed control: \(error.localizedDescription)") }
            await stop.sleep(timing.sessionInterval, unlessWokenSince: wakeGeneration)
        }
    }

    private func claimLoop(stop: StopSignal, fatal: Locked<APIError?>) async {
        let failures = Locked(0)
        while !stop.isStopped {
            let wakeGeneration = stop.generation
            guard hasExecutionCapacity() else {
                await stop.sleep(timing.claimInterval, unlessWokenSince: wakeGeneration)
                continue
            }
            let availableAgentKinds = await availableAgentKinds()
            guard !availableAgentKinds.isEmpty else {
                await stop.sleep(timing.agentUnavailableInterval, unlessWokenSince: wakeGeneration)
                continue
            }
            await shielded {
                do {
                    if let request = try await self.api.claimNext(
                        waitMs: self.timing.claimWaitMs,
                        availableAgentKinds: availableAgentKinds
                    ) {
                        self.capacity.withLock { $0.reservations[request.dispatchId] = Date() }
                        failures.withLock { $0 = 0 }
                        self.noteSuccess("拉取派单出错")
                        let startedAt = Date()
                        let (report, logPath) = await self.launchDispatch(request)
                        if report.status != .launched {
                            _ = self.capacity.withLock { $0.reservations.removeValue(forKey: request.dispatchId) }
                        }
                        let record = { (result: (reported: Bool, error: String?)) in
                            self.recordLaunch(LocalLaunch(
                                dispatchId: request.dispatchId, itemKeys: request.itemKeys,
                                agentKind: request.agentKind, mode: request.mode,
                                repoPath: request.repoPath, startedAt: startedAt, report: report,
                                logPath: logPath, reported: result.reported, resultReportError: result.error
                            ))
                        }
                        do {
                            record(try await self.reportWithRetry(request.dispatchId, report, stop: stop))
                        } catch {
                            // The session may be running even though the credential is
                            // gone; the menu should still show it and its link.
                            record((false, error.localizedDescription))
                            throw error
                        }
                    } else {
                        failures.withLock { $0 = 0 }
                        self.noteSuccess("拉取派单出错")
                    }
                } catch {
                    failures.withLock { $0 = min($0 + 1, 5) }
                    self.handle(error, what: "拉取派单出错", stop: stop, fatal: fatal)
                }
            }
            let count = failures.current
            let delay = count == 0 ? timing.claimInterval
                : min(30, timing.claimFailureInterval * pow(2, Double(count - 1)))
            await stop.sleep(delay, unlessWokenSince: wakeGeneration)
        }
    }

    private func sessionLoop(stop: StopSignal, fatal: Locked<APIError?>) async {
        let queue = SessionWorkQueue()
        /// Reports the server has already accepted, by session id (AND-182). A
        /// mirrored transcript re-reads unchanged for most of a long tool call,
        /// and re-uploading it whole every poll was most of the node's traffic.
        /// The fingerprint covers the entire encoded report, so anything the
        /// server reads — status, a delivered reply's command status, settings
        /// revisions — still goes out the moment it changes. It is recorded only
        /// after a report succeeded, so a failed upload is retried.
        ///
        /// Fingerprints of sessions that left the list are kept on purpose. The
        /// server hands an idle session back roughly every 30 seconds (its
        /// cool-down line), and dropping the fingerprint in between turned that
        /// return into a guaranteed re-upload — measured on production as the
        /// last 30-second re-send loop after AND-182 shipped. A retired entry
        /// costs a session id plus 32 bytes until the app restarts, and the
        /// list itself is capped at a hundred sessions per node.
        let reported = Locked<[String: Data]>([:])
        // Re-send an unacknowledged result report, never the Codex command
        // itself. A lost snapshot HTTP response must not start another turn.
        let awaitingReport = Locked<[String: (commandId: String, report: AgentSessionReport)]>([:])
        // A malformed snapshot must not starve every session behind it in the
        // server's ordered list. Retry deterministic client errors less often.
        let rejectedUntil = Locked<[String: Date]>([:])
        while !stop.isStopped {
            let wakeGeneration = stop.generation
            await shielded {
                do {
                    let mirrorEpoch = await self.sessionSynchronization.epoch
                    let sessions = try await self.api.listAgentSessions()
                    self.noteSuccess("同步 Agent 会话出错")
                    self.reconcileCapacity(sessions)
                    let live = Set(sessions.map(\.id))
                    self.update { value in
                        let current = Set(sessions.map { "同步 Agent 会话 \($0.id) 出错" })
                        for key in value.requestErrors.keys where key.hasPrefix("同步 Agent 会话 ") && !current.contains(key) {
                            value.requestErrors.removeValue(forKey: key)
                            value.unreachableOperations.remove(key)
                        }
                        Self.refreshConnection(&value)
                    }
                    awaitingReport.withLock { value in value = value.filter { live.contains($0.key) } }
                    for original in sessions {
                        if !self.separatedControl.current && original.agentKind == "codex" && original.managedExecution == nil && original.command?.kind == "interrupt" { continue }
                        let session = self.separatedControl.current ? original.forSync(.observation) : original
                        await queue.submit(session.id) {
                            await self.synchronizeOne(session, reported: reported, awaitingReport: awaitingReport,
                                rejectedUntil: rejectedUntil, stop: stop, fatal: fatal, mirrorEpoch: mirrorEpoch)
                        }
                    }
                } catch {
                    self.handle(error, what: "同步 Agent 会话出错", stop: stop, fatal: fatal)
                }
            }
            await stop.sleep(timing.sessionInterval, unlessWokenSince: wakeGeneration)
        }
        await queue.finish()
    }

    private func controlLoop(stop: StopSignal, fatal: Locked<APIError?>) async {
        guard separatedControl.current else { return }
        let queue = SessionWorkQueue()
        let stops = SessionWorkQueue()
        let reported = Locked<[String: Data]>([:])
        let awaiting = Locked<[String: (commandId: String, report: AgentSessionReport)]>([:])
        let rejected = Locked<[String: Date]>([:])
        var first = true
        var modern = true
        while !stop.isStopped {
            do {
                if !first {
                    guard let change = try await api.waitForAgentControl(cursor: controlCursor.current, waitMs: 25000) else {
                        // A rolling downgrade cannot race combined side effects.
                        // Continue the separated lanes with the legacy cadence.
                        await stop.sleep(timing.sessionInterval)
                        first = true
                        modern = false
                        continue
                    }
                    modern = true
                    controlCursor.withLock { $0 = change.cursor }
                }
                first = false
                let sessions = try await api.listAgentSessions()
                noteSuccess("等待节点控制请求出错")
                for session in sessions where session.hasControlWork {
                    let control = session.forSync(modern ? .control : .combined)
                    let lane = session.command?.kind == "interrupt" && session.managedExecution == nil ? stops : queue
                    await lane.submit(session.id) {
                        guard !stop.isStopped else { return }
                        let controlEpoch = await self.sessionSynchronization.beginStop(session.id)
                        await self.synchronizeOne(control, reported: reported, awaitingReport: awaiting,
                            rejectedUntil: rejected, stop: stop, fatal: fatal, serializeUpload: true, controlEpoch: controlEpoch)
                        await self.sessionSynchronization.endStop(session.id)
                    }
                }
            } catch {
                handle(error, what: "等待节点控制请求出错", stop: stop, fatal: fatal)
                await stop.sleep(timing.sessionInterval)
            }
        }
        await queue.finish()
        await stops.finish()
    }

    /// Poll independently of transcript reads, including a read already in flight.
    /// Keep the legacy ordinary path for other adapters and managed stop ownership.
    private func interruptLoop(stop: StopSignal, fatal: Locked<APIError?>) async {
        guard !separatedControl.current else { return }
        let reported = Locked<[String: Data]>([:])
        let awaitingReport = Locked<[String: (commandId: String, report: AgentSessionReport)]>([:])
        let rejectedUntil = Locked<[String: Date]>([:])
        while !stop.isStopped {
            let wakeGeneration = stop.generation
            await shielded {
                do {
                    let sessions = try await self.api.listAgentInterrupts()
                    self.noteSuccess("投递停止请求出错")
                    await withTaskGroup(of: Void.self) { group in
                        for session in sessions where session.agentKind == "codex" && session.managedExecution == nil && session.command?.kind == "interrupt" {
                            group.addTask {
                                await self.sessionSynchronization.beginStop(session.id)
                                // Serialize only uploads, never wait for a slow mirror read.
                                await self.sessionSynchronization.acquireUpload(session.id)
                                do {
                                    if session.command?.status == "queued", awaitingReport.current[session.id]?.commandId != session.command?.id {
                                        // Reserve before the side effect. Expired/cancelled requests cannot execute.
                                        try await self.api.reportAgentSession(sessionId: session.id,
                                            report: AgentSessionReport(status: session.status, messages: [],
                                                commandId: session.command?.id, commandStatus: "delivering"))
                                    }
                                    await self.synchronizeOne(session, reported: reported, awaitingReport: awaitingReport,
                                        rejectedUntil: rejectedUntil, stop: stop, fatal: fatal)
                                } catch {
                                    self.handle(error, what: "投递停止请求出错", stop: stop, fatal: fatal)
                                }
                                await self.sessionSynchronization.releaseUpload(session.id)
                                await self.sessionSynchronization.endStop(session.id)
                            }
                        }
                    }
                } catch {
                    self.handle(error, what: "投递停止请求出错", stop: stop, fatal: fatal)
                }
            }
            await stop.sleep(timing.sessionInterval, unlessWokenSince: wakeGeneration)
        }
    }

    /// Synchronizes one session and uploads its report through the loop's
    /// fingerprint and retry discipline. Each lane serializes a session identity.
    private func synchronizeOne(
        _ session: NodeAgentSession,
        reported: Locked<[String: Data]>,
        awaitingReport: Locked<[String: (commandId: String, report: AgentSessionReport)]>,
        rejectedUntil: Locked<[String: Date]>,
        stop: StopSignal,
        fatal: Locked<APIError?>,
        mirrorEpoch: Int? = nil,
        serializeUpload: Bool = false,
        controlEpoch: Int? = nil
    ) async {
        if let mirrorEpoch, !(await sessionSynchronization.isCurrent(session.id, epoch: mirrorEpoch)) { return }
        var session = session
        if var binding = session.managedExecution {
            if !managedExecutionEnabled {
                binding = ManagedSessionBinding(state: binding.state, id: binding.id, runId: binding.runId,
                    stageId: binding.stageId, generation: binding.generation, role: binding.role, stopRequested: true)
            } else {
                binding.resumeContext = try? await managedRuntime.resumeContext(binding, sessionRef: session.sessionRef)
            }
            let purpose = session.syncPurpose
            session = NodeAgentSession(id: session.id, managedExecution: binding, dispatchId: session.dispatchId,
                agentKind: session.agentKind, sessionRef: session.sessionRef, status: session.status,
                lifecycle: session.lifecycle, occupiesExecutionSlot: session.occupiesExecutionSlot,
                command: binding.stopRequested ? nil : session.command)
            session.syncPurpose = purpose
        }
        let reservationScope = session.externalBindingGeneration.map { "\(session.id):external:\($0)" } ?? session.id
        if let command = session.command, command.status == "queued",
           await sessionSynchronization.reserved(reservationScope + ":command:" + command.id) { return }
        if let retry = session.approvalRetry, retry.status == "queued",
           await sessionSynchronization.reserved(reservationScope + ":retry:" + retry.id) { return }
        if let deadline = rejectedUntil.current[session.id], deadline > Date(), session.command?.kind != "interrupt" { return }
        guard let adapter = self.adapters.first(where: { $0.kind == session.agentKind }) else {
            // The integration was turned off on this Mac (or the app no longer
            // ships it). Skipping the session left its server-side status
            // frozen at the last value an adapter reported — active forever,
            // holding one of the node's execution slots (AND-221). Report it
            // unavailable instead; a re-enabled adapter's next poll overwrites
            // this with the real state.
            let report = AgentSessionReport(
                status: "unavailable", messages: [],
                error: "本机已停用 \(session.agentKind) 集成，会话暂不同步；重新启用后会自动恢复。",
                commandId: session.command?.kind == "interrupt" ? session.command?.id : nil,
                commandStatus: session.command?.kind == "interrupt" ? "failed" : nil,
                commandError: session.command?.kind == "interrupt" ? "停止尚未确认：本机已停用集成，请在来源客户端核实。" : nil
            )
            await self.uploadAgentSessionReport(
                report, for: session, reported: reported, awaitingReport: awaitingReport,
                rejectedUntil: rejectedUntil, stop: stop, fatal: fatal
            )
            return
        }
        performanceObserver.begin(session)
        var report: AgentSessionReport
        if let waiting = awaitingReport.current[session.id],
           session.command?.id == waiting.commandId,
           (session.command?.status == "delivering" || session.command?.kind == "interrupt") {
            report = waiting.report
        } else {
            _ = awaitingReport.withLock { $0.removeValue(forKey: session.id) }
            do {
                var prepared = try await self.prepareAttachments(session)
                prepared.syncPurpose = session.syncPurpose
                do {
                    let sourceReport = try await adapter.synchronize(prepared)
                    // A failed observation is not evidence of source progress.
                    if let command = session.command, command.kind == "interrupt", sourceReport.commandId == nil {
                        report = AgentSessionReport(status: sourceReport.status, messages: sourceReport.messages,
                            error: sourceReport.error, commandId: command.id, commandStatus: "failed",
                            commandError: "停止尚未确认：\(sourceReport.error ?? "节点未能执行停止请求，请在来源客户端核实。")")
                    } else {
                        report = sourceReport
                    }
                } catch {
                    // After the command reached Codex, a transport
                    // error cannot prove whether turn/start took it.
                    let uncertain = session.agentKind == "codex"
                        && session.command?.status == "delivering"
                        && (session.command?.kind ?? "message") == "message"
                    if let command = session.command, session.agentKind == "codex", command.kind == "interrupt" {
                        report = AgentSessionReport(status: "unavailable", messages: [],
                            error: CodexSessionFailure.redact(error.localizedDescription), commandId: command.id,
                            commandStatus: "failed", commandError: "终止尚未确认：无法同步原 Codex 会话，请在来源客户端核实。")
                    } else if let command = session.command, command.status == "delivering",
                       command.attachments?.isEmpty == false, !uncertain {
                        report = AgentSessionReport(
                            status: session.status, messages: [], commandId: command.id,
                            commandStatus: "failed", commandError: "附件未能交付：\(error.localizedDescription)"
                        )
                    } else {
                        report = AgentSessionReport(
                            status: "unavailable", messages: [], error: error.localizedDescription,
                            commandId: uncertain ? session.command?.id : nil,
                            commandStatus: uncertain ? "delivery_unknown" : nil,
                            commandError: uncertain
                                ? "无法确认 Codex 是否收到回复，请在 Codex 会话核实后手动确认；不会自动重发。"
                                : nil
                        )
                    }
                }
            } catch {
                if let command = session.command, command.status == "delivering",
                   command.attachments?.isEmpty == false {
                    report = AgentSessionReport(
                        status: session.status, messages: [], commandId: command.id,
                        commandStatus: "failed", commandError: "附件未能下载：\(error.localizedDescription)"
                    )
                } else {
                    report = AgentSessionReport(
                        status: "unavailable", messages: [], error: error.localizedDescription
                    )
                }
            }
        }
        if let managed = session.managedExecution, managed.state != "terminal" {
            do {
                try await managedRuntime.observe(managed,
                    state: report.status == "active" ? "running" : report.status == "idle" ? "waiting" : "unknown",
                    sessionRef: session.sessionRef, model: report.model, api: api)
            } catch { log("Managed observation: \(error.localizedDescription)") }
        }
        if mirrorEpoch != nil || serializeUpload {
            await sessionSynchronization.acquireUpload(session.id)
        }
        if let mirrorEpoch {
            guard await sessionSynchronization.isCurrent(session.id, epoch: mirrorEpoch) else {
                await sessionSynchronization.releaseUpload(session.id)
                return
            }
        }
        if session.syncPurpose != .control, report.status != "unavailable" {
            let healthKey = session.externalBindingGeneration.map { "\(session.id):external:\($0)" } ?? session.id
            report = self.sessionHealth.observe(report, key: healthKey)
        }
        if let controlEpoch {
            report = await sessionSynchronization.controlReport(report, id: session.id, epoch: controlEpoch)
        }
        for batch in performanceObserver.observe(session, report: report) {
            await performanceUploader.enqueue(sessionId: session.id, batch: batch, api: api)
        }
        await self.uploadAgentSessionReport(
            report, for: session, reported: reported, awaitingReport: awaitingReport,
            rejectedUntil: rejectedUntil, stop: stop, fatal: fatal
        )
        if mirrorEpoch != nil || serializeUpload { await sessionSynchronization.releaseUpload(session.id) }
    }

    /// Uploads one session's report unless it is byte-for-byte what the server
    /// already accepted (AND-182), remembering an unacknowledged Codex command
    /// result so a lost HTTP response cannot resend the command itself.
    private func uploadAgentSessionReport(
        _ report: AgentSessionReport,
        for session: NodeAgentSession,
        reported: Locked<[String: Data]>,
        awaitingReport: Locked<[String: (commandId: String, report: AgentSessionReport)]>,
        rejectedUntil: Locked<[String: Date]>,
        stop: StopSignal,
        fatal: Locked<APIError?>
    ) async {
        // No fingerprint means the report cannot be encoded at
        // all; uploading it unconditionally errs on the side of
        // the server hearing about the session.
        var report = report
        if session.externalBindingGeneration != nil {
            report = report.reportingExternalSettings(supportedFields: session.agentKind == "claude_code" ? [] : session.agentKind == "codex" ? ["model", "effort"] : ["mode", "model", "effort"])
        }
        let fingerprint = Self.fingerprint(of: report)
        // A reconnect clears the server snapshot even when the native transcript
        // is unchanged. Its new generation must receive its own first report.
        let reportKey = session.externalBindingGeneration.map { "\(session.id):external:\($0)" } ?? session.id
        if session.syncPurpose == .control {
            await sessionSynchronization.invalidateMirror(session.id)
        } else if await sessionSynchronization.consumeMirrorInvalidation(session.id) {
            _ = reported.withLock { $0.removeValue(forKey: reportKey) }
        }
        if let fingerprint, reported.current[reportKey] == fingerprint { return }
        // Codex and OpenCode both hand the reply to the agent before this
        // upload confirms it: a lost HTTP response must not turn into a second
        // delivery on the next poll. Codex answers with clientUserMessageId
        // (AND-203); OpenCode has no such id, so the unacknowledged report is
        // the only thing standing between a timeout and a duplicate reply
        // (AND-226).
        if (session.agentKind == "codex" || session.agentKind == "opencode"),
           (session.command?.status == "delivering" || session.command?.kind == "interrupt"),
           let commandId = report.commandId,
           report.commandStatus == "delivered" || report.commandStatus == "delivery_unknown"
            || (session.command?.kind == "interrupt" && report.commandStatus == "failed") {
            awaitingReport.withLock { $0[session.id] = (commandId, report) }
        }
        do {
            if let generation = session.externalBindingGeneration {
                if session.externalAutoConnect {
                    // An unbound probe has no input capability. Do not publish
                    // unrelated source errors or claim a node on a failed read.
                    guard report.commandId == nil, report.sourceArchived != true else { return }
                    try await self.api.reportAutomaticExternalSession(sessionId: session.id, generation: generation, nativeSessionRef: session.sessionRef, report: report)
                } else {
                    try await self.api.reportExternalAgentSession(sessionId: session.id, generation: generation, report: report)
                }
            } else {
                try await self.api.reportAgentSession(sessionId: session.id, report: report)
            }
            if let id = report.commandId, report.commandStatus == "delivering" {
                await sessionSynchronization.confirmReservation(reportKey + ":command:" + id)
            }
            if let id = report.approvalRetryId, report.approvalRetryStatus == "delivering" {
                await sessionSynchronization.confirmReservation(reportKey + ":retry:" + id)
            }
            self.noteSuccess("同步 Agent 会话 \(session.id) 出错")
            _ = rejectedUntil.withLock { $0.removeValue(forKey: session.id) }
        } catch {
            if let id = report.commandId, report.commandStatus == "delivering" {
                adapters.first(where: { $0.kind == session.agentKind })?.discardCommandReservation(sessionId: session.id, commandId: id)
            }
            // A lost response might have accepted this newer snapshot. If the
            // local transcript returns to the previously confirmed contents,
            // that old fingerprint must not suppress the recovery upload.
            _ = reported.withLock { $0.removeValue(forKey: reportKey) }
            if session.externalAutoConnect, let apiError = error as? APIError,
               case .externalNativeAlreadyBound = apiError {
                // A binding can win after the node fetched its probe list.
                // This is a per-conversation conflict, not a broken connection.
                // Leave the existing reply channel untouched and poll again
                // after a cooldown in case its owner releases the binding.
                rejectedUntil.withLock { $0[session.id] = Date().addingTimeInterval(60) }
                self.noteSuccess("同步 Agent 会话 \(session.id) 出错")
                self.log("跳过重复自动连接 \(session.id)：\(apiError.localizedDescription)")
                return
            }
            if let apiError = error as? APIError,
               case let .http(_, status, _) = apiError,
               (400..<500).contains(status), status != 409 {
                rejectedUntil.withLock { $0[session.id] = Date().addingTimeInterval(60) }
                self.handle(error, what: "同步 Agent 会话 \(session.id) 出错", stop: stop, fatal: fatal)
                self.log("同步 Agent 会话 \(session.id) 被拒绝（HTTP \(status)）；该会话 60 秒后重试，其余会话继续同步：\(error.localizedDescription)")
                return
            }
            self.handle(error, what: "同步 Agent 会话 \(session.id) 出错", stop: stop, fatal: fatal)
            return
        }
        // Keep the result until a node poll no longer offers
        // this command. Even after a 204, a stale poll must
        // not call Codex a second time.
        if let fingerprint { reported.withLock { $0[reportKey] = fingerprint } }
    }

    func prepareAttachments(_ session: NodeAgentSession) async throws -> NodeAgentSession {
        guard let command = session.command, command.status == "delivering",
              let attachments = command.attachments, !attachments.isEmpty else { return session }
        guard UUID(uuidString: session.id) != nil else { throw CocoaError(.fileReadCorruptFile) }
        let root = attachmentCacheRoot.appendingPathComponent(session.id, isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true,
                                                attributes: [.posixPermissions: 0o700])
        var prepared: [AgentSessionAttachment] = []
        for attachment in attachments {
            guard UUID(uuidString: attachment.id) != nil,
                  attachment.sizeBytes > 0, attachment.sizeBytes <= 100 * 1024 * 1024,
                  let suffix = attachment.filename.split(separator: ".").last,
                  suffix.range(of: "^[a-z0-9]{2,5}$", options: [.regularExpression, .caseInsensitive]) != nil else {
                throw CocoaError(.fileReadCorruptFile)
            }
            let file = root.appendingPathComponent("\(attachment.id).\(suffix.lowercased())")
            var bytes = try? Data(contentsOf: file)
            let expected = attachment.sha256.lowercased()
            if bytes?.count != attachment.sizeBytes || bytes.map({ SHA256.hash(data: $0).map { String(format: "%02x", $0) }.joined() }) != expected {
                bytes = try await api.downloadAgentSessionAttachment(sessionId: session.id, attachmentId: attachment.id)
                guard bytes?.count == attachment.sizeBytes,
                      bytes.map({ SHA256.hash(data: $0).map { String(format: "%02x", $0) }.joined() }) == expected else {
                    throw CocoaError(.fileReadCorruptFile)
                }
                try bytes!.write(to: file, options: .atomic)
                try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: file.path)
            }
            prepared.append(AgentSessionAttachment(
                id: attachment.id, filename: attachment.filename, kind: attachment.kind,
                contentType: attachment.contentType, sizeBytes: attachment.sizeBytes,
                sha256: attachment.sha256, localPath: file.path
            ))
        }
        let readyCommand = AgentSessionCommand(
            id: command.id, kind: command.kind, text: command.text, turnId: command.turnId,
            status: command.status, error: command.error, createdAt: command.createdAt,
            deliveredAt: command.deliveredAt, attachments: prepared
        )
        return NodeAgentSession(
            id: session.id, managedExecution: session.managedExecution, dispatchId: session.dispatchId, agentKind: session.agentKind,
            sessionRef: session.sessionRef, status: session.status, lifecycle: session.lifecycle,
            occupiesExecutionSlot: session.occupiesExecutionSlot, command: readyCommand,
            archiveInSource: session.archiveInSource, restoreInSource: session.restoreInSource,
            desiredSettings: session.desiredSettings, appliedSettingsRevision: session.appliedSettingsRevision,
            externalBindingGeneration: session.externalBindingGeneration, externalAutoConnect: session.externalAutoConnect
        )
    }

    /// A stable digest of everything a report says. `APIClient.encoder` sorts
    /// keys, so the same report value always encodes to the same bytes.
    private static func fingerprint(of report: AgentSessionReport) -> Data? {
        return (try? APIClient.encoder.encode(report)).map { Data(SHA256.hash(data: $0)) }
    }

    private func hasExecutionCapacity(now: Date = Date()) -> Bool {
        capacity.withLock { value in
            // Compatibility with a server from before dispatchId was included:
            // a reservation still prevents a burst, but cannot wedge the node
            // forever if the old response cannot acknowledge it.
            value.reservations = value.reservations.filter { now.timeIntervalSince($0.value) < 30 }
            let occupied = value.sessions.filter(\.occupiesExecutionSlot).count
            return occupied + value.reservations.count < Self.maximumExecutingSessions
        }
    }

    private func availableAgentKinds() async -> [String] {
        var available: [String] = []
        for adapter in adapters {
            if unconfirmedDetections.current.contains(adapter.kind) { continue }
            if skillReadiness != nil && !skillReadyAgents.current.contains(adapter.kind) {
                let reason = "MissionGo Skill 尚未同步到服务端要求的版本。"
                let changed = unavailableAgents.withLock { previous -> Bool in
                    if previous[adapter.kind] == reason { return false }
                    previous[adapter.kind] = reason
                    return true
                }
                if changed { log("暂停领取 \(adapter.kind) 派单：\(reason)") }
                continue
            }
            switch await adapter.dispatchAvailability() {
            case .ready:
                available.append(adapter.kind)
                let recovered = unavailableAgents.withLock { $0.removeValue(forKey: adapter.kind) != nil }
                if recovered { log("\(adapter.kind) 已恢复，继续领取派单。") }
            case let .unavailable(reason):
                let changed = unavailableAgents.withLock { previous -> Bool in
                    if previous[adapter.kind] == reason { return false }
                    previous[adapter.kind] = reason
                    return true
                }
                if changed { log("暂停领取 \(adapter.kind) 派单：\(reason)") }
            }
        }
        return available
    }

    private func reconcileCapacity(_ sessions: [NodeAgentSession], now: Date = Date()) {
        capacity.withLock { value in
            let observed = Set(sessions.compactMap(\.dispatchId))
            for dispatchId in observed { value.reservations.removeValue(forKey: dispatchId) }
            value.reservations = value.reservations.filter { now.timeIntervalSince($0.value) < 30 }
            value.sessions = sessions
        }
    }

    /// Runs `body` in a task that the caller's cancellation does not reach, and
    /// waits for it. Cancelling `run()` must not abort a claim whose dispatch the
    /// server has already marked delivered, or a launch half-way through.
    private func shielded(_ body: @escaping @Sendable () async -> Void) async {
        await Task { await body() }.value
    }

    /// A revoked credential is the one failure that never fixes itself; it stops
    /// both loops and surfaces to the caller.
    private func handle(_ error: Error, what: String, stop: StopSignal, fatal: Locked<APIError?>) {
        if let apiError = error as? APIError, case .credentialRevoked = apiError {
            fatal.withLock { if $0 == nil { $0 = apiError } }
            update {
                $0.connection = .credentialRevoked(code: Self.revokedCode(of: apiError))
                $0.lastError = apiError.localizedDescription
            }
            stop.stop()
            return
        }
        let message = "\(what)：\(error.localizedDescription)"
        log(message)
        update { value in
            if case .credentialRevoked = value.connection { return }
            value.requestErrors[what] = message
            if let apiError = error as? APIError, case .network = apiError {
                value.unreachableOperations.insert(what)
            } else {
                value.unreachableOperations.remove(what)
                if let apiError = error as? APIError, case .http = apiError {
                    value.lastServerResponseAt = Date()
                }
            }
            Self.refreshConnection(&value)
        }
    }

    private func noteSuccess(_ operation: String) {
        update { value in
            if case .credentialRevoked = value.connection { return }
            value.requestErrors.removeValue(forKey: operation)
            value.unreachableOperations.remove(operation)
            value.lastServerResponseAt = Date()
            Self.refreshConnection(&value)
        }
    }

    /// The problem code of a refused credential, when the server sent one
    /// (AND-291): "node_revoked" and "node_credential_replaced" read very
    /// differently to whoever is staring at the menu bar.
    static func revokedCode(of error: Error) -> String? {
        if case let .credentialRevoked(_, code, _) = error as? APIError { return code }
        return nil
    }

    static func refreshConnection(_ value: inout NodeLoopState, now: Date = Date()) {
        if case .credentialRevoked = value.connection { return }
        let messages = value.requestErrors.sorted { $0.key < $1.key }.map(\.value)
        value.lastError = messages.isEmpty ? nil : messages.joined(separator: "\n\n")
        // Two heartbeat intervals without any response are evidence of an
        // outage. A single failed upload must not override healthy heartbeats
        // and session-list requests, or keep the whole node falsely offline.
        let recentlyReachedServer = value.lastServerResponseAt.map { now.timeIntervalSince($0) < 60 } ?? false
        value.connection = messages.isEmpty ? .online
            : !value.unreachableOperations.isEmpty && !recentlyReachedServer ? .offline : .degraded
    }

    // MARK: Steps

    private func detectAgents() async -> [DetectedAgent] {
        if let cached = agentCache.current, Date().timeIntervalSince(cached.at) < timing.agentDetectTTL {
            return cached.agents
        }
        var detected: [DetectedAgent] = []
        for adapter in adapters {
            // Missing and temporarily unconfirmed are different. Keep the
            // latter visible, but never claim against a stale ready verdict.
            if let report = await adapter.detectionReport() {
                detected.append(report)
            }
        }
        // A failed version probe must not hide an otherwise installed agent
        // for the full five-minute cache window. Retry incomplete results on
        // the next heartbeat; complete results still avoid repeated processes.
        let complete = detected.count == adapters.count && detected.allSatisfy { $0.ready != false }
        unconfirmedDetections.withLock { $0 = Set(detected.filter { $0.ready == false }.map(\.kind)) }
        agentCache.withLock { $0 = complete ? (detected, Date()) : nil }
        return detected
    }

    private func heartbeatAgents(
        _ detected: [DetectedAgent],
        expectedSkillVersion: String?,
        authorizations: [AiAuthorizationEntry]? = nil
    ) async -> [DetectedAgent] {
        var reports: [DetectedAgent] = []
        var readyKinds = Set<String>()
        for agent in detected {
            guard let adapter = adapters.first(where: { $0.kind == agent.kind }) else { continue }
            // Do not turn an unsuccessful installation probe into ready=true
            // through an unrelated skill/resource check, or reuse its catalog.
            if agent.ready == false {
                reports.append(agent)
                continue
            }
            let skill = await skillReadiness?(agent.kind, expectedSkillVersion)
            let resource = await adapter.resourceSnapshot()
            let skillReady = skillReadiness == nil || (
                expectedSkillVersion != nil
                    && skill?.syncState == "ready"
                    && skill?.localVersion == expectedSkillVersion
            )
            let availabilityReason: String?
            if let resource {
                availabilityReason = resource.status == "unavailable"
                    ? resource.reason ?? "Agent resource readiness could not be verified."
                    : nil
            } else {
                switch await adapter.dispatchAvailability() {
                case .ready: availabilityReason = nil
                case let .unavailable(reason): availabilityReason = reason
                }
            }
            let ready = skillReady && availabilityReason == nil && resource?.status != "unavailable"
            if ready { readyKinds.insert(agent.kind) }
            let reason = availabilityReason ?? resource?.reason ?? (skillReady ? nil : "MissionGo Skill 尚未同步。")
            // AND-289: where this machine knows an agent's MissionGo token,
            // report whether it still works -- a session dispatched against a
            // dead one dies on its first MCP call. Only the verdict travels.
            // AND-306: the OpenCode token is read from the environment and
            // then from the config file an operator edits by hand, because the
            // injection chain is exactly what breaks in the field; a `mgpat_`
            // token is judged against the account's live authorizations.
            let mcpAuth: McpAuthSnapshot?
            if agent.kind == "opencode" {
                let token = McpAuthorizationHealth.openCodeToken()
                mcpAuth = McpAuthorizationHealth.report(token: token)
                    ?? McpAuthorizationHealth.report(personalAccessToken: token, authorizations: authorizations)
                if let notice = AuthorizationNoticeScheduler.notice(for: agent.kind, snapshot: mcpAuth) {
                    authorizationNotifier.notify(notice)
                }
            } else {
                mcpAuth = nil
            }
            reports.append(DetectedAgent(
                kind: agent.kind,
                version: agent.version,
                models: await adapter.availableModels(),
                modes: await adapter.availableModes(),
                ready: skillReadiness == nil && resource == nil && availabilityReason == nil ? nil : ready,
                unavailableReason: reason,
                skill: skill,
                resource: resource,
                mcpAuth: mcpAuth
            ))
        }
        skillReadyAgents.withLock { $0 = readyKinds }
        // Local sync results belong in the menu even if the following
        // heartbeat request fails.
        update { $0.agents = reports }
        return reports
    }

    /// The mapping is configured in the console or the menu, so logging it when
    /// it changes is the confirmation on this machine that a product actually
    /// points at a local repository.
    private func noteReposChanged(_ repos: [RepoMapping]) {
        let changed = lastReposFingerprint.withLock { last -> Bool in
            if last == repos { return false }
            last = repos
            return true
        }
        guard changed else { return }
        let summary = repos.map { "\($0.productKey) → \($0.repoPath)" }.joined(separator: "，")
        log("仓库映射：\(summary.isEmpty ? "（尚未配置）" : summary)")
    }

    /// Starts one dispatch. Every failure path ends in a report rather than a
    /// throw: a dispatch nobody reports on is stuck in `delivered`, which reads in
    /// the console as "the machine took it and is working on it".
    func launchDispatch(_ request: DispatchRequest) async -> (DispatchReport, String?) {
        guard let adapter = adapters.first(where: { $0.kind == request.agentKind }) else {
            return (DispatchReport(
                status: .failed,
                error: "本机没有 \(request.agentKind) 的适配器。",
                failureCode: "unknown",
                failureStage: "readiness"
            ), nil)
        }
        let choice = [request.model, request.effort].compactMap { $0 }.joined(separator: "/")
        log("派单 \(request.dispatchId)：\(request.itemKeys.joined(separator: "、"))（\(request.agentKind)/\(request.mode)\(choice.isEmpty ? "" : "/\(choice)")）于 \(request.repoPath)")
        do {
            guard try await api.permitDispatchStart(dispatchId: request.dispatchId) else {
                return (DispatchReport(status: .cancelled, error: "已在启动前停止"), nil)
            }
            let launched = try await adapter.launch(DispatchJob(
                dispatchId: request.dispatchId, itemKeys: request.itemKeys,
                repoPath: request.repoPath, mode: request.mode,
                // Read per dispatch rather than at login, so a nickname changed in
                // the console or the menu names the very next session.
                nodeName: request.nodeName ?? fallbackNodeName,
                round: request.round ?? 1,
                reworkItemKeys: request.reworkItemKeys ?? [],
                model: request.model,
                effort: request.effort,
                freeSession: request.freeSession == true,
                sessionTitle: request.sessionTitle
            ))
            log("会话「\(launched.sessionName)」已启动" + (launched.logPath.map { "，日志 \($0)" } ?? ""))
            if let url = launched.sessionUrl {
                log("会话地址 \(url)")
                return (DispatchReport(
                    status: .launched,
                    sessionName: launched.sessionName,
                    sessionUrl: url,
                    sessionRef: launched.sessionRef, initialTurnId: launched.initialTurnId
                ), launched.logPath)
            }
            // A Claude Code session with a custom API endpoint has no
            // claude.ai URL. Its session reference still supports MissionGo
            // conversation, replies and approvals.
            log("会话已由 agent 确认启动，可在 MissionGo 中控制。")
            return (DispatchReport(
                status: .launched,
                sessionName: launched.sessionName,
                sessionRef: launched.sessionRef, initialTurnId: launched.initialTurnId
            ), launched.logPath)
        } catch {
            let reason = error.localizedDescription
            log("派单 \(request.dispatchId) 启动失败：\(reason)")
            let launchError = error as? LaunchError
            return (DispatchReport(
                status: launchError?.retryAfterSeconds == nil ? .failed : .retry,
                error: reason,
                failureCode: launchError?.failureCode ?? "unknown",
                failureStage: launchError?.failureStage ?? "unknown",
                retryAfterSeconds: launchError?.retryAfterSeconds,
                diagnosticSnapshot: launchError?.diagnosticSnapshot
            ), nil)
        }
    }

    /// True once the server has the result. Rethrows only a revoked credential.
    private func reportWithRetry(_ dispatchId: String, _ report: DispatchReport, stop: StopSignal) async throws -> (reported: Bool, error: String?) {
        if report.status == .cancelled { return (true, nil) }
        var lastError: String?
        for attempt in 1...max(1, timing.resultReportAttempts) {
            do {
                try await api.reportResult(dispatchId: dispatchId, report: report)
                return (true, nil)
            } catch let error as APIError {
                if case .credentialRevoked = error { throw error }
                lastError = error.localizedDescription
                log("回报派单 \(dispatchId) 的结果失败（第 \(attempt) 次）：\(error.localizedDescription)")
            } catch {
                lastError = error.localizedDescription
                log("回报派单 \(dispatchId) 的结果失败（第 \(attempt) 次）：\(error.localizedDescription)")
            }
            if attempt == timing.resultReportAttempts { return (false, lastError) }
            await stop.sleep(timing.resultRetryDelay)
            if stop.isStopped { return (false, lastError) }
        }
        return (false, lastError)
    }

    private func recordLaunch(_ launch: LocalLaunch) {
        update {
            $0.recentLaunches.insert(launch, at: 0)
            if $0.recentLaunches.count > NodeLoop.recentLaunchLimit {
                $0.recentLaunches.removeLast($0.recentLaunches.count - NodeLoop.recentLaunchLimit)
            }
        }
    }

    private func update(_ change: (inout NodeLoopState) -> Void) {
        // Yielded under the lock so two loops updating at once cannot deliver
        // their snapshots out of order; the callback runs outside it so it may
        // read `currentState` without deadlocking.
        let snapshot = state.withLock { value -> NodeLoopState in
            change(&value)
            stateContinuation.yield(value)
            return value
        }
        onState(snapshot)
    }
}
