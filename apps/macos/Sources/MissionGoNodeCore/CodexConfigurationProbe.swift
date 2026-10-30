import Darwin
import Foundation

/// A short-lived stdio app-server used only by foreground checks and dispatch
/// preflight. config/read parses the installed CLI's own TOML dialect without
/// starting a thread, running hooks, or sending a model request. No daemon is
/// started or restarted here. Raw responses/errors must never be logged.
enum CodexConfigurationProbe {
    static func fetch(
        binary: String, environment: ShellEnvironment, location: CodexLocation, cwd: String? = nil
    ) async -> [String: Any]? {
        await withCheckedContinuation { continuation in
            DispatchQueue.global().async {
                continuation.resume(returning: fetchSync(binary: binary, environment: environment, location: location, cwd: cwd))
            }
        }
    }

    static func fetchSync(
        binary: String, environment: ShellEnvironment, location: CodexLocation,
        timeout: TimeInterval = 10, cwd: String? = nil
    ) -> [String: Any]? {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: binary)
        process.arguments = ["app-server"]
        var childEnvironment = environment.environment
        childEnvironment["CODEX_HOME"] = location.codexHome
        process.environment = childEnvironment
        // A global check must not inherit the app's cwd. A dispatch must read
        // the same project layers as the thread it will actually start.
        process.currentDirectoryURL = URL(fileURLWithPath: cwd ?? location.codexHome)
        let input = Pipe()
        let output = Pipe()
        process.standardInput = input
        process.standardOutput = output
        process.standardError = FileHandle.nullDevice
        do { try process.run() } catch { return nil }
        defer {
            try? input.fileHandleForWriting.close()
            if process.isRunning { process.terminate() }
            // Bound cleanup too: a broken CLI may ignore SIGTERM.
            let pid = process.processIdentifier
            DispatchQueue.global().asyncAfter(deadline: .now() + 1) {
                if process.isRunning { _ = kill(pid, SIGKILL) }
                process.waitUntilExit()
            }
        }
        func send(_ object: [String: Any]) throws {
            let data = try JSONSerialization.data(withJSONObject: object)
            try input.fileHandleForWriting.write(contentsOf: data + Data([0x0a]))
        }
        do {
            try send(["id": 1, "method": "initialize", "params": [
                "clientInfo": ["name": "missiongo_auth_check", "version": "1"],
            ]])
        } catch { return nil }
        let descriptor = output.fileHandleForReading.fileDescriptor
        let flags = fcntl(descriptor, F_GETFL)
        guard flags >= 0, fcntl(descriptor, F_SETFL, flags | O_NONBLOCK) >= 0 else { return nil }
        let deadline = Date().addingTimeInterval(timeout)
        var buffer = Data()
        var bytesRead = 0
        var initialized = false
        var chunk = [UInt8](repeating: 0, count: 8192)
        while Date() < deadline && bytesRead < 4_000_000 {
            var watched = pollfd(fd: descriptor, events: Int16(POLLIN), revents: 0)
            let ready = poll(&watched, 1, 100)
            if ready < 0 { if errno == EINTR { continue }; return nil }
            if ready == 0 { continue }
            let count = read(descriptor, &chunk, chunk.count)
            if count < 0 && (errno == EAGAIN || errno == EINTR) { continue }
            guard count > 0 else { return nil }
            bytesRead += count
            buffer.append(contentsOf: chunk.prefix(count))
            while let end = buffer.firstIndex(of: 0x0a) {
                let line = Data(buffer.prefix(upTo: end))
                buffer.removeSubrange(...end)
                guard let message = try? JSONSerialization.jsonObject(with: line) as? [String: Any],
                      let id = JSONValues.number(message["id"]) else { continue }
                if Int(id) == 1 && !initialized {
                    guard message["error"] == nil, message["result"] is [String: Any] else { return nil }
                    do {
                        try send(["method": "initialized"])
                        var params: [String: Any] = ["includeLayers": false]
                        if let cwd { params["cwd"] = cwd }
                        try send(["id": 2, "method": "config/read", "params": params])
                    } catch { return nil }
                    initialized = true
                } else if Int(id) == 2 && initialized {
                    guard message["error"] == nil,
                          let result = message["result"] as? [String: Any] else { return nil }
                    return result["config"] as? [String: Any]
                }
            }
        }
        return nil
    }
}
