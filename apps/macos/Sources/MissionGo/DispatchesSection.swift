import MissionGoNodeCore
import SwiftUI

struct DispatchesSection: View {
    @EnvironmentObject private var model: AppModel

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            SectionTitle(text: "最近派单")
            if let error = model.dispatchesError {
                WrappingCaption(text: error, color: .red)
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
                    if let error = DispatchPresentation.shortError(record.error) {
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
        .help(record.error ?? (record.sessionUrl != nil ? "打开会话" : ""))
    }

    private var statusColor: Color {
        switch record.status {
        case "launched": return .green
        case "failed": return .red
        default: return .secondary
        }
    }
}
