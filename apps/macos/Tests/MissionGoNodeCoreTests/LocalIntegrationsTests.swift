import XCTest
import LocalAuthentication
@testable import MissionGoNodeCore

private struct AccessTestAdapter: AgentAdapter {
    let kind: String
    let calls = Locked<[String]>([])
    let fail: Bool
    var onLaunch: @Sendable () async -> Void = {}

    func detect() async -> String? { calls.withLock { $0.append("detect") }; return "1.0" }
    func launch(_ job: DispatchJob) async throws -> LaunchResult {
        calls.withLock { $0.append("launch:\(job.mode)") }
        await onLaunch()
        if fail { throw LaunchError("access denied") }
        return LaunchResult(sessionName: "test", sessionUrl: nil, logPath: nil)
    }
}

final class LocalIntegrationsTests: XCTestCase {
    private func defaults() -> UserDefaults {
        let suite = "io.missiongo.tests.permissions.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suite)!
        addTeardownBlock { defaults.removePersistentDomain(forName: suite) }
        return defaults
    }

    private var job: DispatchJob {
        DispatchJob(dispatchId: "test", itemKeys: ["AND-1"], repoPath: "/unused", mode: "plan", nodeName: "Test")
    }

    func testBothClientsStartDisabledAndNeverProbeNativeAdapters() async throws {
        let access = LocalIntegrations(defaults: defaults())
        for agent in LocalAgent.allCases {
            let base = AccessTestAdapter(kind: agent.rawValue, fail: false)
            let adapter = ConsentedAgentAdapter(agent: agent, base: base, access: access)
            for _ in 0..<3 {
                let detected = await adapter.detect()
                XCTAssertNil(detected)
                do { _ = try await adapter.launch(job); XCTFail("disabled launch") } catch {}
            }
            XCTAssertEqual(base.calls.current, [])
        }
    }

    func testExplicitEnablePersistsAndDoesNotEnableTheOtherClient() async throws {
        let saved = defaults()
        let access = LocalIntegrations(defaults: saved)
        let attempt = access.begin(.claudeCode)
        access.finish(.claudeCode, attempt: attempt, version: "2.1")
        let restored = LocalIntegrations(defaults: saved)
        XCTAssertEqual(restored.state(for: .claudeCode)?.version, "2.1")
        XCTAssertNil(restored.state(for: .codex))
        let base = AccessTestAdapter(kind: "claude_code", fail: false)
        let adapter = ConsentedAgentAdapter(agent: .claudeCode, base: base, access: restored)
        let detected = await adapter.detect()
        XCTAssertEqual(detected, "2.1")
        XCTAssertEqual(base.calls.current, [])
        _ = try await adapter.launch(job)
        XCTAssertEqual(base.calls.current, ["launch:plan"])
        XCTAssertEqual(restored.state(for: .claudeCode)?.version, "2.1")
    }

    func testFailurePausesAcrossRestartsAndSubsequentDispatchesDoNotRetry() async {
        for agent in LocalAgent.allCases {
            let saved = defaults()
            let access = LocalIntegrations(defaults: saved)
            access.finish(agent, attempt: access.begin(agent), version: "1.0")
            let base = AccessTestAdapter(kind: agent.rawValue, fail: true)
            let adapter = ConsentedAgentAdapter(agent: agent, base: base, access: access)
            for _ in 0..<3 { do { _ = try await adapter.launch(job); XCTFail("expected failure") } catch {} }
            XCTAssertEqual(base.calls.current, ["launch:plan"])
            let restored = LocalIntegrations(defaults: saved)
            XCTAssertNil(restored.state(for: agent)?.version)
            XCTAssertTrue(restored.state(for: agent)?.issue?.contains("access denied") == true)
        }
    }

    func testInterruptedCheckAndStaleCompletionRemainPaused() {
        let saved = defaults()
        let access = LocalIntegrations(defaults: saved)
        let old = access.begin(.codex)
        XCTAssertNil(LocalIntegrations(defaults: saved).state(for: .codex)?.version)
        let latest = access.begin(.codex)
        access.finish(.codex, attempt: old, version: "stale")
        XCTAssertNil(access.state(for: .codex)?.version)
        access.disable(.codex)
        access.finish(.codex, attempt: latest, version: "late")
        XCTAssertNil(access.state(for: .codex))
        XCTAssertNil(LocalIntegrations(defaults: saved).state(for: .codex))
    }

    func testDisableDuringLaunchIsNotUndoneBySuccessfulLaunch() async throws {
        let access = LocalIntegrations(defaults: defaults())
        access.finish(.codex, attempt: access.begin(.codex), version: "1.0")
        let base = AccessTestAdapter(kind: "codex", fail: false, onLaunch: { access.disable(.codex) })
        _ = try await ConsentedAgentAdapter(agent: .codex, base: base, access: access).launch(job)
        XCTAssertNil(access.state(for: .codex))
    }

    func testMappedCandidatesUseOnlyExplicitPathsWithoutProbingTheirExistence() {
        let snapshot = MappedRepositorySnapshot()
        let paths = ["/does-not-exist/repo", "/does-not-exist/repo", "/another/checkout"]
        snapshot.update(paths.enumerated().map { RepoMapping(productId: "\($0.offset)", productKey: "AND", repoPath: $0.element) })
        XCTAssertEqual(snapshot.candidates.map(\.path), ["/another/checkout", "/does-not-exist/repo"])
        snapshot.update([])
        XCTAssertEqual(snapshot.candidates, [])
    }

    func testSelectingARepositoryDoesNotRequireClaudeTrustForCodex() {
        XCTAssertEqual(RepoFolderCheck.evaluate(path: "/repo", claudeJson: nil, checkClaudeTrust: false, isRepo: { _ in true }), .accepted)
    }

    func testSkillTargetOnlyNamesTheSelectedClient() {
        XCTAssertEqual(SkillSync.target(for: .claudeCode, home: "/home", codexHome: "/custom/codex"), "/home/.claude/skills/missiongo/SKILL.md")
        XCTAssertEqual(SkillSync.target(for: .codex, home: "/home", codexHome: "/custom/codex"), "/custom/codex/skills/missiongo/SKILL.md")
    }

    func testStartupDoesNotEvaluateLoginShell() {
        var calls = 0
        _ = ShellEnvironment.resolve(home: "/home", loginShell: { calls += 1; return "/custom/bin" })
        XCTAssertEqual(calls, 0)
        let explicit = ShellEnvironment.resolve(home: "/home", loadLoginShell: true, loginShell: { calls += 1; return "/custom/bin" })
        XCTAssertEqual(calls, 1)
        XCTAssertTrue(explicit.path.hasPrefix("/custom/bin:"))
    }

    func testStartupKeychainQueryForbidsInteraction() {
        let quiet = KeychainCredentialStore.readQuery(service: "test", account: "test", allowInteraction: false)
        XCTAssertEqual((quiet[kSecUseAuthenticationContext as String] as? LAContext)?.interactionNotAllowed, true)
        let interactive = KeychainCredentialStore.readQuery(service: "test", account: "test", allowInteraction: true)
        XCTAssertNil(interactive[kSecUseAuthenticationContext as String])
    }

    func testDisabledLaunchCannotReserveOrRestoreAccess() {
        let access = LocalIntegrations(defaults: defaults())
        XCTAssertNil(access.beginLaunch(.codex))
        access.finish(.codex, attempt: access.begin(.codex), version: "1.0")
        let launch = access.beginLaunch(.codex)
        XCTAssertNotNil(launch)
        XCTAssertNil(access.beginLaunch(.codex))
        access.disable(.codex)
        XCTAssertNil(access.beginLaunch(.codex))
    }

    func testDisabledDuringSkillDownloadDoesNotWriteToDisk() async throws {
        StubURLProtocol.install { _, _ in
            .response(status: 200, body: "---\nname: missiongo\nversion: 5.8.0\n---\nTest")
        }
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        let target = directory.appendingPathComponent("SKILL.md")
        do {
            _ = try await SkillSync.run(serverUrl: "https://s.invalid", targets: [target.path], session: StubURLProtocol.session(), shouldApply: { false })
            XCTFail("cancelled sync must not write")
        } catch is CancellationError {} catch { XCTFail("unexpected error: \(error)") }
        XCTAssertFalse(FileManager.default.fileExists(atPath: directory.path))
    }
}
