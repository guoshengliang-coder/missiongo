import MissionGoNodeCore
import SwiftUI

struct UnreadSessionCard: View {
    let session: UnreadSessionPreview
    let open: () -> Void

    var body: some View {
        Button(action: open) {
            VStack(alignment: .leading, spacing: 3) {
                Text(session.title)
                    .font(.subheadline.weight(.medium))
                    .lineLimit(1)
                ForEach(session.items, id: \.key) { item in
                    Text(item.label)
                        .font(.caption)
                        .foregroundStyle(MenuPalette.sectionText)
                        .fixedSize(horizontal: false, vertical: true)
                }
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
            .padding(.vertical, 9)
            .frame(maxWidth: .infinity, minHeight: 57, alignment: .leading)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .help(([session.title] + session.items.map(\.label)).joined(separator: "\n"))
        .accessibilityLabel("\(session.title)，\(session.items.map(\.label).joined(separator: "，"))，\(agentName(session.agentKind))，\(session.nodeName)，\(relativeTime(session.activityAt))，在 Web 打开会话")
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

struct AgentSkillRow: View {
    let agent: LocalAgent
    let skill: AgentSkillSnapshot?
    let expectedVersion: String?
    let retrying: Bool
    let retry: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack {
                Text(agent.title).fontWeight(.medium)
                Spacer()
                Text(skill?.summary ?? "等待版本检查")
                    .foregroundStyle(skill?.syncState == "failed" ? MenuPalette.warning : MenuPalette.secondaryText)
                Button(skill?.syncState == "failed" ? "重试" : "检查") { retry() }
                    .buttonStyle(.plain)
                    .foregroundStyle(MenuPalette.action)
                    .disabled(skill?.syncState == "syncing" || retrying)
                    .accessibilityLabel("重试 \(agent.title) Skill 同步")
            }
            Text("本地 \(skill?.localVersion ?? "未识别") · 服务端要求 \(skill?.expectedVersion ?? expectedVersion ?? "待获取")")
                .foregroundStyle(MenuPalette.secondaryText)
                .fixedSize(horizontal: false, vertical: true)
            if let reason = skill?.reason {
                Text(reason).foregroundStyle(MenuPalette.warning)
                    .fixedSize(horizontal: false, vertical: true)
                    .textSelection(.enabled)
            }
        }
        .padding(.leading, 26)
        .padding(.bottom, 5)
    }
}
