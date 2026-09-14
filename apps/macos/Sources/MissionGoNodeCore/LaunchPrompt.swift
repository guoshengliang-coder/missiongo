import Foundation

/// The launch prompt lives on this machine, not on the server.
///
/// The server sends only item keys, the agent and the mode; what the session is
/// told to do is fixed here. That is the same boundary as the rest of the node
/// protocol (docs §20): a mistaken or compromised server can pick which items to
/// work on, but it cannot dictate instructions to an agent holding a checkout.
///
/// Claude Code and Codex are told exactly the same thing, including the plan
/// paragraph: which agent runs a batch must not change what it is asked to do.
public enum LaunchPrompt {
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
    /// In plan mode a paragraph is added asking for a plan, written back as a
    /// comment, and a stop until the person approves. For Codex that paragraph is
    /// the whole of plan mode; Claude Code is also started in its own plan mode.
    public static func build(itemKeys: [String], dispatchId: String, mode: String? = nil) throws -> String {
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
        ]
        if mode == "plan" {
            lines += [
                "",
                "本次派单是计划模式：先完整读取条目，给出处理计划，把计划写成结构化评论回写到各条条目，然后在本会话里停下，等用户批准。",
                "用户批准之前不领取条目、不建分支、不改代码。",
            ]
        }
        return lines.joined(separator: "\n")
    }
}
