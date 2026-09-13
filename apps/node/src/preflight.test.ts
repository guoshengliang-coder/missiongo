import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  type CommandResult,
  type CommandRunner,
  isTrustedRepoPath,
  parseAuthStatus,
  parseClaudeVersion,
  preflightClaudeCode,
} from "./preflight.js";

const ok = (stdout: string): CommandResult => ({ code: 0, stdout, stderr: "" });

/** A `claude` that is installed, logged in, and nothing else. */
function fakeClaude(overrides: { version?: CommandResult; auth?: CommandResult } = {}): CommandRunner {
  return (file, args) => {
    if (file !== "claude") throw new Error(`unexpected command: ${file}`);
    if (args[0] === "--version") return Promise.resolve(overrides.version ?? ok("2.1.232 (Claude Code)\n"));
    if (args[0] === "auth") {
      return Promise.resolve(
        overrides.auth ?? ok('{"loggedIn":true,"authMethod":"oauth","apiProvider":"firstParty"}\n'),
      );
    }
    throw new Error(`unexpected args: ${args.join(" ")}`);
  };
}

function trustedRepo(options: { trusted: boolean; git?: boolean }): { home: string; repoPath: string } {
  const home = mkdtempSync(join(tmpdir(), "missiongo-node-home-"));
  const repoPath = join(home, "repo");
  mkdirSync(repoPath, { recursive: true });
  if (options.git !== false) mkdirSync(join(repoPath, ".git"));
  writeFileSync(
    join(home, ".claude.json"),
    JSON.stringify({ projects: { [repoPath]: { hasTrustDialogAccepted: options.trusted } } }),
  );
  return { home, repoPath };
}

describe("parseAuthStatus", () => {
  it("reads the JSON the CLI prints", () => {
    expect(parseAuthStatus('{"loggedIn":false,"authMethod":"none","apiProvider":"firstParty"}')).toEqual({
      loggedIn: false,
      authMethod: "none",
      apiProvider: "firstParty",
    });
    expect(parseAuthStatus('{"loggedIn":true,"authMethod":"oauth","apiProvider":"firstParty"}')?.loggedIn).toBe(true);
  });

  it("cuts the object out of surrounding chatter", () => {
    // An update notice printed around the JSON must not read as "not logged in".
    const raw = 'A new version is available\n{"loggedIn":true,"authMethod":"oauth","apiProvider":"firstParty"}\n';
    expect(parseAuthStatus(raw)?.loggedIn).toBe(true);
  });

  it("returns nothing when the output is not the expected object", () => {
    expect(parseAuthStatus("")).toBeUndefined();
    expect(parseAuthStatus("command not found: claude")).toBeUndefined();
    expect(parseAuthStatus("{not json}")).toBeUndefined();
    // Missing loggedIn is not a login: guessing either way would be wrong.
    expect(parseAuthStatus('{"authMethod":"none"}')).toBeUndefined();
  });
});

describe("parseClaudeVersion", () => {
  it("takes the version out of the --version line", () => {
    expect(parseClaudeVersion("2.1.232 (Claude Code)\n")).toBe("2.1.232");
    expect(parseClaudeVersion("claude 2.0.0-beta.3\n")).toBe("2.0.0-beta.3");
    expect(parseClaudeVersion("command not found")).toBeUndefined();
  });
});

describe("isTrustedRepoPath", () => {
  const claudeJson = JSON.stringify({
    projects: {
      "/Users/dev/trusted": { hasTrustDialogAccepted: true, allowedTools: [] },
      "/Users/dev/seen-but-not-trusted": { hasTrustDialogAccepted: false },
      "/Users/dev/no-flag": { allowedTools: [] },
    },
  });

  it("is true only for a path with the trust dialog accepted", () => {
    expect(isTrustedRepoPath(claudeJson, "/Users/dev/trusted")).toBe(true);
    expect(isTrustedRepoPath(claudeJson, "/Users/dev/seen-but-not-trusted")).toBe(false);
    expect(isTrustedRepoPath(claudeJson, "/Users/dev/no-flag")).toBe(false);
    expect(isTrustedRepoPath(claudeJson, "/Users/dev/never-opened")).toBe(false);
  });

  it("matches a stored path that differs only in shape", () => {
    expect(isTrustedRepoPath(claudeJson, "/Users/dev/trusted/")).toBe(true);
    expect(isTrustedRepoPath(claudeJson, "/Users/dev/trusted/../trusted")).toBe(true);
  });

  it("treats an unreadable or unexpected file as untrusted", () => {
    expect(isTrustedRepoPath("", "/Users/dev/trusted")).toBe(false);
    expect(isTrustedRepoPath("{}", "/Users/dev/trusted")).toBe(false);
    expect(isTrustedRepoPath('{"projects":null}', "/Users/dev/trusted")).toBe(false);
  });
});

describe("preflightClaudeCode", () => {
  it("passes when the CLI is installed and logged in and the repo is trusted", async () => {
    const { home, repoPath } = trustedRepo({ trusted: true });
    await expect(preflightClaudeCode({ repoPath, home, run: fakeClaude() })).resolves.toEqual({
      ok: true,
      version: "2.1.232",
    });
  });

  it("reports a missing CLI", async () => {
    const { home, repoPath } = trustedRepo({ trusted: true });
    const run = fakeClaude({ version: { code: -1, stdout: "", stderr: "spawn claude ENOENT" } });
    const result = await preflightClaudeCode({ repoPath, home, run });
    expect(result).toMatchObject({ ok: false });
    expect(result.ok ? "" : result.reason).toContain("claude 命令");
  });

  it("reports a CLI that is not logged in, with the method it reported", async () => {
    const { home, repoPath } = trustedRepo({ trusted: true });
    const auth = ok('{"loggedIn":false,"authMethod":"none","apiProvider":"firstParty"}');
    const result = await preflightClaudeCode({ repoPath, home, run: fakeClaude({ auth }) });
    expect(result.ok ? "" : result.reason).toContain("未登录（authMethod=none）");
  });

  it("reports an untrusted repository instead of letting the session hang", async () => {
    // The trust dialog waits forever, and a hung session is indistinguishable
    // from a working one in the console.
    const { home, repoPath } = trustedRepo({ trusted: false });
    const result = await preflightClaudeCode({ repoPath, home, run: fakeClaude() });
    expect(result.ok ? "" : result.reason).toContain("信任确认");
  });

  it("reports a path that is missing, relative, or not a git repository", async () => {
    const { home, repoPath } = trustedRepo({ trusted: true, git: false });
    expect((await preflightClaudeCode({ repoPath, home, run: fakeClaude() })) as { reason: string }).toMatchObject({
      ok: false,
      reason: expect.stringContaining("不是 git 仓库"),
    });
    expect(
      (await preflightClaudeCode({ repoPath: join(home, "missing"), home, run: fakeClaude() })) as { reason: string },
    ).toMatchObject({ ok: false, reason: expect.stringContaining("目录不存在") });
    expect(
      (await preflightClaudeCode({ repoPath: "relative/path", home, run: fakeClaude() })) as { reason: string },
    ).toMatchObject({ ok: false, reason: expect.stringContaining("绝对路径") });
  });
});
