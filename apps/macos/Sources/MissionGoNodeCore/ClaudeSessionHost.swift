import Darwin
import Foundation

/// Durable files shared by MissionGo and the detached Claude host. The host is
/// deliberately a separate executable: a menu-app restart must not close the
/// stdin that owns a running stream-json Claude session.
public enum ClaudeHostStore {
    public static func defaultRoot(home: String = Paths.homeDirectory()) -> String {
        "\(home)/Library/Application Support/MissionGo/ClaudeSessions"
    }

    public static func sessionDirectory(root: String, sessionRef: String) -> String {
        "\(root)/\(sessionRef)"
    }

    public static func configPath(root: String, sessionRef: String) -> String {
        "\(sessionDirectory(root: root, sessionRef: sessionRef))/config.json"
    }

    public static func statePath(root: String, sessionRef: String) -> String {
        "\(sessionDirectory(root: root, sessionRef: sessionRef))/state.json"
    }

    public static func commandPath(root: String, sessionRef: String, commandId: String) -> String {
        "\(sessionDirectory(root: root, sessionRef: sessionRef))/commands/\(commandId).json"
    }
}

public struct ClaudeHostConfiguration: Codable, Equatable, Sendable {
    public let version: Int
    public let claudeExecutable: String
    public let cwd: String
    public let mode: String
    public let sessionName: String
    public let sessionRef: String
    public let prompt: String
    public let statePath: String
    public let commandsDirectory: String
    public let logPath: String

    public init(
        version: Int = 1,
        claudeExecutable: String,
        cwd: String,
        mode: String,
        sessionName: String,
        sessionRef: String,
        prompt: String,
        statePath: String,
        commandsDirectory: String,
        logPath: String
    ) {
        self.version = version
        self.claudeExecutable = claudeExecutable
        self.cwd = cwd
        self.mode = mode
        self.sessionName = sessionName
        self.sessionRef = sessionRef
        self.prompt = prompt
        self.statePath = statePath
        self.commandsDirectory = commandsDirectory
        self.logPath = logPath
    }
}

public struct ClaudeHostCommandResult: Codable, Equatable, Sendable {
    public let status: String
    public let error: String?

    public init(status: String, error: String? = nil) {
        self.status = status
        self.error = error
    }
}

public struct ClaudeHostState: Codable, Equatable, Sendable {
    public var version: Int = 1
    public var status: String
    public var sessionRef: String
    public var hostPid: Int32?
    public var sessionUrl: String?
    public var messages: [AgentSessionMessage]
    public var commandResults: [String: ClaudeHostCommandResult]
    public var error: String?

    public init(
        status: String,
        sessionRef: String,
        hostPid: Int32? = nil,
        sessionUrl: String? = nil,
        messages: [AgentSessionMessage] = [],
        commandResults: [String: ClaudeHostCommandResult] = [:],
        error: String? = nil
    ) {
        self.status = status
        self.sessionRef = sessionRef
        self.hostPid = hostPid
        self.sessionUrl = sessionUrl
        self.messages = messages
        self.commandResults = commandResults
        self.error = error
    }
}

public struct ClaudeHostCommand: Codable, Equatable, Sendable {
    public let id: String
    public let kind: String
    public let text: String

    public init(id: String, kind: String, text: String) {
        self.id = id
        self.kind = kind
        self.text = text
    }
}

/// Locates the helper beside the app executable. SwiftPM puts sibling
/// executables in the same directory too, which keeps development builds easy.
public enum ClaudeHostLocation {
    public static let executableName = "MissionGoClaudeHost"

    public static func executable(mainExecutable: URL? = Bundle.main.executableURL) -> String? {
        guard let mainExecutable else { return nil }
        let candidate = mainExecutable.deletingLastPathComponent().appendingPathComponent(executableName).path
        return FileManager.default.isExecutableFile(atPath: candidate) ? candidate : nil
    }
}

/// Converts the stable, user-visible subset of Claude stream-json into the same
/// snapshot shape used by Codex. Unknown event fields are ignored on purpose so
/// a CLI upgrade can add events without breaking the host.
public struct ClaudeStreamSnapshot: Sendable {
    public private(set) var state: ClaudeHostState
    public private(set) var initialized = false

    public init(sessionRef: String, hostPid: Int32? = nil) {
        state = ClaudeHostState(status: "active", sessionRef: sessionRef, hostPid: hostPid)
    }

    public mutating func consume(_ value: [String: Any]) {
        guard let type = value["type"] as? String else { return }
        if type == "system", value["subtype"] as? String == "init" {
            initialized = true
            return
        }
        if type == "user" {
            guard value["parent_tool_use_id"] is NSNull || value["parent_tool_use_id"] == nil,
                  let message = value["message"] as? [String: Any],
                  let text = Self.textContent(message["content"]), !text.isEmpty
            else { return }
            let sourceId = (value["uuid"] as? String) ?? UUID().uuidString
            upsert(AgentSessionMessage(
                sourceId: sourceId,
                turnId: sourceId,
                role: "user",
                text: text
            ))
            state.status = "active"
            state.error = nil
            return
        }
        if type == "assistant" {
            guard value["parent_tool_use_id"] is NSNull || value["parent_tool_use_id"] == nil,
                  let message = value["message"] as? [String: Any],
                  let content = message["content"] as? [[String: Any]]
            else { return }
            let sourceId = (message["id"] as? String) ?? (value["uuid"] as? String) ?? UUID().uuidString
            let turnId = (value["user_message_uuid"] as? String) ?? latestTurnId() ?? sourceId
            let text = content.compactMap { block -> String? in
                guard block["type"] as? String == "text" else { return nil }
                return block["text"] as? String
            }.filter { !$0.isEmpty }.joined(separator: "\n")
            let questions = Self.questions(content)
            if !text.isEmpty || !questions.isEmpty {
                let previous = state.messages.first(where: { $0.sourceId == sourceId })
                let combinedText = [previous?.text, text].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: "\n")
                upsert(AgentSessionMessage(
                    sourceId: sourceId,
                    turnId: turnId,
                    role: "agent",
                    text: combinedText.isEmpty ? "Claude Code 正在等待你的选择。" : combinedText,
                    questions: questions.isEmpty ? previous?.questions : questions
                ))
            }
            state.status = "active"
            state.error = nil
            return
        }
        if type == "result" {
            state.status = "idle"
            let subtype = value["subtype"] as? String
            let terminalReason = value["terminal_reason"] as? String
            // interrupt() currently ends a turn with this SDK result. It is a
            // completed cancellation, not a broken session.
            if subtype == "error_during_execution", terminalReason != "aborted_streaming" {
                let errors = value["errors"] as? [String]
                state.error = errors?.joined(separator: "\n") ?? "Claude Code 当前回合执行失败。"
            } else {
                state.error = nil
            }
        }
    }

    public mutating func setRemote(sessionUrl: String) {
        state.sessionUrl = sessionUrl
        state.error = nil
    }

    public mutating func fail(_ message: String) {
        state.status = "failed"
        state.error = message
    }

    public mutating func commandFinished(id: String, status: String, error: String? = nil) {
        state.commandResults[id] = ClaudeHostCommandResult(status: status, error: error)
        if state.commandResults.count > 100 {
            for key in state.commandResults.keys.sorted().prefix(state.commandResults.count - 100) {
                state.commandResults.removeValue(forKey: key)
            }
        }
    }

    public mutating func markActive() {
        state.status = "active"
        state.error = nil
    }

    public mutating func markIdle() {
        state.status = "idle"
    }

    public mutating func markUnavailable(_ message: String) {
        state.status = "unavailable"
        state.error = message
    }

    private mutating func upsert(_ message: AgentSessionMessage) {
        if let index = state.messages.firstIndex(where: { $0.sourceId == message.sourceId }) {
            state.messages[index] = message
        } else {
            state.messages.append(message)
            if state.messages.count > 2_000 { state.messages.removeFirst(state.messages.count - 2_000) }
        }
    }

    private func latestTurnId() -> String? {
        state.messages.reversed().compactMap(\.turnId).first
    }

    private static func textContent(_ value: Any?) -> String? {
        if let text = value as? String { return text.trimmingCharacters(in: .whitespacesAndNewlines) }
        guard let blocks = value as? [[String: Any]] else { return nil }
        let text = blocks.compactMap { block -> String? in
            guard block["type"] as? String == "text" else { return nil }
            return block["text"] as? String
        }.joined(separator: "\n").trimmingCharacters(in: .whitespacesAndNewlines)
        return text.isEmpty ? nil : text
    }

    private static func questions(_ content: [[String: Any]]) -> [AgentSessionQuestion] {
        content.flatMap { block -> [AgentSessionQuestion] in
            guard block["type"] as? String == "tool_use",
                  block["name"] as? String == "AskUserQuestion",
                  let input = block["input"] as? [String: Any],
                  let questions = input["questions"] as? [[String: Any]]
            else { return [] }
            return questions.compactMap { question in
                guard let title = question["question"] as? String ?? question["header"] as? String else { return nil }
                let options = (question["options"] as? [[String: Any]])?.compactMap { $0["label"] as? String }
                return AgentSessionQuestion(title: title, options: options?.isEmpty == false ? options : nil)
            }
        }
    }
}

public enum ClaudeHostFiles {
    public static func readState(_ path: String) throws -> ClaudeHostState {
        try JSONDecoder().decode(ClaudeHostState.self, from: Data(contentsOf: URL(fileURLWithPath: path)))
    }

    public static func write<T: Encodable>(_ value: T, to path: String) throws {
        let data = try JSONEncoder().encode(value)
        try data.write(to: URL(fileURLWithPath: path), options: .atomic)
    }
}

public enum ClaudeHostProcess {
    public static func isRunning(_ pid: Int32) -> Bool {
        guard pid > 0 else { return false }
        if Darwin.kill(pid, 0) == 0 { return true }
        return errno == EPERM
    }
}
