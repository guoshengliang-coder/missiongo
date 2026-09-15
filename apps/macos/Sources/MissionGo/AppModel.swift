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
        static let serverOverride = "serverURLOverride"
        static let revokedNotice = "lastSessionRevoked"
        static let launchAtLoginApplied = "launchAtLoginAppliedAfterFirstLogin"
    }

    static let claudeRecheckInterval: TimeInterval = 5 * 60
    /// The Skill changes with releases, not minutes; the first sync runs at login.
    static let skillSyncInterval: TimeInterval = 60 * 60
    /// Releases are days apart, and the check costs a request against the
    /// deployment this Mac is already heartbeating to every 30 seconds. Once at
    /// login is what actually catches most of them.
    static let updateCheckInterval: TimeInterval = 6 * 60 * 60
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
    @Published private(set) var savingNickname = false
    @Published private(set) var nicknameError: String?
    @Published private(set) var repos: [RepoMapping] = []
    @Published private(set) var repoNotices: [String: RepoNotice] = [:]
    @Published private(set) var savingProductIds: Set<String> = []
    @Published private(set) var candidates: [RepoCandidate] = []
    /// The product list from whichever answer arrived last — the heartbeat every
    /// 30 seconds, or a profile refresh. nil until one of them has answered.
    @Published private var latestProducts: [NodeProfile.Product]?
    @Published private(set) var dispatches: [DispatchRecord] = []
    @Published private(set) var dispatchesError: String?
    @Published private(set) var claude: ClaudeCodeStatus = .checking
    @Published private(set) var codex: CodexStatus = .checking
    /// One line for the menu: the synced version, or why it failed.
    @Published private(set) var skillSyncSummary: String?
    @Published private(set) var skillSyncFailed = false
    @Published private(set) var launchAtLogin = LaunchAtLogin()
    /// The client's own version, and whether a newer one is published.
    @Published private(set) var updateState: UpdateState = .unavailable

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
    private var skillTimer: Task<Void, Never>?
    private var updateTimer: Task<Void, Never>?
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
        guard !started else { return }
        started = true
        // Before any network call: the menu should be able to say which version
        // this is even when the check never gets to run.
        updateState = AppUpdater.currentVersion().map { .current($0) } ?? .unavailable
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
        startSkillTimer(credential)
        startUpdateTimer(credential)
        refreshProfile()
        refreshDispatches()
        refreshCandidates()
    }

    private func leaveSignedIn(revoked: Bool) {
        stopLoop()
        claudeTimer?.cancel()
        claudeTimer = nil
        skillTimer?.cancel()
        skillTimer = nil
        updateTimer?.cancel()
        updateTimer = nil
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
        savingNickname = false
        nicknameError = nil
        repos = []
        repoNotices = [:]
        dispatches = []
        dispatchesError = nil
        claude = .checking
        codex = .checking
        skillSyncSummary = nil
        skillSyncFailed = false
        // The version is a property of this build, not of the session, so it
        // stays; anything in flight does not.
        updateState = AppUpdater.currentVersion().map { .current($0) } ?? .unavailable
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
        latestProducts = nil
        lastSeenLaunchId = nil
        loopState = NodeLoopState()

        // A loop runs once; every login gets a fresh one.
        let loop = NodeLoop(
            api: APIClient(serverUrl: credential.serverUrl, token: credential.token),
            adapters: [
                SessionLauncher(environment: environment),
                CodexLauncher(environment: environment, serverUrl: credential.serverUrl),
            ],
            fallbackNodeName: credential.name
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
            let run = Commands.runner(environment: environment)
            async let claudeStatus = ClaudeCodeStatus.check(run: run)
            async let codexStatus = CodexStatus.check(
                environment: environment, location: CodexLocation(environment: environment), run: run
            )
            let (claudeResult, codexResult) = await (claudeStatus, codexStatus)
            if credential != nil {
                claude = claudeResult
                codex = codexResult
            }
        }
    }

    private func startSkillTimer(_ credential: NodeCredential) {
        skillTimer?.cancel()
        skillTimer = Task { [weak self] in
            while !Task.isCancelled {
                await self?.syncSkill(credential)
                try? await Task.sleep(nanoseconds: UInt64(AppModel.skillSyncInterval * 1_000_000_000))
            }
        }
    }

    /// Fetches the Skill from the server this Mac is logged in to and updates
    /// the agents' copies. A failure is shown, never fatal: a session still
    /// starts with whatever copy is installed.
    private func syncSkill(_ credential: NodeCredential) async {
        guard let environment else { return }
        let targets = SkillSync.targets(
            home: Paths.homeDirectory(), codexHome: CodexLocation(environment: environment).codexHome
        )
        do {
            let outcome = try await SkillSync.run(serverUrl: credential.serverUrl, targets: targets)
            guard self.credential == credential else { return }
            if !outcome.updated.isEmpty {
                NSLog("%@", "missiongo Skill 已更新到 \(outcome.version)：\(outcome.updated.joined(separator: "，"))")
            }
            if outcome.failures.isEmpty {
                skillSyncSummary = outcome.version
                skillSyncFailed = false
            } else {
                skillSyncSummary = "写入失败：\(outcome.failures.joined(separator: "；"))"
                skillSyncFailed = true
            }
        } catch {
            guard self.credential == credential else { return }
            skillSyncSummary = error.localizedDescription
            skillSyncFailed = true
        }
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
    private func checkForUpdate(_ credential: NodeCredential) async {
        guard let current = AppUpdater.currentVersion() else {
            updateState = .unavailable
            return
        }
        // A download or an install already under way owns this state.
        guard !updateState.isBusy else { return }
        updateState = .checking(current)
        do {
            let found = try await AppUpdater.check(serverUrl: credential.serverUrl, currentVersion: current)
            guard self.credential == credential, !updateState.isBusy else { return }
            updateState = found.map { .available($0) } ?? .current(current)
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
                let zip = try await AppUpdater.download(update.manifest, serverUrl: credential.serverUrl)
                updateState = .installing(update)
                let bundle = try await AppUpdater.install(
                    zip: zip,
                    manifest: update.manifest,
                    replacing: Bundle.main.bundleURL,
                    expectedIdentifier: Bundle.main.bundleIdentifier
                )
                relaunch(bundle)
            } catch {
                updateState = .failed(current: update.current, reason: error.localizedDescription)
            }
        }
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
