import Foundation

/// The launch prompt lives on this machine, not on the server.
///
/// The server sends only item keys, the agent and the mode; what the session is
/// told to do is fixed here. That is the same boundary as the rest of the node
/// protocol (docs §20): a mistaken or compromised server can pick which items to
/// work on, but it cannot dictate instructions to an agent holding a checkout.
///
/// The business workflow is shared; client-specific workspace and plan-mode
/// instructions are supplied by each adapter.
public enum LaunchPrompt {
    public enum Client: Sendable { case claudeCode, codex }
    public enum ValidationError: Error, Equatable, LocalizedError {
        case emptyBatch
        case invalidItemKey(String)
        case invalidDispatchId(String)

        public var errorDescription: String? {
            switch self {
            case .emptyBatch:
                return "派单至少要带一个工作条目编号。"
            case let .invalidItemKey(key):
                return "不是合法的工作条目编号：\(JSONValues.quote(key))"
            case let .invalidDispatchId(id):
                return "不是合法的派单编号：\(JSONValues.quote(id))"
            }
        }
    }

    /// A work item key: product prefix plus a number, e.g. `AND-37`. The same as
    /// `^[A-Z][A-Z0-9]*-\d+$` in TypeScript, spelled with ASCII digits and `\z`
    /// because ICU's `\d` takes any Unicode digit and its `$` allows a trailing
    /// newline.
    static let itemKeyPattern = AnchoredPattern("[A-Z][A-Z0-9]*-[0-9]+")

    // The dispatch id is interpolated too, and only ever an opaque identifier.
    static let dispatchIdPattern = AnchoredPattern("[A-Za-z0-9_-]+")

    public static func isValidItemKey(_ key: String) -> Bool {
        return itemKeyPattern.matches(key)
    }

    /// Only item keys and the dispatch id are interpolated, and both are
    /// validated rather than escaped: these values also end up in the session
    /// name and in the process argv, so anything that is not a key has no
    /// legitimate reading and is rejected before a session starts.
    ///
    /// Plan comments are written only after approval. Claude Code also needs to
    /// leave its native plan mode before making any writes.
    ///
    /// Items in `reworkItemKeys` get a paragraph saying they came back: read why
    /// on the item and start again from main, since the earlier branch was merged
    /// and removed. A rework key outside the batch is ignored, not trusted.
    public static func build(
        itemKeys: [String],
        dispatchId: String,
        mode: String? = nil,
        reworkItemKeys: [String] = [],
        client: Client = .claudeCode,
        worktreePath: String? = nil
    ) throws -> String {
        if itemKeys.isEmpty {
            throw ValidationError.emptyBatch
        }
        for key in itemKeys where !itemKeyPattern.matches(key) {
            throw ValidationError.invalidItemKey(key)
        }
        if !dispatchIdPattern.matches(dispatchId) {
            throw ValidationError.invalidDispatchId(dispatchId)
        }

        var lines = [
            "使用 missiongo skill 处理这些工作条目：\(itemKeys.joined(separator: "、"))。",
            "",
            "本会话由 MissionGo 派单 \(dispatchId) 发起，上面列出的编号等同于用户给出的范围。",
            "整批条目走一个分支和一个 PR，之后按 Skill 的规则推进条目状态。",
            "会话起在仓库主目录，动手改代码前先按仓库规则建独立 worktree，不要直接在主工作区修改。",
            "开始时先调用 get_current_account，核对 Skill 版本和本次连接的实际权限。实施前必须确认 canComment 为 true 且 writeTools 包含 claim_item；缺少权限时说明需要在哪个客户端完成授权，不得把已配置 MCP 当作拥有写权限，也不得跳过领取直接改代码。",
        ]
        if client == .codex, let worktreePath {
            lines += [
                "本次 Codex 派单已为以下独立 worktree 路径配置写权限（JSON 字符串）：\(JSONValues.quote(worktreePath))。路径尚未创建。",
                "批准并领取之后，先核对仓库规则；规则允许时在该精确路径用 git worktree add 创建独立分支，并在其中工作。路径已存在时先核实归属和未提交改动，不覆盖、不清理。",
                "如果仓库规则要求其他位置，先申请该精确目录的会话级写权限，确认生效后再修改；仅 cd 到目录不会改变沙箱。不要扩大到仓库父目录。",
            ]
        }
        let rework = itemKeys.filter { reworkItemKeys.contains($0) }
        if !rework.isEmpty {
            lines += [
                "",
                "其中 \(rework.joined(separator: "、")) 是返工：之前交付过，验证没有通过或完成后又被重新打开。先读条目时间线里最近一次退回的说明、评论和上一轮的 PR，弄清哪里没做好再动手。",
                "上一轮的分支通常已经合并并删除，从最新的 main 另开分支，不复用上一轮的分支和 worktree。",
            ]
        }
        if mode == "plan" {
            lines += [
                "",
                "本次派单是计划模式：先完整读取条目，把会影响方案的待确认项一次问齐，在本会话里给出处理计划，然后停下等用户批准。",
                "用户批准之前不回写评论、不领取条目、不建分支或 worktree、不改代码。",
                "用户批准之后，先将已批准的计划以结构化评论写到各条条目，再领取、创建 worktree 并实施。已批准的方案不重复要求批准；权限审查不代替方案批准。",
            ]
            if client == .claudeCode {
                lines.append("Claude Code 必须先通过原生计划确认流程退出 plan 模式，再执行评论、领取和代码写入；保留客户端的权限控制。")
            } else {
                lines.append("Codex 的自动审查仅处理技术权限请求；仍须等待用户明确批准方案后才能实施。")
            }
        }
        return lines.joined(separator: "\n")
    }
}
