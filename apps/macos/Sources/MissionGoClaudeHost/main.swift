import Darwin
import Foundation
import MissionGoNodeCore

private enum HostFailure: Error, LocalizedError {
    case usage
    case invalidMode(String)
    case writeClosed

    var errorDescription: String? {
        switch self {
        case .usage: return "usage: MissionGoClaudeHost <config.json>"
        case let .invalidMode(mode): return "unsupported Claude Code mode: \(mode)"
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
    let config = try JSONDecoder().decode(
        ClaudeHostConfiguration.self,
        from: Data(contentsOf: URL(fileURLWithPath: configPath))
    )
    guard ClaudeCodeModes.isAllowed(config.mode) else { throw HostFailure.invalidMode(config.mode) }

    let log = try openLog(config.logPath)
    defer { try? log.close() }
    var snapshot = ClaudeStreamSnapshot(sessionRef: config.sessionRef, hostPid: getpid())
    try ClaudeHostFiles.write(snapshot.state, to: config.statePath)

    let input = Pipe()
    let output = Pipe()
    let process = Process()
    process.executableURL = URL(fileURLWithPath: config.claudeExecutable)
    process.arguments = [
        "--output-format", "stream-json",
        "--verbose",
        "--input-format", "stream-json",
        "--replay-user-messages",
        "--no-chrome",
        "--permission-mode", config.mode,
        "--session-id", config.sessionRef,
        "--name", config.sessionName,
    ]
    process.currentDirectoryURL = URL(fileURLWithPath: config.cwd, isDirectory: true)
    var environment = ProcessInfo.processInfo.environment
    environment["CLAUDE_CODE_ENTRYPOINT"] = "sdk-ts"
    process.environment = environment
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
    var remoteReady = false
    var pendingControlCommands: [String: String] = [:]
    var shouldContinue = true

    // The Agent SDK performs this handshake before exposing any other control
    // method. Without it the CLI starts hooks but waits forever for its host,
    // so no work prompt is sent until initialize and remote_control both pass.
    try write(controlRequest(id: initializeRequestId, request: ["subtype": "initialize"]), to: writer)

    func persist() {
        try? ClaudeHostFiles.write(snapshot.state, to: config.statePath)
    }

    func handleEvent(_ event: [String: Any]) throws {
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
                    snapshot.fail((response["error"] as? String) ?? "Claude Code 不支持受控 Remote Control 会话。")
                    persist()
                    shouldContinue = false
                    return
                }
                snapshot.setRemote(sessionUrl: sessionUrl)
                remoteReady = true
                try write(userMessage(id: UUID().uuidString, text: config.prompt), to: writer)
                persist()
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
        persist()
    }

    func handleCommands() throws {
        guard remoteReady else { return }
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
            if command.kind == "interrupt" {
                let requestId = UUID().uuidString
                pendingControlCommands[requestId] = command.id
                try write(controlRequest(id: requestId, request: ["subtype": "interrupt"]), to: writer)
            } else {
                try write(userMessage(id: command.id, text: command.text), to: writer)
                snapshot.commandFinished(id: command.id, status: "delivered")
                snapshot.markActive()
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
        usleep(100_000)
    }

    if process.isRunning { process.terminate() }
    process.waitUntilExit()
    if snapshot.state.sessionUrl == nil && snapshot.state.status != "failed" {
        snapshot.fail("Claude Code 在 Remote Control 建立前退出（code=\(process.terminationStatus)）。")
    } else if snapshot.state.status == "active" {
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
