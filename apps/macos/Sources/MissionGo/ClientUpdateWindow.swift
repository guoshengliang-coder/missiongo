import AppKit
import SwiftUI
import MissionGoNodeCore

/// One window observes the existing update task from consent through relaunch.
@MainActor
final class ClientUpdateWindowController: NSObject, NSWindowDelegate {
    let window: NSWindow
    private weak var model: AppModel?

    init(model: AppModel) {
        self.model = model
        let host = NSHostingView(rootView: ClientUpdateView().environmentObject(model))
        if #available(macOS 13.3, *) { host.sizingOptions = [] }
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 500, height: 540),
                          styleMask: [.titled, .closable, .resizable], backing: .buffered, defer: false)
        super.init()
        window.title = "客户端更新"
        window.contentMinSize = NSSize(width: 360, height: 320)
        window.contentView = host
        window.isReleasedWhenClosed = false
        window.delegate = self
        window.center()
    }

    func show() {
        NSApp.activate(ignoringOtherApps: true)
        window.makeKeyAndOrderFront(nil)
    }

    func windowShouldClose(_ sender: NSWindow) -> Bool {
        // Closing a window must not pretend to cancel a download or installation.
        model?.updateState.isBusy != true
    }
}

struct ClientUpdateView: View {
    @EnvironmentObject private var model: AppModel
    @State private var confirmsImmediateRestart = false

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text(model.updateOffer.map { "MissionGo \($0.version)" } ?? "客户端更新")
                .font(.title2.bold())
            Text("当前运行版本：\(model.updateState.current ?? model.appVersion ?? "开发构建")")
                .foregroundStyle(.secondary)
            ScrollView {
                VStack(alignment: .leading, spacing: 12) {
                    if let activity = model.updateActivity {
                        Divider()
                        Text(activity.stage.rawValue).font(.headline)
                        TimelineView(.periodic(from: .now, by: 1)) { context in
                            Text(activity.detail(now: context.date))
                                .fixedSize(horizontal: false, vertical: true)
                        }
                        if activity.stage == .downloading {
                            ProgressView(value: activity.fraction).accessibilityLabel("更新下载进度")
                        } else if model.updateState.isBusy && activity.stage != .waiting {
                            ProgressView().controlSize(.small)
                        }
                        DisclosureGroup("本次更新诊断") {
                            Text(activity.diagnostics).font(.caption).textSelection(.enabled)
                            Button("复制诊断") { model.copyToClipboard(activity.diagnostics) }
                        }
                    }
                    if case let .failed(_, reason) = model.updateState {
                        Text(reason).foregroundStyle(.red).textSelection(.enabled)
                    }
                    if let notice = model.updateNotice { Text(notice).foregroundStyle(.secondary) }
                    if let offer = model.updateOffer {
                        if let date = offer.manifest.publishedAtLabel { Text("发布时间：\(date)") }
                        Text(offer.manifest.releaseNotesText).textSelection(.enabled)
                    }
                    if Bundle.main.object(forInfoDictionaryKey: "MissionGoAllowsAdHocUpdates") as? Bool == true {
                        Text("此安装使用 ad-hoc 签名；更新后 macOS 可能要求重新授予权限。")
                    }
                    if AppUpdater.isTranslocated(bundle: Bundle.main.bundleURL) {
                        Text("当前正在运行下载位置的临时副本。更新会安装到「应用程序」，并从那里重新打开。")
                    }

                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            Divider()
            HStack {
                if !model.updateState.isBusy {
                    Button(model.updateActivity == nil ? "稍后" : "关闭") { model.closeClientUpdate() }
                }
                Spacer()
                if model.updateActivity?.stage == .waiting {
                    Button("立即重启更新") { confirmsImmediateRestart = true }
                } else if model.updateActivity?.stage == .restartFailed {
                    Text("新版本已安装，请手动重新打开 MissionGo。")
                } else if model.updateState.isBusy {
                    if model.updateActivity?.stage.canCancel == true {
                        Button("取消下载") { model.cancelUpdate() }
                    } else {
                        Text("正在处理，请稍候…").foregroundStyle(.secondary)
                    }
                } else if model.canRetryClientUpdate {
                    Button(model.updateActivity == nil ? "同意更新" : "重新更新") { model.retryClientUpdate() }
                        .keyboardShortcut(.defaultAction)
                }
            }
            .fixedSize(horizontal: false, vertical: true)
        }
        .padding(20)
        .frame(minWidth: 320, minHeight: 280)
        .background(Color(nsColor: .windowBackgroundColor))
        .alert("立即重启 MissionGo？", isPresented: $confirmsImmediateRestart) {
            Button("继续等待", role: .cancel) {}
            Button("立即重启") { model.restartInstalledUpdate(immediately: true) }
        } message: {
            Text("立即打开已安装的新版本可能中断正在启动的派单或尚未完成的结果回传。已启动的 Agent 会继续运行。")
        }
    }
}
