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

  // AND-253: the unconfirmed-delivery line and its confirm button said Codex on
  // every session, so an OpenCode reply the Mac could not confirm read as if
  // Codex had been asked.
  it("names the session's own agent in the unconfirmed-delivery copy", () => {
    expect(translate("zh-CN", "agentSessionReplyDeliveryUnknown", { agent: "OpenCode" }))
      .toBe("送达结果未确认，请先在 OpenCode 会话中核实，再决定是否重发。");
    expect(translate("zh-CN", "agentSessionReplyConfirmReceived", { agent: "OpenCode" }))
      .toBe("已在 OpenCode 收到");
    expect(translate("en", "agentSessionReplyDeliveryUnknown", { agent: "Claude Code" }))
      .toBe("Delivery is unconfirmed. Check this Claude Code conversation before sending again.");
    expect(translate("en", "agentSessionReplyConfirmReceived", { agent: "Codex" }))
      .toBe("I found it in Codex");
  });

  // AND-236: a Codex or OpenCode turn reported as "Claude Code" told the user the
  // wrong agent was running, so both running and waiting copy take the agent name.
  it("names the running agent in the turn and waiting lines", () => {
    expect(translate("zh-CN", "agentSessionTurnRunning", { agent: "Codex", duration: "1 分 20 秒" }))
      .toBe("Codex 回合进行中 · 1 分 20 秒");
    expect(translate("en", "agentSessionTurnRunning", { agent: "Codex", duration: "1m 20s" }))
      .toBe("Codex turn running · 1m 20s");
    expect(translate("zh-CN", "agentSessionWaitingForInput", { agent: "OpenCode" }))
      .toBe("OpenCode 正在等待你的回复。");
    expect(translate("en", "agentSessionWaitingForInput", { agent: "OpenCode" }))
      .toBe("OpenCode is waiting for your reply.");
  });

  it("explains queued replies and offers to cancel them for editing", () => {
    expect(translate("zh-CN", "agentSessionReplyQueued")).toBe("回复已排队，正在等待 Mac 接收");
    expect(translate("zh-CN", "agentSessionCancelAndEdit")).toBe("取消等待并编辑");
    expect(translate("en", "agentSessionReplyCancelled")).toBe("Queued reply cancelled");
  });

  // AND-254: the chat body's size is a second setting, so it must not be named
  // like the console-wide one in either language.
  it("names the console-wide size and the chat body's size separately", () => {
    expect(translate("zh-CN", "fontSize")).toBe("字体大小");
    expect(translate("zh-CN", "consoleFontSize")).toBe("Agent 控制台聊天字号");
    expect(translate("en", "consoleFontSize")).toBe("Agent console chat text size");
    expect(translate("zh-CN", "consoleFontSizeHelp")).toContain("互不影响");
  });
});
