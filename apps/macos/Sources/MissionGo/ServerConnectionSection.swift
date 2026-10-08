import MissionGoNodeCore
import SwiftUI

struct ServerConnectionSection: View {
    @EnvironmentObject private var model: AppModel

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("服务器连接").font(.headline)
            Picker("连接方式", selection: Binding(
                get: { model.connectionMode },
                set: { model.setConnectionMode($0) }
            )) {
                ForEach(ServerConnectionMode.allCases, id: \.self) { mode in
                    Text(mode.label).tag(mode)
                }
            }
            .disabled(!model.canChangeConnectionMode)
            Text("仅影响本客户端连接服务器；切换后自动重试，无需重启。")
                .font(.caption)
                .foregroundStyle(.secondary)
            if model.phase == .signingIn {
                Text("如需切换连接方式，请先取消当前登录。")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            Button(model.diagnosingConnection ? "正在诊断…" : "诊断连接") {
                model.diagnoseConnection()
            }
            .disabled(model.diagnosingConnection || model.consoleUrl == nil || model.updateState.isBusy)
            if let diagnosis = model.connectionDiagnosis {
                Text(diagnosis.summary).font(.callout).fixedSize(horizontal: false, vertical: true)
                Text("系统设置：\(diagnosis.system.description)\n直连：\(diagnosis.direct.description)")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                    .textSelection(.enabled)
                if diagnosis.recommendsDirect, model.connectionMode != .direct {
                    Button("切换直连并重试") { model.setConnectionMode(.direct) }
                        .disabled(!model.canChangeConnectionMode)
                }
            }
        }
    }
}
