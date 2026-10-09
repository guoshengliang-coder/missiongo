import Darwin
import Foundation
import MissionGoNodeCore

private let usage = """
MissionGoClaudeBridge start [Claude options] -- <prompt>
MissionGoClaudeBridge resume <session-id> [--confirm-config-change] -- <prompt>
MissionGoClaudeBridge adopt <session-id> --history <file> --handoff-pid <exited-pid> --confirm-handoff [--confirm-config-change] [Claude options] -- <prompt>
MissionGoClaudeBridge watch <session-id>
MissionGoClaudeBridge send <session-id> -- <text>
MissionGoClaudeBridge answer <session-id> <request-id> -- <answer>
MissionGoClaudeBridge release <session-id>
MissionGoClaudeBridge confirm <session-id> <command-id> received|not_received

Claude options: --model, --effort, --permission-mode, --settings <file>, --mcp-config <file>, --add-dir, --plugin-dir, --strict-mcp-config.
在原第三方模型终端中运行。凭据只通过进程环境继承，不保存或上传。
交互输入：普通文字；/answer <request-id> <answer>；/detach；/release；/confirm <command-id> received|not_received。
"""

private func configuration(_ root: String, _ ref: String) throws -> ClaudeHostConfiguration {
    try JSONDecoder().decode(ClaudeHostConfiguration.self,
        from: Data(contentsOf: URL(fileURLWithPath: ClaudeHostStore.configPath(root: root, sessionRef: ref))))
}

private func enqueue(root: String, ref: String, text: String, requestId: String? = nil, release: Bool = false, confirm: Bool = false) throws {
    if !release && !confirm && (text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || text.count > 20_000) {
        throw LaunchError("本机回复需要 1 到 20000 个字符。")
    }
    let config = try configuration(root, ref)
    let state = try ClaudeHostFiles.readState(config.statePath)
    guard config.externalArguments != nil, state.sessionRef == ref, state.launchReady, !["suspended", "failed"].contains(state.status), let pid = state.hostPid,
          ClaudeHostProcess.isClaudeHost(pid, servingConfigPath: ClaudeHostStore.configPath(root: root, sessionRef: ref)) else {
        throw LaunchError("本地桥接未运行；请在原模型配置终端中 resume。")
    }
    let command = ClaudeHostCommand(id: UUID().uuidString.lowercased(),
        kind: confirm ? "delivery_resolution" : release ? "release" : requestId == nil ? "message" : "permission_response",
        text: text, createdAt: ISO8601DateFormatter().string(from: Date()), permissionRequestId: requestId)
    try ClaudeHostFiles.write(command, to: ClaudeHostStore.commandPath(root: root, sessionRef: ref, commandId: command.id))
    print("本地命令：\(command.id)")
}

private final class InputLines: @unchecked Sendable {
    private let lock = NSLock()
    private var lines: [String] = []
    private var ended = false
    func read() {
        while let line = readLine() { lock.lock(); lines.append(line); lock.unlock() }
        lock.lock(); ended = true; lock.unlock()
    }
    func drain() -> ([String], Bool) {
        lock.lock(); defer { lock.unlock() }
        let result = lines; lines = []; return (result, ended)
    }
}

private func watch(root: String, ref: String, interactive: Bool) throws {
    let input = InputLines()
    if interactive { DispatchQueue.global().async { input.read() } }
    var shown: [String: String] = [:]
    var lastStatus = ""
    var shownCommands: [String: ClaudeHostCommandResult] = [:]
    while true {
        if let state = try? ClaudeHostFiles.readState(ClaudeHostStore.statePath(root: root, sessionRef: ref)) {
            for message in state.messages where shown[message.sourceId] != message.text {
                print("[\(message.role)] \(message.text)")
                if message.sourceId.hasPrefix("permission-") {
                    print("本机回答：/answer \(message.sourceId.dropFirst(11)) <答案或批准/拒绝>")
                }
                shown[message.sourceId] = message.text
            }
            for (id, result) in state.commandResults where shownCommands[id] != result {
                print("[交付] \(id) \(result.status) \(result.error ?? "")")
                shownCommands[id] = result
            }
            let status = state.status + (state.error.map { ": " + $0 } ?? "")
            if status != lastStatus { print("[状态] \(status)"); lastStatus = status }
            if state.status == "failed" { throw LaunchError(state.error ?? "Claude 桥接失败。") }
            if let pid = state.hostPid, !ClaudeHostProcess.isRunning(pid) { return }
            if state.status == "suspended" { return }
        }
        if interactive {
            let (lines, ended) = input.drain()
            for line in lines {
                if line == "/detach" { return }
                if line == "/release" { try enqueue(root: root, ref: ref, text: "", release: true); continue }
                if line.hasPrefix("/confirm ") {
                    let parts = line.dropFirst(9).split(separator: " ", maxSplits: 1).map(String.init)
                    guard parts.count == 2, ["received", "not_received"].contains(parts[1]) else { print("/confirm <command-id> received|not_received"); continue }
                    try enqueue(root: root, ref: ref, text: parts[1], requestId: parts[0], confirm: true)
                } else if line.hasPrefix("/answer ") {
                    let parts = line.dropFirst(8).split(separator: " ", maxSplits: 1).map(String.init)
                    guard parts.count == 2 else { print("/answer <request-id> <answer>"); continue }
                    try enqueue(root: root, ref: ref, text: parts[1], requestId: parts[0])
                } else if !line.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                    try enqueue(root: root, ref: ref, text: line)
                }
            }
            if ended { print("终端输入已关闭；宿主继续运行，可从 MissionGo Web 回复。"); return }
        }
        usleep(100_000)
    }
}

private func run() throws {
    _ = umask(0o077)
    var args = Array(CommandLine.arguments.dropFirst())
    guard let action = args.first else { print(usage); return }
    args.removeFirst()
    if action == "--help" || action == "help" { print(usage); return }
    let root = ClaudeExternalBridge.root()
    try ClaudeExternalBridge.privateDirectory(root)
    let ref: String
    if action == "start" { ref = UUID().uuidString.lowercased() }
    else {
        guard !args.isEmpty else { throw LaunchError(usage) }
        ref = try ClaudeExternalBridge.normalizedRef(args.removeFirst())
    }
    let directory = ClaudeHostStore.sessionDirectory(root: root, sessionRef: ref)
    try ClaudeExternalBridge.privateDirectory(directory)
    if action == "watch" { try watch(root: root, ref: ref, interactive: true); return }
    if action == "release" { try enqueue(root: root, ref: ref, text: "", release: true); return }
    if action == "confirm" {
        guard args.count == 2, ["received", "not_received"].contains(args[1]) else { throw LaunchError(usage) }
        try enqueue(root: root, ref: ref, text: args[1], requestId: args[0], confirm: true)
        return
    }
    if action == "send" || action == "answer" {
        var requestId: String?
        if action == "answer" { guard !args.isEmpty else { throw LaunchError(usage) }; requestId = args.removeFirst() }
        guard args.first == "--" else { throw LaunchError(usage) }
        try enqueue(root: root, ref: ref, text: args.dropFirst().joined(separator: " "), requestId: requestId)
        return
    }
    guard ["start", "resume", "adopt"].contains(action), let delimiter = args.firstIndex(of: "--") else { throw LaunchError(usage) }
    var options = Array(args[..<delimiter])
    let prompt = args[(delimiter + 1)...].joined(separator: " ").trimmingCharacters(in: .whitespacesAndNewlines)
    guard !prompt.isEmpty else { throw LaunchError("启动或恢复需要明确的处理提示词。") }
    let startLease = try ClaudeExternalBridge.Lease(directory: directory, name: "start.lock")
    defer { withExtendedLifetime(startLease) {} }
    // Prove no bridge owns stdin before touching config or history.
    do { let lease = try ClaudeExternalBridge.Lease(directory: directory); withExtendedLifetime(lease) {} }
    let cwd = FileManager.default.currentDirectoryPath
    let configPath = ClaudeHostStore.configPath(root: root, sessionRef: ref)
    let statePath = ClaudeHostStore.statePath(root: root, sessionRef: ref)
    let commandsDirectory = directory + "/commands"
    try ClaudeExternalBridge.privateDirectory(commandsDirectory)
    let existing = try? configuration(root, ref)
    if let state = try? ClaudeHostFiles.readState(statePath), let child = state.externalChildPid, ClaudeHostProcess.isRunning(child) {
        throw LaunchError("原桥接 CLI 进程仍在运行；请先明确释放或处理原进程，未启动第二个会话。")
    }
    var messages: [AgentSessionMessage] = []
    if action == "adopt" {
        guard options.contains("--confirm-handoff") else { throw LaunchError("移交需要 --confirm-handoff，且原会话无活跃回合或待审批。") }
        let confirmChange = options.contains("--confirm-config-change")
        options.removeAll { $0 == "--confirm-handoff" || $0 == "--confirm-config-change" }
        if let fingerprint = existing?.externalEnvironmentFingerprint,
           fingerprint != ClaudeExternalBridge.environmentFingerprint(ProcessInfo.processInfo.environment), !confirmChange {
            throw LaunchError("当前终端配置与原桥接不同；请恢复原配置，或用 --confirm-config-change 明确采用当前配置。")
        }
        func take(_ name: String) throws -> String {
            guard let index = options.firstIndex(of: name), index + 1 < options.count else { throw LaunchError(usage) }
            let value = options[index + 1]; options.removeSubrange(index...(index + 1)); return value
        }
        let history = try take("--history")
        let pidValue = try take("--handoff-pid")
        guard let pid = Int32(pidValue), pid > 0, !ClaudeHostProcess.isRunning(pid) else {
            throw LaunchError("原 CLI 进程尚未退出，或 PID 无效；未接管。")
        }
        messages = try ClaudeExternalBridge.history(path: history, sessionRef: ref, cwd: cwd)
        if options.isEmpty { options = existing?.externalArguments ?? [] }
    } else if action == "resume" {
        let confirmChange = options == ["--confirm-config-change"]
        guard let existing, existing.externalArguments != nil, existing.cwd == cwd, options.isEmpty || confirmChange else {
            throw LaunchError("恢复需在原工作目录执行，沿用已有参数；认证与接口仍由当前终端提供。")
        }
        if let fingerprint = existing.externalEnvironmentFingerprint,
           fingerprint != ClaudeExternalBridge.environmentFingerprint(ProcessInfo.processInfo.environment), !confirmChange {
            throw LaunchError("当前终端的模型/接口/代理配置与启动时不同；请恢复原配置，或用 --confirm-config-change 明确采用当前配置。")
        }
        options = existing.externalArguments ?? []
        if let state = try? ClaudeHostFiles.readState(statePath) {
            guard !state.turnActive, !state.waitingForInput else {
                throw LaunchError("上次会话仍有未完成回合或审批；请先在原 CLI 处理，再显式移交。")
            }
            messages = state.messages
        }
    }
    try ClaudeExternalBridge.validateArguments(options)
    let environment = ShellEnvironment(path: ProcessInfo.processInfo.environment["PATH"] ?? "")
    guard let executable = environment.which("claude"), let host = ClaudeHostLocation.executable() else {
        throw LaunchError("找不到 claude 或 MissionGoClaudeHost；请使用含桥接入口的客户端。")
    }
    let config = ClaudeHostConfiguration(claudeExecutable: executable, cwd: cwd, mode: "default",
        sessionName: existing?.sessionName ?? "MissionGo external Claude", sessionRef: ref,
        prompt: prompt + "\nMissionGo 会话原生 ID：" + ref + "。领取条目时如需登记处理会话，使用 claude_code、refKind native 和此 ID。",
        statePath: statePath, commandsDirectory: commandsDirectory, logPath: directory + "/host.log",
        externalArguments: options, externalResume: action != "start",
        externalEnvironmentFingerprint: ClaudeExternalBridge.environmentFingerprint(environment.environment))
    try ClaudeHostFiles.write(config, to: configPath)
    var state = (try? ClaudeHostFiles.readState(statePath)) ?? ClaudeHostState(status: "suspended", sessionRef: ref, messages: messages, turnActive: false)
    state = ClaudeExternalBridge.uncertainWrites(state)
    state.messages = messages
    state.launchReady = false
    state.hostPid = nil
    state.externalChildPid = nil
    state.status = "suspended"
    state.turnActive = false
    state.waitingForInput = false
    try ClaudeHostFiles.write(state, to: statePath)
    let process = Process()
    process.executableURL = URL(fileURLWithPath: host)
    process.arguments = [configPath]
    process.environment = environment.environment
    process.standardInput = FileHandle.nullDevice
    process.standardOutput = FileHandle.nullDevice
    process.standardError = FileHandle.nullDevice
    try process.run()
    print("Claude 原生会话 ID：\(ref)")
    print("在 MissionGo 外部会话记录中选择此 Mac 节点，首次成功同步后可回复。")
    let deadline = Date().addingTimeInterval(60)
    while Date() < deadline {
        if let state = try? ClaudeHostFiles.readState(statePath), state.launchReady && state.hostPid == process.processIdentifier { break }
        guard process.isRunning else { throw LaunchError("桥接宿主退出；请核对 CLI 协议和本机第三方配置。") }
        usleep(100_000)
    }
    guard (try ClaudeHostFiles.readState(statePath)).launchReady else {
        throw LaunchError("CLI 尚未确认会话，暂不可从 Web 回复；请在本机核对状态，不要重复启动。")
    }
    try watch(root: root, ref: ref, interactive: true)
}

do { try run() }
catch { FileHandle.standardError.write(Data("MissionGoClaudeBridge: \(error.localizedDescription)\n".utf8)); exit(1) }
