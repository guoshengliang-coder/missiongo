import Foundation

/// The CLI arguments the detached host starts Claude Code with.
public enum ClaudeHostArguments {
    /// These are the existing irreversible-operation stops for every MissionGo
    /// Claude session. Claude Code honors them even in bypassPermissions mode;
    /// the bypass removes approval prompts, not these hard denials.
    public static let disallowedTools = [
        "Bash(git reflog expire:*)",
        "Bash(git gc --prune=now:*)",
        "Bash(git push --force:*)",
        "Bash(git push -f:*)",
    ]

    /// `--permission-prompt-tool stdio` is load-bearing. Without it a
    /// non-interactive session has no approval surface: Claude Code hides
    /// `AskUserQuestion` and `ExitPlanMode` from the model and denies every
    /// other tool call that would need a person's approval. With it, each of
    /// those arrives at the host as a `can_use_tool` control request, which is
    /// what the Agent SDK does whenever it is given a `canUseTool` callback.
    ///
    /// `--model` and `--effort` appear only when a dispatch or a person chose
    /// them; without them Claude Code follows the user's own settings, which
    /// is what "follow this machine's configuration" means.
    public static func claude(
        mode: String,
        sessionName: String,
        sessionRef: String,
        resuming: Bool,
        model: String? = nil,
        effort: String? = nil
    ) -> [String] {
        [
            "--output-format", "stream-json",
            "--verbose",
            "--input-format", "stream-json",
            "--replay-user-messages",
            "--permission-prompt-tool", "stdio",
            "--permission-prompts", "host",
            "--no-chrome",
            "--disallowedTools", disallowedTools.joined(separator: ","),
            "--permission-mode", mode,
            "--name", sessionName,
        ]
            + (model.map { ["--model", $0] } ?? [])
            + (effort.map { ["--effort", $0] } ?? [])
            + (resuming ? ["--resume", sessionRef] : ["--session-id", sessionRef])
    }
}

/// One `can_use_tool` request Claude Code is blocked on until a person answers,
/// either from MissionGo or from the claude.ai Remote Control page.
public struct ClaudePermissionRequest {
    public static let approveOption = "批准"
    public static let denyOption = "拒绝"
    static let approvals: Set<String> = ["批准", "批准并实施", "approve", "approved", "yes", "proceed"]
    static let summaryLimit = 300

    public let requestId: String
    public let toolName: String
    public let input: [String: Any]
    public let description: String?

    public init(requestId: String, toolName: String, input: [String: Any], description: String? = nil) {
        self.requestId = requestId
        self.toolName = toolName
        self.input = input
        self.description = description
    }

    /// Reads a `control_request` event; nil for anything but `can_use_tool`.
    public init?(event: [String: Any]) {
        guard event["type"] as? String == "control_request",
              let requestId = event["request_id"] as? String,
              let request = event["request"] as? [String: Any],
              request["subtype"] as? String == "can_use_tool",
              let toolName = request["tool_name"] as? String
        else { return nil }
        self.init(
            requestId: requestId,
            toolName: toolName,
            input: request["input"] as? [String: Any] ?? [:],
            description: request["description"] as? String
        )
    }

    /// These two already show up as questions from their own `tool_use`
    /// blocks in the assistant message, so they need no extra prompt.
    public var asksThroughToolUse: Bool {
        toolName == "AskUserQuestion" || toolName == "ExitPlanMode"
    }

    /// What the person sees for an ordinary tool: which tool, what it is for,
    /// and the one argument that decides whether to allow it.
    public var question: AgentSessionQuestion {
        AgentSessionQuestion(
            header: "授权请求",
            title: "Claude Code 请求使用 \(toolName)",
            options: [Self.approveOption, Self.denyOption]
        )
    }

    public var promptText: String {
        var lines: [String] = []
        let purpose = (description ?? input["description"] as? String)?
            .trimmingCharacters(in: .whitespacesAndNewlines)
        if let purpose, !purpose.isEmpty { lines.append(Self.clip(purpose)) }
        if let detail = detail { lines.append(detail) }
        return lines.isEmpty ? "Claude Code 需要你批准才能继续。" : lines.joined(separator: "\n")
    }

    private var detail: String? {
        for key in ["command", "file_path", "notebook_path", "url", "pattern", "path"] {
            if let value = input[key] as? String, !value.isEmpty { return Self.clip(value) }
        }
        guard !input.isEmpty,
              let data = try? JSONSerialization.data(withJSONObject: input, options: [.sortedKeys]),
              let text = String(data: data, encoding: .utf8)
        else { return nil }
        return Self.clip(text)
    }

    private static func clip(_ text: String) -> String {
        text.count > summaryLimit ? String(text.prefix(summaryLimit)) + "…" : text
    }

    /// The `can_use_tool` response for a person's reply.
    public func result(answer: String) -> [String: Any] {
        if toolName == "AskUserQuestion" {
            return ["behavior": "allow", "updatedInput": answeredQuestions(answer)]
        }
        let normalized = answer.trimmingCharacters(in: .whitespacesAndNewlines)
        if Self.approvals.contains(normalized.lowercased()) {
            return ["behavior": "allow", "updatedInput": input]
        }
        let message = normalized == Self.denyOption ? "用户拒绝了这次操作。" : normalized
        return ["behavior": "deny", "message": message]
    }

    private func answeredQuestions(_ answer: String) -> [String: Any] {
        let questions = input["questions"] as? [[String: Any]] ?? []
        var labelled: [String: String] = [:]
        for line in answer.split(separator: "\n").map(String.init) {
            let pieces = line.split(separator: ":", maxSplits: 1).map(String.init)
            let fullWidth = line.split(separator: "：", maxSplits: 1).map(String.init)
            let pair = pieces.count == 2 ? pieces : fullWidth
            if pair.count == 2 {
                labelled[pair[0].trimmingCharacters(in: .whitespacesAndNewlines)] =
                    pair[1].trimmingCharacters(in: .whitespacesAndNewlines)
            }
        }
        var answers: [String: String] = [:]
        for question in questions {
            guard let text = question["question"] as? String else { continue }
            let header = question["header"] as? String
            if questions.count == 1 {
                answers[text] = answer
            } else if let selected = labelled[text] ?? header.flatMap({ labelled[$0] }) {
                answers[text] = selected
            }
        }
        var updated = input
        updated["answers"] = answers
        return updated
    }
}

/// Requests the host still owes an answer to. Parallel tool calls can ask for
/// several approvals at once; each must be answered exactly once, or Claude
/// Code waits on the missing one forever. A reply answers the oldest.
public struct ClaudePermissionQueue {
    public private(set) var pending: [ClaudePermissionRequest] = []

    public init() {}

    public var head: ClaudePermissionRequest? { pending.first }
    public var isEmpty: Bool { pending.isEmpty }

    public mutating func enqueue(_ request: ClaudePermissionRequest) {
        pending.append(request)
    }

    /// Answered elsewhere, e.g. on the claude.ai page. True when it was queued.
    @discardableResult
    public mutating func cancel(requestId: String) -> Bool {
        guard let index = pending.firstIndex(where: { $0.requestId == requestId }) else { return false }
        pending.remove(at: index)
        return true
    }

    public mutating func answerHead(_ answer: String) -> (requestId: String, result: [String: Any])? {
        guard !pending.isEmpty else { return nil }
        let request = pending.removeFirst()
        return (request.requestId, request.result(answer: answer))
    }
}
