import MissionGoNodeCore
import SwiftUI

struct SignedInView: View {
    @EnvironmentObject private var model: AppModel
    let credential: NodeCredential

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HeaderView(credential: credential)
            Divider()
            ClaudeCodeRow()
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
            Text(ServerAddress.displayHost(credential.serverUrl))
                .font(.caption)
                .foregroundStyle(.secondary)
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

private struct ClaudeCodeRow: View {
    @EnvironmentObject private var model: AppModel
    @State private var copied = false

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack {
                Text("Claude Code")
                Spacer()
                if model.claude == .checking {
                    ProgressView().controlSize(.mini)
                }
                Text(model.claude.summary)
                    .foregroundColor(model.claude.isReady || model.claude == .checking ? .secondary : .orange)
            }
            if let hint = model.claude.fixHint {
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    WrappingCaption(text: hint)
                    if let command = model.claude.fixCommand {
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
