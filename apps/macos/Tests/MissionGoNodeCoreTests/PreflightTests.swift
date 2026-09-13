import XCTest
@testable import MissionGoNodeCore

private func ok(_ stdout: String) -> CommandResult {
    return CommandResult(code: 0, stdout: stdout, stderr: "")
}

/// A `claude` that is installed, logged in, and nothing else.
func fakeClaude(version: CommandResult? = nil, auth: CommandResult? = nil) -> CommandRunner {
    return { file, args in
        precondition(file == "claude", "unexpected command: \(file)")
        if args.first == "--version" { return version ?? ok("2.1.232 (Claude Code)\n") }
        if args.first == "auth" { return auth ?? ok(#"{"loggedIn":true,"authMethod":"oauth","apiProvider":"firstParty"}"# + "\n") }
        preconditionFailure("unexpected args: \(args)")
    }
}

/// A temporary home with a repository and a `~/.claude.json` describing it.
func makeTrustedRepo(trusted: Bool, git: Bool = true) throws -> (home: String, repoPath: String) {
    let home = FileManager.default.temporaryDirectory
        .appendingPathComponent("missiongo-macos-home-\(UUID().uuidString)").path
    let repoPath = "\(home)/repo"
    try FileManager.default.createDirectory(atPath: repoPath, withIntermediateDirectories: true)
    if git { try FileManager.default.createDirectory(atPath: "\(repoPath)/.git", withIntermediateDirectories: true) }
    let json = try JSONSerialization.data(withJSONObject: ["projects": [repoPath: ["hasTrustDialogAccepted": trusted]]])
    try json.write(to: URL(fileURLWithPath: "\(home)/.claude.json"))
    return (home, repoPath)
}

final class PreflightTests: XCTestCase {
    func testParsesTheAuthStatusJSON() {
        XCTAssertEqual(
            Preflight.parseAuthStatus(#"{"loggedIn":false,"authMethod":"none","apiProvider":"firstParty"}"#),
            Preflight.AuthStatus(loggedIn: false, authMethod: "none", apiProvider: "firstParty")
        )
        XCTAssertEqual(Preflight.parseAuthStatus(#"{"loggedIn":true,"authMethod":"oauth","apiProvider":"firstParty"}"#)?.loggedIn, true)
    }

    func testCutsTheObjectOutOfSurroundingChatter() {
        // An update notice printed around the JSON must not read as "not logged in".
        let raw = "A new version is available\n{\"loggedIn\":true,\"authMethod\":\"oauth\",\"apiProvider\":\"firstParty\"}\n"
        XCTAssertEqual(Preflight.parseAuthStatus(raw)?.loggedIn, true)
    }

    func testReturnsNothingForUnexpectedOutput() {
        XCTAssertNil(Preflight.parseAuthStatus(""))
        XCTAssertNil(Preflight.parseAuthStatus("command not found: claude"))
        XCTAssertNil(Preflight.parseAuthStatus("{not json}"))
        // Missing loggedIn is not a login: guessing either way would be wrong.
        XCTAssertNil(Preflight.parseAuthStatus(#"{"authMethod":"none"}"#))
        // Nor is a number where JSON has a boolean.
        XCTAssertNil(Preflight.parseAuthStatus(#"{"loggedIn":1}"#))
        XCTAssertEqual(Preflight.parseAuthStatus(#"{"loggedIn":true}"#)?.authMethod, "unknown")
    }

    func testParsesTheVersion() {
        XCTAssertEqual(Preflight.parseClaudeVersion("2.1.232 (Claude Code)\n"), "2.1.232")
        XCTAssertEqual(Preflight.parseClaudeVersion("claude 2.0.0-beta.3\n"), "2.0.0-beta.3")
        XCTAssertNil(Preflight.parseClaudeVersion("command not found"))
    }

    private let claudeJson = #"""
    {"projects":{
      "/Users/dev/trusted":{"hasTrustDialogAccepted":true,"allowedTools":[]},
      "/Users/dev/seen-but-not-trusted":{"hasTrustDialogAccepted":false},
      "/Users/dev/no-flag":{"allowedTools":[]},
      "/Users/dev/numeric":{"hasTrustDialogAccepted":1}
    }}
    """#

    func testTrustIsTrueOnlyForAcceptedPaths() {
        XCTAssertTrue(Preflight.isTrustedRepoPath(claudeJson: claudeJson, repoPath: "/Users/dev/trusted"))
        XCTAssertFalse(Preflight.isTrustedRepoPath(claudeJson: claudeJson, repoPath: "/Users/dev/seen-but-not-trusted"))
        XCTAssertFalse(Preflight.isTrustedRepoPath(claudeJson: claudeJson, repoPath: "/Users/dev/no-flag"))
        XCTAssertFalse(Preflight.isTrustedRepoPath(claudeJson: claudeJson, repoPath: "/Users/dev/never-opened"))
        // `=== true`: a 1 is not an accepted trust dialog.
        XCTAssertFalse(Preflight.isTrustedRepoPath(claudeJson: claudeJson, repoPath: "/Users/dev/numeric"))
    }

    func testTrustMatchesAPathThatDiffersOnlyInShape() {
        XCTAssertTrue(Preflight.isTrustedRepoPath(claudeJson: claudeJson, repoPath: "/Users/dev/trusted/"))
        XCTAssertTrue(Preflight.isTrustedRepoPath(claudeJson: claudeJson, repoPath: "/Users/dev/trusted/../trusted"))
        XCTAssertTrue(Preflight.isTrustedRepoPath(claudeJson: #"{"projects":{"/Users/dev/trusted/":{"hasTrustDialogAccepted":true}}}"#, repoPath: "/Users/dev/trusted"))
    }

    func testTrustTreatsAnUnreadableFileAsUntrusted() {
        XCTAssertFalse(Preflight.isTrustedRepoPath(claudeJson: "", repoPath: "/Users/dev/trusted"))
        XCTAssertFalse(Preflight.isTrustedRepoPath(claudeJson: "{}", repoPath: "/Users/dev/trusted"))
        XCTAssertFalse(Preflight.isTrustedRepoPath(claudeJson: #"{"projects":null}"#, repoPath: "/Users/dev/trusted"))
    }

    func testPassesWhenEverythingIsInPlace() async throws {
        let (home, repoPath) = try makeTrustedRepo(trusted: true)
        let result = await Preflight.check(repoPath: repoPath, run: fakeClaude(), home: home)
        XCTAssertEqual(result, .ok(version: "2.1.232"))
    }

    func testReportsAMissingCLI() async throws {
        let (home, repoPath) = try makeTrustedRepo(trusted: true)
        let run = fakeClaude(version: CommandResult(code: -1, stdout: "", stderr: "not found"))
        guard case let .failed(reason) = await Preflight.check(repoPath: repoPath, run: run, home: home) else {
            return XCTFail("expected a failure")
        }
        XCTAssertTrue(reason.contains("claude 命令"), reason)
    }

    func testReportsALoggedOutCLIWithItsMethod() async throws {
        let (home, repoPath) = try makeTrustedRepo(trusted: true)
        let run = fakeClaude(auth: ok(#"{"loggedIn":false,"authMethod":"none","apiProvider":"firstParty"}"#))
        guard case let .failed(reason) = await Preflight.check(repoPath: repoPath, run: run, home: home) else {
            return XCTFail("expected a failure")
        }
        XCTAssertTrue(reason.contains("未登录（authMethod=none）"), reason)
    }

    func testReportsAnUntrustedRepository() async throws {
        // The trust dialog waits forever, and a hung session is indistinguishable
        // from a working one in the console.
        let (home, repoPath) = try makeTrustedRepo(trusted: false)
        guard case let .failed(reason) = await Preflight.check(repoPath: repoPath, run: fakeClaude(), home: home) else {
            return XCTFail("expected a failure")
        }
        XCTAssertTrue(reason.contains("信任确认"), reason)
    }

    func testReportsMissingRelativeOrNonGitPaths() async throws {
        let (home, repoPath) = try makeTrustedRepo(trusted: true, git: false)
        let notGit = await Preflight.check(repoPath: repoPath, run: fakeClaude(), home: home)
        XCTAssertEqual(notGit, .failed(reason: "目录不是 git 仓库：\(repoPath)"))
        let missing = await Preflight.check(repoPath: "\(home)/missing", run: fakeClaude(), home: home)
        XCTAssertEqual(missing, .failed(reason: "仓库目录不存在：\(home)/missing"))
        let relative = await Preflight.check(repoPath: "relative/path", run: fakeClaude(), home: home)
        XCTAssertEqual(relative, .failed(reason: "仓库路径必须是绝对路径：relative/path"))
    }

    func testAGitFileCountsLikeAGitDirectory() async throws {
        // A worktree records `.git` as a file.
        let (home, repoPath) = try makeTrustedRepo(trusted: true, git: false)
        try Data("gitdir: /elsewhere\n".utf8).write(to: URL(fileURLWithPath: "\(repoPath)/.git"))
        let result = await Preflight.check(repoPath: repoPath, run: fakeClaude(), home: home)
        XCTAssertEqual(result, .ok(version: "2.1.232"))
    }
}

final class RepoCandidatesTests: XCTestCase {
    private func claudeJson(_ projects: [String: Any]) -> String {
        let data = try! JSONSerialization.data(withJSONObject: ["projects": projects])
        return String(decoding: data, as: UTF8.self)
    }

    private let everythingIsARepo: (String) -> Bool = { _ in true }

    func testOffersTrustedCheckoutsNewestFirst() {
        let candidates = RepoCandidates.parse(
            claudeJson: claudeJson([
                "/Users/dev/Projects/hermes": ["hasTrustDialogAccepted": true, "lastSessionModified": 1_000],
                "/Users/dev/Projects/missiongo": ["hasTrustDialogAccepted": true, "lastSessionModified": 9_000],
            ]),
            isRepo: everythingIsARepo
        )
        XCTAssertEqual(candidates.map(\.name), ["missiongo", "hermes"])
        XCTAssertEqual(candidates.first, RepoCandidate(
            path: "/Users/dev/Projects/missiongo", name: "missiongo", lastUsedAt: "1970-01-01T00:00:09.000Z"
        ))
    }

    func testLeavesOutWhatADispatchCouldNotUse() {
        let candidates = RepoCandidates.parse(
            claudeJson: claudeJson([
                "/Users/dev/Projects/untrusted": ["hasTrustDialogAccepted": false, "lastSessionModified": 9_000],
                "/Users/dev/Documents/notes": ["hasTrustDialogAccepted": true, "lastSessionModified": 8_000],
                "/Users/dev/Projects/missiongo/.claude/worktrees/mg-1f2e3d4c": [
                    "hasTrustDialogAccepted": true, "lastSessionModified": 7_000,
                ],
                "/Users/dev/Projects/missiongo": ["hasTrustDialogAccepted": true, "lastSessionModified": 6_000],
            ]),
            isRepo: { !$0.contains("/Documents/") }
        )
        XCTAssertEqual(candidates.map(\.path), ["/Users/dev/Projects/missiongo"])
    }

    func testDeduplicatesByResolvedPath() {
        let candidates = RepoCandidates.parse(
            claudeJson: claudeJson([
                "/Users/dev/Projects/missiongo": ["hasTrustDialogAccepted": true, "lastSessionModified": 6_000],
                "/Users/dev/Projects/missiongo/": ["hasTrustDialogAccepted": true, "lastSessionModified": 6_000],
            ]),
            isRepo: everythingIsARepo
        )
        XCTAssertEqual(candidates.map(\.path), ["/Users/dev/Projects/missiongo"])
    }

    func testCapsTheListAndSurvivesAMissingOrUnreadableFile() {
        var many: [String: Any] = [:]
        for index in 0..<80 {
            many["/Users/dev/Projects/repo-\(index)"] = ["hasTrustDialogAccepted": true, "lastSessionModified": index]
        }
        let capped = RepoCandidates.parse(claudeJson: claudeJson(many), isRepo: everythingIsARepo)
        XCTAssertEqual(capped.count, 50)
        XCTAssertEqual(capped.first?.name, "repo-79")
        XCTAssertEqual(RepoCandidates.parse(claudeJson: nil), [])
        XCTAssertEqual(RepoCandidates.parse(claudeJson: "{ not json"), [])
        XCTAssertEqual(RepoCandidates.parse(claudeJson: "{}"), [])
    }

    func testFallsBackToTheCheckoutMtimeWhenNoSessionTimeWasRecorded() {
        // Claude Code leaves the field null while a session is still open, which
        // is the repository most likely to be dispatched to next.
        let candidates = RepoCandidates.parse(
            claudeJson: claudeJson([
                "/Users/dev/Projects/older": ["hasTrustDialogAccepted": true, "lastSessionModified": 1_000],
                "/Users/dev/Projects/open-now": ["hasTrustDialogAccepted": true, "lastSessionModified": NSNull()],
                "/Users/dev/Projects/never": ["hasTrustDialogAccepted": true],
            ]),
            isRepo: everythingIsARepo,
            modifiedAt: { $0.hasSuffix("open-now") ? 5_000.75 : nil }
        )
        XCTAssertEqual(candidates.map(\.name), ["open-now", "older", "never"])
        // Milliseconds truncated like `new Date(ms)`; no time at all means no field.
        XCTAssertEqual(candidates[0].lastUsedAt, "1970-01-01T00:00:05.000Z")
        XCTAssertNil(candidates[2].lastUsedAt)
    }

    func testReadsATimeStoredAsAString() {
        let candidates = RepoCandidates.parse(
            claudeJson: claudeJson([
                "/Users/dev/Projects/a": ["hasTrustDialogAccepted": true, "lastSessionModified": "2026-09-01T10:00:00.123Z"],
                "/Users/dev/Projects/b": ["hasTrustDialogAccepted": true, "lastSessionModified": 1_000],
            ]),
            isRepo: everythingIsARepo
        )
        XCTAssertEqual(candidates.map(\.name), ["a", "b"])
        XCTAssertEqual(candidates[0].lastUsedAt, "2026-09-01T10:00:00.123Z")
    }

    func testRecognisesASessionWorktreeByItsPath() {
        XCTAssertTrue(RepoCandidates.isSessionWorktree("/Users/dev/p/.claude/worktrees/mg-1"))
        XCTAssertFalse(RepoCandidates.isSessionWorktree("/Users/dev/p/worktrees/mine"))
        XCTAssertFalse(RepoCandidates.isSessionWorktree("/Users/dev/p"))
    }

    func testEncodesWithoutAnAbsentTime() throws {
        let data = try JSONEncoder().encode(RepoCandidate(path: "/a", name: "a"))
        XCTAssertNil(jsonObject(data)["lastUsedAt"])
    }
}
