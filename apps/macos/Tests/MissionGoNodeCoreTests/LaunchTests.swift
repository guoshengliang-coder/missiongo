import XCTest
@testable import MissionGoNodeCore

final class LaunchPromptTests: XCTestCase {
    func testNamesTheItemsTheDispatchAndTheOneBranchRule() throws {
        let prompt = try LaunchPrompt.build(itemKeys: ["AND-37", "AND-38"], dispatchId: "d1f2a3b4")
        XCTAssertTrue(prompt.contains("missiongo skill"))
        XCTAssertTrue(prompt.contains("AND-37、AND-38"))
        XCTAssertTrue(prompt.contains("d1f2a3b4"))
        XCTAssertTrue(prompt.contains("一个分支和一个 PR"))
    }

    func testIsAFixedTemplateWithOnlyTheKeysAndTheIdFilledIn() throws {
        // Pinned in full, identical to apps/node/src/prompt.test.ts: the server
        // sends item keys, agent and mode and nothing else, so any wording that
        // starts arriving from outside — or drifting from the TypeScript — shows up here.
        XCTAssertEqual(
            try LaunchPrompt.build(itemKeys: ["HG-8"], dispatchId: "abc"),
            [
                "使用 missiongo skill 处理这些工作条目：HG-8。",
                "",
                "本会话由 MissionGo 派单 abc 发起，上面列出的编号等同于用户给出的范围。",
                "整批条目走一个分支和一个 PR，之后按 Skill 的规则推进条目状态。",
                "会话起在仓库主目录，动手改代码前先按仓库规则建独立 worktree，不要直接在主工作区修改。",
                "建 worktree 用 git worktree add 再 cd 进去；不要用 EnterWorktree 一类的工具——仓库规定的 worktree 位置在它默认放行的范围之外，它会弹出授权框，而派单会话旁边没有人能回答。",
            ].joined(separator: "\n")
        )
    }

    func testRejectsAnythingThatIsNotAWorkItemKey() {
        // The keys reach the process argv and the session name as well, so a value
        // that is not a key is refused instead of escaped.
        for key in [
            "and-37", "AND-37 ", "AND-", "-37", "AND-37; rm -rf /", "AND-37\nAND-38", "$(whoami)-1", "AND-37、AND-38", "",
            // ICU's `$` would accept a trailing newline and `\d` a non-ASCII digit.
            "AND-37\n", "AND-٣٧",
        ] {
            XCTAssertThrowsError(try LaunchPrompt.build(itemKeys: [key], dispatchId: "abc"), key) {
                XCTAssertTrue($0.localizedDescription.hasPrefix("不是合法的工作条目编号："), $0.localizedDescription)
            }
        }
    }

    func testRejectsAnEmptyBatchAndANonIdentifierDispatchId() {
        XCTAssertThrowsError(try LaunchPrompt.build(itemKeys: [], dispatchId: "abc")) {
            XCTAssertTrue($0.localizedDescription.contains("至少要带一个"))
        }
        XCTAssertThrowsError(try LaunchPrompt.build(itemKeys: ["AND-1"], dispatchId: "a b")) {
            XCTAssertEqual($0.localizedDescription, #"不是合法的派单编号："a b""#)
        }
        XCTAssertThrowsError(try LaunchPrompt.build(itemKeys: ["AND-1"], dispatchId: "abc\n"))
    }

    func testAcceptsTheKeyShapesTheProductsActuallyUse() {
        XCTAssertNoThrow(try LaunchPrompt.build(itemKeys: ["AND-1", "HG-8", "WEB2-1024"], dispatchId: "0d8f-4c"))
    }
}

final class LaunchCommandTests: XCTestCase {
    func testWrapsClaudeInScriptWithEveryFlagInTheVerifiedOrder() throws {
        // Verified on a real machine: without `script -q /dev/null` there is no TTY
        // and the session never comes up, and without `--no-chrome` a first run
        // stops on the Chrome extension prompt with nobody there to answer it.
        let command = try SessionLauncher.launchCommand(
            sessionName: "Mac mini-AND-37+AND-38", mode: "plan", prompt: "使用 missiongo skill 处理这些工作条目：AND-37、AND-38。"
        )
        XCTAssertEqual(command.file, "script")
        XCTAssertEqual(command.args, [
            "-q", "/dev/null", "claude", "--no-chrome",
            "--remote-control", "Mac mini-AND-37+AND-38",
            "--permission-mode", "plan",
            "-n", "Mac mini-AND-37+AND-38",
            "使用 missiongo skill 处理这些工作条目：AND-37、AND-38。",
        ])
    }

    func testPassesThePromptAsOneArgument() throws {
        let prompt = try LaunchPrompt.build(itemKeys: ["AND-1"], dispatchId: "abc")
        let command = try SessionLauncher.launchCommand(sessionName: "Mac mini-AND-1", mode: "default", prompt: prompt)
        XCTAssertEqual(command.args.filter { $0.contains("missiongo skill") }.count, 1)
        XCTAssertTrue(command.args.last?.contains("\n") == true)
    }

    func testPassesNoWorktreeFlag() throws {
        // Claude Code files sessions by working directory: a session started in a
        // worktree shows up as its own project and is missing from /resume in the
        // repository it belongs to. The session makes its own worktree instead.
        let args = try SessionLauncher.launchCommand(sessionName: "Mac mini-AND-1", mode: "plan", prompt: "x").args
        XCTAssertFalse(args.contains("-w"))
        XCTAssertFalse(args.contains("--worktree"))
        XCTAssertTrue(try LaunchPrompt.build(itemKeys: ["AND-1"], dispatchId: "abc").contains("worktree"))
    }

    func testRefusesAModeTheConsoleIsNotAllowedToSend() {
        // bypassPermissions and dontAsk are exactly the modes that remove the human
        // from the loop, and a dispatched session has no human at the machine.
        for mode in ["bypassPermissions", "dontAsk", "", "plan --dangerously-skip-permissions", "Plan"] {
            XCTAssertThrowsError(try SessionLauncher.launchCommand(sessionName: "Mac mini-AND-1", mode: mode, prompt: "x"), mode) {
                XCTAssertTrue($0.localizedDescription.hasPrefix("不支持的 Claude Code 模式："))
            }
        }
    }

    func testAcceptsTheFourSupportedModes() throws {
        XCTAssertEqual(ClaudeCodeModes.allowed, ["plan", "default", "acceptEdits", "auto"])
        for mode in ClaudeCodeModes.allowed {
            XCTAssertTrue(try SessionLauncher.launchCommand(sessionName: "Mac mini-AND-1", mode: mode, prompt: "x").args.contains(mode))
        }
    }

    func testTheModeListIsOneLiteralLineForTheRepositoryCheck() throws {
        // scripts compare this line against CLAUDE_CODE_MODES in packages/domain.
        let source = try String(contentsOfFile: #filePath.replacingOccurrences(
            of: "Tests/MissionGoNodeCoreTests/LaunchTests.swift", with: "Sources/MissionGoNodeCore/ClaudeCodeModes.swift"
        ))
        XCTAssertTrue(source.contains(#"["plan", "default", "acceptEdits", "auto"]"#))
    }

    func testWritesTheProductPrefixOnceAndThenOnlyTheNumbers() {
        // No "MissionGo" prefix and no spaces around the hyphen: the machine is
        // what tells sessions from several Macs apart.
        XCTAssertEqual(SessionLauncher.sessionName(nodeName: "Mac mini", itemKeys: ["HG-49"]), "Mac mini-HG-49")
        XCTAssertEqual(SessionLauncher.sessionName(nodeName: "Mac mini", itemKeys: ["AND-37", "AND-38"]), "Mac mini-AND-37,38")
        XCTAssertEqual(
            SessionLauncher.sessionName(nodeName: "Mac mini", itemKeys: ["HG-52", "HG-51", "HG-50", "HG-48", "HG-44", "HG-43"]),
            "Mac mini-HG-52,51,50,48,44,43"
        )
    }

    func testStartsANewRunWhenTheProductChanges() {
        XCTAssertEqual(
            SessionLauncher.sessionName(nodeName: "M4", itemKeys: ["HG-52", "HG-51", "AND-43"]),
            "M4-HG-52,51+AND-43"
        )
        XCTAssertEqual(
            SessionLauncher.sessionName(nodeName: "M4", itemKeys: ["HG-52", "AND-43", "HG-51"]),
            "M4-HG-52+AND-43+HG-51"
        )
    }

    func testKeepsTheOrderTheDispatchCarried() {
        // The console's selection order is the order that reaches here; nothing
        // is sorted, so an ascending batch stays ascending.
        XCTAssertEqual(
            SessionLauncher.sessionName(nodeName: "M4", itemKeys: ["HG-43", "HG-44", "HG-48"]),
            "M4-HG-43,44,48"
        )
    }

    func testWritesAKeyInFullWhenItIsNotAPrefixAndNumber() {
        XCTAssertEqual(SessionLauncher.sessionName(nodeName: "M4", itemKeys: ["HG-52", "SPIKE"]), "M4-HG-52+SPIKE")
        XCTAssertEqual(SessionLauncher.sessionName(nodeName: "M4", itemKeys: ["HG-9a", "HG-10"]), "M4-HG-9a+HG-10")
    }

    func testCutsALongListByLengthAndSaysHowManyThereWere() {
        let twenty = (33...52).reversed().map { "HG-\($0)" }
        XCTAssertEqual(twenty.count, 20)
        XCTAssertEqual(
            SessionLauncher.sessionName(nodeName: "Mac mini", itemKeys: twenty),
            "Mac mini-HG-52,51,50,49,48,47,46,45,44,43,42,41 等 20 条"
        )
    }

    func testAlwaysWritesTheFirstKeyInFullHoweverLongItIs() {
        // A name of only "等 N 条" would not tell two sessions apart.
        let long = "VERYLONGPRODUCTPREFIX-1234567890123456789"
        XCTAssertEqual(SessionLauncher.sessionName(nodeName: "M4", itemKeys: [long, "HG-2"]), "M4-\(long) 等 2 条")
    }

    func testKeepsANicknameAsWrittenApartFromTheOuterWhitespace() {
        XCTAssertEqual(SessionLauncher.sessionName(nodeName: "  老王的 MacBook Pro \n", itemKeys: ["HG-8"]), "老王的 MacBook Pro-HG-8")
        XCTAssertEqual(SessionLauncher.sessionName(nodeName: "办公室 · 二号机", itemKeys: ["HG-8", "HG-9"]), "办公室 · 二号机-HG-8,9")
    }

    func testFallsBackToMissionGoWhenTheNameIsBlank() {
        // Never `-HG-49`.
        XCTAssertEqual(SessionLauncher.sessionName(nodeName: "", itemKeys: ["HG-49"]), "MissionGo-HG-49")
        XCTAssertEqual(SessionLauncher.sessionName(nodeName: " \t\n ", itemKeys: ["HG-49"]), "MissionGo-HG-49")
    }

    func testTheNewNameGoesToBothRemoteControlAndTheSessionTitle() throws {
        let name = SessionLauncher.sessionName(nodeName: "Mac mini", itemKeys: ["AND-37", "AND-38", "AND-40", "AND-41", "AND-42"])
        let args = try SessionLauncher.launchCommand(sessionName: name, mode: "plan", prompt: "x").args
        XCTAssertEqual(args[try XCTUnwrap(args.firstIndex(of: "--remote-control")) + 1], "Mac mini-AND-37,38,40,41,42")
        XCTAssertEqual(args[try XCTUnwrap(args.firstIndex(of: "-n")) + 1], "Mac mini-AND-37,38,40,41,42")
        XCTAssertFalse(args.contains("-w"))
        XCTAssertFalse(args.contains("--worktree"))
    }

    func testKeepsTheLogInsideTheLogDirectory() {
        XCTAssertEqual(SessionLauncher.logPath(for: "d1-a_B", in: "/logs"), "/logs/d1-a_B.log")
        XCTAssertEqual(SessionLauncher.logPath(for: "../../etc/passwd", in: "/logs"), "/logs/______etc_passwd.log")
    }

    func testFindsTheSessionURLNextToTheRemoteControlNotice() {
        let log = [
            "Welcome to Claude Code",
            "/remote-control is active — open https://claude.ai/code/session_01JQ8Z4KFW2N7VXR to take over",
            "",
        ].joined(separator: "\n")
        XCTAssertEqual(SessionLauncher.scrapeSessionUrl(log), "https://claude.ai/code/session_01JQ8Z4KFW2N7VXR")
    }

    func testStopsAtTheURL() {
        XCTAssertEqual(
            SessionLauncher.scrapeSessionUrl("see https://claude.ai/code/session_abc-DEF_123, then approve"),
            "https://claude.ai/code/session_abc-DEF_123"
        )
    }

    func testReturnsNothingWhileTheLogHasNoSessionURL() {
        XCTAssertNil(SessionLauncher.scrapeSessionUrl(""))
        XCTAssertNil(SessionLauncher.scrapeSessionUrl("Loading...\nhttps://claude.ai/code\n"))
    }
}

/// Runs the launcher for real against a fake `script` on PATH, so the process
/// handling — cwd, argv, log redirection, exit detection — is exercised too.
final class SessionLauncherProcessTests: XCTestCase {
    private func fakeScript(_ body: String) throws -> (bin: String, root: String) {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("missiongo-bin-\(UUID().uuidString)").path
        let bin = "\(root)/bin"
        try FileManager.default.createDirectory(atPath: bin, withIntermediateDirectories: true)
        let path = "\(bin)/script"
        try Data("#!/bin/sh\n\(body)\n".utf8).write(to: URL(fileURLWithPath: path))
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: path)
        return (bin, root)
    }

    func testStartsInTheRepositoryAndReturnsTheScrapedURL() async throws {
        let (home, repoPath) = try makeTrustedRepo(trusted: true)
        let script = try fakeScript(#"""
        printf 'cwd=%s\n' "$PWD"
        for arg in "$@"; do printf 'arg=%s\n' "$arg"; done
        echo "/remote-control is active https://claude.ai/code/session_TEST-123"
        sleep 5
        """#)
        let launcher = SessionLauncher(
            environment: ShellEnvironment(path: "\(script.bin):/usr/bin:/bin"),
            run: fakeClaude(), home: home, logsDirectory: "\(script.root)/logs", sessionUrlTimeout: 10
        )
        let result = try await launcher.launch(DispatchJob(dispatchId: "d-1", itemKeys: ["AND-1"], repoPath: repoPath, mode: "plan", nodeName: " Mac mini "))
        XCTAssertEqual(result.sessionName, "Mac mini-AND-1")
        XCTAssertEqual(result.sessionUrl, "https://claude.ai/code/session_TEST-123")
        XCTAssertEqual(result.logPath, "\(script.root)/logs/d-1.log")

        let log = try String(contentsOfFile: try XCTUnwrap(result.logPath))
        // The temporary directory sits behind the /var → /private/var symlink.
        let resolvedRepo = String(cString: realpath(repoPath, nil))
        XCTAssertTrue(log.contains("cwd=\(repoPath)\n") || log.contains("cwd=\(resolvedRepo)\n"), log)
        XCTAssertTrue(log.contains("arg=-q\narg=/dev/null\narg=claude\narg=--no-chrome\narg=--remote-control\narg=Mac mini-AND-1\narg=--permission-mode\narg=plan\narg=-n\narg=Mac mini-AND-1\narg=使用 missiongo skill"), log)
    }

    func testReportsAProcessThatExitsBeforeAURLWithTheLogTail() async throws {
        let (home, repoPath) = try makeTrustedRepo(trusted: true)
        let script = try fakeScript("echo 'Error: something went wrong'\nexit 3")
        let launcher = SessionLauncher(
            environment: ShellEnvironment(path: "\(script.bin):/usr/bin:/bin"),
            run: fakeClaude(), home: home, logsDirectory: "\(script.root)/logs", sessionUrlTimeout: 10
        )
        do {
            _ = try await launcher.launch(DispatchJob(dispatchId: "d-2", itemKeys: ["AND-1"], repoPath: repoPath, mode: "plan", nodeName: "Mac mini"))
            XCTFail("expected a failure")
        } catch {
            let message = error.localizedDescription
            XCTAssertTrue(message.hasPrefix("claude 进程已退出（code=3），会话没有启动。"), message)
            XCTAssertTrue(message.contains("Error: something went wrong"), message)
        }
    }

    func testRunsThePreflightFirst() async throws {
        let (home, repoPath) = try makeTrustedRepo(trusted: false)
        let script = try fakeScript("touch \"$HOME/should-not-run\"")
        let launcher = SessionLauncher(
            environment: ShellEnvironment(path: "\(script.bin):/usr/bin:/bin"),
            run: fakeClaude(), home: home, logsDirectory: "\(script.root)/logs"
        )
        do {
            _ = try await launcher.launch(DispatchJob(dispatchId: "d-3", itemKeys: ["AND-1"], repoPath: repoPath, mode: "plan", nodeName: "Mac mini"))
            XCTFail("expected a failure")
        } catch {
            XCTAssertTrue(error.localizedDescription.contains("信任确认"), error.localizedDescription)
        }
        XCTAssertFalse(FileManager.default.fileExists(atPath: "\(script.root)/logs/d-3.log"))
    }
}

final class ShellEnvironmentTests: XCTestCase {
    func testKeepsTheLoginShellOrderAndAddsMissingDefaults() {
        XCTAssertEqual(
            ShellEnvironment.mergePath("/opt/homebrew/bin:/usr/bin:/bin", defaults: ["/Users/dev/.local/bin", "/opt/homebrew/bin", "/usr/bin"]),
            "/opt/homebrew/bin:/usr/bin:/bin:/Users/dev/.local/bin"
        )
        XCTAssertEqual(ShellEnvironment.mergePath(nil, defaults: ["/a", "/b"]), "/a:/b")
    }

    func testTakesThePathAfterTheMarkerSoProfileChatterIsIgnored() {
        XCTAssertEqual(
            ShellEnvironment.extractPath(fromShellOutput: "Welcome back!\n__MISSIONGO_PATH__/Users/dev/.local/bin:/usr/bin"),
            "/Users/dev/.local/bin:/usr/bin"
        )
        XCTAssertNil(ShellEnvironment.extractPath(fromShellOutput: "no marker"))
    }

    func testDefaultsCoverTheUsualInstallLocations() {
        let defaults = ShellEnvironment.defaultPathEntries(home: "/Users/dev")
        XCTAssertTrue(defaults.contains("/Users/dev/.local/bin"))
        XCTAssertTrue(defaults.contains("/opt/homebrew/bin"))
        XCTAssertTrue(defaults.contains("/usr/local/bin"))
    }

    func testChildEnvironmentCarriesTheResolvedPath() {
        let environment = ShellEnvironment(path: "/x:/y", base: ["HOME": "/Users/dev", "PATH": "/usr/bin:/bin"])
        XCTAssertEqual(environment.environment["PATH"], "/x:/y")
        XCTAssertEqual(environment.environment["HOME"], "/Users/dev")
    }

    func testResolvesALoginShellPathOnThisMachine() {
        // Not asserting contents — only that the real shell answers in time and the
        // result is a usable PATH that finds a system binary.
        let shellPath = ShellEnvironment.loginShellPath(timeout: 5)
        XCTAssertNotNil(shellPath, "zsh -l did not answer with a PATH")
        XCTAssertTrue(shellPath?.contains("/usr/bin") == true, shellPath ?? "")
        let environment = ShellEnvironment.resolve()
        XCTAssertNotNil(environment.which("script"))
    }
}
