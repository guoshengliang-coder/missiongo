import Darwin
import Foundation

/// Ask the same local Claude CLI that runs dispatched work for its picker.
/// Safe mode disables hooks and other startup customizations while retaining
/// authentication and model selection. No user message or model request is sent.
enum ClaudeModelProbe {
    static let timeout: TimeInterval = 30
    static let arguments = [
        "--safe-mode", "--strict-mcp-config", "--no-chrome",
        "--output-format", "stream-json", "--verbose",
        "--input-format", "stream-json", "--permission-mode", "plan",
    ]

    static func options(fromLine line: Data, requestId: String) -> [AgentModelOption]? {
        guard let event = try? JSONSerialization.jsonObject(with: line) as? [String: Any],
              event["type"] as? String == "control_response",
              let response = event["response"] as? [String: Any],
              response["request_id"] as? String == requestId,
              response["subtype"] as? String == "success",
              let body = response["response"] as? [String: Any]
        else { return nil }
        return ClaudeModelCatalog.options(fromInitialize: body)
    }

    static func fetch(environment: ShellEnvironment) -> [AgentModelOption]? {
        guard let executable = environment.which("claude") else { return nil }
        let requestId = UUID().uuidString
        let process = Process()
        process.executableURL = URL(fileURLWithPath: executable)
        process.arguments = arguments + ["--session-id", UUID().uuidString]
        var childEnvironment = ClaudeProcessEnvironment.unattended(environment.environment)
        childEnvironment["CLAUDE_CODE_ENTRYPOINT"] = "sdk-ts"
        process.environment = childEnvironment
        let input = Pipe()
        let output = Pipe()
        process.standardInput = input
        process.standardOutput = output
        process.standardError = FileHandle.nullDevice
        guard let request = try? JSONSerialization.data(withJSONObject: [
            "type": "control_request", "request_id": requestId,
            "request": ["subtype": "initialize"],
        ]) else { return nil }
        do { try process.run() } catch { return nil }
        defer {
            try? input.fileHandleForWriting.close()
            if process.isRunning { process.terminate() }
            // Reap the short-lived probe without waiting for a hung CLI.
            if process.isRunning {
                DispatchQueue.global().async { process.waitUntilExit() }
            } else {
                process.waitUntilExit()
            }
        }
        do { try input.fileHandleForWriting.write(contentsOf: request + Data([0x0a])) }
        catch { return nil }

        let descriptor = output.fileHandleForReading.fileDescriptor
        let flags = fcntl(descriptor, F_GETFL)
        _ = fcntl(descriptor, F_SETFL, flags | O_NONBLOCK)
        let deadline = Date().addingTimeInterval(timeout)
        var buffer = Data()
        var chunk = [UInt8](repeating: 0, count: 8192)
        while Date() < deadline && buffer.count < 1_000_000 {
            var watched = pollfd(fd: descriptor, events: Int16(POLLIN), revents: 0)
            let pollResult = poll(&watched, 1, 200)
            if pollResult < 0 { return nil }
            if pollResult == 0 { continue }
            let count = read(descriptor, &chunk, chunk.count)
            if count <= 0 { return nil }
            buffer.append(contentsOf: chunk.prefix(count))
            while let end = buffer.firstIndex(of: 0x0a) {
                let line = buffer.prefix(upTo: end)
                buffer.removeSubrange(...end)
                if let options = options(fromLine: Data(line), requestId: requestId) {
                    return options
                }
            }
        }
        return nil
    }
}
