import Darwin
import Foundation

public struct AgentModeCapability: Codable, Equatable, Sendable {
    public let mode: String
    public let state: String
    public let reason: String?
    public let model: String?
    public init(mode: String, state: String, reason: String? = nil, model: String? = nil) {
        self.mode = mode; self.state = state; self.reason = reason; self.model = model
    }
}

/// Uses the native control protocol, never model/provider name heuristics.
/// Safe mode disables startup hooks. No user prompt or model request is sent.
enum ClaudeModeProbe {
    static func result(mode: String, response: [String: Any], model: String? = nil) -> AgentModeCapability {
        let actual = (response["response"] as? [String: Any])?["mode"] as? String
        let success = response["subtype"] as? String == "success" && actual == mode
        let rejected = response["subtype"] as? String == "error" || actual != nil
        return AgentModeCapability(mode: mode, state: success ? "available" : rejected ? "unavailable" : "unknown",
            reason: success ? nil : rejected ? "native_mode_rejected" : "native_mode_unconfirmed", model: model)
    }
    static func fetch(environment: ShellEnvironment, models: [AgentModelOption]) -> [AgentModeCapability]? {
        guard let executable = environment.which("claude") else { return nil }
        let process = Process(); process.executableURL = URL(fileURLWithPath: executable)
        process.arguments = ClaudeModelProbe.arguments
        process.environment = ClaudeProcessEnvironment.unattended(environment.environment)
        let input = Pipe(), output = Pipe()
        process.standardInput = input; process.standardOutput = output; process.standardError = FileHandle.nullDevice
        do { try process.run() } catch { return nil }
        defer { try? input.fileHandleForWriting.close(); if process.isRunning { process.terminate() }; DispatchQueue.global().async { process.waitUntilExit() } }
        let descriptor = output.fileHandleForReading.fileDescriptor
        _ = fcntl(descriptor, F_SETFL, fcntl(descriptor, F_GETFL) | O_NONBLOCK)
        var buffer = Data()
        let deadline = Date().addingTimeInterval(20)
        func call(_ request: [String: Any]) -> [String: Any]? {
            let id = UUID().uuidString
            guard let data = try? JSONSerialization.data(withJSONObject: ["type": "control_request", "request_id": id, "request": request]) else { return nil }
            do { try input.fileHandleForWriting.write(contentsOf: data + Data([10])) } catch { return nil }
            while Date() < deadline && buffer.count < 1_000_000 {
                while let end = buffer.firstIndex(of: 10) {
                    let line = buffer.prefix(upTo: end); buffer.removeSubrange(...end)
                    if let event = try? JSONSerialization.jsonObject(with: line) as? [String: Any],
                       event["type"] as? String == "control_response", let response = event["response"] as? [String: Any],
                       response["request_id"] as? String == id { return response }
                }
                var watched = pollfd(fd: descriptor, events: Int16(POLLIN), revents: 0)
                if poll(&watched, 1, 100) < 0 { return nil }
                var bytes = [UInt8](repeating: 0, count: 8192)
                let count = read(descriptor, &bytes, bytes.count)
                if count > 0 { buffer.append(contentsOf: bytes.prefix(count)) }
                else if count == 0 { return nil }
            }
            return nil
        }
        guard call(["subtype": "initialize"])?["subtype"] as? String == "success" else { return nil }
        var capabilities: [AgentModeCapability] = []
        for mode in ["default", "acceptEdits", "bypassPermissions", "plan", "auto"] {
            guard let response = call(["subtype": "set_permission_mode", "mode": mode]) else { return nil }
            capabilities.append(result(mode: mode, response: response))
        }
        for model in models.prefix(14) {
            guard call(["subtype": "set_model", "model": model.id])?["subtype"] as? String == "success",
                  let response = call(["subtype": "set_permission_mode", "mode": "auto"]) else { continue }
            capabilities.append(result(mode: "auto", response: response, model: model.id))
        }
        return capabilities
    }
}
