import Darwin
import Foundation
import MissionGoNodeCore

private enum HostFailure: Error, LocalizedError {
    case usage
    case invalidMode(String)
    case invalidSettings(String)
    case writeClosed

    var errorDescription: String? {
        switch self {
        case .usage: return "usage: MissionGoClaudeHost <config.json>"
        case let .invalidMode(mode): return "unsupported Claude Code mode: \(mode)"
        case let .invalidSettings(problem): return problem
        case .writeClosed: return "Claude Code closed its control input."
        }
    }
}

private func jsonLine(_ value: [String: Any]) throws -> Data {
    var data = try JSONSerialization.data(withJSONObject: value)
    data.append(0x0a)
    return data
}

private func appendLog(_ data: Data, handle: FileHandle) {
    try? handle.write(contentsOf: data)
}

private func openLog(_ path: String) throws -> FileHandle {
    FileManager.default.createFile(atPath: path, contents: nil, attributes: [.posixPermissions: 0o600])
    let handle = try FileHandle(forWritingTo: URL(fileURLWithPath: path))
    try handle.seekToEnd()
    return handle
}

private func write(_ value: [String: Any], to handle: FileHandle) throws {
    do {
        try handle.write(contentsOf: jsonLine(value))
    } catch {
        throw HostFailure.writeClosed
    }
}

private func controlRequest(id: String, request: [String: Any]) -> [String: Any] {
    ["type": "control_request", "request_id": id, "request": request]
}

private func controlResponse(id: String, result: [String: Any]) -> [String: Any] {
    [
        "type": "control_response",
        "response": ["subtype": "success", "request_id": id, "response": result],
    ]
}

private func userMessage(id: String, text: String) -> [String: Any] {
    [
        "type": "user",
        "uuid": id,
        "session_id": "",
        "message": ["role": "user", "content": [["type": "text", "text": text]]],
        "parent_tool_use_id": NSNull(),
    ]
}

private func commandFiles(in directory: String) -> [String] {
    ((try? FileManager.default.contentsOfDirectory(atPath: directory)) ?? [])
        .filter { $0.hasSuffix(".json") }
        .sorted()
        .map { "\(directory)/\($0)" }
}

private func run(configPath: String) throws {
    // Rewritten after a person switches settings, so a later resume starts
    // Claude Code with what they chose rather than what the dispatch said.
    var config = try JSONDecoder().decode(
        ClaudeHostConfiguration.self,
        from: Data(contentsOf: URL(fileURLWithPath: configPath))
    )
    guard ClaudeCodeModes.isAllowed(config.mode) else { throw HostFailure.invalidMode(config.mode) }
    if let problem = AgentModelSettings.problem(model: config.model, effort: config.effort) {
        throw HostFailure.invalidSettings(problem)
    }

    // MissionGo terminates the whole group on startup timeout or when all work
    // items reach verification/done. Claude and its test/build descendants
    // inherit this group, so no orphan survives the host.
    _ = setpgid(0, 0)

    let log = try openLog(config.logPath)
    defer { try? log.close() }
    let previous = try? ClaudeHostFiles.readState(config.statePath)
    let resuming = previous?.status == "suspended"
    var snapshot = resuming
        ? ClaudeStreamSnapshot(resuming: previous!, hostPid: getpid())
        : ClaudeStreamSnapshot(sessionRef: config.sessionRef, hostPid: getpid())
    snapshot.adoptConfiguration(config)
    try ClaudeHostFiles.write(snapshot.state, to: config.statePath)

    let input = Pipe()
    let output = Pipe()
    let process = Process()
    process.executableURL = URL(fileURLWithPath: config.claudeExecutable)
    process.arguments = ClaudeHostArguments.claude(
        mode: config.mode,
        sessionName: config.sessionName,
        sessionRef: config.sessionRef,
        resuming: resuming,
        model: config.model,
        effort: config.effort
    )
    process.currentDirectoryURL = URL(fileURLWithPath: config.cwd, isDirectory: true)
    var environment = ProcessInfo.processInfo.environment
    environment["CLAUDE_CODE_ENTRYPOINT"] = "sdk-ts"
    process.environment = ClaudeProcessEnvironment.unattended(environment)
    process.standardInput = input
    process.standardOutput = output
    process.standardError = log
    try process.run()

    let readDescriptor = output.fileHandleForReading.fileDescriptor
    let currentFlags = fcntl(readDescriptor, F_GETFL)
    _ = fcntl(readDescriptor, F_SETFL, currentFlags | O_NONBLOCK)
    let writer = input.fileHandleForWriting
    var buffer = Data()
    let initializeRequestId = UUID().uuidString
    var remoteRequestId: String?
    var controlReady = false
    var promptSent = false
    var promptId: String?
    var pendingControlCommands: [String: String] = [:]
    var settingsChange: ClaudeSettingsChange?
    var permissions = ClaudePermissionQueue()
    var shouldContinue = true
    var lastCpu = ClaudeProcessActivity.totalCpuNanoseconds(rootPid: process.processIdentifier)
    var lastCpuProgressAt = Date()
    var nextCpuSampleAt = Date().addingTimeInterval(60)

    // The Agent SDK performs this handshake before exposing any other control
    // method. Without it the CLI starts hooks but waits forever for its host.
    try write(controlRequest(id: initializeRequestId, request: ["subtype": "initialize"]), to: writer)

    func persist() {
        try? ClaudeHostFiles.write(snapshot.state, to: config.statePath)
    }

    func finishSettings(_ change: ClaudeSettingsChange) {
        snapshot.finishSettings(change)
        config = config.applying(change.appliedSettings)
        // Best effort: the running session already has the settings; only a
        // later resume would miss them.
        try? ClaudeHostFiles.write(config, to: configPath)
        persist()
    }

    func showNextPermission() {
        if let next = permissions.head {
            snapshot.showPermissionRequest(next)
        } else {
            snapshot.setWaitingForInput(false)
        }
    }

    func startWork() throws {
        controlReady = true
        if resuming {
            snapshot.markIdle()
            snapshot.confirmLaunch()
        } else {
            let id = UUID().uuidString
            try write(userMessage(id: id, text: config.prompt), to: writer)
            promptId = id
            promptSent = true
        }
        persist()
    }

    func handleEvent(_ event: [String: Any]) throws {
        if let request = ClaudePermissionRequest(event: event) {
            // Every approval Claude Code asks for waits here for a person;
            // none is answered on their behalf.
            permissions.enqueue(request)
            if permissions.head?.requestId == request.requestId {
                snapshot.showPermissionRequest(request)
            }
            snapshot.setWaitingForInput(true)
            persist()
            return
        }
        if event["type"] as? String == "control_cancel_request",
           let requestId = event["request_id"] as? String,
           permissions.cancel(requestId: requestId) {
            // Answered on the claude.ai page instead of in MissionGo.
            showNextPermission()
            persist()
            return
        }
        if event["type"] as? String == "control_response",
           let response = event["response"] as? [String: Any],
           let requestId = response["request_id"] as? String {
            if requestId == initializeRequestId {
                guard response["subtype"] as? String == "success" else {
                    snapshot.fail((response["error"] as? String) ?? "Claude Code 控制通道初始化失败。")
                    persist()
                    shouldContinue = false
                    return
                }
                // The heartbeat reads this instead of starting `claude` itself.
                if let path = config.modelsCachePath,
                   let body = response["response"] as? [String: Any],
                   let options = ClaudeModelCatalog.options(fromInitialize: body) {
                    try? ClaudeModelCatalog.save(options, to: path)
                }
                let body = response["response"] as? [String: Any] ?? [:]
                if body["remote_control_available"] as? Bool == false {
                    snapshot.setMissionGoControl()
                    try startWork()
                    return
                }
                let requestId = UUID().uuidString
                remoteRequestId = requestId
                try write(controlRequest(id: requestId, request: [
                    "subtype": "remote_control",
                    "enabled": true,
                    "name": config.sessionName,
                    "keep_session_on_exit": true,
                ]), to: writer)
                return
            }
            if requestId == remoteRequestId {
                guard response["subtype"] as? String == "success",
                      let body = response["response"] as? [String: Any],
                      let sessionUrl = body["session_url"] as? String
                else {
                    // Remote Control is optional. Older CLIs may not advertise
                    // availability during initialize but can still run locally.
                    snapshot.setMissionGoControl()
                    try startWork()
                    return
                }
                snapshot.setRemote(sessionUrl: sessionUrl)
                try startWork()
                return
            }
            if var change = settingsChange, change.receive(requestId: requestId, response: response) {
                settingsChange = change
                if change.isComplete {
                    settingsChange = nil
                    finishSettings(change)
                }
                return
            }
            if let commandId = pendingControlCommands.removeValue(forKey: requestId) {
                if response["subtype"] as? String == "success" {
                    snapshot.commandFinished(id: commandId, status: "delivered")
                    snapshot.markIdle()
                } else {
                    snapshot.commandFinished(
                        id: commandId,
                        status: "failed",
                        error: (response["error"] as? String) ?? "Claude Code 拒绝了终止请求。"
                    )
                }
                persist()
            }
            return
        }

        snapshot.consume(event)
        if promptSent,
           (event["type"] as? String == "system" && event["subtype"] as? String == "init"
            || event["type"] as? String == "user" && event["uuid"] as? String == promptId) {
            snapshot.confirmLaunch()
            promptSent = false
        }
        persist()
    }

    func handleCommands() throws {
        guard controlReady else { return }
        for path in commandFiles(in: config.commandsDirectory) {
            let command: ClaudeHostCommand
            do {
                command = try JSONDecoder().decode(ClaudeHostCommand.self, from: Data(contentsOf: URL(fileURLWithPath: path)))
            } catch {
                try? FileManager.default.removeItem(atPath: path)
                continue
            }
            if snapshot.state.commandResults[command.id] != nil {
                try? FileManager.default.removeItem(atPath: path)
                continue
            }
            if command.kind == "settings" {
                guard let settings = command.settings,
                      settings.revision > (snapshot.state.settingsRevision ?? 0)
                else {
                    try? FileManager.default.removeItem(atPath: path)
                    continue
                }
                // One change at a time; a newer one waits for its file to be read again.
                if settingsChange != nil { continue }
                let change = ClaudeSettingsChange(settings)
                for (requestId, request) in change.requests {
                    try write(controlRequest(id: requestId, request: request), to: writer)
                }
                if change.isComplete {
                    finishSettings(change)
                } else {
                    settingsChange = change
                }
                try? FileManager.default.removeItem(atPath: path)
                continue
            }
            if command.kind == "interrupt" {
                let requestId = UUID().uuidString
                pendingControlCommands[requestId] = command.id
                try write(controlRequest(id: requestId, request: ["subtype": "interrupt"]), to: writer)
            } else {
                if let answered = permissions.answerHead(command.text) {
                    try write(controlResponse(id: answered.requestId, result: answered.result), to: writer)
                    snapshot.recordUserMessage(
                        id: command.id, text: command.text, occurredAt: command.createdAt
                    )
                } else {
                    snapshot.makeUserMessageVisible(id: command.id)
                    try write(userMessage(id: command.id, text: command.text), to: writer)
                }
                snapshot.commandFinished(id: command.id, status: "delivered")
                snapshot.markActive()
                // A parallel tool call may still be waiting; the session then
                // stays in "waiting for input" rather than "active".
                showNextPermission()
                if !permissions.isEmpty { snapshot.setWaitingForInput(true) }
                persist()
            }
            try? FileManager.default.removeItem(atPath: path)
        }
    }

    while shouldContinue && process.isRunning {
        var bytes = [UInt8](repeating: 0, count: 64 * 1024)
        let count = Darwin.read(readDescriptor, &bytes, bytes.count)
        if count > 0 {
            let data = Data(bytes.prefix(count))
            appendLog(data, handle: log)
            snapshot.noteProgress()
            buffer.append(data)
            while let newline = buffer.firstIndex(of: 0x0a) {
                let line = buffer[..<newline]
                buffer.removeSubrange(...newline)
                guard !line.isEmpty,
                      let object = try? JSONSerialization.jsonObject(with: Data(line)) as? [String: Any]
                else { continue }
                try handleEvent(object)
            }
        } else if count < 0 && errno != EAGAIN && errno != EWOULDBLOCK {
            break
        }
        try handleCommands()
        let now = Date()
        snapshot.ensureIdleClock(at: now)
        if ClaudeRuntimePolicy.shouldSuspend(state: snapshot.state, now: now, timeout: config.idleTimeoutSeconds) {
            snapshot.markSuspended()
            persist()
            shouldContinue = false
        }
        if now >= nextCpuSampleAt {
            if let cpu = ClaudeProcessActivity.totalCpuNanoseconds(rootPid: process.processIdentifier) {
                if let previousCpu = lastCpu, cpu > previousCpu {
                    lastCpuProgressAt = now
                    snapshot.noteProgress(at: now)
                }
                lastCpu = cpu
            }
            if ClaudeRuntimePolicy.shouldWarnStalled(
                state: snapshot.state,
                now: now,
                lastCpuProgressAt: lastCpuProgressAt,
                timeout: config.stallWarningSeconds
            ) {
                snapshot.markStalled()
                persist()
            }
            nextCpuSampleAt = now.addingTimeInterval(60)
        }
        usleep(100_000)
    }

    if process.isRunning, snapshot.state.status == "suspended" {
        // The host and Claude share this process group. Ignore the signal only
        // in the already-persisted host so Claude and any test/build descendants
        // are stopped together instead of becoming orphans.
        _ = signal(SIGTERM, SIG_IGN)
        _ = kill(-getpid(), SIGTERM)
    } else if process.isRunning {
        process.terminate()
    }
    process.waitUntilExit()
    _ = signal(SIGTERM, SIG_DFL)
    if !snapshot.state.launchReady && snapshot.state.status != "failed" {
        snapshot.fail("Claude Code 在接收派单提示词前退出（code=\(process.terminationStatus)）。")
    } else if snapshot.state.status == "active" || snapshot.state.status == "stalled" {
        snapshot.markUnavailable("Claude Code 宿主已退出（code=\(process.terminationStatus)）。")
    }
    persist()
}

do {
    guard CommandLine.arguments.count == 2 else { throw HostFailure.usage }
    try run(configPath: CommandLine.arguments[1])
} catch {
    FileHandle.standardError.write(Data("MissionGoClaudeHost: \(error.localizedDescription)\n".utf8))
    exit(1)
}
