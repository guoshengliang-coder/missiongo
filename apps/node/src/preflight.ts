import { spawn } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

/**
 * Everything that has to be true on this machine before a session can start.
 *
 * A dispatched session runs with nobody at the keyboard, so every condition
 * that would normally show up as an interactive prompt has to be checked here
 * instead: a missing login, an untrusted directory and a first-run dialog all
 * look identical from the outside — a process that sits there forever — and the
 * console would keep saying "已启动" while nothing happens.
 */

export type CommandResult = { code: number; stdout: string; stderr: string };
export type CommandRunner = (file: string, args: readonly string[]) => Promise<CommandResult>;

const COMMAND_TIMEOUT_MS = 15_000;

/** Runs a command without a shell, so no argument can turn into shell syntax. */
export const runCommand: CommandRunner = (file, args) =>
  new Promise((resolvePromise) => {
    const child = spawn(file, [...args], { stdio: ["ignore", "pipe", "pipe"], timeout: COMMAND_TIMEOUT_MS });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    // A binary that is not installed shows up as an `error` event, not as an
    // exit code, and the caller cares about neither: both mean "not usable".
    child.on("error", (error) => resolvePromise({ code: -1, stdout, stderr: `${stderr}${error.message}` }));
    child.on("close", (code) => resolvePromise({ code: code ?? -1, stdout, stderr }));
  });

export type AuthStatus = { loggedIn: boolean; authMethod: string; apiProvider: string };

/**
 * Parse `claude auth status`, which prints a JSON object such as
 * `{"loggedIn":false,"authMethod":"none","apiProvider":"firstParty"}`.
 *
 * The object is cut out of the surrounding output rather than parsed whole: the
 * CLI is free to print update notices or warnings around it, and a warning must
 * not read as "not logged in".
 */
export function parseAuthStatus(raw: string): AuthStatus | undefined {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end <= start) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(raw.slice(start, end + 1));
  } catch {
    return undefined;
  }
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record.loggedIn !== "boolean") return undefined;
  return {
    loggedIn: record.loggedIn,
    authMethod: typeof record.authMethod === "string" ? record.authMethod : "unknown",
    apiProvider: typeof record.apiProvider === "string" ? record.apiProvider : "unknown",
  };
}

/** `claude --version` prints something like `2.1.232 (Claude Code)`. */
export function parseClaudeVersion(raw: string): string | undefined {
  return /\d+\.\d+\.\d+(?:[\w.-]*)?/.exec(raw)?.[0];
}

export async function claudeVersion(run: CommandRunner = runCommand): Promise<string | undefined> {
  const result = await run("claude", ["--version"]);
  if (result.code !== 0) return undefined;
  return parseClaudeVersion(result.stdout);
}

export async function claudeAuthStatus(run: CommandRunner = runCommand): Promise<AuthStatus | undefined> {
  const result = await run("claude", ["auth", "status"]);
  // The command prints its JSON on stdout; a non-zero exit still carries a
  // usable answer on some versions, so both streams are considered.
  return parseAuthStatus(result.stdout) ?? parseAuthStatus(result.stderr);
}

/**
 * Whether Claude Code has recorded the workspace-trust confirmation for a path.
 *
 * Trust lives per absolute path in `~/.claude.json` under
 * `projects["<path>"].hasTrustDialogAccepted`. Without it the session stops on
 * the trust dialog and waits forever, which is indistinguishable from a session
 * that is thinking. Keys are compared after resolution so a stored trailing
 * slash still matches.
 *
 * A git worktree that the CLI creates itself under a trusted repository
 * inherits that trust, so only the mapped repository path needs checking.
 */
export function isTrustedRepoPath(claudeJsonRaw: string, repoPath: string): boolean {
  let value: unknown;
  try {
    value = JSON.parse(claudeJsonRaw);
  } catch {
    return false;
  }
  if (typeof value !== "object" || value === null) return false;
  const projects = (value as Record<string, unknown>).projects;
  if (typeof projects !== "object" || projects === null) return false;
  const wanted = resolve(repoPath);
  for (const [key, project] of Object.entries(projects as Record<string, unknown>)) {
    if (resolve(key) !== wanted) continue;
    if (typeof project !== "object" || project === null) return false;
    return (project as Record<string, unknown>).hasTrustDialogAccepted === true;
  }
  return false;
}

export function readClaudeJson(home: string = homedir()): string | undefined {
  try {
    return readFileSync(join(home, ".claude.json"), "utf8");
  } catch {
    return undefined;
  }
}

export type PreflightResult =
  | { ok: true; version: string }
  | { ok: false; reason: string };

export type PreflightOptions = {
  repoPath: string;
  run?: CommandRunner;
  home?: string;
};

/**
 * Reasons are written for the person reading them in the console, not for code:
 * each one says what is missing and what to do about it, because the operator
 * is the only one who can fix a login or a trust dialog.
 */
export async function preflightClaudeCode(options: PreflightOptions): Promise<PreflightResult> {
  const run = options.run ?? runCommand;
  const home = options.home ?? homedir();
  const { repoPath } = options;

  const version = await claudeVersion(run);
  if (!version) {
    return { ok: false, reason: "本机找不到可用的 claude 命令：确认 Claude Code 已安装，且 claude --version 能正常运行。" };
  }

  const auth = await claudeAuthStatus(run);
  if (!auth) {
    return { ok: false, reason: "无法读取 claude auth status 的输出，无法确认登录状态。" };
  }
  if (!auth.loggedIn) {
    return {
      ok: false,
      reason: `Claude Code 未登录（authMethod=${auth.authMethod}）：在本机运行一次 claude 完成登录后再派单。`,
    };
  }

  if (!isAbsolute(repoPath)) {
    return { ok: false, reason: `仓库路径必须是绝对路径：${repoPath}` };
  }
  let isDirectory = false;
  try {
    isDirectory = statSync(repoPath).isDirectory();
  } catch {
    isDirectory = false;
  }
  if (!isDirectory) {
    return { ok: false, reason: `仓库目录不存在：${repoPath}` };
  }
  // A worktree records `.git` as a file, a normal clone as a directory; both
  // are fine, only the absence matters.
  let hasGit = false;
  try {
    statSync(join(repoPath, ".git"));
    hasGit = true;
  } catch {
    hasGit = false;
  }
  if (!hasGit) {
    return { ok: false, reason: `目录不是 git 仓库：${repoPath}` };
  }

  const claudeJson = readClaudeJson(home);
  if (!claudeJson || !isTrustedRepoPath(claudeJson, repoPath)) {
    return {
      ok: false,
      reason: `${repoPath} 还没有在本机通过 Claude Code 的信任确认：先在该目录手动运行一次 claude 并选择信任，否则会话会一直停在信任对话框上。`,
    };
  }

  return { ok: true, version };
}
