import XCTest
@testable import MissionGoNodeCore

final class ServerAddressTests: XCTestCase {
    func testAcceptsHttpAndHttpsOrigins() {
        XCTAssertEqual(try ServerAddress.validate("https://missiongo.example.com").get(), "https://missiongo.example.com")
        XCTAssertEqual(try ServerAddress.validate("  http://127.0.0.1:3000/ \n").get(), "http://127.0.0.1:3000")
        XCTAssertEqual(try ServerAddress.validate("HTTPS://Example.com:8443").get(), "HTTPS://Example.com:8443")
    }

    func testRefusesWhatIsNotAnOrigin() {
        XCTAssertEqual(ServerAddress.validate(""), .failure(.empty))
        XCTAssertEqual(ServerAddress.validate("missiongo.example.com"), .failure(.unsupportedScheme))
        XCTAssertEqual(ServerAddress.validate("ftp://example.com"), .failure(.unsupportedScheme))
        XCTAssertEqual(ServerAddress.validate("https://"), .failure(.missingHost))
        XCTAssertEqual(ServerAddress.validate("https://example.com/admin"), .failure(.notAnOrigin))
        XCTAssertEqual(ServerAddress.validate("https://example.com?x=1"), .failure(.notAnOrigin))
        XCTAssertEqual(ServerAddress.validate("https://example.com#top"), .failure(.notAnOrigin))
        XCTAssertEqual(ServerAddress.validate("https://user:pw@example.com"), .failure(.notAnOrigin))
        XCTAssertEqual(ServerAddress.validate("https://example.invalid"), .failure(.placeholder))
    }

    func testOverrideWinsAndPlaceholderBuildsHaveNoAddress() {
        XCTAssertEqual(
            ServerAddress.effective(bundleValue: "https://built.example.com", override: "http://localhost:3000"),
            "http://localhost:3000"
        )
        XCTAssertEqual(ServerAddress.effective(bundleValue: "https://built.example.com/", override: nil), "https://built.example.com")
        // A broken saved override falls back to the build's address.
        XCTAssertEqual(ServerAddress.effective(bundleValue: "https://built.example.com", override: "nope"), "https://built.example.com")
        XCTAssertNil(ServerAddress.effective(bundleValue: "https://example.invalid", override: nil))
        XCTAssertNil(ServerAddress.effective(bundleValue: nil, override: nil))
    }

    func testDisplayHostKeepsThePort() {
        XCTAssertEqual(ServerAddress.displayHost("https://missiongo.example.com"), "missiongo.example.com")
        XCTAssertEqual(ServerAddress.displayHost("http://127.0.0.1:3000"), "127.0.0.1:3000")
    }
}

final class NodeNicknameTests: XCTestCase {
    func testTrimsWhatItKeeps() {
        XCTAssertEqual(NodeNickname.validate("  二号机 \n"), .success("二号机"))
        XCTAssertEqual(NodeNickname.validate("老王的 MacBook Pro"), .success("老王的 MacBook Pro"))
        // Full-width spaces and a BOM are trimmed too, as JavaScript's trim does.
        XCTAssertEqual(NodeNickname.validate("\u{3000}办公室\u{FEFF}"), .success("办公室"))
    }

    func testAnEmptyFieldClearsTheNickname() {
        XCTAssertEqual(NodeNickname.validate(""), .success(nil))
        XCTAssertEqual(NodeNickname.validate(" \t\n "), .success(nil))
    }

    func testAllowsFortyCharactersAndNoMore() {
        XCTAssertEqual(NodeNickname.validate(String(repeating: "机", count: 40)), .success(String(repeating: "机", count: 40)))
        XCTAssertEqual(NodeNickname.validate(String(repeating: "a", count: 41)), .failure(.tooLong))
        // Outer whitespace does not count against the limit.
        XCTAssertEqual(NodeNickname.validate("  " + String(repeating: "a", count: 40) + "  "), .success(String(repeating: "a", count: 40)))
        // Counted like the server's JavaScript length: an emoji is two.
        XCTAssertEqual(NodeNickname.validate(String(repeating: "💻", count: 20)), .success(String(repeating: "💻", count: 20)))
        XCTAssertEqual(NodeNickname.validate(String(repeating: "💻", count: 21)), .failure(.tooLong))
    }

    func testRefusesControlCharactersInside() {
        XCTAssertEqual(NodeNickname.validate("Mac\nmini"), .failure(.controlCharacter))
        XCTAssertEqual(NodeNickname.validate("Mac\tmini"), .failure(.controlCharacter))
        XCTAssertEqual(NodeNickname.validate("Mac\u{7F}mini"), .failure(.controlCharacter))
        XCTAssertEqual(NodeNickname.validate("Mac\u{0}mini"), .failure(.controlCharacter))
    }

    func testErrorsReadInChinese() {
        XCTAssertEqual(NodeNickname.ValidationError.tooLong.localizedDescription, "昵称最多 40 个字符。")
        XCTAssertEqual(NodeNickname.ValidationError.controlCharacter.localizedDescription, "昵称不能包含换行、制表符等控制字符。")
    }
}

final class ConnectionPresentationTests: XCTestCase {
    private func state(_ connection: NodeLoopState.Connection, error: String? = nil) -> NodeLoopState {
        var value = NodeLoopState()
        value.connection = connection
        value.lastError = error
        return value
    }

    func testSummarizesEachConnectionState() {
        XCTAssertEqual(ConnectionSummary.summarize(state(.online)), ConnectionSummary(text: "在线", tone: .good))
        XCTAssertEqual(ConnectionSummary.summarize(state(.connecting)), ConnectionSummary(text: "连接中", tone: .pending))
        XCTAssertEqual(
            ConnectionSummary.summarize(state(.offline, error: "上报心跳出错：无法连接 a.example（URLError.timedOut）")),
            ConnectionSummary(text: "离线：上报心跳出错：无法连接 a.example（URLError.timedOut）", tone: .bad)
        )
        XCTAssertEqual(ConnectionSummary.summarize(state(.offline, error: "  ")).text, "离线：原因未知")
        XCTAssertEqual(ConnectionSummary.summarize(state(.stopped)).tone, .idle)
    }

    func testMenuBarSymbolDiffersWhenTheMachineCannotTakeWork() {
        let online = MenuBarSymbol.name(signedIn: true, connection: .online)
        XCTAssertNotEqual(online, MenuBarSymbol.name(signedIn: true, connection: .offline))
        XCTAssertNotEqual(online, MenuBarSymbol.name(signedIn: false, connection: nil))
        XCTAssertNotEqual(MenuBarSymbol.name(signedIn: true, connection: .offline), MenuBarSymbol.name(signedIn: false, connection: nil))
        XCTAssertNotEqual(online, MenuBarSymbol.name(signedIn: true, connection: .connecting))
    }
}

final class AppVersionLabelTests: XCTestCase {
    func testNamesTheVersionOrSaysThereIsNone() {
        XCTAssertEqual(AppVersionLabel.text("0.3.2"), "版本 0.3.2")
        XCTAssertEqual(AppVersionLabel.text(nil), "开发构建")
    }
}

final class ClaudeCodeStatusTests: XCTestCase {
    func testEvaluatesInstallAndLogin() {
        let loggedIn = Preflight.AuthStatus(loggedIn: true, authMethod: "oauth", apiProvider: "firstParty")
        let loggedOut = Preflight.AuthStatus(loggedIn: false, authMethod: "none", apiProvider: "firstParty")
        XCTAssertEqual(ClaudeCodeStatus.evaluate(version: nil, auth: loggedIn), .notInstalled)
        XCTAssertEqual(ClaudeCodeStatus.evaluate(version: "2.1.0", auth: loggedIn), .ready(version: "2.1.0"))
        XCTAssertEqual(ClaudeCodeStatus.evaluate(version: "2.1.0", auth: loggedOut), .notLoggedIn(version: "2.1.0"))
        XCTAssertEqual(ClaudeCodeStatus.evaluate(version: "2.1.0", auth: nil), .unreadable(version: "2.1.0"))
    }

    func testEachProblemSaysHowToFixIt() {
        XCTAssertEqual(ClaudeCodeStatus.notLoggedIn(version: "2.1.0").summary, "未登录")
        XCTAssertEqual(ClaudeCodeStatus.notLoggedIn(version: "2.1.0").fixHint, "在终端运行 claude auth login")
        XCTAssertEqual(ClaudeCodeStatus.notLoggedIn(version: "2.1.0").fixCommand, "claude auth login")
        XCTAssertEqual(ClaudeCodeStatus.notInstalled.summary, "未安装")
        XCTAssertNotNil(ClaudeCodeStatus.notInstalled.fixHint)
        XCTAssertNil(ClaudeCodeStatus.notInstalled.fixCommand)
        XCTAssertEqual(ClaudeCodeStatus.ready(version: "2.1.232").summary, "2.1.232")
        XCTAssertNil(ClaudeCodeStatus.ready(version: "2.1.232").fixHint)
    }

    func testChecksThroughTheCommandRunner() async {
        let ready = await ClaudeCodeStatus.check(run: fakeClaude())
        XCTAssertEqual(ready, .ready(version: "2.1.232"))
        let loggedOut = await ClaudeCodeStatus.check(
            run: fakeClaude(auth: CommandResult(code: 1, stdout: #"{"loggedIn":false,"authMethod":"none"}"#, stderr: ""))
        )
        XCTAssertEqual(loggedOut, .notLoggedIn(version: "2.1.232"))
        let missing = await ClaudeCodeStatus.check(run: fakeClaude(version: CommandResult(code: -1, stdout: "", stderr: "")))
        XCTAssertEqual(missing, .notInstalled)
    }
}

final class RepoFolderCheckTests: XCTestCase {
    func testTrustedRepositoryIsAccepted() throws {
        let fixture = try makeTrustedRepo(trusted: true)
        let verdict = RepoFolderCheck.evaluate(
            path: fixture.repoPath, claudeJson: ClaudeJson.read(home: fixture.home), home: fixture.home
        )
        XCTAssertEqual(verdict, .accepted)
        XCTAssertTrue(verdict.canSave)
    }

    func testUntrustedRepositoryIsSavedWithAWarning() throws {
        let fixture = try makeTrustedRepo(trusted: false)
        let verdict = RepoFolderCheck.evaluate(
            path: fixture.repoPath, claudeJson: ClaudeJson.read(home: fixture.home), home: fixture.home
        )
        XCTAssertEqual(verdict, .acceptedUntrusted(warning: RepoFolderCheck.untrustedWarning))
        XCTAssertTrue(verdict.canSave)
        // No ~/.claude.json at all means nothing is trusted yet.
        XCTAssertEqual(
            RepoFolderCheck.evaluate(path: fixture.repoPath, claudeJson: nil, home: fixture.home),
            .acceptedUntrusted(warning: RepoFolderCheck.untrustedWarning)
        )
    }

    func testFolderThatIsNotAGitRepositoryIsRefused() throws {
        let fixture = try makeTrustedRepo(trusted: true, git: false)
        let verdict = RepoFolderCheck.evaluate(
            path: fixture.repoPath, claudeJson: ClaudeJson.read(home: fixture.home), home: fixture.home
        )
        XCTAssertFalse(verdict.canSave)
        XCTAssertEqual(verdict.message, "~/repo 不是 git 仓库，没有保存：请选择仓库的根目录（包含 .git 的那一层）。")
    }

    func testSessionWorktreeIsRefused() {
        let verdict = RepoFolderCheck.evaluate(
            path: "/Users/me/app/.claude/worktrees/fix-1", claudeJson: nil, home: "/Users/me", isRepo: { _ in true }
        )
        XCTAssertFalse(verdict.canSave)
        XCTAssertTrue(verdict.message?.hasPrefix("~/app/.claude/worktrees/fix-1 是 Claude Code 会话的临时 worktree") == true)
    }

    func testSuggestionsPutTheLikelyFolderFirst() {
        let candidates = [
            RepoCandidate(path: "/r/other", name: "other"),
            RepoCandidate(path: "/r/mission-go", name: "mission-go"),
            RepoCandidate(path: "/r/and", name: "AND"),
            RepoCandidate(path: "/r/current", name: "current"),
        ]
        let picked = RepoFolderCheck.suggestions(
            keyPrefix: "AND", productName: "MissionGo", candidates: candidates, excluding: "/r/current"
        )
        XCTAssertEqual(picked.map(\.path), ["/r/mission-go", "/r/and", "/r/other"])
        XCTAssertEqual(
            RepoFolderCheck.suggestions(keyPrefix: "X", productName: "", candidates: candidates, excluding: nil, limit: 2).map(\.path),
            ["/r/other", "/r/mission-go"]
        )
    }

    func testAssignmentsReplaceOneProductAndKeepTheRest() {
        let repos = [
            RepoMapping(productId: "p1", productKey: "AND", repoPath: "/a"),
            RepoMapping(productId: "p2", productKey: "WEB", repoPath: "/b"),
        ]
        XCTAssertEqual(
            RepoFolderCheck.assignments(from: repos, setting: "p1", to: "/c"),
            [RepoAssignment(productId: "p2", repoPath: "/b"), RepoAssignment(productId: "p1", repoPath: "/c")]
        )
        XCTAssertEqual(RepoFolderCheck.assignments(from: repos, setting: "p2", to: nil), [RepoAssignment(productId: "p1", repoPath: "/a")])
        XCTAssertEqual(RepoFolderCheck.assignments(from: [], setting: "p3", to: "/d"), [RepoAssignment(productId: "p3", repoPath: "/d")])
    }

    func testPathsUnderHomeAreAbbreviated() {
        XCTAssertEqual(PathDisplay.abbreviate("/Users/me/Projects/app", home: "/Users/me"), "~/Projects/app")
        XCTAssertEqual(PathDisplay.abbreviate("/Users/me", home: "/Users/me/"), "~")
        XCTAssertEqual(PathDisplay.abbreviate("/Users/meow/app", home: "/Users/me"), "/Users/meow/app")
        XCTAssertEqual(PathDisplay.abbreviate("/opt/app", home: "/Users/me"), "/opt/app")
    }
}

final class DispatchPresentationTests: XCTestCase {
    func testStatusLabels() {
        XCTAssertEqual(DispatchPresentation.statusLabel("queued"), "排队中")
        XCTAssertEqual(DispatchPresentation.statusLabel("delivered"), "已送达")
        XCTAssertEqual(DispatchPresentation.statusLabel("launched"), "已启动")
        XCTAssertEqual(DispatchPresentation.statusLabel("failed"), "失败")
        XCTAssertEqual(DispatchPresentation.statusLabel("something_new"), "something_new")
        XCTAssertEqual(DispatchPresentation.itemsLabel(["AND-1", "AND-2"]), "AND-1、AND-2")
    }

    func testNamesTheAgentAndTheModeItWasDispatchedWith() {
        XCTAssertEqual(DispatchPresentation.agentLabel("claude_code"), "Claude Code")
        XCTAssertEqual(DispatchPresentation.agentLabel("codex"), "Codex")
        XCTAssertEqual(DispatchPresentation.agentLabel("hermes"), "Hermes")
        XCTAssertEqual(DispatchPresentation.modeLabel("plan"), "计划")
        XCTAssertEqual(DispatchPresentation.modeLabel("acceptEdits"), "自动接受编辑")
        XCTAssertEqual(DispatchPresentation.agentLine(agentKind: "claude_code", mode: "plan"), "Claude Code · 计划")
        XCTAssertEqual(DispatchPresentation.agentLine(agentKind: "codex", mode: "default"), "Codex · 默认")
    }

    func testShowsAnUnknownAgentOrModeAsItArrived() {
        // A server that learned a new agent or mode must not leave a blank row.
        XCTAssertEqual(DispatchPresentation.agentLabel("hermes_v2"), "hermes_v2")
        XCTAssertEqual(DispatchPresentation.modeLabel("yolo"), "yolo")
        XCTAssertEqual(DispatchPresentation.agentLine(agentKind: "hermes_v2", mode: ""), "hermes_v2")
    }

    func testErrorsAreCutToTheirFirstLine() {
        XCTAssertNil(DispatchPresentation.shortError(nil))
        XCTAssertNil(DispatchPresentation.shortError(" \n "))
        XCTAssertEqual(DispatchPresentation.shortError("目录不是 git 仓库"), "目录不是 git 仓库")
        XCTAssertEqual(DispatchPresentation.shortError("claude 进程已退出（code=1）\nlog tail"), "claude 进程已退出（code=1）…")
        XCTAssertEqual(DispatchPresentation.shortError(String(repeating: "长", count: 70), limit: 60), String(repeating: "长", count: 60) + "…")
    }

    func testRelativeTimes() throws {
        let now = try XCTUnwrap(DispatchPresentation.parseDate("2026-09-13T12:00:00.000Z"))
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(secondsFromGMT: 0)!
        func relative(_ iso: String) -> String { DispatchPresentation.relativeTime(iso, now: now, calendar: calendar) }
        XCTAssertEqual(relative("2026-09-13T11:59:30.000Z"), "刚刚")
        XCTAssertEqual(relative("2026-09-13T12:00:05Z"), "刚刚")
        XCTAssertEqual(relative("2026-09-13T11:55:00.000Z"), "5 分钟前")
        XCTAssertEqual(relative("2026-09-13T11:55:00.123Z"), "4 分钟前")
        XCTAssertEqual(relative("2026-09-13T09:00:00Z"), "3 小时前")
        XCTAssertEqual(relative("2026-09-11T12:00:00Z"), "2 天前")
        XCTAssertEqual(relative("2026-08-01T12:00:00Z"), "8 月 1 日")
        XCTAssertEqual(relative("2025-08-01T12:00:00Z"), "2025 年 8 月 1 日")
        XCTAssertEqual(relative("not a date"), "")
    }
}
