import MissionGoNodeCore
import SwiftUI

struct SignedOutView: View {
    @EnvironmentObject private var model: AppModel

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 10) {
                Image(systemName: "paperplane.circle.fill")
                    .font(.system(size: 30))
                    .foregroundStyle(Color.accentColor)
                VStack(alignment: .leading, spacing: 2) {
                    Text("MissionGo").font(.headline)
                    Text(model.loginServerUrl.map(ServerAddress.displayHost) ?? "尚未设置服务器地址")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    // Before signing in too: "which version is this?" is often
                    // the first question when sign-in is what does not work.
                    Text(AppVersionLabel.text(model.appVersion))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .textSelection(.enabled)
                }
            }

            // AND-291: the three ways a session ends against this Mac's will
            // read differently on purpose -- a console revocation is the only
            // one that says "revoked".
            if model.phase != .signingIn, let reason = model.credentialEndReason {
                switch reason {
                case "revoked":
                    WrappingCaption(text: "这台 Mac 已在控制台被撤销，重新登录即可恢复。", color: .orange)
                case "replaced":
                    WrappingCaption(text: "本机的登录凭据已被一次新的登录替换（常见于客户端更新重启），重新登录即可恢复。", color: .orange)
                default:
                    WrappingCaption(text: "登录凭据已失效，重新登录即可恢复。", color: .orange)
                }
            } else if model.showsRevokedNotice {
                WrappingCaption(text: "这台 Mac 已在控制台被撤销，重新登录即可恢复。", color: .orange)
            }

            if model.phase == .signingIn {
                HStack(spacing: 8) {
                    ProgressView().controlSize(.small)
                    Text(model.loginStatus)
                    Spacer()
                    Button("取消") { model.cancelSignIn() }
                }
                if let pending = model.deviceLogin {
                    Text(pending.userCode).font(.title2.monospaced()).textSelection(.enabled)
                    Text(pending.verificationUri.absoluteString).font(.caption).textSelection(.enabled)
                    Text("打开页面后先核对：页面显示的验证码必须与上面完全一致。不一致说明浏览器停在旧标签页——请关掉它，手动访问上面的网址并输入当前验证码。")
                        .font(.caption).foregroundStyle(.secondary)
                    Button("打开验证页面") { model.reopenDeviceLogin() }
                }
            } else {
                Button {
                    model.signIn()
                } label: {
                    Text("登录 MissionGo").frame(maxWidth: .infinity)
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.large)
                .disabled(model.loginServerUrl == nil)
            }

            if let error = model.loginError {
                WrappingCaption(text: error, color: .red)
            }

            ServerAddressDisclosure()
            DisclosureGroup("连接诊断与代理设置") {
                ServerConnectionSection().padding(.top, 6)
            }

            Divider()

            HStack {
                Spacer()
                Button("退出 MissionGo") { model.quit() }
            }
        }
    }
}

private struct ServerAddressDisclosure: View {
    @EnvironmentObject private var model: AppModel
    @State private var expanded = false
    @State private var draft = ""
    @State private var error: String?

    var body: some View {
        DisclosureGroup("服务器地址", isExpanded: $expanded) {
            VStack(alignment: .leading, spacing: 6) {
                TextField("https://missiongo.example.com", text: $draft)
                    .textFieldStyle(.roundedBorder)
                    .onSubmit(save)
                HStack {
                    Button("保存", action: save)
                        .disabled(draft.trimmingCharacters(in: .whitespaces).isEmpty)
                    if model.serverOverride != nil, model.hasBundledServer {
                        Button("恢复默认") {
                            model.clearServerOverride()
                            draft = model.loginServerUrl ?? ""
                            error = nil
                        }
                    }
                    Spacer()
                }
                if let error {
                    WrappingCaption(text: error, color: .red)
                } else if model.loginServerUrl == nil {
                    WrappingCaption(text: "这个安装包没有内置服务器地址，请填写你的 MissionGo 地址，例如 https://missiongo.example.com。")
                }
            }
            .padding(.top, 6)
        }
        .font(.callout)
        .disabled(model.phase == .signingIn)
        .onAppear {
            draft = model.serverOverride ?? model.loginServerUrl ?? ""
            if model.loginServerUrl == nil { expanded = true }
        }
    }

    private func save() {
        error = model.setServerOverride(draft)
        if error == nil { draft = model.serverOverride ?? draft }
    }
}
