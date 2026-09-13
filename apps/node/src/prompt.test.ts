import { describe, expect, it } from "vitest";

import { buildLaunchPrompt } from "./prompt.js";

describe("buildLaunchPrompt", () => {
  it("names the items, the dispatch and the one-branch-one-PR rule", () => {
    const prompt = buildLaunchPrompt({ itemKeys: ["AND-37", "AND-38"], dispatchId: "d1f2a3b4" });
    expect(prompt).toContain("missiongo skill");
    expect(prompt).toContain("AND-37、AND-38");
    expect(prompt).toContain("d1f2a3b4");
    expect(prompt).toContain("一个分支和一个 PR");
  });

  it("is a fixed template with only the keys and the id filled in", () => {
    // Pinned in full: the server sends item keys, agent and mode and nothing
    // else, so any wording that starts arriving from outside shows up here.
    expect(buildLaunchPrompt({ itemKeys: ["HG-8"], dispatchId: "abc" })).toBe(
      [
        "使用 missiongo skill 处理这些工作条目：HG-8。",
        "",
        "本会话由 MissionGo 派单 abc 发起，上面列出的编号等同于用户给出的范围。",
        "整批条目走一个分支和一个 PR，之后按 Skill 的规则推进条目状态。",
        "会话起在仓库主目录，动手改代码前先按仓库规则建独立 worktree，不要直接在主工作区修改。",
      ].join("\n"),
    );
  });

  it("rejects anything that is not a work item key", () => {
    // The keys reach the process argv and the session name as well, so a value
    // that is not a key is refused instead of escaped.
    for (const key of [
      "and-37",
      "AND-37 ",
      "AND-",
      "-37",
      "AND-37; rm -rf /",
      "AND-37\nAND-38",
      "$(whoami)-1",
      "AND-37、AND-38",
      "",
    ]) {
      expect(() => buildLaunchPrompt({ itemKeys: [key], dispatchId: "abc" })).toThrowError(/不是合法的工作条目编号/);
    }
  });

  it("rejects an empty batch and a non-identifier dispatch id", () => {
    expect(() => buildLaunchPrompt({ itemKeys: [], dispatchId: "abc" })).toThrowError(/至少要带一个/);
    expect(() => buildLaunchPrompt({ itemKeys: ["AND-1"], dispatchId: "a b" })).toThrowError(/不是合法的派单编号/);
  });

  it("accepts the key shapes the products actually use", () => {
    expect(() => buildLaunchPrompt({ itemKeys: ["AND-1", "HG-8", "WEB2-1024"], dispatchId: "0d8f-4c" })).not.toThrow();
  });
});
