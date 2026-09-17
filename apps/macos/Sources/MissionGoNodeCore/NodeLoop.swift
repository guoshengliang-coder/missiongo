import Foundation

/// The protocol calls the loop makes, so a test can stand in for the server.
public protocol NodeAPI: Sendable {
    func heartbeat(agents: [DetectedAgent], repoCandidates: [RepoCandidate]) async throws -> HeartbeatReply
    func claimNext(waitMs: Int) async throws -> DispatchRequest?
    func reportResult(dispatchId: String, report: DispatchReport) async throws
}

extension APIClient: NodeAPI {}

/// What the menu bar shows about the loop.
public struct NodeLoopState: Equatable, Sendable {
    public enum Connection: Equatable, Sendable {
        /// Started, nothing has answered yet.
        case connecting
        /// The last request reached the server.
        case online
        /// The last request did not; the loop keeps trying.
        case offline
        /// The credential was refused. Terminal: the app has to log in again.
        case credentialRevoked
        case stopped
    }

    public var connection: Connection = .connecting
    public var lastError: String?
    public var lastHeartbeatAt: Date?
    public var agents: [DetectedAgent] = []
    public var repos: [RepoMapping] = []
    /// The products this machine can be given a repository for. Carried by the
    /// heartbeat so a product created in the console reaches the menu without
    /// the client being restarted. nil means no server has said yet — an empty
    /// array is a real answer and means there are none.
    public var products: [NodeProfile.Product]?
    /// Most recent first, capped at `NodeLoop.recentLaunchLimit`.
    public var recentLaunches: [LocalLaunch] = []

    public init() {}
}

/// One dispatch this machine picked up, as it looked from here.
public struct LocalLaunch: Equatable, Sendable, Identifiable {
    public var id: String { dispatchId }
    public let dispatchId: String
    public let itemKeys: [String]
    public let mode: String
    public let repoPath: String
    public let startedAt: Date
    public let report: DispatchReport
    public let logPath: String?
    /// False when the server never heard the result, after every retry.
    public let reported: Bool
}

/// Stops the loops the way an `AbortSignal` did: sleeps end early, but a request
/// or a launch already under way is left to finish.
final class StopSignal: @unchecked Sendable {
    private let state = Locked<(stopped: Bool, sleepers: [UUID: CheckedContinuation<Void, Never>])>((false, [:]))

    var isStopped: Bool {
        return state.current.stopped
    }

    func stop() {
        let sleepers = state.withLock { value -> [CheckedContinuation<Void, Never>] in
            value.stopped = true
            defer { value.sleepers = [:] }
            return Array(value.sleepers.values)
        }
        sleepers.forEach { $0.resume() }
    }

    /// Sleeps for `seconds`, or until `stop()`, whichever comes first.
    func sleep(_ seconds: TimeInterval) async {
        let id = UUID()
        await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
            let stopped = state.withLock { value -> Bool in
                if value.stopped { return true }
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

    private let state = Locked(NodeLoopState())
    private let stateContinuation: AsyncStream<NodeLoopState>.Continuation
    /// Every state change, starting with the current one. Also delivered to
    /// `onState`; use whichever suits the caller.
    public let states: AsyncStream<NodeLoopState>

    private let agentCache = Locked<(agents: [DetectedAgent], at: Date)?>(nil)
    private let lastReposFingerprint = Locked<[RepoMapping]?>(nil)

    public init(
        api: NodeAPI,
        adapters: [AgentAdapter],
        fallbackNodeName: String,
        detectRepoCandidates: @escaping @Sendable () -> [RepoCandidate] = { RepoCandidates.detect() },
        timing: Timing = Timing(),
        log: @escaping @Sendable (String) -> Void = { NSLog("%@", $0) },
        onState: @escaping @Sendable (NodeLoopState) -> Void = { _ in }
    ) {
        self.api = api
        self.adapters = adapters
        self.fallbackNodeName = fallbackNodeName
        self.detectRepoCandidates = detectRepoCandidates
        self.timing = timing
        self.log = log
        self.onState = onState
        let (stream, continuation) = AsyncStream.makeStream(of: NodeLoopState.self, bufferingPolicy: .bufferingNewest(1))
        states = stream
        stateContinuation = continuation
        continuation.yield(NodeLoopState())
    }

    public var currentState: NodeLoopState {
        return state.current
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
        let stop = StopSignal()
        let fatal = Locked<APIError?>(nil)
        update { $0.connection = .connecting }

        await withTaskCancellationHandler {
            async let heartbeat: Void = heartbeatLoop(stop: stop, fatal: fatal)
            async let claim: Void = claimLoop(stop: stop, fatal: fatal)
            _ = await (heartbeat, claim)
        } onCancel: {
            stop.stop()
        }

        if let error = fatal.current {
            update { $0.connection = .credentialRevoked }
            stateContinuation.finish()
            throw error
        }
        update { $0.connection = .stopped }
        stateContinuation.finish()
    }

    // MARK: Loops

    private func heartbeatLoop(stop: StopSignal, fatal: Locked<APIError?>) async {
        while !stop.isStopped {
            await shielded {
                do {
                    let agents = await self.detectAgents()
                    // Re-read every beat rather than caching: a repository the
                    // operator just opened for the first time should appear in the
                    // mapping list without restarting the app.
                    let candidates = self.detectRepoCandidates()
                    let beat = try await self.api.heartbeat(agents: agents, repoCandidates: candidates)
                    self.noteReposChanged(beat.repos)
                    self.update {
                        $0.connection = .online
                        $0.lastError = nil
                        $0.lastHeartbeatAt = Date()
                        $0.agents = agents
                        $0.repos = beat.repos
                        // A server from before this field keeps the list it had:
                        // an older server must not empty the repository menu.
                        if let products = beat.products { $0.products = products }
                    }
                } catch {
                    self.handle(error, what: "上报心跳出错", stop: stop, fatal: fatal)
                }
            }
            await stop.sleep(timing.heartbeatInterval)
        }
    }

    private func claimLoop(stop: StopSignal, fatal: Locked<APIError?>) async {
        while !stop.isStopped {
            await shielded {
                do {
                    if let request = try await self.api.claimNext(waitMs: self.timing.claimWaitMs) {
                        self.update {
                            $0.connection = .online
                            $0.lastError = nil
                        }
                        let startedAt = Date()
                        let (report, logPath) = await self.launchDispatch(request)
                        let record = { (reported: Bool) in
                            self.recordLaunch(LocalLaunch(
                                dispatchId: request.dispatchId, itemKeys: request.itemKeys, mode: request.mode,
                                repoPath: request.repoPath, startedAt: startedAt, report: report,
                                logPath: logPath, reported: reported
                            ))
                        }
                        do {
                            record(try await self.reportWithRetry(request.dispatchId, report, stop: stop))
                        } catch {
                            // The session may be running even though the credential is
                            // gone; the menu should still show it and its link.
                            record(false)
                            throw error
                        }
                    } else {
                        self.update {
                            $0.connection = .online
                            $0.lastError = nil
                        }
                    }
                } catch {
                    self.handle(error, what: "拉取派单出错", stop: stop, fatal: fatal)
                }
            }
            await stop.sleep(timing.claimInterval)
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
                $0.connection = .credentialRevoked
                $0.lastError = apiError.localizedDescription
            }
            stop.stop()
            return
        }
        let message = "\(what)：\(error.localizedDescription)"
        log(message)
        update {
            if $0.connection != .credentialRevoked {
                $0.connection = .offline
            }
            $0.lastError = message
        }
    }

    // MARK: Steps

    private func detectAgents() async -> [DetectedAgent] {
        if let cached = agentCache.current, Date().timeIntervalSince(cached.at) < timing.agentDetectTTL {
            return cached.agents
        }
        var detected: [DetectedAgent] = []
        for adapter in adapters {
            // One adapter failing to detect must not hide the others; a missing
            // agent is simply not reported.
            if let version = await adapter.detect() {
                detected.append(DetectedAgent(kind: adapter.kind, version: version))
            }
        }
        agentCache.withLock { $0 = (detected, Date()) }
        return detected
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
            return (DispatchReport(status: .failed, error: "本机没有 \(request.agentKind) 的适配器。"), nil)
        }
        log("派单 \(request.dispatchId)：\(request.itemKeys.joined(separator: "、"))（\(request.agentKind)/\(request.mode)）于 \(request.repoPath)")
        do {
            let launched = try await adapter.launch(DispatchJob(
                dispatchId: request.dispatchId, itemKeys: request.itemKeys,
                repoPath: request.repoPath, mode: request.mode,
                // Read per dispatch rather than at login, so a nickname changed in
                // the console or the menu names the very next session.
                nodeName: request.nodeName ?? fallbackNodeName,
                round: request.round ?? 1,
                reworkItemKeys: request.reworkItemKeys ?? []
            ))
            log("会话「\(launched.sessionName)」已启动" + (launched.logPath.map { "，日志 \($0)" } ?? ""))
            if let url = launched.sessionUrl {
                log("会话地址 \(url)")
                return (DispatchReport(status: .launched, sessionName: launched.sessionName, sessionUrl: url), launched.logPath)
            }
            // Some adapters receive a positive start acknowledgement but cannot
            // represent the resulting identifier as a link. Claude Code never
            // reaches this path: its only acknowledgement is the URL itself.
            log("会话已由 agent 确认启动，但没有可打开的会话地址。")
            return (DispatchReport(status: .launched, sessionName: launched.sessionName), launched.logPath)
        } catch {
            let reason = error.localizedDescription
            log("派单 \(request.dispatchId) 启动失败：\(reason)")
            return (DispatchReport(status: .failed, error: reason), nil)
        }
    }

    /// True once the server has the result. Rethrows only a revoked credential.
    private func reportWithRetry(_ dispatchId: String, _ report: DispatchReport, stop: StopSignal) async throws -> Bool {
        for attempt in 1...max(1, timing.resultReportAttempts) {
            do {
                try await api.reportResult(dispatchId: dispatchId, report: report)
                return true
            } catch let error as APIError {
                if case .credentialRevoked = error { throw error }
                log("回报派单 \(dispatchId) 的结果失败（第 \(attempt) 次）：\(error.localizedDescription)")
            } catch {
                log("回报派单 \(dispatchId) 的结果失败（第 \(attempt) 次）：\(error.localizedDescription)")
            }
            if attempt == timing.resultReportAttempts { return false }
            await stop.sleep(timing.resultRetryDelay)
            if stop.isStopped { return false }
        }
        return false
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
