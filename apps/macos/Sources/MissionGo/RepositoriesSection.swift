import MissionGoNodeCore
import SwiftUI

struct RepositoriesSection: View {
    @EnvironmentObject private var model: AppModel

    /// Past this many products the list scrolls, so the menu never grows taller
    /// than the screen.
    private static let visibleRows = 5
    private static let rowHeight: CGFloat = 50

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            SectionTitle(text: "仓库")
            if model.profile == nil {
                if let error = model.profileError {
                    WrappingCaption(text: error, color: .red)
                    Button("重试") { model.refreshProfile() }
                        .font(.caption)
                } else {
                    HStack(spacing: 6) {
                        ProgressView().controlSize(.mini)
                        Text("正在读取产品…").font(.caption).foregroundStyle(.secondary)
                    }
                }
            } else if model.products.isEmpty {
                WrappingCaption(text: "当前账号下还没有可以映射的产品。")
            } else if model.products.count > RepositoriesSection.visibleRows {
                ScrollView {
                    rows.padding(.trailing, 8)
                }
                .frame(height: CGFloat(RepositoriesSection.visibleRows) * RepositoriesSection.rowHeight)
            } else {
                rows
            }
        }
    }

    private var rows: some View {
        VStack(alignment: .leading, spacing: 10) {
            ForEach(model.products, id: \.id) { product in
                RepoRow(product: product)
            }
        }
    }
}

private struct RepoRow: View {
    @EnvironmentObject private var model: AppModel
    let product: NodeProfile.Product

    var body: some View {
        let path = model.repoPath(for: product.id)
        let saving = model.savingProductIds.contains(product.id)
        VStack(alignment: .leading, spacing: 3) {
            HStack(spacing: 6) {
                Text("\(product.keyPrefix) · \(product.name)")
                    .lineLimit(1)
                Spacer(minLength: 4)
                if saving {
                    ProgressView().controlSize(.mini)
                }
                chooser(currentPath: path)
                    .disabled(saving)
                if path != nil {
                    Button {
                        model.clearFolder(for: product)
                    } label: {
                        Image(systemName: "xmark.circle")
                    }
                    .buttonStyle(.borderless)
                    .help("清除这个产品的仓库映射")
                    .disabled(saving)
                }
            }
            Text(path.map { PathDisplay.abbreviate($0) } ?? "未选择")
                .font(.caption)
                .foregroundColor(path == nil ? Color(nsColor: .tertiaryLabelColor) : .secondary)
                .lineLimit(1)
                .truncationMode(.middle)
                .help(path ?? "")
            if let notice = model.repoNotices[product.id] {
                WrappingCaption(text: notice.text, color: notice.kind == .error ? .red : .orange)
            }
        }
    }

    @ViewBuilder
    private func chooser(currentPath: String?) -> some View {
        let suggestions = RepoFolderCheck.suggestions(
            keyPrefix: product.keyPrefix,
            productName: product.name,
            candidates: model.candidates,
            excluding: currentPath
        )
        if suggestions.isEmpty {
            Button("选择文件夹…") { model.chooseFolder(for: product) }
                .buttonStyle(.borderless)
        } else {
            // Only mappings explicitly chosen for this node, never another
            // application's project history.
            Menu {
                Section("本机已映射的仓库") {
                    ForEach(suggestions, id: \.path) { candidate in
                        Button(PathDisplay.abbreviate(candidate.path)) {
                            model.assign(candidate.path, to: product)
                        }
                    }
                }
                Divider()
                Button("其他文件夹…") { model.chooseFolder(for: product) }
            } label: {
                Text("选择文件夹…")
            } primaryAction: {
                model.chooseFolder(for: product)
            }
            .menuStyle(.borderlessButton)
            .fixedSize()
        }
    }
}
