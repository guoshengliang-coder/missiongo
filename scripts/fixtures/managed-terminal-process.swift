import Foundation
import Darwin
@testable import MissionGoNodeCore

// Test executable only. APIClient still encodes requests and decodes real route
// responses; stdin/stdout substitute for sockets in restricted test environments.
private func emit(_ value: [String: Any]) throws {
    var bytes = try JSONSerialization.data(withJSONObject: value)
    bytes.append(10)
    FileHandle.standardOutput.write(bytes)
}
private struct Configuration: Decodable {
    let root: String
    let id: String
    let mode: String
}
private struct Reply: Decodable {
    let status: Int
    let body: String
}
private struct CrashAfterACK: NodeAPI {
    let client: APIClient
    let crash: Bool
    func reportManaged(id: String, observation: ManagedExecutionObservation) async throws -> ManagedObservationReceipt {
        let ack = try await client.reportManaged(id: id, observation: observation)
        guard ack.accepted, let terminal = ack.terminal, terminal.intentId == id,
              terminal.generation == observation.generation, terminal.sequence == observation.sequence,
              terminal.state == "terminal", terminal.sessionRef == observation.sessionRef,
              terminal.resolvedModel == observation.resolvedModel else { throw LaunchError("Invalid fixture terminal ACK") }
        if crash {
            // A decoded, bound ACK has arrived. Runtime.flush has not regained
            // control, so it cannot save or clear its original pending journal.
            try emit(["ack": try JSONSerialization.jsonObject(with: JSONEncoder().encode(ack))])
            Darwin._exit(73)
        }
        return ack
    }
    func claimManaged(id: String, generation: Int) async throws -> ManagedExecutionIntent { Darwin._exit(90) }
    func permitManaged(id: String, generation: Int) async throws -> ManagedExecutionPermit { Darwin._exit(90) }
    func heartbeat(agents: [DetectedAgent], repoCandidates: [RepoCandidate]) async throws -> HeartbeatReply { Darwin._exit(90) }
    func claimNext(waitMs: Int, availableAgentKinds: [String]?) async throws -> DispatchRequest? { Darwin._exit(90) }
    func reportResult(dispatchId: String, report: DispatchReport) async throws { Darwin._exit(90) }
}
private struct NoLaunch: AgentAdapter {
    let kind = "codex"
    func detect() async -> String? { "fixture" }
    func launch(_ job: DispatchJob) async throws -> LaunchResult { Darwin._exit(91) }
    func launchManaged(_ job: ManagedExecutionJob) async throws -> ManagedRuntimeReceipt { Darwin._exit(91) }
    func startManagedTurn(_ job: ManagedExecutionJob, receipt: ManagedRuntimeReceipt) async throws { Darwin._exit(92) }
}
@main
private struct TerminalProcessFixture {
    static func main() async {
        do {
            guard let line = readLine() else { throw LaunchError("Missing fixture configuration") }
            let config = try JSONDecoder().decode(Configuration.self, from: Data(line.utf8))
            StubURLProtocol.install { request, body in
                do {
                    try emit(["request": ["method": request.httpMethod ?? "", "path": request.url!.path,
                                          "body": String(decoding: body, as: UTF8.self)]])
                    guard let line = readLine() else { throw LaunchError("Missing route response") }
                    let reply = try JSONDecoder().decode(Reply.self, from: Data(line.utf8))
                    return .response(status: reply.status, body: reply.body)
                } catch { return .failure(URLError(.badServerResponse)) }
            }
            let api = CrashAfterACK(client: APIClient(serverUrl: "https://fixture.invalid", token: "mgn_fixture",
                session: StubURLProtocol.session()), crash: config.mode == "crash")
            let root = URL(fileURLWithPath: config.root)
            let file = root.appendingPathComponent(config.id + ".json")
            let original = try Data(contentsOf: file)
            let entry = try JSONDecoder().decode(ManagedExecutionRuntime.Entry.self, from: original)
            let runtime = ManagedExecutionRuntime(root: root)
            if config.mode == "reject" {
                do {
                    try await runtime.process(entry.job, api: api, adapter: NoLaunch())
                    throw LaunchError("Expected report rejection")
                } catch is APIError { /* Parent separately asserts the actual HTTP 400. */ }
                guard try Data(contentsOf: file) == original else { throw LaunchError("Rejected pending bytes changed") }
                try emit(["rejected": true])
            } else if config.mode == "crash" {
                try await runtime.process(entry.job, api: api, adapter: NoLaunch())
                throw LaunchError("Expected process exit at ACK")
            } else {
                var errors = [String]()
                try await runtime.flushObservations(api: api, onError: { id, _ in errors.append(id) })
                // A stale enabled job must not launch after durable terminal ACK.
                try await runtime.process(entry.job, api: api, adapter: NoLaunch())
                try emit(["errors": errors])
            }
        } catch {
            FileHandle.standardError.write(Data("Fixture failed: \(error)\n".utf8))
            Darwin.exit(1)
        }
    }
}
