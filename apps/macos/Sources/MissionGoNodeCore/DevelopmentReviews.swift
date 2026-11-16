import Foundation
import CryptoKit
import Darwin

public struct DevelopmentReviewEvidence: Codable, Equatable, Sendable {
    public struct Reviewer: Codable, Equatable, Sendable {
        public let sessionRef: String
        public let model: String
        public let provider: String
        public let readOnly: Bool
    }
    public struct Finding: Codable, Equatable, Sendable {
        public let id: String
        public let severity: String
        public let path: String
        public let trigger: String
        public let expected: String
        public let actual: String
        public let evidence: String
        public let validation: String
    }
    public struct Check: Codable, Equatable, Sendable {
        public let name: String
        public let method: String
        public let result: String
        public let evidence: String
    }
    public var findings: [Finding]?
    public var checks: [Check]?
    public var requiredChecks: [String]?
    public var reviewer: Reviewer?
    public struct Proof: Codable, Equatable, Sendable {
        public let checkedAt: String
        public let head: String
        public let base: String
        public let candidateDigest: String
        public let clean: Bool
        public let valid: Bool
    }
    public let version: Int
    public let taskId: String
    public let agentKind: String
    public let sessionRef: String
    public let requestId: String
    public let scopeDigest: String
    public let revision: Int
    public let generation: Int
    public let status: String
    public let round: Int
    public let base: String
    public let candidateDigest: String?
    public var repository: String?
    public let checksPassed: Bool
    public let blockingFindings: Int
    public let limitations: [String]
    public let proof: Proof?
}

/// Reads the same local ledger as the three native integrations. Offline use
/// never depends on MissionGo and observation never starts or resumes an Agent.
public enum LocalDevelopmentReviews {
    public static func required(agentKind: String, sessionRef: String, root: URL? = nil) -> Bool {
        let directory = root ?? FileManager.default.homeDirectoryForCurrentUser.resolvingSymlinksInPath().appendingPathComponent(".local/state/missiongo-review", isDirectory: true)
        let key = SHA256.hash(data: Data((agentKind + ":" + sessionRef).utf8)).map { String(format: "%02x", $0) }.joined()
        let url = directory.appendingPathComponent("policy-" + key + ".json")
        guard let info = try? url.resourceValues(forKeys: [.isRegularFileKey, .isSymbolicLinkKey, .fileSizeKey]),
              info.isRegularFile == true, info.isSymbolicLink != true, (info.fileSize ?? Int.max) <= 4096,
              let attrs = try? FileManager.default.attributesOfItem(atPath: url.path),
              ((attrs[.posixPermissions] as? NSNumber)?.intValue ?? 0o777) & 0o077 == 0,
              (attrs[.ownerAccountID] as? NSNumber)?.uint32Value == getuid(),
              let data = try? Data(contentsOf: url), let value = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        else { return false }
        return value["version"] as? Int == 1 && value["agentKind"] as? String == agentKind && value["sessionRef"] as? String == sessionRef && value["required"] as? Bool == true
    }

    public static func read(agentKind: String, sessionRef: String, root: URL? = nil) -> [DevelopmentReviewEvidence]? {
        let directory = root ?? FileManager.default.homeDirectoryForCurrentUser.resolvingSymlinksInPath()
            .appendingPathComponent(".local/state/missiongo-review", isDirectory: true)
        func readJSON(_ name: String) throws -> Any {
            let url = directory.appendingPathComponent(name + ".json")
            let info = try url.resourceValues(forKeys: [.isRegularFileKey, .isSymbolicLinkKey, .fileSizeKey])
            let attributes = try FileManager.default.attributesOfItem(atPath: url.path)
            guard info.isRegularFile == true, info.isSymbolicLink != true, (info.fileSize ?? Int.max) <= 1_048_576,
                  ((attributes[.posixPermissions] as? NSNumber)?.intValue ?? 0o777) & 0o077 == 0,
                  (attributes[.ownerAccountID] as? NSNumber)?.uint32Value == getuid()
            else { throw LaunchError("Local review evidence is unavailable") }
            return try JSONSerialization.jsonObject(with: Data(contentsOf: url))
        }
        let key = SHA256.hash(data: Data((agentKind + ":" + sessionRef).utf8)).map { String(format: "%02x", $0) }.joined()
        guard let tasks = try? readJSON("session-" + key) as? [String], tasks.count <= 32,
              tasks.allSatisfy({ $0.range(of: "^[A-Za-z0-9_-]{1,150}$", options: .regularExpression) != nil }) else { return nil }
        return tasks.map { taskId in
            do {
                guard let state = try readJSON(taskId) as? [String: Any], state["version"] as? Int == 1,
                      state["taskId"] as? String == taskId, let binding = state["binding"] as? [String: Any],
                      binding["agentKind"] as? String == agentKind, binding["sessionRef"] as? String == sessionRef,
                      let rounds = state["rounds"] as? [[String: Any]], let required = binding["requiredChecks"] as? [String]
                else { throw LaunchError("Review identity mismatch") }
                let round = rounds.last ?? [:], confirmation = round["confirmation"] as? [String: Any]
                let result = (confirmation?["result"] ?? round["result"]) as? [String: Any] ?? [:]
                let checks = state["checks"] as? [[String: Any]] ?? []
                var limitations = (result["limitations"] as? [Any] ?? []).compactMap { item -> String? in
                    if let text = item as? String { return text }
                    guard let value = item as? [String: Any], value["kind"] as? String == "blocking" else { return nil }
                    return value["detail"] as? String
                }
                if let reason = state["reason"] as? String { limitations.append(reason) }
                var wire: [String: Any] = ["version": 1, "taskId": taskId, "agentKind": agentKind, "sessionRef": sessionRef,
                    "requestId": binding["requestId"] ?? "unavailable", "scopeDigest": binding["scopeDigest"] ?? "",
                    "revision": state["revision"] ?? 0, "generation": state["generation"] ?? 0,
                    "status": state["status"] ?? "incomplete", "round": rounds.count, "base": binding["base"] ?? "",
                    "checksPassed": !required.isEmpty && required.allSatisfy { name in checks.contains { $0["name"] as? String == name && $0["result"] as? String == "passed" } },
                    "blockingFindings": (result["findings"] as? [[String: Any]] ?? []).filter { $0["severity"] as? String == "blocking" }.count,
                    "limitations": limitations]
                if let receipt = (confirmation?["receipt"] ?? round["receipt"]) as? [String: Any] {
                    wire["reviewer"] = ["sessionRef": receipt["sessionRef"] ?? "", "model": receipt["model"] ?? "", "provider": receipt["provider"] ?? "", "readOnly": receipt["readOnly"] ?? false]
                }
                wire["findings"] = result["findings"] ?? []; wire["checks"] = checks; wire["requiredChecks"] = required
                wire["repository"] = binding["repositoryUrl"] as? String; wire["candidateDigest"] = state["candidateDigest"]; wire["proof"] = state["proof"]
                return try JSONDecoder().decode(DevelopmentReviewEvidence.self, from: JSONSerialization.data(withJSONObject: wire))
            } catch {
                return DevelopmentReviewEvidence(version: 1, taskId: taskId, agentKind: agentKind, sessionRef: sessionRef,
                    requestId: "unavailable", scopeDigest: String(repeating: "0", count: 64), revision: 0, generation: 0,
                    status: "incomplete", round: 0, base: String(repeating: "0", count: 40), candidateDigest: nil,
                    checksPassed: false, blockingFindings: 0, limitations: ["Local review evidence unavailable"], proof: nil)
            }
        }
    }
}
