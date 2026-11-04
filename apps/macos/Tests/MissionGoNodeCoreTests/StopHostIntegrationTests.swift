import Foundation
import XCTest
@testable import MissionGoNodeCore

final class StopHostIntegrationTests: XCTestCase {
    func testPermissionStopWaitsForResultDeduplicatesAndContinuesInSameHost() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let cli = root.appendingPathComponent("fixture-cli")
        let script = #"""
#!/usr/bin/python3
import json, sys, threading
lock = threading.Lock()
def emit(value):
    with lock:
        print(json.dumps(value), flush=True)
def record(value):
    with open('events.jsonl', 'a') as f:
        f.write(json.dumps(value)+'\n')
users = 0
for line in sys.stdin:
    value = json.loads(line)
    record(value)
    if value.get('type') == 'control_request':
        subtype = value['request']['subtype']
        emit({'type':'control_response','response':{'request_id':value['request_id'],'subtype':'success','response':{'remote_control_available':False}}})
        if subtype == 'interrupt':
            threading.Timer(0.6, lambda: emit({'type':'result','terminal_reason':'aborted_streaming'})).start()
    elif value.get('type') == 'user':
        users += 1
        emit(value)
        if users == 1:
            emit({'type':'control_request','request_id':'permission-first','request':{'subtype':'can_use_tool','tool_name':'Bash','input':{'command':'echo fixture'}}})
        else:
            emit({'type':'assistant','uuid':'answer-new','message':{'content':[{'type':'text','text':'continued in same session'}]}})
            emit({'type':'result'})
"""#
        try Data(script.utf8).write(to: cli)
        try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: cli.path)
        let commands = root.appendingPathComponent("commands")
        try FileManager.default.createDirectory(at: commands, withIntermediateDirectories: true)
        let statePath = root.appendingPathComponent("state.json").path
        let configPath = root.appendingPathComponent("config.json")
        let config = ClaudeHostConfiguration(claudeExecutable: cli.path, cwd: root.path, mode: "default",
            sessionName: "stop test", sessionRef: "test-native", prompt: "fixture work", statePath: statePath,
            commandsDirectory: commands.path, logPath: root.appendingPathComponent("host.log").path)
        try ClaudeHostFiles.write(config, to: configPath.path)
        let package = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        let host = Process()
        host.executableURL = package.appendingPathComponent(".build/debug/MissionGoClaudeHost")
        host.arguments = [configPath.path]
        host.environment = ["PATH":"/usr/bin:/bin"]
        host.standardOutput = FileHandle.nullDevice
        host.standardError = FileHandle.nullDevice
        try host.run()
        defer { if host.isRunning { ClaudeHostProcess.terminateGroup(host.processIdentifier); host.waitUntilExit() } }
        func waitFor(_ predicate: (ClaudeHostState) -> Bool) async throws -> ClaudeHostState {
            for _ in 0..<100 {
                if let state = try? ClaudeHostFiles.readState(statePath), predicate(state) { return state }
                try await Task.sleep(nanoseconds: 50_000_000)
            }
            throw LaunchError("Fixture host state did not settle")
        }
        let initial = try await waitFor { $0.waitingForInput }
        let target = try XCTUnwrap(initial.initialTurnId)
        let stop = ClaudeHostCommand(id: "stop-test", kind: "interrupt", text: "stop", turnId: target)
        let stopPath = commands.appendingPathComponent("stop-test.json").path
        try ClaudeHostFiles.write(stop, to: stopPath)
        _ = try await waitFor { $0.commandResults["stop-test"]?.status == "delivering" }
        // Recreate the command as a re-poll would while its native ACK/result is delayed.
        try ClaudeHostFiles.write(stop, to: stopPath)
        try await Task.sleep(nanoseconds: 150_000_000)
        XCTAssertEqual(try ClaudeHostFiles.readState(statePath).commandResults["stop-test"]?.status, "delivering")
        let stopped = try await waitFor { $0.commandResults["stop-test"]?.status == "delivered" }
        XCTAssertFalse(stopped.turnActive)
        XCTAssertFalse(stopped.waitingForInput)
        XCTAssertEqual(stopped.messages.first(where: { $0.sourceId == "permission-permission-first" })?.questions?.first?.withdrawn, true)
        try ClaudeHostFiles.write(ClaudeHostCommand(id: "next-message", kind: "message", text: "continue fixture"),
            to: commands.appendingPathComponent("next-message.json").path)
        let continued = try await waitFor { $0.messages.contains(where: { $0.text == "continued in same session" }) }
        XCTAssertEqual(continued.hostPid, initial.hostPid)
        let events = try String(contentsOf: root.appendingPathComponent("events.jsonl"), encoding: .utf8)
            .split(separator: "\n").map { try JSONSerialization.jsonObject(with: Data($0.utf8)) as! [String:Any] }
        XCTAssertEqual(events.filter { ($0["request"] as? [String:Any])?["subtype"] as? String == "interrupt" }.count, 1)
        XCTAssertEqual(events.filter { $0["type"] as? String == "user" }.count, 2)
    }
}
