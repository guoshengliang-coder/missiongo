import AppKit
import Foundation
import MissionGoNodeCore
import ServiceManagement

/// Everything the menu shows and everything it does. Views read published
/// state and call methods; no view talks to the server, the Keychain or a
/// process directly.
@MainActor
final class AppModel: ObservableObject {
    static let shared = AppModel()

    enum Phase: Equatable {
        /// Reading this app's credential and resolving known CLI locations.
        case starting
        case signedOut
        case signingIn
        case signedIn(NodeCredential)
    }

    struct RepoNotice: Equatable {
        enum Kind { case warning, error }
        let kind: Kind
        let text: String
    }

    struct LaunchAtLogin: Equatable {
        var enabled = false
        var requiresApproval = false
        var error: String?
    }

    /// Where this Mac is in updating its own client.
    ///
    /// `unavailable` is the answer for a build with no version to compare --
    /// `swift run`, mostly. It is not an error and gets no warning colour: the
    /// menu simply says nothing about updates.
    enum UpdateState: Equatable {
        case unavailable
        case current(String)
        case checking(String)
        case available(AppUpdater.Available)
        case downloading(AppUpdater.Available)
        case installing(AppUpdater.Available)
        case failed(current: String, reason: String)

        /// The running version, once it is known.
        var current: String? {
            switch self {
            case .unavailable: return nil
            case let .current(version), let .checking(version): return version
            case let .available(update), let .downloading(update), let .installing(update):
                return update.current
            case let .failed(current, _): return current
            }
        }

        /// True while an update is being fetched or written: the button has to
        /// stay out of reach, and a timer tick must not restart the check.
        var isBusy: Bool {
            switch self {
            case .downloading, .installing: return true
            case .unavailable, .current, .checking, .available, .failed: return false
            }
        }
    }

    private enum DefaultsKey {
        static let credentialUnavailable = "credentialUnavailable"
        static let pendingLoginCancelled = "pendingLoginCancelled"
        static let serverOverride = "serverURLOverride"
        static let revokedNotice = "lastSessionRevoked"
        static let importedPath = "explicitlyImportedCLIPath"
    }

    /// Releases are days apart, and the check costs a request against the
    /// deployment this Mac is already heartbeating to every 30 seconds. Once at
    /// login is what actually catches most of them.
    static let updateCheckInterval: TimeInterval = 6 * 60 * 60
    static let dispatchRefreshInterval: TimeInterval = 30
    static let unreadRefreshInterval: TimeInterval = 60
    /// Opening and closing the menu quickly should not start a process each time.
    static let openRefreshThrottle: TimeInterval = 10

    // MARK: Published state

    @Published private(set) var phase: Phase = .starting
    @Published private(set) var loginError: String?
    @Published private(set) var deviceLogin: PendingDeviceLogin?
    @Published private(set) var loginStatus = "正在准备登录…"
    @Published private(set) var showsRevokedNotice: Bool
    @Published private(set) var serverOverride: String?
    @Published private(set) var connectionMode: ServerConnectionMode = .system
    @Published private(set) var diagnosingConnection = false
    @Published private(set) var connectionDiagnosis: ServerConnection.Diagnosis?
    @Published private(set) var loopState = NodeLoopState()
    @Published private(set) var profile: NodeProfile?
    @Published private(set) var profileError: String?
    @Published private(set) var savingNickname = false
    @Published private(set) var nicknameError: String?
    @Published private(set) var repos: [RepoMapping] = [] {
        didSet {
            candidates = RepoCandidates.mapped(repos)
            candidateSnapshot.update(repos)
        }
    }
    @Published private(set) var repoNotices: [String: RepoNotice] = [:]
    @Published private(set) var savingProductIds: Set<String> = []
    @Published private(set) var candidates: [RepoCandidate] = []
    /// The product list from whichever answer arrived last — the heartbeat every
    /// 30 seconds, or a profile refresh. nil until one of them has answered.
    @Published private var latestProducts: [NodeProfile.Product]?
    @Published private(set) var dispatches: [DispatchRecord] = []
    @Published private(set) var dispatchesError: String?
    @Published private(set) var unreadCount: Int? {
        didSet {
            NSApplication.shared.dockTile.badgeLabel = UnreadBadgeLabel.text(unreadCount)
        }
    }
    @Published private(set) var unreadSessions: [UnreadSessionPreview] = []
    @Published private(set) var unreadError: String?
    @Published private(set) var claude: ClaudeCodeStatus = .checking
    @Published private(set) var codex: CodexStatus = .checking
    @Published private(set) var skillSync: [String: AgentSkillSnapshot] = [:]
    private var skillSyncTracker = AgentSkillSync()
    @Published private(set) var integrationStates: [String: LocalIntegrations.State] = [:]
    @Published private(set) var detectedAgentVersions: [String: String] = [:]
    @Published private(set) var checkingIntegrations: Set<LocalAgent> = []
    @Published private(set) var checkingAllIntegrations = false
    @Published private(set) var importingPath = false
    @Published private(set) var launchAtLogin = LaunchAtLogin()
    /// The client's own version, and whether a newer one is published.
    @Published private(set) var updateState: UpdateState = .unavailable
    @Published private(set) var updateNotice: String?
    /// This build's version, for the menu to name; nil when run without a bundle.
    let appVersion: String? = AppUpdater.currentVersion()

    // MARK: Private state

    private let store = KeychainCredentialStore()
    private let credentialAccess = AsyncCredentialAccess()
    private var loginGeneration = 0
    private let integrations = LocalIntegrations()
    private let candidateSnapshot = MappedRepositorySnapshot()
    private let defaults = UserDefaults.standard
    private let bundleServerUrl = Bundle.main.object(forInfoDictionaryKey: "MissionGoServerURL") as? String
    private var environment: ShellEnvironment?
    private var started = false
    #if DEBUG
    private var isPreview = false
    #endif
    private var loginTask: Task<Void, Never>?
    private var loopTask: Task<Void, Never>?
    private var loopStatesTask: Task<Void, Never>?
    /// Bumped whenever a loop is started or stopped, so a stopped loop that is
    /// still winding down (it may finish a long poll first) cannot write into
    /// the state of the session that replaced it.
    private var loopGeneration = 0
    private var lastLoopRepos: [RepoMapping]?
    private var lastSeenLaunchId: String?
    private var updateTimer: Task<Void, Never>?
    private var lastPresentedUpdateVersion: String?
    private var menuTimer: Task<Void, Never>?
    private var lastOpenRefresh: Date?
    private var unreadTask: Task<Void, Never>?
    /// The loop of the current session, kept so the reconnect button can wake
    /// it. `nil` whenever no loop is running.
    private var loop: NodeLoop?

    private init() {
        showsRevokedNotice = UserDefaults.standard.bool(forKey: DefaultsKey.revokedNotice)
        serverOverride = UserDefaults.standard.string(forKey: DefaultsKey.serverOverride)
        connectionMode = ServerConnection.mode()
        refreshIntegrationStates()
    }

    #if DEBUG
    /// Offline device-login fixture for layout checks; no network or Keychain I/O.
    init(previewDeviceLogin: PendingDeviceLogin) {
        isPreview = true
        showsRevokedNotice = false
        serverOverride = previewDeviceLogin.serverUrl
        phase = .signingIn
        deviceLogin = previewDeviceLogin
        loginStatus = "等待浏览器授权…"
    }

    /// A read-only UI fixture. It never starts the node loop, reads credentials,
    /// or refreshes an integration; release builds do not include this path.
    init(previewCredential: NodeCredential, unread: UnreadSessionsSnapshot, agentVersions: [String: String],
         connectionDiagnosis: ServerConnection.Diagnosis? = nil) {
        isPreview = true
        showsRevokedNotice = false
        serverOverride = nil
        self.connectionDiagnosis = connectionDiagnosis
        phase = .signedIn(previewCredential)
        unreadCount = unread.totalUnread
        unreadSessions = unread.sessions
        detectedAgentVersions = agentVersions
        loopState.connection = .online
        loopState.expectedSkillVersion = "5.15.0"
        for (agent, version) in agentVersions {
            let state = ["attempt": UUID().uuidString, "version": version]
            if let data = try? JSONSerialization.data(withJSONObject: state),
               let integration = try? JSONDecoder().decode(LocalIntegrations.State.self, from: data) {
                integrationStates[agent] = integration
            }
            skillSync[agent] = AgentSkillSnapshot(localVersion: "5.15.0", expectedVersion: "5.15.0", syncState: "ready")
        }
    }
    #endif

    // MARK: Derived

    var credential: NodeCredential? {
        if case let .signedIn(credential) = phase { return credential }
        return nil
    }

    /// The address a new login goes to. Once signed in, the credential's own
    /// address is the one every request uses.
    var loginServerUrl: String? {
        return ServerAddress.effective(bundleValue: bundleServerUrl, override: serverOverride)
    }

    var consoleUrl: String? {
        return credential?.serverUrl ?? loginServerUrl
    }

    var menuBarSymbol: String {
        return MenuBarSymbol.name(signedIn: credential != nil, connection: credential == nil ? nil : loopState.connection)
    }

    var machineName: String {
        return profile?.node.name ?? credential?.name ?? MachineIdentity.defaultName()
    }

    var products: [NodeProfile.Product] {
        return (latestProducts ?? profile?.products ?? []).sorted { $0.keyPrefix < $1.keyPrefix }
    }

    func repoPath(for productId: String) -> String? {
        return repos.first { $0.productId == productId }?.repoPath
    }

    var recentDispatches: [DispatchRecord] {
        return Array(dispatches.prefix(DispatchPresentation.menuLimit))
    }

    // MARK: Lifecycle

    /// Called once at launch, before the menu is ever opened: a Mac that comes
    /// up at login has to go online without anyone clicking the icon.
    func start() {
        #if DEBUG
        guard !isPreview else { return }
        #endif
        guard !started else { return }
        started = true
        // Before any network call: the menu should be able to say which version
        // this is even when the check never gets to run.
        updateState = AppUpdater.currentVersion().map { .current($0) } ?? .unavailable
        refreshLaunchAtLogin()
        Task {
            // Do not run the user's shell profile as a startup side effect.
            let environment: ShellEnvironment
            if let path = defaults.string(forKey: DefaultsKey.importedPath), !path.isEmpty {
                environment = ShellEnvironment(path: path)
            } else {
                environment = ShellEnvironment.resolve()
            }
            self.environment = environment
            let credential: NodeCredential?
            do {
                if defaults.bool(forKey: DefaultsKey.credentialUnavailable) {
                    credential = nil
                } else {
                    let store = self.store
                    credential = try await credentialAccess.run { try store.loadCredential(allowInteraction: false) }
                }
            } catch {
                credential = nil
                loginError = "未自动读取登录凭据：\(error.localizedDescription)。请点击登录后按系统提示授权。"
            }
            if let credential {
                enterSignedIn(credential)
            } else {
                if loginError == nil, !defaults.bool(forKey: DefaultsKey.pendingLoginCancelled) {
                    let store = self.store
                    do {
                        if let pending = try await credentialAccess.run(operation: { try store.loadPendingLogin() }) {
                            if pending.isExpired || pending.serverUrl != loginServerUrl {
                                defaults.set(true, forKey: DefaultsKey.pendingLoginCancelled)
                                try await credentialAccess.run { try store.deletePendingLogin() }
                            } else {
                                phase = .signedOut
                                beginDeviceSignIn(resuming: pending)
                                return
                            }
                        }
                    } catch {
                        loginError = "未能恢复登录：\(error.localizedDescription)"
                    }
                }
                phase = .signedOut
            }
        }
    }

    private func enterSignedIn(_ credential: NodeCredential) {
        phase = .signedIn(credential)
        loginError = nil
        startUnreadUpdates(credential)
        startLoop(credential)
        startUpdateTimer(credential)
        refreshProfile()
        refreshDispatches()
    }

    private func leaveSignedIn(revoked: Bool) {
        loginGeneration += 1
        loginTask?.cancel()
        loginTask = nil
        let generation = loginGeneration
        unreadTask?.cancel()
        unreadTask = nil
        unreadCount = nil
        unreadSessions = []
        unreadError = nil
        stopLoop()
        for agent in checkingIntegrations { integrations.disable(agent) }
        checkingIntegrations.removeAll()
        refreshIntegrationStates()
        updateTimer?.cancel()
        updateTimer = nil
        // Persist the signed-out intent before a possibly stuck delete. A late
        // completion or a restart must never resurrect this credential.
        defaults.set(true, forKey: DefaultsKey.credentialUnavailable)
        defaults.set(true, forKey: DefaultsKey.pendingLoginCancelled)
        let store = self.store
        let access = credentialAccess
        Task {
            do { try await access.run { try store.deleteCredential(); try store.deletePendingLogin() } }
            catch {
                if generation == loginGeneration { loginError = "已退出登录，但未能清理钥匙串：\(error.localizedDescription)" }
            }
        }
        showsRevokedNotice = revoked
        defaults.set(revoked, forKey: DefaultsKey.revokedNotice)
        phase = .signedOut
        loopState = NodeLoopState()
        profile = nil
        profileError = nil
        savingNickname = false
        nicknameError = nil
        repos = []
        repoNotices = [:]
        dispatches = []
        dispatchesError = nil
        claude = .checking
        codex = .checking
        skillSync = [:]
        skillSyncTracker = AgentSkillSync()
        updateNotice = nil
        // The version is a property of this build, not of the session, so it
        // stays; anything in flight does not.
        updateState = AppUpdater.currentVersion().map { .current($0) } ?? .unavailable
    }

    private func handleCredentialRevoked() {
        guard credential != nil else { return }
        leaveSignedIn(revoked: true)
    }

    /// Any API failure goes through here: a refused credential ends the session,
    /// everything else is only a message.
    private func isRevoked(_ error: Error) -> Bool {
        if let apiError = error as? APIError, case .credentialRevoked = apiError {
            handleCredentialRevoked()
            return true
        }
        return false
    }

    private func startUnreadUpdates(_ credential: NodeCredential) {
        unreadTask?.cancel()
        unreadCount = nil
        unreadSessions = []
        unreadError = nil
        unreadTask = Task { [weak self] in
            while !Task.isCancelled {
                guard let self else { return }
                await self.loadUnreadSessions(credential)
                try? await Task.sleep(nanoseconds: UInt64(Self.unreadRefreshInterval * 1_000_000_000))
            }
        }
    }

    func refreshUnreadSessions() {
        guard let credential else { return }
        Task { await loadUnreadSessions(credential) }
    }

    private func loadUnreadSessions(_ credential: NodeCredential) async {
        do {
            let snapshot = try await APIClient(
                serverUrl: credential.serverUrl, token: credential.token
            ).unreadSessions()
            guard !Task.isCancelled, self.credential == credential else { return }
            unreadSessions = snapshot.sessions
            unreadCount = snapshot.totalUnread
            unreadError = nil
        } catch {
            guard !Task.isCancelled, self.credential == credential else { return }
            unreadSessions = []
            unreadCount = nil
            unreadError = error.localizedDescription
            _ = isRevoked(error)
        }
    }

    // MARK: Node loop

    private func startLoop(_ credential: NodeCredential) {
        stopLoop()
        guard let environment else { return }
        loopGeneration += 1
        let generation = loopGeneration
        lastLoopRepos = nil
        latestProducts = nil
        lastSeenLaunchId = nil
        loopState = NodeLoopState()
        let skillTracker = AgentSkillSync()
        skillSyncTracker = skillTracker
        skillSync = [:]

        // A loop runs once; every login gets a fresh one.
        var timing = NodeLoop.Timing()
        // The consented adapters only read cached metadata. Do not cache it
        // again in the loop, otherwise disabling stays advertised for minutes.
        timing.agentDetectTTL = 0
        let snapshot = candidateSnapshot
        let access = integrations
        let codexHome = CodexLocation(environment: environment).codexHome
        let loop = NodeLoop(
            api: APIClient(serverUrl: credential.serverUrl, token: credential.token),
            managedExecutionEnabled: ProcessInfo.processInfo.environment["MISSIONGO_MANAGED_EXECUTION"] == "1",
            adapters: [
                ConsentedAgentAdapter(agent: .claudeCode, base: SessionLauncher(environment: environment), access: integrations),
                ConsentedAgentAdapter(agent: .codex, base: CodexLauncher(environment: environment, serverUrl: credential.serverUrl), access: integrations),
                ConsentedAgentAdapter(agent: .openCode, base: OpenCodeLauncher(), access: integrations),
            ],
            fallbackNodeName: credential.name,
            detectRepoCandidates: { snapshot.candidates },
            timing: timing,
            skillReadiness: { agentKind, expectedVersion in
                guard let agent = LocalAgent(rawValue: agentKind),
                      let consent = access.state(for: agent), consent.version != nil else {
                    return AgentSkillSnapshot(expectedVersion: expectedVersion, syncState: "missing")
                }
                // A foreground retry owns its result until it finishes.
                if let current = skillTracker.snapshots[agentKind], current.syncState == "syncing" {
                    return current
                }
                let target = SkillSync.target(for: agent, home: Paths.homeDirectory(), codexHome: codexHome)
                let attempt = skillTracker.begin(
                    agentKind, localVersion: SkillSync.localVersion(at: target), expectedVersion: expectedVersion
                )
                let result: AgentSkillSnapshot
                if let expectedVersion {
                    result = await SkillSync.check(
                        serverUrl: credential.serverUrl, target: target, expectedVersion: expectedVersion,
                        shouldApply: {
                            access.isCurrent(agent, attempt: consent.attempt)
                                && skillTracker.isCurrent(agentKind, attempt: attempt)
                        }
                    )
                } else {
                    result = AgentSkillSnapshot(
                        localVersion: SkillSync.localVersion(at: target), syncState: "unknown"
                    )
                }
                guard access.isCurrent(agent, attempt: consent.attempt) else {
                    return skillTracker.finish(
                        agentKind, attempt: attempt,
                        snapshot: AgentSkillSnapshot(expectedVersion: expectedVersion, syncState: "missing")
                    )
                }
                return skillTracker.finish(agentKind, attempt: attempt, snapshot: result)
            }
        )
        loopStatesTask = Task { [weak self] in
            for await state in loop.states {
                guard let self, self.loopGeneration == generation else { return }
                self.apply(state)
            }
        }
        loopTask = Task { [weak self] in
            do {
                try await loop.run()
            } catch {
                guard let self, self.loopGeneration == generation else { return }
                _ = self.isRevoked(error)
            }
        }
        self.loop = loop
    }

    /// Cancelling ends the loop's sleeps at once; a claim or launch already
    /// under way finishes in the background and is ignored here. Sessions it
    /// started are never touched.
    private func stopLoop() {
        loopGeneration += 1
        skillSyncTracker.invalidateAll()
        loop = nil
        loopTask?.cancel()
        loopTask = nil
        loopStatesTask?.cancel()
        loopStatesTask = nil
    }

    /// The reconnect button (AND-177): retry everything the menu shows a
    /// failure for now, rather than waiting out each refresh interval. The
    /// loops' in-flight requests are left to finish; the wake takes effect on
    /// their next sleep.
    func reconnect() {
        guard credential != nil else { return }
        loop?.retryNow()
        refreshProfile()
        refreshDispatches()
        refreshUnreadSessions()
        checkForUpdates()
    }

    var canChangeConnectionMode: Bool {
        phase != .starting && phase != .signingIn && !updateState.isBusy && !diagnosingConnection
    }

    func setConnectionMode(_ mode: ServerConnectionMode) {
        guard canChangeConnectionMode, mode != connectionMode else { return }
        connectionMode = mode
        #if DEBUG
        if isPreview { return }
        #endif
        ServerConnection.setMode(mode, defaults: defaults)
        loginError = nil
        reconnect()
    }

    func diagnoseConnection() {
        guard let server = consoleUrl, !diagnosingConnection else { return }
        #if DEBUG
        if isPreview { return }
        #endif
        diagnosingConnection = true
        connectionDiagnosis = nil
        Task {
            let diagnosis = await ServerConnection.diagnose(serverUrl: server)
            diagnosingConnection = false
            guard consoleUrl == server else { return }
            connectionDiagnosis = diagnosis
        }
    }

    private func apply(_ state: NodeLoopState) {
        refreshIntegrationStates()
        loopState = state
        refreshSkillStates()
        // The heartbeat carries the mapping, so a change made in the console
        // shows up here within one beat. Only a changed snapshot is applied, so
        // an unchanged one cannot overwrite a save made from the menu since.
        if state.lastHeartbeatAt != nil, state.repos != lastLoopRepos {
            lastLoopRepos = state.repos
            repos = state.repos
        }
        // The same beat carries the product list, so a product created in the
        // console appears in the repository menu without waiting for the menu to
        // be opened. A server too old to send it leaves this nil and the list
        // stands as it was.
        if let products = state.products, products != latestProducts {
            latestProducts = products
        }
        if let launch = state.recentLaunches.first, launch.dispatchId != lastSeenLaunchId {
            lastSeenLaunchId = launch.dispatchId
            refreshDispatches()
        }
    }

    // MARK: Login

    func setServerOverride(_ input: String) -> String? {
        switch ServerAddress.validate(input) {
        case let .success(origin):
            serverOverride = origin
            connectionDiagnosis = nil
            defaults.set(origin, forKey: DefaultsKey.serverOverride)
            loginError = nil
            return nil
        case let .failure(error):
            return error.localizedDescription
        }
    }

    func clearServerOverride() {
        serverOverride = nil
        defaults.removeObject(forKey: DefaultsKey.serverOverride)
        connectionDiagnosis = nil
    }

    var hasBundledServer: Bool {
        return ServerAddress.effective(bundleValue: bundleServerUrl, override: nil) != nil
    }

    func signIn() {
        guard phase == .signedOut, loginServerUrl != nil else { return }
        beginDeviceSignIn(resuming: nil)
    }

    private func beginDeviceSignIn(resuming initial: PendingDeviceLogin?) {
        guard let serverUrl = loginServerUrl else { return }
        loginGeneration += 1
        let generation = loginGeneration
        loginTask?.cancel()
        loginError = nil
        loginStatus = "正在准备登录…"
        phase = .signingIn
        deviceLogin = initial
        let store = self.store
        let access = credentialAccess
        loginTask = Task {
            do {
                let installationId = try await access.run { try store.installationId() }
                let login = DeviceLogin(serverUrl: serverUrl)
                var pending = initial
                if pending == nil, !defaults.bool(forKey: DefaultsKey.pendingLoginCancelled) {
                    pending = try await access.run { try store.loadPendingLogin(allowInteraction: true) }
                    if pending?.isExpired == true || pending?.serverUrl != serverUrl { pending = nil }
                }
                if pending == nil {
                    // Finish deleting any cancelled/expired request before storing
                    // its replacement. Keychain operations never overlap.
                    try await access.run { try store.deletePendingLogin() }
                    let started = try await login.begin()
                    try Task.checkCancellation()
                    try await access.run { try store.savePendingLogin(started) }
                    pending = started
                }
                try Task.checkCancellation()
                guard generation == loginGeneration else { return }
                defaults.set(false, forKey: DefaultsKey.pendingLoginCancelled)
                let current = pending!
                deviceLogin = current
                loginStatus = "等待浏览器授权…"
                if initial == nil { reopenDeviceLogin() }
                let credential = try await login.complete(current, installationId: installationId,
                    name: MachineIdentity.defaultName(), hostname: MachineIdentity.hostname(), checkpoint: { pending in
                        try Task.checkCancellation()
                        try await access.run { try store.savePendingLogin(pending) }
                    }, status: { [weak self] message in
                        await self?.updateLoginStatus(message, generation: generation)
                    })
                try Task.checkCancellation()
                guard generation == loginGeneration else { return }
                // Suppress auto-login after a timed-out or cancelled save, even if
                // Security.framework writes the value after our deadline.
                defaults.set(true, forKey: DefaultsKey.credentialUnavailable)
                try await access.run { try store.saveCredential(credential) }
                try Task.checkCancellation()
                guard generation == loginGeneration else { return }
                defaults.set(false, forKey: DefaultsKey.credentialUnavailable)
                defaults.set(true, forKey: DefaultsKey.pendingLoginCancelled)
                showsRevokedNotice = false
                defaults.set(false, forKey: DefaultsKey.revokedNotice)
                deviceLogin = nil
                enterSignedIn(credential)
                // Best effort cleanup cannot turn a successful login into failure.
                do { try await access.run { try store.deletePendingLogin() } }
                catch {
                    if generation == loginGeneration { loginError = "已登录，但未能清理临时授权：\(error.localizedDescription)" }
                }
            } catch is CancellationError {
                if generation == loginGeneration, phase == .signingIn { phase = .signedOut }
            } catch {
                if generation == loginGeneration, phase == .signingIn {
                    phase = .signedOut
                    loginError = error.localizedDescription
                    deviceLogin = nil
                    // Terminal protocol failures need a new request. Network
                    // and Keychain failures keep the checkpoint for retry.
                    if error is OAuthLoginError {
                        defaults.set(true, forKey: DefaultsKey.pendingLoginCancelled)
                    } else if let apiError = error as? APIError,
                              case let .http(_, status, _) = apiError, status == 401 || status == 403 {
                        defaults.set(true, forKey: DefaultsKey.pendingLoginCancelled)
                    }
                }
            }
            if generation == loginGeneration { loginTask = nil }
        }
    }

    private func updateLoginStatus(_ message: String, generation: Int) {
        guard generation == loginGeneration else { return }
        loginStatus = message
    }

    func reopenDeviceLogin() {
        guard let pending = deviceLogin else { return }
        if !NSWorkspace.shared.open(pending.verificationUriComplete) {
            loginError = "无法打开默认浏览器。请在任意浏览器打开验证网址并输入验证码。"
        }
    }

    func cancelSignIn() {
        loginGeneration += 1
        loginTask?.cancel()
        loginTask = nil
        deviceLogin = nil
        defaults.set(true, forKey: DefaultsKey.pendingLoginCancelled)
        if phase == .signingIn { phase = .signedOut }
        // The durable cancelled flag prevents a late checkpoint being resumed.
        let store = self.store
        let access = credentialAccess
        Task { try? await access.run { try store.deletePendingLogin() } }
    }

    func confirmSignOut() {
        let alert = NSAlert()
        alert.messageText = "退出登录？"
        alert.informativeText = "这台 Mac 将不再接收派单，已经启动的会话不受影响。重新登录后，仓库映射和派单记录都还在。"
        alert.addButton(withTitle: "退出登录")
        alert.addButton(withTitle: "取消")
        NSApp.activate(ignoringOtherApps: true)
        if alert.runModal() == .alertFirstButtonReturn {
            leaveSignedIn(revoked: false)
        }
    }

    // MARK: Menu open / close

    func menuDidOpen() {
        #if DEBUG
        guard !isPreview else { return }
        #endif
        refreshLaunchAtLogin()
        guard credential != nil else { return }
        refreshUnreadSessions()
        let now = Date()
        if let last = lastOpenRefresh, now.timeIntervalSince(last) < AppModel.openRefreshThrottle {
            startMenuTimer()
            return
        }
        lastOpenRefresh = now
        refreshIntegrationStates()
        refreshProfile()
        refreshDispatches()
        startMenuTimer()
    }

    func menuDidClose() {
        menuTimer?.cancel()
        menuTimer = nil
    }

    private func startMenuTimer() {
        menuTimer?.cancel()
        menuTimer = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: UInt64(AppModel.dispatchRefreshInterval * 1_000_000_000))
                guard !Task.isCancelled, let self else { return }
                self.refreshDispatches()
            }
        }
    }

    // MARK: Refreshing

    private func refreshIntegrationStates() {
        integrationStates = Dictionary(uniqueKeysWithValues: LocalAgent.allCases.compactMap { agent in
            integrations.state(for: agent).map { (agent.rawValue, $0) }
        })
    }

    /// Optional compatibility path for nvm/custom installations. Reading PATH
    /// by launching a login shell runs its profile, so never do this implicitly.
    func importShellPath() {
        guard !importingPath, checkingIntegrations.isEmpty else { return }
        let alert = NSAlert()
        alert.messageText = "从登录 Shell 导入命令路径？"
        alert.informativeText = "这会运行一次 zsh 登录配置（例如 .zprofile）；其中的自定义命令可能触发系统权限请求。只保存得到的 PATH，以后启动不会再次执行配置。仅在使用自定义 CLI 安装位置时需要。"
        alert.addButton(withTitle: "导入一次")
        alert.addButton(withTitle: "取消")
        NSApp.activate(ignoringOtherApps: true)
        guard alert.runModal() == .alertFirstButtonReturn else { return }
        importingPath = true
        Task {
            defer { importingPath = false }
            let environment = await Task.detached { ShellEnvironment.resolve(loadLoginShell: true) }.value
            self.environment = environment
            defaults.set(environment.path, forKey: DefaultsKey.importedPath)
            if let credential { startLoop(credential) }
        }
    }

    func disableIntegration(_ agent: LocalAgent) {
        integrations.disable(agent)
        detectedAgentVersions.removeValue(forKey: agent.rawValue)
        skillSyncTracker.remove(agent.rawValue)
        refreshSkillStates()
        refreshIntegrationStates()
    }

    /// The only path that checks client login or enables an integration. A
    /// heartbeat may later refresh the Skill for enabled clients, but it never
    /// invokes this permission/login flow. Each client is independent.
    func checkAllIntegrations() {
        guard !checkingAllIntegrations, checkingIntegrations.isEmpty else { return }
        let enabled = LocalAgent.allCases.filter { integrations.state(for: $0) != nil }
        guard !enabled.isEmpty else { return }
        checkingAllIntegrations = true
        Task {
            defer { checkingAllIntegrations = false }
            for agent in enabled {
                if let check = checkIntegration(agent) { await check.value }
            }
        }
    }

    @discardableResult
    func checkIntegration(_ agent: LocalAgent) -> Task<Void, Never>? {
        guard let credential, let environment, checkingIntegrations.isEmpty, !importingPath else { return nil }
        if integrations.state(for: agent) == nil {
            let alert = NSAlert()
            if agent == .claudeCode {
                alert.messageText = "先为 MissionGo 授予完全磁盘访问权限"
                alert.informativeText = "这台无人值守执行机会由 Claude Code 访问映射仓库及任务明确要求的文件。请在「隐私与安全性 → 完全磁盘访问权限」中允许 MissionGo，再回来继续启用。该权限范围很大；ad-hoc 签名的更新仍可能要求重新授权。MissionGo 不会扫描历史项目。"
                alert.addButton(withTitle: "打开系统设置")
                alert.addButton(withTitle: "我已授权，继续")
                alert.addButton(withTitle: "取消")
            } else {
                alert.messageText = "启用 \(agent.title) 集成？"
                alert.informativeText = "将检查该客户端的安装和登录状态，并向它的 missiongo Skill 目录写入规则。收到派单后才访问映射的仓库，不会扫描历史项目。拒绝或失败后会暂停，只有点击重新检查才重试。"
                alert.addButton(withTitle: "启用并检查")
                alert.addButton(withTitle: "取消")
            }
            NSApp.activate(ignoringOtherApps: true)
            let response = alert.runModal()
            if agent == .claudeCode, response == .alertFirstButtonReturn {
                openFullDiskAccessSettings()
                return nil
            }
            let proceed: NSApplication.ModalResponse = agent == .claudeCode
                ? .alertSecondButtonReturn
                : .alertFirstButtonReturn
            guard response == proceed else { return nil }
        }
        let access = integrations
        let attempt = access.begin(agent)
        let skillTracker = skillSyncTracker
        skillTracker.remove(agent.rawValue)
        refreshSkillStates()
        checkingIntegrations.insert(agent)
        refreshIntegrationStates()
        return Task {
            defer {
                checkingIntegrations.remove(agent)
                refreshIntegrationStates()
            }
            let runner = Commands.runner(environment: environment)
            let run: CommandRunner = { file, args in
                guard access.isCurrent(agent, attempt: attempt) else {
                    return CommandResult(code: -1, stdout: "", stderr: "集成已停用")
                }
                return await runner(file, args)
            }
            let version: String
            let issue: String?
            switch agent {
            case .claudeCode:
                let status = await ClaudeCodeStatus.check(run: run)
                guard access.isCurrent(agent, attempt: attempt) else { return }
                claude = status
                if case let .ready(value) = status { version = value; issue = nil }
                else { version = ""; issue = status.summary + "。" + (status.fixHint ?? "") }
            case .codex:
                let status = await CodexStatus.check(environment: environment, location: CodexLocation(environment: environment), run: run)
                guard access.isCurrent(agent, attempt: attempt) else { return }
                codex = status
                if case let .ready(value) = status { version = value; issue = nil }
                else { version = ""; issue = status.summary + "。" + (status.fixHint ?? "") }
            case .openCode:
                do {
                    let control = OpenCodeHTTPControl()
                    let found = try await control.health()
                    let mcp = try await control.missionGoMcpStatus()
                    guard access.isCurrent(agent, attempt: attempt) else { return }
                    version = found
                    issue = OpenCodeProtocol.integrationIssue(for: mcp)
                } catch {
                    version = ""
                    issue = error.localizedDescription
                }
            }
            detectedAgentVersions[agent.rawValue] = version.isEmpty ? nil : version
            if let issue {
                access.finish(agent, attempt: attempt, version: nil, issue: issue)
                return
            }
            let target = SkillSync.target(for: agent, home: Paths.homeDirectory(), codexHome: CodexLocation(environment: environment).codexHome)
            let syncAttempt = skillTracker.begin(
                agent.rawValue, localVersion: SkillSync.localVersion(at: target),
                expectedVersion: loopState.expectedSkillVersion
            )
            refreshSkillStates()
            let result = await SkillSync.check(
                serverUrl: credential.serverUrl, target: target,
                expectedVersion: loopState.expectedSkillVersion,
                shouldApply: {
                    access.isCurrent(agent, attempt: attempt)
                        && skillTracker.isCurrent(agent.rawValue, attempt: syncAttempt)
                }
            )
            guard access.isCurrent(agent, attempt: attempt), self.credential == credential,
                  self.skillSyncTracker === skillTracker else {
                skillTracker.finish(agent.rawValue, attempt: syncAttempt, snapshot: AgentSkillSnapshot(syncState: "missing"))
                return
            }
            skillTracker.finish(agent.rawValue, attempt: syncAttempt, snapshot: result)
            refreshSkillStates()
            access.finish(agent, attempt: attempt, version: result.syncState == "ready" ? version : nil,
                          issue: result.reason)
        }
    }

    private func refreshSkillStates() {
        skillSync = skillSyncTracker.snapshots.filter { key, _ in
            LocalAgent(rawValue: key).flatMap { integrations.state(for: $0) } != nil
        }
    }

    /// Retry just the Skill for an enabled client; paused integrations retain
    /// the explicit foreground login/permission check.
    func retrySkill(_ agent: LocalAgent) {
        guard let credential, let environment, checkingIntegrations.isEmpty,
              skillSync[agent.rawValue]?.syncState != "syncing" else { return }
        guard let consent = integrations.state(for: agent), consent.version != nil else {
            checkIntegration(agent)
            return
        }
        let tracker = skillSyncTracker
        let target = SkillSync.target(for: agent, home: Paths.homeDirectory(), codexHome: CodexLocation(environment: environment).codexHome)
        let attempt = tracker.begin(
            agent.rawValue, localVersion: SkillSync.localVersion(at: target),
            expectedVersion: loopState.expectedSkillVersion
        )
        refreshSkillStates()
        let access = integrations
        let expected = loopState.expectedSkillVersion
        Task {
            let result = await SkillSync.check(
                serverUrl: credential.serverUrl, target: target, expectedVersion: expected,
                shouldApply: {
                    access.isCurrent(agent, attempt: consent.attempt)
                        && tracker.isCurrent(agent.rawValue, attempt: attempt)
                }
            )
            guard self.credential == credential, self.skillSyncTracker === tracker,
                  access.isCurrent(agent, attempt: consent.attempt) else {
                tracker.finish(agent.rawValue, attempt: attempt, snapshot: AgentSkillSnapshot(syncState: "missing"))
                refreshSkillStates()
                return
            }
            tracker.finish(agent.rawValue, attempt: attempt, snapshot: result)
            refreshSkillStates()
            loop?.retryNow()
        }
    }

    func openFullDiskAccessSettings() {
        guard let url = URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles") else { return }
        NSWorkspace.shared.open(url)
    }

    private func startUpdateTimer(_ credential: NodeCredential) {
        updateTimer?.cancel()
        updateTimer = Task { [weak self] in
            while !Task.isCancelled {
                await self?.checkForUpdate(credential)
                try? await Task.sleep(nanoseconds: UInt64(AppModel.updateCheckInterval * 1_000_000_000))
            }
        }
    }

    /// Asks the server this Mac is signed in to whether a newer client is
    /// published. Shown, never fatal: a machine that cannot reach the manifest
    /// keeps taking dispatches on the build it has.
    func checkForUpdates() {
        guard let credential else { return }
        Task { await checkForUpdate(credential, manual: true) }
    }

    func showAvailableUpdate() {
        guard case let .available(update) = updateState else { return }
        presentUpdate(update, force: true)
    }

    private func checkForUpdate(_ credential: NodeCredential, manual: Bool = false) async {
        guard let current = AppUpdater.currentVersion() else {
            updateState = .unavailable
            return
        }
        // A download or an install already under way owns this state.
        guard !updateState.isBusy else { return }
        updateNotice = nil
        updateState = .checking(current)
        do {
            let found = try await AppUpdater.check(serverUrl: credential.serverUrl, currentVersion: current)
            guard self.credential == credential, !updateState.isBusy else { return }
            if let found {
                updateState = .available(found)
                presentUpdate(found, force: manual)
            } else {
                updateState = .current(current)
                if manual { updateNotice = "当前已是最新版（\(current)）。" }
            }
        } catch {
            guard self.credential == credential, !updateState.isBusy else { return }
            updateState = .failed(current: current, reason: error.localizedDescription)
        }
    }

    /// Called from the menu. Downloading is automatic; this part is not, because
    /// it ends with the app quitting and coming back.
    func installUpdate() {
        guard case let .available(update) = updateState, let credential else { return }
        updateState = .downloading(update)
        Task {
            do {
                // The confirmation may have been open for a while. Re-fetch so
                // a superseding release cannot be installed under stale notes.
                guard let latest = try await AppUpdater.check(
                    serverUrl: credential.serverUrl,
                    currentVersion: update.current
                ) else {
                    updateState = .current(update.current)
                    updateNotice = "更新信息已变化，请重新检查。"
                    return
                }
                guard latest.manifest == update.manifest else {
                    updateState = .available(latest)
                    presentUpdate(latest, force: true)
                    return
                }
                let zip = try await AppUpdater.download(latest.manifest, serverUrl: credential.serverUrl)
                updateState = .installing(latest)
                let bundle = try await AppUpdater.install(
                    zip: zip,
                    manifest: latest.manifest,
                    replacing: Bundle.main.bundleURL,
                    expectedIdentifier: Bundle.main.bundleIdentifier
                )
                await drainLoopForRelaunch()
                relaunch(bundle)
            } catch {
                updateState = .failed(current: update.current, reason: error.localizedDescription)
            }
        }
    }

    private func presentUpdate(_ update: AppUpdater.Available, force: Bool) {
        guard force || lastPresentedUpdateVersion != update.version else { return }
        lastPresentedUpdateVersion = update.version
        let alert = NSAlert()
        alert.messageText = "发现 MissionGo \(update.version)"
        var details = "当前版本：\(update.current)"
        if let published = update.manifest.publishedAtLabel {
            details += "\n发布时间：\(published)"
        }
        if Bundle.main.object(forInfoDictionaryKey: "MissionGoAllowsAdHocUpdates") as? Bool == true {
            details += "\n\n此安装使用 ad-hoc 签名；更新后 macOS 可能要求重新授予权限。"
        }
        alert.informativeText = details
        // The notes live in a bounded, scrolling box: release after release they
        // are the only unbounded part of this alert, and a long one must never
        // push the buttons out of reach.
        alert.accessoryView = UpdateNotesView.make(text: update.manifest.releaseNotesText)
        alert.addButton(withTitle: "同意更新")
        alert.addButton(withTitle: "稍后")
        NSApp.activate(ignoringOtherApps: true)
        if alert.runModal() == .alertFirstButtonReturn { installUpdate() }
    }

    /// Stop requesting new work, then wait for an already claimed dispatch to
    /// finish its launch/report sequence before this process exits.
    private func drainLoopForRelaunch() async {
        loopGeneration += 1
        let running = loopTask
        loopTask?.cancel()
        if let running { await running.value }
        loopTask = nil
        loopStatesTask?.cancel()
        loopStatesTask = nil
    }

    /// Hands the relaunch to a detached child and quits. Sessions this app
    /// started are in their own process groups and keep running throughout --
    /// see SessionLauncher, which relies on the same thing for quit and logout.
    private func relaunch(_ bundle: URL) {
        let command = AppUpdater.relaunchCommand(bundle: bundle, pid: ProcessInfo.processInfo.processIdentifier)
        let process = Process()
        process.executableURL = URL(fileURLWithPath: command.file)
        process.arguments = command.args
        process.standardInput = FileHandle.nullDevice
        do {
            try process.run()
        } catch {
            // Installed but not restarted: saying so beats quitting into silence.
            updateState = .failed(
                current: updateState.current ?? "",
                reason: "新版本已装好，但没能自动重启，请手动打开 MissionGo。"
            )
            return
        }
        quit()
    }

    func refreshProfile() {
        #if DEBUG
        guard !isPreview else { return }
        #endif
        guard let credential else { return }
        Task {
            do {
                let profile = try await APIClient(serverUrl: credential.serverUrl, token: credential.token).me()
                guard self.credential == credential else { return }
                self.profile = profile
                self.repos = profile.repos
                self.latestProducts = profile.products
                self.profileError = nil
            } catch {
                guard self.credential == credential, !isRevoked(error) else { return }
                profileError = error.localizedDescription
            }
        }
    }

    func refreshDispatches() {
        #if DEBUG
        guard !isPreview else { return }
        #endif
        guard let credential else { return }
        Task {
            do {
                let records = try await APIClient(serverUrl: credential.serverUrl, token: credential.token).dispatches()
                guard self.credential == credential else { return }
                dispatches = records
                dispatchesError = nil
            } catch {
                guard self.credential == credential, !isRevoked(error) else { return }
                dispatchesError = error.localizedDescription
            }
        }
    }

    // MARK: Nickname

    /// Whether the server behind this login can store a nickname. One from
    /// before nicknames sends no `deviceName`, and offering an edit that server
    /// can only refuse is worse than not offering it.
    var canEditNickname: Bool {
        return profile?.node.deviceName != nil
    }

    func clearNicknameError() {
        nicknameError = nil
    }

    /// Validates, sends, and takes the answer as the new profile. `true` once
    /// the server has it, so the field can close; on `false` the reason is in
    /// `nicknameError`, next to the field.
    func saveNickname(_ input: String) async -> Bool {
        guard let credential, !savingNickname else { return false }
        let nickname: String?
        switch NodeNickname.validate(input) {
        case let .success(value):
            nickname = value
        case let .failure(error):
            nicknameError = error.localizedDescription
            return false
        }
        // Nothing to change: close without a request.
        if nickname == profile?.node.nickname {
            nicknameError = nil
            return true
        }
        savingNickname = true
        nicknameError = nil
        defer { savingNickname = false }
        do {
            // The PATCH answers with the whole profile, so it is applied as the
            // refreshed one instead of asking again.
            let updated = try await APIClient(serverUrl: credential.serverUrl, token: credential.token)
                .updateNickname(nickname)
            guard self.credential == credential else { return false }
            profile = updated
            repos = updated.repos
            latestProducts = updated.products
            profileError = nil
            return true
        } catch {
            guard self.credential == credential, !isRevoked(error) else { return false }
            nicknameError = error.localizedDescription
            return false
        }
    }

    // MARK: Repositories

    func chooseFolder(for product: NodeProfile.Product) {
        // An accessory app's panel opens behind whatever app is in front unless
        // the app is activated first.
        NSApp.activate(ignoringOtherApps: true)
        let panel = NSOpenPanel()
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.allowsMultipleSelection = false
        panel.canCreateDirectories = false
        panel.prompt = "选择"
        panel.message = "为 \(product.keyPrefix) · \(product.name) 选择本机的仓库目录"
        if let current = repoPath(for: product.id) {
            panel.directoryURL = URL(fileURLWithPath: current, isDirectory: true)
        }
        guard panel.runModal() == .OK, let url = panel.url else { return }
        assign(url.path, to: product)
    }

    func assign(_ path: String, to product: NodeProfile.Product) {
        // Picking a repository is not consent to inspect Claude's configuration.
        // The native adapter checks trust when an actual Claude dispatch starts.
        let verdict = RepoFolderCheck.evaluate(path: path, claudeJson: nil, checkClaudeTrust: false)
        switch verdict {
        case let .rejected(reason):
            repoNotices[product.id] = RepoNotice(kind: .error, text: reason)
            // The menu closes while the panel is up, so a refusal that only lived
            // inside it would go unseen.
            showAlert(title: "没有保存这个目录", message: reason)
        case .accepted, .acceptedUntrusted:
            let notice = verdict.message.map { RepoNotice(kind: .warning, text: $0) }
            save(RepoFolderCheck.assignments(from: repos, setting: product.id, to: path), for: product, notice: notice)
            if let warning = verdict.message {
                showAlert(title: "已保存，但派单暂时会失败", message: warning)
            }
        }
    }

    func clearFolder(for product: NodeProfile.Product) {
        save(RepoFolderCheck.assignments(from: repos, setting: product.id, to: nil), for: product, notice: nil)
    }

    private func save(_ assignments: [RepoAssignment], for product: NodeProfile.Product, notice: RepoNotice?) {
        guard let credential else { return }
        savingProductIds.insert(product.id)
        repoNotices[product.id] = nil
        Task {
            defer { savingProductIds.remove(product.id) }
            do {
                let saved = try await APIClient(serverUrl: credential.serverUrl, token: credential.token)
                    .replaceRepos(assignments)
                guard self.credential == credential else { return }
                repos = saved
                repoNotices[product.id] = notice
            } catch {
                guard self.credential == credential, !isRevoked(error) else { return }
                repoNotices[product.id] = RepoNotice(kind: .error, text: error.localizedDescription)
            }
        }
    }

    private func showAlert(title: String, message: String) {
        let alert = NSAlert()
        alert.messageText = title
        alert.informativeText = message
        alert.addButton(withTitle: "好")
        NSApp.activate(ignoringOtherApps: true)
        alert.runModal()
    }

    // MARK: Launch at login

    func refreshLaunchAtLogin() {
        let status = SMAppService.mainApp.status
        launchAtLogin.enabled = status == .enabled || status == .requiresApproval
        launchAtLogin.requiresApproval = status == .requiresApproval
    }

    func setLaunchAtLogin(_ enabled: Bool) {
        do {
            if enabled {
                try SMAppService.mainApp.register()
            } else {
                try SMAppService.mainApp.unregister()
            }
            launchAtLogin.error = nil
        } catch {
            launchAtLogin.error = "\(enabled ? "打开" : "关闭")开机自启失败：\(error.localizedDescription)"
        }
        refreshLaunchAtLogin()
    }

    func openLoginItemsSettings() {
        SMAppService.openSystemSettingsLoginItems()
    }

    // MARK: Small actions

    func open(_ urlString: String) {
        guard let url = URL(string: urlString) else { return }
        NSWorkspace.shared.open(url)
    }

    func openUnreadSession(_ session: UnreadSessionPreview) {
        guard let credential,
              let url = ConsoleDeepLink.session(
                serverUrl: credential.serverUrl,
                sessionId: session.sessionId,
                productId: session.items.first?.productId
              ) else { return }
        NSWorkspace.shared.open(url)
    }

    func openAllUnread() {
        guard let credential, let url = ConsoleDeepLink.unread(serverUrl: credential.serverUrl) else { return }
        NSWorkspace.shared.open(url)
    }

    func copyToClipboard(_ text: String) {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(text, forType: .string)
    }

    func quit() {
        // Sessions run in their own processes and outlive the app.
        NSApp.terminate(nil)
    }
}
