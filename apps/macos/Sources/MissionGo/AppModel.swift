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
        /// Reading the Keychain and the login shell's PATH at launch.
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

    private enum DefaultsKey {
        static let serverOverride = "serverURLOverride"
        static let revokedNotice = "lastSessionRevoked"
        static let launchAtLoginApplied = "launchAtLoginAppliedAfterFirstLogin"
    }

    static let claudeRecheckInterval: TimeInterval = 5 * 60
    static let dispatchRefreshInterval: TimeInterval = 30
    /// Opening and closing the menu quickly should not start a process each time.
    static let openRefreshThrottle: TimeInterval = 10

    // MARK: Published state

    @Published private(set) var phase: Phase = .starting
    @Published private(set) var loginError: String?
    @Published private(set) var showsRevokedNotice: Bool
    @Published private(set) var serverOverride: String?
    @Published private(set) var loopState = NodeLoopState()
    @Published private(set) var profile: NodeProfile?
    @Published private(set) var profileError: String?
    @Published private(set) var repos: [RepoMapping] = []
    @Published private(set) var repoNotices: [String: RepoNotice] = [:]
    @Published private(set) var savingProductIds: Set<String> = []
    @Published private(set) var candidates: [RepoCandidate] = []
    @Published private(set) var dispatches: [DispatchRecord] = []
    @Published private(set) var dispatchesError: String?
    @Published private(set) var claude: ClaudeCodeStatus = .checking
    @Published private(set) var launchAtLogin = LaunchAtLogin()

    // MARK: Private state

    private let store: CredentialStore = KeychainCredentialStore()
    private let defaults = UserDefaults.standard
    private let bundleServerUrl = Bundle.main.object(forInfoDictionaryKey: "MissionGoServerURL") as? String
    private var environment: ShellEnvironment?
    private var started = false
    private var loginTask: Task<Void, Never>?
    private var loopTask: Task<Void, Never>?
    private var loopStatesTask: Task<Void, Never>?
    /// Bumped whenever a loop is started or stopped, so a stopped loop that is
    /// still winding down (it may finish a long poll first) cannot write into
    /// the state of the session that replaced it.
    private var loopGeneration = 0
    private var lastLoopRepos: [RepoMapping]?
    private var lastSeenLaunchId: String?
    private var claudeTimer: Task<Void, Never>?
    private var menuTimer: Task<Void, Never>?
    private var lastClaudeCheck: Date?
    private var lastOpenRefresh: Date?

    private init() {
        showsRevokedNotice = UserDefaults.standard.bool(forKey: DefaultsKey.revokedNotice)
        serverOverride = UserDefaults.standard.string(forKey: DefaultsKey.serverOverride)
    }

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
        return (profile?.products ?? []).sorted { $0.keyPrefix < $1.keyPrefix }
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
        guard !started else { return }
        started = true
        refreshLaunchAtLogin()
        Task {
            // The login shell can take seconds to answer; never on the main thread.
            let environment = await Task.detached { ShellEnvironment.resolve() }.value
            self.environment = environment
            let credential: NodeCredential?
            do {
                credential = try store.loadCredential()
            } catch {
                credential = nil
                loginError = error.localizedDescription
            }
            if let credential {
                enterSignedIn(credential)
            } else {
                phase = .signedOut
            }
        }
    }

    private func enterSignedIn(_ credential: NodeCredential) {
        phase = .signedIn(credential)
        loginError = nil
        startLoop(credential)
        startClaudeTimer()
        refreshProfile()
        refreshDispatches()
        refreshCandidates()
    }

    private func leaveSignedIn(revoked: Bool) {
        stopLoop()
        claudeTimer?.cancel()
        claudeTimer = nil
        do {
            // The installation id stays: logging in again finds the same machine
            // with its mappings and history.
            try store.deleteCredential()
        } catch {
            loginError = error.localizedDescription
        }
        showsRevokedNotice = revoked
        defaults.set(revoked, forKey: DefaultsKey.revokedNotice)
        phase = .signedOut
        loopState = NodeLoopState()
        profile = nil
        profileError = nil
        repos = []
        repoNotices = [:]
        dispatches = []
        dispatchesError = nil
        claude = .checking
        lastClaudeCheck = nil
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

    // MARK: Node loop

    private func startLoop(_ credential: NodeCredential) {
        stopLoop()
        guard let environment else { return }
        loopGeneration += 1
        let generation = loopGeneration
        lastLoopRepos = nil
        lastSeenLaunchId = nil
        loopState = NodeLoopState()

        // A loop runs once; every login gets a fresh one.
        let loop = NodeLoop(
            api: APIClient(serverUrl: credential.serverUrl, token: credential.token),
            adapters: [SessionLauncher(environment: environment)]
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
    }

    /// Cancelling ends the loop's sleeps at once; a claim or launch already
    /// under way finishes in the background and is ignored here. Sessions it
    /// started are never touched.
    private func stopLoop() {
        loopGeneration += 1
        loopTask?.cancel()
        loopTask = nil
        loopStatesTask?.cancel()
        loopStatesTask = nil
    }

    private func apply(_ state: NodeLoopState) {
        loopState = state
        // The heartbeat carries the mapping, so a change made in the console
        // shows up here within one beat. Only a changed snapshot is applied, so
        // an unchanged one cannot overwrite a save made from the menu since.
        if state.lastHeartbeatAt != nil, state.repos != lastLoopRepos {
            lastLoopRepos = state.repos
            repos = state.repos
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
    }

    var hasBundledServer: Bool {
        return ServerAddress.effective(bundleValue: bundleServerUrl, override: nil) != nil
    }

    func signIn() {
        guard phase == .signedOut, let serverUrl = loginServerUrl else { return }
        loginError = nil
        phase = .signingIn
        let store = self.store
        loginTask = Task {
            do {
                let installationId = try store.installationId()
                let login = OAuthLogin(serverUrl: serverUrl) { url in
                    let opened = await MainActor.run { NSWorkspace.shared.open(url) }
                    if !opened {
                        throw OAuthLoginError.invalidResponse("无法打开默认浏览器，请检查系统的默认浏览器设置。")
                    }
                }
                let credential = try await login.run(
                    installationId: installationId,
                    name: MachineIdentity.defaultName(),
                    hostname: MachineIdentity.hostname()
                )
                // Cancelled after the browser already finished: the person asked to
                // stop, so the new credential is not kept.
                guard !Task.isCancelled else { return }
                try store.saveCredential(credential)
                showsRevokedNotice = false
                defaults.set(false, forKey: DefaultsKey.revokedNotice)
                enterSignedIn(credential)
                enableLaunchAtLoginAfterFirstLogin()
            } catch is CancellationError {
                if phase == .signingIn { phase = .signedOut }
            } catch {
                if phase == .signingIn {
                    phase = .signedOut
                    loginError = error.localizedDescription
                }
            }
            loginTask = nil
        }
    }

    func cancelSignIn() {
        loginTask?.cancel()
        loginTask = nil
        if phase == .signingIn { phase = .signedOut }
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
        refreshLaunchAtLogin()
        guard credential != nil else { return }
        let now = Date()
        if let last = lastOpenRefresh, now.timeIntervalSince(last) < AppModel.openRefreshThrottle {
            startMenuTimer()
            return
        }
        lastOpenRefresh = now
        refreshClaude()
        refreshProfile()
        refreshDispatches()
        refreshCandidates()
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

    private func startClaudeTimer() {
        claudeTimer?.cancel()
        claudeTimer = Task { [weak self] in
            while !Task.isCancelled {
                self?.refreshClaude(force: true)
                try? await Task.sleep(nanoseconds: UInt64(AppModel.claudeRecheckInterval * 1_000_000_000))
            }
        }
    }

    // MARK: Refreshing

    func refreshClaude(force: Bool = false) {
        guard let environment else { return }
        let now = Date()
        if !force, let last = lastClaudeCheck, now.timeIntervalSince(last) < AppModel.openRefreshThrottle { return }
        lastClaudeCheck = now
        Task {
            let status = await ClaudeCodeStatus.check(run: Commands.runner(environment: environment))
            if credential != nil { claude = status }
        }
    }

    func refreshProfile() {
        guard let credential else { return }
        Task {
            do {
                let profile = try await APIClient(serverUrl: credential.serverUrl, token: credential.token).me()
                guard self.credential == credential else { return }
                self.profile = profile
                self.repos = profile.repos
                self.profileError = nil
            } catch {
                guard self.credential == credential, !isRevoked(error) else { return }
                profileError = error.localizedDescription
            }
        }
    }

    func refreshDispatches() {
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

    private func refreshCandidates() {
        Task {
            candidates = await Task.detached { RepoCandidates.detect() }.value
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
        let verdict = RepoFolderCheck.evaluate(path: path, claudeJson: ClaudeJson.read())
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

    /// Once, after the first successful login; turning it off later sticks.
    private func enableLaunchAtLoginAfterFirstLogin() {
        guard !defaults.bool(forKey: DefaultsKey.launchAtLoginApplied) else { return }
        defaults.set(true, forKey: DefaultsKey.launchAtLoginApplied)
        if SMAppService.mainApp.status != .enabled {
            setLaunchAtLogin(true)
        }
    }

    func openLoginItemsSettings() {
        SMAppService.openSystemSettingsLoginItems()
    }

    // MARK: Small actions

    func open(_ urlString: String) {
        guard let url = URL(string: urlString) else { return }
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
