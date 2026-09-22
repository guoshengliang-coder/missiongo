import MissionGoNodeCore
import SwiftUI

struct SignedInView: View {
    @EnvironmentObject private var model: AppModel
    let credential: NodeCredential

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HeaderView(credential: credential)
            Divider()
            AgentsSection()
            Divider()
            RepositoriesSection()
            Divider()
            DispatchesSection()
            Divider()
            FooterView()
        }
    }
}

private struct HeaderView: View {
    @EnvironmentObject private var model: AppModel
    let credential: NodeCredential

    var body: some View {
        let summary = ConnectionSummary.summarize(model.loopState)
        VStack(alignment: .leading, spacing: 4) {
            MachineNameRow()
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                Circle()
                    .fill(color(summary.tone))
                    .frame(width: 8, height: 8)
                    .alignmentGuide(.firstTextBaseline) { $0[.bottom] - 1 }
                Text(summary.text)
                    .font(.callout)
                    .lineLimit(4)
                    .fixedSize(horizontal: false, vertical: true)
                    .textSelection(.enabled)
            }
            // The version rides along with the server: both answer "what is
            // this Mac running against", and the top of the menu is where
            // somebody looks for that.
            Text("\(ServerAddress.displayHost(credential.serverUrl)) · \(AppVersionLabel.text(model.appVersion))")
                .font(.caption)
                .foregroundStyle(.secondary)
                .textSelection(.enabled)
        }
    }

    private func color(_ tone: ConnectionSummary.Tone) -> Color {
        switch tone {
        case .good: return .green
        case .pending: return .yellow
        case .bad: return .red
        case .idle: return .gray
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

private struct AgentsSection: View {
    @EnvironmentObject private var model: AppModel

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            WrappingCaption(text: "按需启用客户端；未启用时不会检查登录、运行命令或写入 Skill。升级后的首次使用也需要启用。")
            IntegrationRow(agent: .claudeCode)
            IntegrationRow(agent: .codex)
            Button(model.importingPath ? "正在导入命令路径…" : "自定义安装：导入终端 PATH…") { model.importShellPath() }
                .buttonStyle(.borderless)
                .font(.caption)
                .disabled(model.importingPath || !model.checkingIntegrations.isEmpty)
            if let skill = model.skillSync {
                SkillRow(status: skill)
            }
            UpdateRow()
        }
    }
}

/// The missiongo Skill every dispatched session relies on. A failure gets its
/// whole reason, wrapped and selectable, and a way to try again now (AND-47).
private struct SkillRow: View {
    @EnvironmentObject private var model: AppModel
    let status: SkillSyncStatus

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                Text("missiongo Skill")
                    .font(.caption)
                Spacer()
                if status == .syncing {
                    ProgressView().controlSize(.mini)
                }
                Text(status.summary)
                    .font(.caption)
                    .foregroundColor(status.failureReason == nil ? .secondary : .orange)
            }
            if let reason = status.failureReason {
                WrappingCaption(text: reason, color: .orange)
                WrappingCaption(text: "已启用的客户端会稍后自动重试，也可点击对应客户端的「重新检查」。")
            }
        }
    }
}

/// Client updates, beside the agents it checks on. The version itself is in
/// the header (AND-53). The row stays visible so a person can check on demand,
/// in addition to the startup and six-hour checks.
private struct UpdateRow: View {
    @EnvironmentObject private var model: AppModel

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(alignment: .firstTextBaseline) {
                Text("MissionGo")
                    .font(.caption)
                Spacer()
                detail
            }
            if case let .failed(_, reason) = model.updateState {
                WrappingCaption(text: reason, color: .orange)
            }
            if let notice = model.updateNotice {
                WrappingCaption(text: notice)
            }
        }
    }

    @ViewBuilder private var detail: some View {
        switch model.updateState {
        case .unavailable:
            Button("检测更新") { model.checkForUpdates() }
                .buttonStyle(.borderless)
                .font(.caption)
        case let .current(version):
            HStack(spacing: 6) {
                Text(version).font(.caption).foregroundColor(.secondary)
                Button("检测更新") { model.checkForUpdates() }
                    .buttonStyle(.borderless)
                    .font(.caption)
            }
        case .checking:
            progress("正在检查更新…")
        case let .available(update):
            HStack(spacing: 6) {
                Text(update.current).font(.caption).foregroundColor(.secondary)
                Button("查看 \(update.version)") { model.showAvailableUpdate() }
                    .buttonStyle(.borderless)
                    .font(.caption)
                Button("检测更新") { model.checkForUpdates() }
                    .buttonStyle(.borderless)
                    .font(.caption)
            }
        case let .downloading(update):
            progress("正在下载 \(update.version)…")
        case let .installing(update):
            progress("正在安装 \(update.version)…")
        case let .failed(current, _):
            HStack(spacing: 6) {
                Text(current).font(.caption).foregroundColor(.orange)
                Button("重试") { model.checkForUpdates() }
                    .buttonStyle(.borderless)
                    .font(.caption)
            }
        }
    }

    private func progress(_ text: String) -> some View {
        HStack(spacing: 6) {
            ProgressView().controlSize(.mini)
            Text(text).font(.caption).foregroundColor(.secondary)
        }
    }
}

private struct IntegrationRow: View {
    @EnvironmentObject private var model: AppModel
    @State private var copied = false
    let agent: LocalAgent

    private var command: String? {
        agent == .claudeCode ? model.claude.fixCommand : model.codex.fixCommand(serverUrl: model.credential?.serverUrl)
    }

    var body: some View {
        let state = model.integrationStates[agent.rawValue]
        let checking = model.checkingIntegrations.contains(agent)
        VStack(alignment: .leading, spacing: 4) {
            HStack {
                Text(agent.title)
                Spacer()
                if checking {
                    ProgressView().controlSize(.mini)
                }
                Text(checking ? "检查中…" : (state?.version ?? (state == nil ? "未启用" : "已暂停")))
                    .foregroundColor(state?.issue == nil ? .secondary : .orange)
                Button(state == nil ? "启用…" : "重新检查") { model.checkIntegration(agent) }
                    .buttonStyle(.borderless)
                    .disabled(!model.checkingIntegrations.isEmpty || model.importingPath)
                    .help("检查登录并同步该客户端的 missiongo Skill；不会检查另一个客户端。")
                if state != nil {
                    Button("停用") { model.disableIntegration(agent) }
                        .buttonStyle(.borderless)
                }
            }
            if !checking, let hint = state?.issue {
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    WrappingCaption(text: hint)
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
