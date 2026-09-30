import AppKit
import MissionGoNodeCore
import SwiftUI

enum MenuPalette {
    private static func adaptive(_ light: NSColor, _ dark: NSColor) -> Color {
        Color(nsColor: NSColor(name: nil) { appearance in
            appearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua ? dark : light
        })
    }

    static let canvas = adaptive(NSColor(srgbRed: 246 / 255, green: 249 / 255, blue: 248 / 255, alpha: 1),
                                 NSColor(srgbRed: 28 / 255, green: 34 / 255, blue: 35 / 255, alpha: 1))
    static let surface = adaptive(.white, NSColor(srgbRed: 37 / 255, green: 43 / 255, blue: 44 / 255, alpha: 1))
    static let groupHeader = adaptive(NSColor(srgbRed: 237 / 255, green: 243 / 255, blue: 242 / 255, alpha: 1),
                                      NSColor(srgbRed: 46 / 255, green: 57 / 255, blue: 56 / 255, alpha: 1))
    static let divider = adaptive(NSColor(srgbRed: 220 / 255, green: 230 / 255, blue: 228 / 255, alpha: 1),
                                  NSColor(srgbRed: 67 / 255, green: 77 / 255, blue: 76 / 255, alpha: 1))
    static let sectionText = adaptive(NSColor(srgbRed: 66 / 255, green: 93 / 255, blue: 98 / 255, alpha: 1), .white)
    static let secondaryText = adaptive(NSColor(srgbRed: 99 / 255, green: 115 / 255, blue: 123 / 255, alpha: 1),
                                        NSColor(srgbRed: 183 / 255, green: 195 / 255, blue: 195 / 255, alpha: 1))
    static let action = adaptive(NSColor(srgbRed: 22 / 255, green: 107 / 255, blue: 80 / 255, alpha: 1),
                                 NSColor(srgbRed: 113 / 255, green: 224 / 255, blue: 183 / 255, alpha: 1))
    static let badge = adaptive(NSColor(srgbRed: 104 / 255, green: 223 / 255, blue: 178 / 255, alpha: 1),
                                NSColor(srgbRed: 57 / 255, green: 154 / 255, blue: 122 / 255, alpha: 1))
}

struct SignedInView: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.openWindow) private var openWindow
    @State private var showingConnectionError = false
    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 11) {
                Image(nsImage: NSApp.applicationIconImage)
                    .resizable()
                    .interpolation(.high)
                    .frame(width: 32, height: 32)
                    .clipShape(RoundedRectangle(cornerRadius: 9))
                Text(Bundle.main.object(forInfoDictionaryKey: "CFBundleDisplayName") as? String ?? "应用")
                    .font(.system(size: 16, weight: .medium))
                Text("·")
                    .foregroundStyle(.secondary)
                Text(model.machineName)
                    .font(.system(size: 12))
                    .lineLimit(1)
                    .truncationMode(.middle)
                    .help(model.machineName)
                Spacer(minLength: 0)
            }
            .padding(.horizontal, 12)
            .padding(.top, 10)
            .padding(.bottom, 11)
            .background(MenuPalette.canvas)
            .overlay(alignment: .bottom) { MenuPalette.divider.frame(height: 1) }

            ScrollView {
                VStack(alignment: .leading, spacing: 8) {
                    UnreadSection()
                    AgentStatusSection()
                    VersionStatusSection()
                }
            }
            .frame(maxHeight: min(620, max(160, (NSScreen.main?.visibleFrame.height ?? 800) - 120)))
            .background(MenuPalette.canvas)

            HStack(spacing: 7) {
                let summary = ConnectionSummary.summarize(model.loopState)
                Circle()
                    .fill(connectionColor(summary.tone))
                    .frame(width: 7, height: 7)
                Text("\(model.machineName) \(summary.text)")
                    .font(.caption)
                    .lineLimit(1)
                    .truncationMode(.tail)
                    .help(summary.text)
                Spacer(minLength: 0)
                if let error = model.loopState.lastError {
                    Button("详情") { showingConnectionError = true }
                        .font(.caption)
                        .popover(isPresented: $showingConnectionError) {
                            VStack(alignment: .leading, spacing: 12) {
                                Text("连接与接口错误").font(.headline)
                                ScrollView {
                                    Text(error).font(.system(.body, design: .monospaced))
                                        .textSelection(.enabled)
                                        .frame(maxWidth: .infinity, alignment: .leading)
                                }
                                .frame(maxHeight: 300)
                                Button("复制错误") {
                                    NSPasteboard.general.clearContents()
                                    NSPasteboard.general.setString(error, forType: .string)
                                }
                            }
                            .padding(16)
                            .frame(width: 420)
                        }
                }
                if model.loopState.connection == .offline || model.loopState.connection == .degraded {
                    Button("重新连接") { model.reconnect() }
                        .font(.caption)
                        .help("自动重试中；点击可立即重试")
                }
                Button { openWindow(id: "local-settings") } label: {
                    Image(systemName: "gearshape")
                        .frame(width: 30, height: 30)
                }
                .buttonStyle(.plain)
                .help("本机设置")
                .accessibilityLabel("本机设置")
            }
            .padding(.horizontal, 12)
            .frame(minHeight: 43)
            .background(MenuPalette.canvas)
            .overlay(alignment: .top) { MenuPalette.divider.frame(height: 1) }
        }
        .background(MenuPalette.canvas)
    }

    private func connectionColor(_ tone: ConnectionSummary.Tone) -> Color {
        switch tone {
        case .good: return MenuPalette.action
        case .pending: return .yellow
        case .bad: return .red
        case .idle: return .gray
        }
    }
}

private struct MenuGroup<Content: View>: View {
    let title: String
    let symbol: String
    let meta: String?
    let trailing: AnyView?
    let content: Content

    init(title: String, symbol: String, meta: String? = nil, trailing: AnyView? = nil, @ViewBuilder content: () -> Content) {
        self.title = title
        self.symbol = symbol
        self.meta = meta
        self.trailing = trailing
        self.content = content()
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 7) {
                Image(systemName: symbol).frame(width: 16)
                Text(title).font(.system(size: 12, weight: .semibold))
                if let meta {
                    Text(meta).font(.system(size: 11)).foregroundStyle(MenuPalette.secondaryText)
                        .padding(.leading, 4)
                }
                Spacer(minLength: 4)
                trailing
            }
            .foregroundStyle(MenuPalette.sectionText)
            .padding(.horizontal, 12)
            .frame(minHeight: 37)
            .background(MenuPalette.groupHeader)
            .overlay(alignment: .top) { MenuPalette.divider.frame(height: 1) }
            .overlay(alignment: .bottom) { MenuPalette.divider.frame(height: 1) }
            content
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(MenuPalette.surface)
                .overlay(alignment: .bottom) { MenuPalette.divider.frame(height: 1) }
        }
    }
}

private struct UnreadSection: View {
    @EnvironmentObject private var model: AppModel

    var body: some View {
        MenuGroup(title: "未读会话", symbol: "bubble.left", trailing: AnyView(
            Group {
                if let count = model.unreadCount {
                    Text(String(count))
                        .font(.caption.weight(.semibold))
                        .padding(.horizontal, 7)
                        .frame(minWidth: 25, minHeight: 25)
                        .foregroundStyle(Color(red: 16 / 255, green: 87 / 255, blue: 67 / 255))
                        .background(MenuPalette.badge, in: RoundedRectangle(cornerRadius: 8))
                        .accessibilityLabel("未读会话 \(count) 条")
                }
            }
        )) {
            if let error = model.unreadError {
                VStack(alignment: .leading, spacing: 5) {
                    Text(error).font(.caption).foregroundStyle(.orange)
                    Button("重试") { model.refreshUnreadSessions() }.font(.caption)
                }
                .padding(12)
            } else if model.unreadCount == nil {
                ProgressView("正在读取未读会话…").controlSize(.small)
                    .padding(12)
            } else if model.unreadSessions.isEmpty {
                VStack(alignment: .leading, spacing: 2) {
                    Text("这台 Mac 已就绪").font(.subheadline.weight(.medium))
                    Text("没有未读会话").font(.caption).foregroundStyle(.secondary)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(12)
            } else {
                ScrollView {
                    LazyVStack(spacing: 0) {
                        ForEach(model.unreadSessions) { session in
                            Button { model.openUnreadSession(session) } label: {
                                VStack(alignment: .leading, spacing: 3) {
                                    Text(session.title)
                                        .font(.subheadline.weight(.medium))
                                        .lineLimit(1)
                                    HStack(spacing: 3) {
                                        Text(agentName(session.agentKind))
                                        Text("·")
                                        Text(session.nodeName)
                                        Text("·")
                                        if let date = sessionDate(session.activityAt) {
                                            Text(date, style: .relative)
                                        }
                                        Spacer(minLength: 0)
                                        Image(systemName: "arrow.up.right")
                                    }
                                    .font(.caption)
                                    .foregroundStyle(MenuPalette.secondaryText)
                                    .lineLimit(1)
                                }
                                .padding(.horizontal, 12)
                                .frame(maxWidth: .infinity, minHeight: 57, alignment: .leading)
                                .contentShape(Rectangle())
                            }
                            .buttonStyle(.plain)
                            .help(session.title)
                            .accessibilityLabel("\(session.title)，\(agentName(session.agentKind))，\(session.nodeName)，\(relativeTime(session.activityAt))，在 Web 打开会话")
                            MenuPalette.divider.frame(height: 1)
                        }
                    }
                }
                .frame(height: min(CGFloat(model.unreadSessions.count) * 58, 232))
                Button("在 Web 查看全部 \(model.unreadCount ?? 0) 条 ↗") { model.openAllUnread() }
                    .buttonStyle(.plain)
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(MenuPalette.action)
                    .frame(maxWidth: .infinity, minHeight: 34)
                    .overlay(alignment: .top) { MenuPalette.divider.frame(height: 1) }
            }
        }
    }

    private func agentName(_ kind: String) -> String {
        switch kind {
        case "claude_code": return "Claude Code"
        case "codex": return "Codex"
        case "opencode": return "OpenCode"
        default: return kind
        }
    }

    private func sessionDate(_ value: String) -> Date? {
        let parser = ISO8601DateFormatter()
        parser.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return parser.date(from: value)
    }

    private func relativeTime(_ value: String) -> String {
        guard let date = sessionDate(value) else { return "时间未知" }
        let formatter = RelativeDateTimeFormatter()
        formatter.unitsStyle = .short
        return formatter.localizedString(for: date, relativeTo: Date())
    }
}

private struct AgentStatusSection: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.openWindow) private var openWindow

    private var readyCount: Int {
        LocalAgent.allCases.filter { agent in
            guard let state = model.integrationStates[agent.rawValue] else { return false }
            return state.version != nil && state.issue == nil
        }.count
    }

    var body: some View {
        MenuGroup(title: "Agent 状态", symbol: "cpu", meta: "\(readyCount) 个就绪", trailing: AnyView(
            Button("重新检查") { model.checkAllIntegrations() }
                .buttonStyle(.plain)
                .font(.system(size: 11, weight: .medium))
                .foregroundStyle(MenuPalette.action)
                .frame(minHeight: 30)
                .disabled(model.integrationStates.isEmpty || model.checkingAllIntegrations || !model.checkingIntegrations.isEmpty)
        )) {
            VStack(alignment: .leading, spacing: 7) {
                ForEach(LocalAgent.allCases, id: \.rawValue) { agent in
                    let state = model.integrationStates[agent.rawValue]
                    let checking = model.checkingIntegrations.contains(agent)
                    let ready = state?.version != nil && state?.issue == nil
                    HStack(spacing: 7) {
                        AgentMark(agent: agent)
                        Text(agent.title).font(.subheadline.weight(.medium))
                        Spacer(minLength: 4)
                        Circle().fill(ready ? MenuPalette.action : (state == nil ? Color.gray : Color.orange))
                            .frame(width: 6, height: 6)
                        Text(checking ? "检查中" : ready ? "就绪" : state == nil ? "未启用" : "需处理")
                        if let version = model.detectedAgentVersions[agent.rawValue] ?? state?.version {
                            Text("· \(version)")
                        }
                    }
                    .font(.system(size: 11))
                    .frame(minHeight: 32)
                    .accessibilityElement(children: .combine)
                    if let issue = state?.issue, !checking {
                        Text(issue)
                            .font(.caption)
                            .foregroundStyle(.orange)
                            .fixedSize(horizontal: false, vertical: true)
                        Button("查看处理方法") {
                            UserDefaults.standard.set("Agent", forKey: "localSettingsTab")
                            openWindow(id: "local-settings")
                        }
                        .font(.caption)
                    }
                }
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 6)
        }
    }
}

private struct AgentMark: View {
    let agent: LocalAgent

    var body: some View {
        Group {
            if let url = Bundle.module.url(forResource: agent.rawValue, withExtension: "png"),
               let image = NSImage(contentsOf: url) {
                Image(nsImage: image)
                    .resizable()
                    .renderingMode(.template)
                    .foregroundStyle(color)
            } else {
                Image(systemName: "cpu")
                    .foregroundStyle(color)
            }
        }
        .frame(width: 19, height: 19)
        .accessibilityHidden(true)
    }

    private var color: Color {
        switch agent {
        case .claudeCode: return .orange
        case .codex: return .indigo
        case .openCode: return .primary
        }
    }
}

private struct VersionStatusSection: View {
    @EnvironmentObject private var model: AppModel

    var body: some View {
        MenuGroup(title: "版本与更新", symbol: "shippingbox", trailing: AnyView(
            Button("检查客户端更新") { model.checkForUpdates() }
                .buttonStyle(.plain)
                .font(.system(size: 11, weight: .medium))
                .foregroundStyle(MenuPalette.action)
                .frame(minHeight: 30)
                .disabled(model.updateState.isBusy || updateChecking || model.appVersion == nil)
        )) {
            VStack(alignment: .leading, spacing: 6) {
                HStack(spacing: 7) {
                    Image(systemName: "book.closed").frame(width: 19)
                    Text("Skill")
                    Spacer()
                    Text(model.integrationStates.isEmpty ? "未启用" : (model.skillSync?.summary ?? "未检查"))
                        .foregroundStyle(MenuPalette.secondaryText)
                    if !model.integrationStates.isEmpty, case .synced? = model.skillSync {
                        Text("· 自动同步").foregroundStyle(MenuPalette.secondaryText)
                    }
                }
                .frame(minHeight: 32)
                if let reason = model.skillSync?.failureReason {
                    Text(reason).font(.caption).foregroundStyle(.orange)
                    Text("可在 Agent 状态点击重新检查重试。")
                        .font(.caption).foregroundStyle(.secondary)
                }
                HStack(spacing: 7) {
                    Image(systemName: "laptopcomputer").frame(width: 19)
                    Text("Mac 客户端")
                    Spacer()
                    Text(model.appVersion ?? "开发构建")
                        .foregroundStyle(MenuPalette.secondaryText)
                    Text("· \(updateLabel)")
                        .foregroundStyle(MenuPalette.secondaryText)
                }
                .frame(minHeight: 32)
                if case let .available(update) = model.updateState {
                    Button("查看 \(update.version) 的更新内容") { model.showAvailableUpdate() }
                        .font(.caption)
                }
                if case let .failed(_, reason) = model.updateState {
                    Text(reason).font(.caption).foregroundStyle(.orange)
                }
                if let notice = model.updateNotice {
                    Text(notice).font(.caption).foregroundStyle(.secondary)
                }
            }
            .font(.caption)
            .padding(.horizontal, 12)
            .padding(.vertical, 6)
        }
    }

    private var updateLabel: String {
        switch model.updateState {
        case .unavailable: return "无版本信息"
        case .current: return "已是最新"
        case .checking: return "检查中"
        case .available: return "发现更新"
        case .downloading: return "下载中"
        case .installing: return "安装中"
        case .failed: return "检查失败"
        }
    }

    private var updateChecking: Bool {
        if case .checking = model.updateState { return true }
        return false
    }
}

struct LocalSettingsView: View {
    @EnvironmentObject private var model: AppModel
    @AppStorage("localSettingsTab") private var selectedTab = Tab.device.rawValue

    private enum Tab: String, CaseIterable {
        case device = "设备"
        case agent = "Agent"
        case repositories = "仓库"

        var symbol: String {
            switch self {
            case .device: return "laptopcomputer"
            case .agent: return "cpu"
            case .repositories: return "folder"
            }
        }
    }

    private var tab: Tab { Tab(rawValue: selectedTab) ?? .device }

    var body: some View {
        HStack(spacing: 0) {
            VStack(alignment: .leading, spacing: 8) {
                HStack(spacing: 9) {
                    Image(nsImage: NSApp.applicationIconImage)
                        .resizable()
                        .interpolation(.high)
                        .frame(width: 31, height: 31)
                        .clipShape(RoundedRectangle(cornerRadius: 8))
                    VStack(alignment: .leading, spacing: 2) {
                        Text(model.machineName).font(.headline).lineLimit(1)
                        Text("这台 Mac").font(.caption).foregroundStyle(.secondary)
                    }
                }
                Divider().padding(.vertical, 8)
                ForEach(Tab.allCases, id: \.self) { option in
                    Button {
                        selectedTab = option.rawValue
                        if option == .device { model.refreshDispatches() }
                    } label: {
                        Label(option.rawValue, systemImage: option.symbol)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .padding(.vertical, 7)
                            .padding(.horizontal, 9)
                    }
                    .buttonStyle(.plain)
                    .background(tab == option ? Color.accentColor.opacity(0.14) : Color.clear,
                                in: RoundedRectangle(cornerRadius: 7))
                    .accessibilityAddTraits(tab == option ? .isSelected : [])
                }
                Spacer()
                Text("MissionGo for macOS")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            .padding(18)
            .frame(width: 180)
            .background(Color(nsColor: .controlBackgroundColor))

            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    Text(tab.rawValue).font(.title2.weight(.semibold))
                    switch tab {
                    case .device:
                        MachineNameRow()
                        if let server = model.consoleUrl {
                            Text("服务：\(ServerAddress.displayHost(server))")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                        Divider()
                        DispatchesSection()
                        Divider()
                        FooterView()
                    case .agent:
                        Text("管理允许在这台 Mac 上执行任务的客户端。")
                            .foregroundStyle(.secondary)
                        IntegrationRow(agent: .claudeCode)
                        Divider()
                        IntegrationRow(agent: .codex)
                        Divider()
                        IntegrationRow(agent: .openCode)
                        Divider()
                        Button(model.importingPath ? "正在导入终端 PATH…" : "导入终端 PATH…") {
                            model.importShellPath()
                        }
                        .disabled(model.importingPath || !model.checkingIntegrations.isEmpty)
                    case .repositories:
                        RepositoriesSection()
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(28)
            }
        }
        .frame(minWidth: 580, minHeight: 440)
        .onAppear {
            model.refreshProfile()
            model.refreshDispatches()
        }
    }
}

/// The machine's name, and the place to give it a nickname.
///
/// The nickname is what dispatched sessions are named after, so with several
/// Macs taking work it is what tells their sessions apart. Edited inline rather
/// than in a sheet: the menu closes as soon as another window takes focus.
private struct MachineNameRow: View {
    @EnvironmentObject private var model: AppModel
    @State private var editing = false
    @State private var draft = ""

    var body: some View {
        let node = model.profile?.node
        let nickname = node?.nickname
        let deviceName = node?.deviceName ?? model.machineName
        VStack(alignment: .leading, spacing: 4) {
            if editing {
                HStack(spacing: 6) {
                    TextField(deviceName, text: $draft)
                        .textFieldStyle(.roundedBorder)
                        .controlSize(.small)
                        .onSubmit { save(draft) }
                        .onChange(of: draft) { _ in model.clearNicknameError() }
                    if model.savingNickname {
                        ProgressView().controlSize(.mini)
                    }
                    // No default-button shortcut: Return already submits the field,
                    // and a second path to the same request could send it twice.
                    Button("保存") { save(draft) }
                        .controlSize(.small)
                    Button("取消") {
                        editing = false
                        model.clearNicknameError()
                    }
                    .controlSize(.small)
                }
                .disabled(model.savingNickname)
                if nickname != nil {
                    Button("恢复为设备名") { save("") }
                        .buttonStyle(.borderless)
                        .font(.caption)
                        .disabled(model.savingNickname)
                        .help("清除昵称，派单会话改用设备名「\(deviceName)」命名")
                }
                if let error = model.nicknameError {
                    WrappingCaption(text: error, color: .red)
                }
            } else {
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    Text(model.machineName)
                        .font(.headline)
                        .lineLimit(1)
                        .truncationMode(.middle)
                        .help(model.machineName)
                    if model.canEditNickname {
                        Button(nickname == nil ? "设置昵称" : "修改昵称") {
                            draft = nickname ?? ""
                            model.clearNicknameError()
                            editing = true
                        }
                        .buttonStyle(.borderless)
                        .font(.caption)
                        .help("派单会话以昵称命名，留空则使用设备名")
                    }
                    Spacer(minLength: 0)
                }
                if nickname != nil {
                    Text("设备名：\(deviceName)")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                        .truncationMode(.middle)
                }
            }
        }
    }

    private func save(_ input: String) {
        Task {
            if await model.saveNickname(input) {
                editing = false
            }
        }
    }
}

private struct IntegrationRow: View {
    @EnvironmentObject private var model: AppModel
    @State private var copied = false
    let agent: LocalAgent

    private var command: String? {
        switch agent {
        case .claudeCode: return model.claude.fixCommand
        case .codex: return model.codex.fixCommand(serverUrl: model.credential?.serverUrl)
        case .openCode: return nil
        }
    }

    var body: some View {
        let state = model.integrationStates[agent.rawValue]
        let checking = model.checkingIntegrations.contains(agent)
        VStack(alignment: .leading, spacing: 4) {
            HStack {
                VStack(alignment: .leading, spacing: 3) {
                    Text(agent.title)
                        .font(.subheadline.weight(.medium))
                    Text(checking ? "检查中…" : state == nil ? "已停用" : state?.issue == nil ? "本机已安装" : "需处理")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                Spacer()
                if checking {
                    ProgressView().controlSize(.mini)
                }
                Toggle("启用 \(agent.title)", isOn: Binding(
                    get: { model.integrationStates[agent.rawValue] != nil },
                    set: { enabled in
                        if enabled { model.checkIntegration(agent) }
                        else { model.disableIntegration(agent) }
                    }
                ))
                .labelsHidden()
                .toggleStyle(.switch)
                .disabled(!model.checkingIntegrations.isEmpty || model.importingPath)
                .help("关闭后，此 Agent 不再参与登录检测、派单和 Skill 同步。")
            }
            if !checking, let hint = state?.issue {
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    WrappingCaption(text: hint)
                    Button("重新检查") { model.checkIntegration(agent) }
                        .buttonStyle(.borderless)
                        .font(.caption)
                        .disabled(!model.checkingIntegrations.isEmpty || model.importingPath)
                    if let command {
                        Button {
                            model.copyToClipboard(command)
                            copied = true
                            Task {
                                try? await Task.sleep(nanoseconds: 1_500_000_000)
                                copied = false
                            }
                        } label: {
                            Label(copied ? "已复制" : "复制命令", systemImage: copied ? "checkmark" : "doc.on.doc")
                                .font(.caption)
                        }
                        .buttonStyle(.borderless)
                        .help(command)
                    }
                    Spacer(minLength: 0)
                }
            }
            if agent == .claudeCode {
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    WrappingCaption(text: "无人值守任务建议授予完全磁盘访问；ad-hoc 更新后可能需要重新授权。")
                    Button("打开权限设置") { model.openFullDiskAccessSettings() }
                        .buttonStyle(.borderless)
                        .font(.caption)
                    Spacer(minLength: 0)
                }
            }
        }
        .frame(maxWidth: .infinity, minHeight: 60, alignment: .leading)
    }
}

private struct FooterView: View {
    @EnvironmentObject private var model: AppModel

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Toggle(isOn: Binding(
                get: { model.launchAtLogin.enabled },
                set: { model.setLaunchAtLogin($0) }
            )) {
                Text("开机自启")
            }
            .toggleStyle(.switch)
            .controlSize(.small)

            if model.launchAtLogin.requiresApproval {
                HStack(alignment: .firstTextBaseline) {
                    WrappingCaption(text: "还需要在「系统设置 → 通用 → 登录项」里允许 MissionGo。", color: .orange)
                    Button("打开") { model.openLoginItemsSettings() }
                        .buttonStyle(.borderless)
                        .font(.caption)
                }
            }
            if let error = model.launchAtLogin.error {
                WrappingCaption(text: error, color: .red)
            }

            HStack {
                if let console = model.consoleUrl {
                    Button("打开控制台") { model.open(console) }
                }
                Spacer()
                Button("退出登录") { model.confirmSignOut() }
                Button("退出 MissionGo") { model.quit() }
            }
        }
    }
}
