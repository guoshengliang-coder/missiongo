import { describe, expect, it } from "vitest";

import { resolveLocale, translate } from "./i18n";

describe("MissionGo interface language", () => {
  it("defaults to Simplified Chinese", () => {
    expect(resolveLocale(null)).toBe("zh-CN");
    expect(resolveLocale("unknown")).toBe("zh-CN");
  });

  it("restores an explicit English preference", () => {
    expect(resolveLocale("en")).toBe("en");
  });

  it("translates and interpolates interface copy", () => {
    expect(translate("zh-CN", "capturedInInbox", { key: "HG-8" })).toBe("HG-8 已保存到草稿。");
    expect(translate("en", "capturedInInbox", { key: "HG-8" })).toBe("HG-8 saved as a draft.");
    expect(translate("zh-CN", "submittedForProcessing", { key: "HG-9" })).toBe("HG-9 已提交到待处理。");
    expect(translate("zh-CN", "requiredField")).toBe("必填");
    expect(translate("zh-CN", "bugDetailsHelp")).toContain("都可以不填");
    expect(translate("zh-CN", "add")).toBe("添加");
    expect(translate("zh-CN", "uploadLog")).toBe("上传日志");
    expect(translate("zh-CN", "notAvailableYet")).toBe("暂时还没有");
  });

  it("calls the session entry and heading the Agent console in both languages", () => {
    expect(translate("zh-CN", "agentConsoleOpen")).toBe("Agent 控制台");
    expect(translate("zh-CN", "agentConsoleTitle")).toBe("Agent 控制台");
    expect(translate("en", "agentConsoleOpen")).toBe("Agent console");
    expect(translate("en", "agentConsoleTitle")).toBe("Agent console");
  });

  it("names the actual agent in the session activity and reply copy", () => {
    expect(translate("zh-CN", "agentSessionActivityActive", { agent: "Codex" }))
      .toBe("Codex 正在运行，可能还会有新消息。");
    expect(translate("zh-CN", "agentSessionReplyPlaceholder", { agent: "Claude Code" }))
      .toBe("回复这个 Claude Code 会话…");
    expect(translate("en", "agentSessionReplyPlaceholder", { agent: "Codex" }))
      .toBe("Reply to this Codex session…");
  });

  it("explains queued replies and offers to cancel them for editing", () => {
    expect(translate("zh-CN", "agentSessionReplyQueued")).toBe("回复已排队，正在等待 Mac 接收");
    expect(translate("zh-CN", "agentSessionCancelAndEdit")).toBe("取消等待并编辑");
    expect(translate("en", "agentSessionReplyCancelled")).toBe("Queued reply cancelled");
  });
});
