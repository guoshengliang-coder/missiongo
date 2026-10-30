import MissionGoNodeCore
import SwiftUI

struct DispatchesSection: View {
    @EnvironmentObject private var model: AppModel

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            SectionTitle(text: "最近派单")
            if let error = model.dispatchesError {
                // The list refreshes on its own every 30 seconds while the
                // menu is open, but the retry entry point stays visible next
                // to the failure it retries (AND-177).
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    WrappingCaption(text: error, color: .red)
                    Button("重试") { model.refreshDispatches() }
                        .buttonStyle(.borderless)
                        .font(.caption)
                        .help("立即重新拉取最近派单")
                    Spacer(minLength: 0)
                }
            }
            if let launch = model.latestLaunchFailure,
               (!launch.reported || !model.recentDispatches.contains(where: { $0.id == launch.dispatchId })),
               let problem = DispatchPresentation.localLaunchProblem(launch) {
                // The console list can be stale or unreachable; this Mac still
                // knows why its most recent launch did not start.
                WrappingCaption(text: problem, color: .red)
            }
            if model.recentDispatches.isEmpty {
                if model.dispatchesError == nil {
                    WrappingCaption(text: "还没有派单。在控制台勾选条目并派给这台 Mac 后，会显示在这里。")
                }
            } else {
                VStack(spacing: 2) {
                    ForEach(model.recentDispatches, id: \.id) { record in
                        DispatchRow(record: record)
                    }
                }
            }
        }
    }
}

private struct DispatchRow: View {
    @EnvironmentObject private var model: AppModel
    @State private var hovering = false
    let record: DispatchRecord

    var body: some View {
        Button {
            if let url = record.sessionUrl { model.open(url) }
        } label: {
            HStack(alignment: .top, spacing: 8) {
                VStack(alignment: .leading, spacing: 2) {
                    HStack(spacing: 4) {
                        Text(DispatchPresentation.itemsLabel(record.itemKeys))
                            .lineLimit(1)
                            .truncationMode(.tail)
                        if record.sessionUrl != nil {
                            Image(systemName: "arrow.up.right.square")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                    }
                    Text(DispatchPresentation.agentLine(agentKind: record.agentKind, mode: record.mode))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                        .truncationMode(.tail)
                    if record.status == "launched" && record.agentKind == "claude_code" && record.sessionUrl == nil {
                        Text("在 MissionGo 控制台查看和回复")
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                    }
                    if let problem = DispatchPresentation.failureHint(
                        code: record.failureCode, stage: record.failureStage, agentKind: record.agentKind
                    ) {
                        Text(problem)
                            .font(.caption)
                            .foregroundColor(.red)
                            .lineLimit(2)
                    } else if let error = DispatchPresentation.shortError(record.error) {
                        Text(error)
                            .font(.caption)
                            .foregroundColor(.red)
                            .lineLimit(2)
                    }
                }
                Spacer(minLength: 4)
                VStack(alignment: .trailing, spacing: 2) {
                    Text(DispatchPresentation.statusLabel(record.status))
                        .font(.caption.weight(.medium))
                        .foregroundColor(statusColor)
                    Text(DispatchPresentation.relativeTime(record.createdAt))
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                }
            }
            .padding(.vertical, 4)
            .padding(.horizontal, 6)
            .background(
                RoundedRectangle(cornerRadius: 5)
                    .fill(hovering && record.sessionUrl != nil ? Color.primary.opacity(0.08) : Color.clear)
            )
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .onHover { hovering = $0 }
        .help(rowHelp)
    }

    private var rowHelp: String {
        let hint = DispatchPresentation.failureHint(
            code: record.failureCode, stage: record.failureStage, agentKind: record.agentKind
        )
        if let hint, let error = record.error, error != hint { return "\(hint)\n\(error)" }
        if let hint { return hint }
        if let error = record.error { return error }
        if record.sessionUrl != nil { return "打开会话" }
        if record.agentKind == "claude_code" && record.status == "launched" {
            return "在 MissionGo 控制台查看和回复"
        }
        return ""
    }

    private var statusColor: Color {
        switch record.status {
        case "launched": return .green
        case "failed": return .red
        default: return .secondary
        }
    }
}
