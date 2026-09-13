import { spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";

import { CLAUDE_CODE_MODES } from "@missiongo/domain";

import { logPathFor, logsDir, nodeHome } from "../config.js";
import { type CommandRunner, preflightClaudeCode, claudeVersion, runCommand } from "../preflight.js";
import { buildLaunchPrompt } from "../prompt.js";
import type { AgentAdapter, DispatchJob, LaunchResult } from "./types.js";

/**
 * The Claude Code adapter: starts one remote-controllable session per dispatch.
 *
 * The session is interactive on purpose — the operator approves the plan from
 * claude.ai or a phone — so the daemon's job ends once the session is up and
 * reachable. It does not supervise the work afterwards; the items move through
 * MCP like any other session.
 */

// The mode arrives over the wire and goes straight into argv, so the machine
// checks it against the shared list too rather than trusting the server to have
// checked. Shared, not copied: two lists drift, and the drift shows up as a
// session that starts in a mode nobody picked.
const ALLOWED_MODES = new Set<string>(CLAUDE_CODE_MODES);

export const SESSION_URL_PATTERN = /https:\/\/claude\.ai\/code\/session_[\w-]+/;
export const REMOTE_CONTROL_MARKER = "/remote-control is active";
export const SESSION_URL_TIMEOUT_MS = 60_000;
const SESSION_URL_POLL_MS = 500;

/** e.g. `MissionGo AND-37+AND-38` — the whole batch is one session. */
export function sessionNameFor(itemKeys: readonly string[]): string {
  return `MissionGo ${itemKeys.join("+")}`;
}

export type LaunchCommand = { file: string; args: string[] };

/**
 * The exact command that starts a session.
 *
 * Three details are load-bearing, all of them verified on a real machine:
 *
 * - `script -q /dev/null` hands the CLI a pty. Spawned from a daemon there is
 *   no TTY, and without the wrapper the session never comes up.
 * - `--no-chrome` is required. Without it a first run stops on the "Claude in
 *   Chrome extension detected" prompt, with nobody there to answer it.
 * - the arguments stay an array and never touch a shell, so an item key or a
 *   prompt cannot become shell syntax.
 *
 * Deliberately no `-w`: the session starts in the repository's own directory.
 * Claude Code files sessions by working directory and a worktree is filed as a
 * separate project, so a session started in one is missing from `/resume` in the
 * repository it belongs to. The prompt tells the session to create its own
 * worktree before editing, which is the isolation AGENTS.md asks for — decided
 * by the session rather than imposed by the daemon.
 */
export function claudeLaunchCommand(input: {
  sessionName: string;
  mode: string;
  prompt: string;
}): LaunchCommand {
  if (!ALLOWED_MODES.has(input.mode)) {
    throw new Error(`不支持的 Claude Code 模式：${JSON.stringify(input.mode)}`);
  }
  return {
    file: "script",
    args: [
      "-q",
      "/dev/null",
      "claude",
      "--no-chrome",
      "--remote-control",
      input.sessionName,
      "--permission-mode",
      input.mode,
      "-n",
      input.sessionName,
      input.prompt,
    ],
  };
}

/**
 * The session URL as it appears in the log once remote control is up, on the
 * same lines as `/remote-control is active`. Scraping the log is the only way
 * to learn it: the CLI prints it for the human, there is no machine-readable
 * hand-off.
 */
export function scrapeSessionUrl(logText: string): string | undefined {
  return SESSION_URL_PATTERN.exec(logText)?.[0];
}

function readLogSafely(logPath: string): string {
  try {
    return readFileSync(logPath, "utf8");
  } catch {
    // The CLI may not have written anything yet.
    return "";
  }
}

/** The tail of the log, for a failure the operator has to diagnose. */
function logTail(logPath: string, lines = 12): string {
  const text = readLogSafely(logPath).trimEnd();
  if (text === "") return "（日志为空）";
  return text.split("\n").slice(-lines).join("\n");
}

export type ClaudeCodeAdapterOptions = {
  home?: string;
  logHome?: string;
  run?: CommandRunner;
  sessionUrlTimeoutMs?: number;
};

export function createClaudeCodeAdapter(options: ClaudeCodeAdapterOptions = {}): AgentAdapter {
  const home = options.home ?? homedir();
  const run = options.run ?? runCommand;
  const sessionUrlTimeoutMs = options.sessionUrlTimeoutMs ?? SESSION_URL_TIMEOUT_MS;

  return {
    kind: "claude_code",

    async detect(): Promise<{ version: string } | undefined> {
      const version = await claudeVersion(run);
      return version ? { version } : undefined;
    },

    async launch(job: DispatchJob): Promise<LaunchResult> {
      const preflight = await preflightClaudeCode({ repoPath: job.repoPath, run, home });
      if (!preflight.ok) throw new Error(preflight.reason);

      const prompt = buildLaunchPrompt({ itemKeys: job.itemKeys, dispatchId: job.dispatchId });
      const sessionName = sessionNameFor(job.itemKeys);
      const command = claudeLaunchCommand({ sessionName, mode: job.mode, prompt });

      // Logs follow the daemon's own state directory; the trust table read by
      // the preflight above is Claude Code's and always lives in the real home.
      const logHome = options.logHome ?? nodeHome();
      const logPath = logPathFor(job.dispatchId, logHome);
      mkdirSync(logsDir(logHome), { recursive: true, mode: 0o700 });
      const logFd = openSync(logPath, "a", 0o600);
      let exitCode: number | undefined;
      let spawnError: Error | undefined;
      try {
        // Detached with both streams in the log file: the session must outlive
        // the daemon, so restarting or stopping `missiongo-node run` never kills
        // work that is already in progress.
        const child = spawn(command.file, command.args, {
          cwd: job.repoPath,
          detached: true,
          stdio: ["ignore", logFd, logFd],
        });
        // A missing binary arrives as an asynchronous `error` event. Throwing
        // from the listener would be swallowed, so both outcomes are recorded
        // for the wait loop below to report.
        child.on("error", (error) => { spawnError = error; });
        child.on("exit", (code) => { exitCode = code ?? -1; });
        child.unref();
      } finally {
        closeSync(logFd);
      }

      const deadline = Date.now() + sessionUrlTimeoutMs;
      let sessionUrl: string | undefined;
      while (Date.now() < deadline) {
        sessionUrl = scrapeSessionUrl(readLogSafely(logPath));
        if (sessionUrl) break;
        if (spawnError) {
          throw new Error(`无法启动 ${command.file}：${spawnError.message}`);
        }
        // The process dying before it printed a URL is the failure mode worth
        // reporting: the trust dialog and the login prompt both hang instead,
        // and the preflight above is what catches those.
        if (exitCode !== undefined) {
          throw new Error(`claude 进程已退出（code=${exitCode}），会话没有启动。日志 ${logPath}：\n${logTail(logPath)}`);
        }
        await delay(SESSION_URL_POLL_MS);
      }

      return sessionUrl ? { sessionName, sessionUrl, logPath } : { sessionName, logPath };
    },
  };
}
