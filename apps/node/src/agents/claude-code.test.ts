import { describe, expect, it } from "vitest";

import { buildLaunchPrompt } from "../prompt.js";
import { claudeLaunchCommand, scrapeSessionUrl, sessionNameFor } from "./claude-code.js";

describe("claudeLaunchCommand", () => {
  const command = claudeLaunchCommand({
    sessionName: "MissionGo AND-37+AND-38",
    mode: "plan",
    prompt: "使用 missiongo skill 处理这些工作条目：AND-37、AND-38。",
  });

  it("wraps claude in script and keeps every flag in the verified order", () => {
    // Verified on a real machine: without `script -q /dev/null` there is no TTY
    // and the session never comes up, and without `--no-chrome` a first run
    // stops on the Chrome extension prompt with nobody there to answer it.
    expect(command.file).toBe("script");
    expect(command.args).toEqual([
      "-q",
      "/dev/null",
      "claude",
      "--no-chrome",
      "--remote-control",
      "MissionGo AND-37+AND-38",
      "--permission-mode",
      "plan",
      "-n",
      "MissionGo AND-37+AND-38",
      "使用 missiongo skill 处理这些工作条目：AND-37、AND-38。",
    ]);
  });

  it("passes the prompt as one argument instead of a shell string", () => {
    // The command is spawned with this array and never through a shell, so the
    // prompt stays a single argument no matter what it contains.
    const withSpaces = claudeLaunchCommand({
      sessionName: "MissionGo AND-1",
      mode: "default",
      prompt: buildLaunchPrompt({ itemKeys: ["AND-1"], dispatchId: "abc" }),
    });
    expect(withSpaces.args.filter((arg) => arg.includes("missiongo skill"))).toHaveLength(1);
    expect(withSpaces.args.at(-1)).toContain("\n");
  });

  it("refuses a mode the console is not allowed to send", () => {
    // bypassPermissions and dontAsk are exactly the modes that remove the human
    // from the loop, and a dispatched session has no human at the machine.
    for (const mode of ["bypassPermissions", "dontAsk", "", "plan --dangerously-skip-permissions"]) {
      expect(() =>
        claudeLaunchCommand({ sessionName: "MissionGo AND-1", mode, prompt: "x" }),
      ).toThrowError(/不支持的 Claude Code 模式/);
    }
  });

  it("accepts the four supported modes", () => {
    for (const mode of ["plan", "default", "acceptEdits", "auto"]) {
      expect(
        claudeLaunchCommand({ sessionName: "MissionGo AND-1", mode, prompt: "x" }).args,
      ).toContain(mode);
    }
  });
});

describe("sessionNameFor", () => {
  it("names the session after the whole batch", () => {
    expect(sessionNameFor(["AND-37", "AND-38"])).toBe("MissionGo AND-37+AND-38");
    expect(sessionNameFor(["HG-8"])).toBe("MissionGo HG-8");
  });
});

describe("where the session starts", () => {
  it("passes no -w, so the session is filed under the repository itself", () => {
    // Claude Code files sessions by working directory: a session started in a
    // worktree shows up as its own project and is missing from /resume in the
    // repository it belongs to. The session makes its own worktree instead.
    const args = claudeLaunchCommand({ sessionName: "MissionGo AND-1", mode: "plan", prompt: "x" }).args;
    expect(args).not.toContain("-w");
    expect(args).not.toContain("--worktree");
  });

  it("tells the session to work in its own worktree", () => {
    expect(buildLaunchPrompt({ itemKeys: ["AND-1"], dispatchId: "abc" })).toContain("worktree");
  });
});

describe("scrapeSessionUrl", () => {
  it("finds the session URL the CLI prints next to the remote-control notice", () => {
    const log = [
      "Welcome to Claude Code",
      "/remote-control is active — open https://claude.ai/code/session_01JQ8Z4KFW2N7VXR to take over",
      "",
    ].join("\n");
    expect(scrapeSessionUrl(log)).toBe("https://claude.ai/code/session_01JQ8Z4KFW2N7VXR");
  });

  it("stops at the URL and does not swallow the words after it", () => {
    expect(scrapeSessionUrl("see https://claude.ai/code/session_abc-DEF_123, then approve"))
      .toBe("https://claude.ai/code/session_abc-DEF_123");
  });

  it("returns nothing while the log has no session URL yet", () => {
    expect(scrapeSessionUrl("")).toBeUndefined();
    expect(scrapeSessionUrl("Loading...\nhttps://claude.ai/code\n")).toBeUndefined();
  });
});
