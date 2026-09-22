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
    public let idleTimeoutSeconds: TimeInterval
    public let stallWarningSeconds: TimeInterval

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
        logPath: String,
        idleTimeoutSeconds: TimeInterval = 2 * 60 * 60,
        stallWarningSeconds: TimeInterval = 30 * 60
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
        self.idleTimeoutSeconds = idleTimeoutSeconds
        self.stallWarningSeconds = stallWarningSeconds
    }

    private enum CodingKeys: String, CodingKey {
        case version, claudeExecutable, cwd, mode, sessionName, sessionRef, prompt
        case statePath, commandsDirectory, logPath, idleTimeoutSeconds, stallWarningSeconds
    }

    public init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        version = try values.decodeIfPresent(Int.self, forKey: .version) ?? 1
        claudeExecutable = try values.decode(String.self, forKey: .claudeExecutable)
        cwd = try values.decode(String.self, forKey: .cwd)
        mode = try values.decode(String.self, forKey: .mode)
        sessionName = try values.decode(String.self, forKey: .sessionName)
        sessionRef = try values.decode(String.self, forKey: .sessionRef)
        prompt = try values.decode(String.self, forKey: .prompt)
        statePath = try values.decode(String.self, forKey: .statePath)
        commandsDirectory = try values.decode(String.self, forKey: .commandsDirectory)
        logPath = try values.decode(String.self, forKey: .logPath)
        idleTimeoutSeconds = try values.decodeIfPresent(TimeInterval.self, forKey: .idleTimeoutSeconds) ?? 2 * 60 * 60
        stallWarningSeconds = try values.decodeIfPresent(TimeInterval.self, forKey: .stallWarningSeconds) ?? 30 * 60
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
    public var activities: [AgentSessionActivity]
    public var waitingForInput: Bool
    public var commandResults: [String: ClaudeHostCommandResult]
    public var error: String?
    public var idleSince: Date?
    public var lastProgressAt: Date

    public init(
        status: String,
        sessionRef: String,
        hostPid: Int32? = nil,
        sessionUrl: String? = nil,
        messages: [AgentSessionMessage] = [],
        activities: [AgentSessionActivity] = [],
        waitingForInput: Bool = false,
        commandResults: [String: ClaudeHostCommandResult] = [:],
        error: String? = nil,
        idleSince: Date? = nil,
        lastProgressAt: Date = Date()
    ) {
        self.status = status
        self.sessionRef = sessionRef
        self.hostPid = hostPid
        self.sessionUrl = sessionUrl
        self.messages = messages
        self.activities = activities
        self.waitingForInput = waitingForInput
        self.commandResults = commandResults
        self.error = error
        self.idleSince = idleSince
        self.lastProgressAt = lastProgressAt
    }

    private enum CodingKeys: String, CodingKey {
        case version, status, sessionRef, hostPid, sessionUrl, messages, activities, waitingForInput, commandResults, error
        case idleSince, lastProgressAt
    }

    public init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        version = try values.decodeIfPresent(Int.self, forKey: .version) ?? 1
        status = try values.decode(String.self, forKey: .status)
        sessionRef = try values.decode(String.self, forKey: .sessionRef)
        hostPid = try values.decodeIfPresent(Int32.self, forKey: .hostPid)
        sessionUrl = try values.decodeIfPresent(String.self, forKey: .sessionUrl)
        messages = try values.decodeIfPresent([AgentSessionMessage].self, forKey: .messages) ?? []
        activities = try values.decodeIfPresent([AgentSessionActivity].self, forKey: .activities) ?? []
        waitingForInput = try values.decodeIfPresent(Bool.self, forKey: .waitingForInput) ?? false
        commandResults = try values.decodeIfPresent([String: ClaudeHostCommandResult].self, forKey: .commandResults) ?? [:]
        error = try values.decodeIfPresent(String.self, forKey: .error)
        idleSince = try values.decodeIfPresent(Date.self, forKey: .idleSince)
        lastProgressAt = try values.decodeIfPresent(Date.self, forKey: .lastProgressAt) ?? Date()
    }
}

public struct ClaudeHostCommand: Codable, Equatable, Sendable {
    public let id: String
    public let kind: String
    public let text: String
    public let createdAt: String?

    public init(id: String, kind: String, text: String, createdAt: String? = nil) {
        self.id = id
        self.kind = kind
        self.text = text
        self.createdAt = createdAt
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
    private var visibleUserMessageIds = Set<String>()
    private var taskTitles: [String: String] = [:]
    private var turnActive = true

    public init(sessionRef: String, hostPid: Int32? = nil) {
        state = ClaudeHostState(status: "active", sessionRef: sessionRef, hostPid: hostPid)
    }

    /// Resume keeps the durable transcript and command acknowledgements while
    /// replacing only the process identity and live Remote Control endpoint.
    public init(resuming state: ClaudeHostState, hostPid: Int32) {
        var resumed = state
        resumed.hostPid = hostPid
        resumed.status = "suspended"
        resumed.error = nil
        resumed.idleSince = nil
        resumed.lastProgressAt = Date()
        self.state = resumed
        turnActive = false
    }

    public mutating func consume(_ value: [String: Any]) {
        noteProgress()
        guard let type = value["type"] as? String else { return }
        if type == "system", value["subtype"] as? String == "init" {
            initialized = true
            return
        }
        if type == "user" {
            guard value["parent_tool_use_id"] is NSNull || value["parent_tool_use_id"] == nil,
                  isVisibleUserMessage(value),
                  let message = value["message"] as? [String: Any],
                  let text = Self.textContent(message["content"]), !text.isEmpty
            else { return }
            let sourceId = (value["uuid"] as? String) ?? UUID().uuidString
            upsert(AgentSessionMessage(
                sourceId: sourceId,
                turnId: sourceId,
                role: "user",
                text: text,
                occurredAt: CodexProtocol.sourceActivityTimestamp(
                    value["timestamp"] ?? value["createdAt"] ?? value["created_at"]
                )
            ))
            state.status = "active"
            state.idleSince = nil
            turnActive = true
            state.error = nil
            return
        }
        if type == "system" {
            consumeSystemEvent(value)
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
                    occurredAt: previous?.occurredAt ?? CodexProtocol.sourceActivityTimestamp(
                        value["timestamp"] ?? value["createdAt"] ?? value["created_at"]
                    ),
                    questions: questions.isEmpty ? previous?.questions : questions
                ))
            }
            state.status = "active"
            state.idleSince = nil
            turnActive = true
            state.error = nil
            return
        }
        if type == "result" {
            turnActive = false
            state.waitingForInput = false
            state.status = state.activities.isEmpty ? "idle" : "active"
            state.idleSince = state.status == "idle" ? Date() : nil
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

    public mutating func makeUserMessageVisible(id: String) {
        visibleUserMessageIds.insert(id)
    }

    public mutating func recordUserMessage(id: String, text: String, occurredAt: String? = nil) {
        upsert(AgentSessionMessage(
            sourceId: id, turnId: id, role: "user", text: text, occurredAt: occurredAt
        ))
        state.status = "active"
        state.idleSince = nil
        turnActive = true
        state.error = nil
    }

    public mutating func setWaitingForInput(_ waiting: Bool) {
        state.waitingForInput = waiting
        if waiting {
            // Waiting for a person is not executing work and therefore does not
            // consume one of the node's ten execution slots. It is deliberately
            // exempt from the two-hour automatic suspension policy.
            state.status = "idle"
            state.idleSince = nil
        } else if state.status == "idle" {
            state.status = "active"
        }
        noteProgress()
    }

    /// An ordinary tool's approval has no `tool_use` question of its own, so
    /// it is shown as one. Keyed by request so a re-show does not duplicate it.
    public mutating func showPermissionRequest(_ request: ClaudePermissionRequest) {
        guard !request.asksThroughToolUse else { return }
        upsert(AgentSessionMessage(
            sourceId: "permission-\(request.requestId)",
            turnId: latestTurnId(),
            role: "agent",
            text: request.promptText,
            questions: [request.question]
        ))
    }

    public mutating func setRemote(sessionUrl: String) {
        state.sessionUrl = sessionUrl
        if state.status == "suspended" { state.status = "idle" }
        if state.status == "idle", !state.waitingForInput { state.idleSince = Date() }
        state.error = nil
        noteProgress()
    }

    public mutating func fail(_ message: String) {
        state.status = "failed"
        state.error = message
        state.idleSince = nil
        noteProgress()
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
        turnActive = true
        state.status = "active"
        state.error = nil
        state.idleSince = nil
        noteProgress()
    }

    public mutating func markIdle() {
        turnActive = false
        state.status = state.activities.isEmpty ? "idle" : "active"
        state.idleSince = state.status == "idle" && !state.waitingForInput ? Date() : nil
        noteProgress()
    }

    public mutating func markUnavailable(_ message: String) {
        state.status = "unavailable"
        state.error = message
        state.idleSince = nil
        noteProgress()
    }

    public mutating func markSuspended(_ message: String = "Claude Code 会话已空闲 2 小时，进程已挂起；发送下一条消息时会恢复。") {
        turnActive = false
        state.status = "suspended"
        state.hostPid = nil
        state.error = message
        state.idleSince = nil
        noteProgress()
    }

    public mutating func markStalled() {
        guard state.status == "active" else { return }
        state.status = "stalled"
        state.error = "疑似卡住：连续 30 分钟没有输出且进程树 CPU 无进展；为避免误杀长时间测试，MissionGo 未自动终止。"
    }

    public mutating func noteProgress(at now: Date = Date()) {
        state.lastProgressAt = now
        if state.status == "stalled" {
            state.status = "active"
            state.error = nil
        }
    }

    public mutating func ensureIdleClock(at now: Date = Date()) {
        guard state.status == "idle", !state.waitingForInput, state.activities.isEmpty else { return }
        if state.idleSince == nil { state.idleSince = now }
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

    private func isVisibleUserMessage(_ value: [String: Any]) -> Bool {
        if let origin = value["origin"] as? [String: Any], origin["kind"] as? String == "human" { return true }
        guard let id = value["uuid"] as? String else { return false }
        return visibleUserMessageIds.contains(id)
    }

    private mutating func consumeSystemEvent(_ value: [String: Any]) {
        guard let subtype = value["subtype"] as? String else { return }
        if subtype == "task_started", let id = value["task_id"] as? String {
            taskTitles[id] = Self.safeTaskTitle(value["description"] as? String)
            refreshActivities(ids: Set(taskTitles.keys))
            return
        }
        if subtype == "task_notification", let id = value["task_id"] as? String {
            let status = value["status"] as? String
            if status == "completed" || status == "failed" || status == "cancelled" {
                taskTitles.removeValue(forKey: id)
                refreshActivities(ids: Set(taskTitles.keys))
            }
            return
        }
        guard subtype == "background_tasks_changed", let tasks = value["tasks"] as? [[String: Any]] else { return }
        var activeIds = Set<String>()
        for task in tasks {
            guard let id = task["task_id"] as? String else { continue }
            activeIds.insert(id)
            let type = task["task_type"] as? String
            let description = task["description"] as? String
            taskTitles[id] = type == "local_agent" ? Self.safeTaskTitle(description) : "后台命令"
        }
        taskTitles = taskTitles.filter { activeIds.contains($0.key) }
        refreshActivities(ids: activeIds)
    }

    private mutating func refreshActivities(ids: Set<String>) {
        state.activities = ids.sorted().map { id in
            AgentSessionActivity(id: id, title: taskTitles[id] ?? "后台任务", detail: "运行中")
        }
        state.status = turnActive || !state.activities.isEmpty ? "active" : "idle"
        state.idleSince = state.status == "idle" && !state.waitingForInput ? Date() : nil
    }

    private static func safeTaskTitle(_ description: String?) -> String {
        let value = description?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        guard !value.isEmpty else { return "后台任务" }
        if value.contains("/") || value.contains(";") || value.contains("&&") || value.count > 120 {
            return "后台命令"
        }
        return value
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
                return AgentSessionQuestion(
                    header: question["header"] as? String,
                    title: title,
                    options: options?.isEmpty == false ? options : nil,
                    multiSelect: question["multiSelect"] as? Bool
                )
            }
        } + content.compactMap { block -> AgentSessionQuestion? in
            guard block["type"] as? String == "tool_use", block["name"] as? String == "ExitPlanMode" else { return nil }
            return AgentSessionQuestion(
                header: "计划审批",
                title: "是否批准这份计划并开始实施？",
                options: ["批准并实施", "继续修改计划"]
            )
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

    public static func executablePath(_ pid: Int32) -> String? {
        guard pid > 0 else { return nil }
        // Darwin's PROC_PIDPATHINFO_MAXSIZE macro is not imported into Swift.
        var buffer = [CChar](repeating: 0, count: 4 * Int(MAXPATHLEN))
        let count = proc_pidpath(pid, &buffer, UInt32(buffer.count))
        guard count > 0 else { return nil }
        return String(cString: buffer)
    }

    public static func isClaudeHost(_ pid: Int32) -> Bool {
        guard isRunning(pid), let path = executablePath(pid) else { return false }
        return URL(fileURLWithPath: path).lastPathComponent == ClaudeHostLocation.executableName
    }

    public static func terminateGroup(_ pid: Int32) {
        guard isClaudeHost(pid) else { return }
        // The host makes itself a process-group leader before starting Claude;
        // one signal therefore reaches the CLI and any tests/builds it spawned.
        if Darwin.kill(-pid, SIGTERM) != 0 { _ = Darwin.kill(pid, SIGTERM) }
    }
}

public enum ClaudeRuntimePolicy {
    public static func shouldSuspend(state: ClaudeHostState, now: Date, timeout: TimeInterval) -> Bool {
        guard state.status == "idle", !state.waitingForInput, state.activities.isEmpty,
              let idleSince = state.idleSince else { return false }
        return now.timeIntervalSince(idleSince) >= timeout
    }

    public static func shouldWarnStalled(
        state: ClaudeHostState,
        now: Date,
        lastCpuProgressAt: Date,
        timeout: TimeInterval
    ) -> Bool {
        guard state.status == "active", !state.waitingForInput else { return false }
        return now.timeIntervalSince(state.lastProgressAt) >= timeout
            && now.timeIntervalSince(lastCpuProgressAt) >= timeout
    }
}

public enum ClaudeProcessActivity {
    private static func processInfo(_ pid: pid_t) -> (parent: pid_t, cpu: UInt64)? {
        var bsd = proc_bsdinfo()
        guard proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &bsd, Int32(MemoryLayout.size(ofValue: bsd)))
            == Int32(MemoryLayout.size(ofValue: bsd)) else { return nil }
        var task = proc_taskinfo()
        guard proc_pidinfo(pid, PROC_PIDTASKINFO, 0, &task, Int32(MemoryLayout.size(ofValue: task)))
            == Int32(MemoryLayout.size(ofValue: task)) else { return nil }
        return (pid_t(bsd.pbi_ppid), task.pti_total_user &+ task.pti_total_system)
    }

    /// Sum CPU time for Claude and every descendant, so a quiet parent waiting
    /// on a one-hour test still counts as progress and never triggers a warning.
    public static func totalCpuNanoseconds(rootPid: pid_t) -> UInt64? {
        let capacity = proc_listallpids(nil, 0)
        guard capacity > 0 else { return nil }
        var pids = [pid_t](repeating: 0, count: Int(capacity))
        let bytes = pids.withUnsafeMutableBytes { proc_listallpids($0.baseAddress, Int32($0.count)) }
        guard bytes > 0 else { return nil }
        let count = min(pids.count, Int(bytes))
        var info: [pid_t: (parent: pid_t, cpu: UInt64)] = [:]
        for pid in pids.prefix(count) where pid > 0 {
            if let value = processInfo(pid) { info[pid] = value }
        }
        guard info[rootPid] != nil else { return nil }
        var descendants: Set<pid_t> = [rootPid]
        var changed = true
        while changed {
            changed = false
            for (pid, value) in info where !descendants.contains(pid) && descendants.contains(value.parent) {
                descendants.insert(pid)
                changed = true
            }
        }
        return descendants.reduce(0) { $0 &+ (info[$1]?.cpu ?? 0) }
    }
}

public enum ClaudeProcessEnvironment {
    public static func unattended(_ base: [String: String]) -> [String: String] {
        var result = base
        result["DISABLE_AUTOUPDATER"] = "1"
        return result
    }
}
