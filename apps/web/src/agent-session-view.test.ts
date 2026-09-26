import { describe, expect, it } from "vitest";

import {
  activityLabelKey,
  agentChatMessages,
  agentAttentionCounts,
  agentSessionDetailRefetchInterval,
  agentSessionDispatchFailed,
  agentSessionsRefetchInterval,
  archivableVisibleSessionIds,
  agentSessionMatches,
  answeredOptionSelected,
  byLatestActivity,
  changedMessageIds,
  DEFAULT_AGENT_KIND_FILTER,
  DEFAULT_AGENT_SESSION_FILTER,
  effectiveAgentSessionStatus,
  formatAgentMessageTime,
  isNearMessageBottom,
  isAbnormalAgentSession,
  latestAgentSessionCommand,
  messageLabelKey,
  mergeAgentSessionSnapshot,
  outgoingReply,
  questionAnswerLabel,
  questionAnswerText,
  questionAnswerValue,
  questionAnswerValues,
  replyMirrorArrived,
  toggleQuestionOption,
  replyBlockedLabelKey,
  resolvedAgentSessionId,
  shouldMarkRead,
  shouldResetMessageView,
  shouldScrollMessagesAfterChange,
} from "./agent-session-view";
import type { AgentSessionSummary } from "./types";

describe("agent session message view", () => {
  it("keeps attachment history in order without repeating a mirrored local-file prompt", () => {
    const attachment = { id: "file-1", filename: "photo.png", kind: "image" as const,
      contentType: "image/png", sizeBytes: 3, sha256: "abc", createdAt: "2026-09-25T01:00:00Z" };
    const attached = [{ commandId: "command-1", text: "Look at this", createdAt: "2026-09-25T01:00:00Z",
      status: "delivered" as const, attachments: [attachment] }];
    const messages = [
      { id: "source-1", sourceId: "source-1", role: "user" as const,
        text: "Look at this\n[MissionGo attachment command command-1]\n/local/path", occurredAt: "2026-09-25T01:00:01Z" },
      { id: "answer-1", sourceId: "answer-1", role: "agent" as const,
        text: "I see it", occurredAt: "2026-09-25T01:00:02Z" },
    ];
    expect(agentChatMessages(messages, attached).map((message) => message.text)).toEqual(["Look at this", "I see it"]);
    expect(agentChatMessages(messages, attached)[0]?.attachmentData).toEqual([attachment]);
    expect(agentChatMessages(messages, attached, "command-1").map((message) => message.text)).toEqual(["I see it"]);
  });
  it("pauses in a hidden page and backs off repeated polling failures", () => {
    expect(agentSessionsRefetchInterval(true)).toBe(5_000);
    expect(agentSessionsRefetchInterval(false)).toBe(60_000);
    expect(agentSessionsRefetchInterval(true, false)).toBe(false);
    expect(agentSessionsRefetchInterval(true, true, 3)).toBe(40_000);
    expect(agentSessionsRefetchInterval(false, true, 4)).toBe(300_000);
    expect(agentSessionDetailRefetchInterval(true)).toBe(2_000);
    expect(agentSessionDetailRefetchInterval(true, 2)).toBe(8_000);
    expect(agentSessionDetailRefetchInterval(false)).toBe(false);
  });

  it("formats today as time, yesterday by name, and older messages with a date", () => {
    const now = new Date(2026, 8, 23, 12, 0);
    expect(formatAgentMessageTime(new Date(2026, 8, 23, 9, 5).toISOString(), "zh-CN", now)).toMatch(/^09:05$/);
    expect(formatAgentMessageTime(new Date(2026, 8, 22, 18, 23).toISOString(), "zh-CN", now)).toMatch(/^昨天 18:23$/);
    expect(formatAgentMessageTime(new Date(2026, 7, 31, 23, 59).toISOString(), "zh-CN", now)).toMatch(/8.*31.*23:59/);
  });

  it("counts attention once globally and once per distinct product", () => {
    const sessions = [
      {
        id: "cross-product",
        needsAttention: true,
        items: [
          { productId: "product-1" },
          { productId: "product-1" },
          { productId: "product-2" },
        ],
      },
      { id: "second", needsAttention: true, items: [{ productId: "product-1" }] },
      { id: "settled", needsAttention: false, items: [{ productId: "product-2" }] },
      { id: "archived", needsAttention: true, archivedAt: "2026-09-21T00:00:00Z", items: [{ productId: "product-2" }] },
    ] as unknown as AgentSessionSummary[];

    const counts = agentAttentionCounts(sessions);
    expect(counts.total).toBe(2);
    expect([...counts.byProduct]).toEqual([
      ["product-1", 2],
      ["product-2", 1],
    ]);
  });

  it("opens on conversations needing attention by default", () => {
    expect(DEFAULT_AGENT_SESSION_FILTER).toBe("attention");
    expect(DEFAULT_AGENT_KIND_FILTER).toBe("all");
  });

  it("selects only archivable visible conversations for a batch", () => {
    expect(archivableVisibleSessionIds([
      { id: "one", canArchive: true },
      { id: "two", canArchive: false },
      { id: "three", canArchive: true, archivedAt: "2026-09-21T00:00:00Z" },
      { id: "four", canArchive: true, archivedSource: "source" },
    ])).toEqual(["one"]);
  });

  it("combines Agent and status filters", () => {
    const session = {
      id: "session-1",
      agentKind: "codex",
      status: "idle",
      needsAttention: true,
      nodeName: "Mac mini",
      items: [{ key: "AND-1", title: "First item", productId: "product-1" }],
    } as unknown as AgentSessionSummary;
    expect(agentSessionMatches(session, "attention", "all", "")).toBe(true);
    expect(agentSessionMatches(session, "attention", "codex", "first")).toBe(true);
    expect(agentSessionMatches(session, "attention", "claude_code", "")).toBe(false);
  });

  it("keeps abnormal conversations out of all while retaining them in failed", () => {
    const base = {
      id: "session-1", agentKind: "codex", needsAttention: false,
      nodeName: "Mac mini", items: [{ key: "AND-1", title: "First item", productId: "product-1" }],
    } as unknown as AgentSessionSummary;
    for (const abnormal of [
      { ...base, status: "failed" as const },
      { ...base, status: "idle" as const, command: {
        id: "command-1", kind: "message" as const, text: "reply", status: "failed" as const,
        createdAt: "2026-09-24T00:00:00Z",
      } },
    ]) {
      expect(isAbnormalAgentSession(abnormal)).toBe(true);
      expect(agentSessionMatches(abnormal, "all", "all", "")).toBe(false);
      expect(agentSessionMatches(abnormal, "failed", "all", "")).toBe(true);
    }
    const healthy = { ...base, status: "idle" as const };
    expect(agentSessionMatches(healthy, "all", "all", "")).toBe(true);
    expect(agentSessionMatches(healthy, "failed", "all", "")).toBe(false);
  });

  it("calls a dispatch failed when the session behind it never got going (AND-180)", () => {
    expect(agentSessionDispatchFailed({ status: "failed", lastError: "boom" })).toBe(true);
    expect(agentSessionDispatchFailed({ status: "failed" })).toBe(true);
    expect(agentSessionDispatchFailed({ status: "unavailable", lastError: "OpenCode 请求失败（HTTP 400）" })).toBe(true);
    // A machine that has gone quiet reports no error, so it is not a failed
    // dispatch, and a state that is merely paused is not one either.
    expect(agentSessionDispatchFailed({ status: "unavailable" })).toBe(false);
    for (const status of ["active", "idle", "suspended", "stalled"] as const) {
      expect(agentSessionDispatchFailed({ status })).toBe(false);
    }
  });

  it("sorts only by activity and ignores unread state", () => {
    const ordered = byLatestActivity([
      { id: "oldest-unread", unread: true, activityAt: "2026-09-20T00:00:00Z", updatedAt: "", createdAt: "" },
      { id: "newest-read", unread: false, activityAt: "2026-09-23T00:00:00Z", updatedAt: "", createdAt: "" },
      { id: "middle-unread", unread: true, activityAt: "2026-09-22T00:00:00Z", updatedAt: "", createdAt: "" },
    ]);
    expect(ordered.map((session) => session.id)).toEqual(["newest-read", "middle-unread", "oldest-unread"]);
  });

  it("marks read only a conversation the person opened, while the tab is in front", () => {
    const unread = { unread: true, unreadAt: "2026-09-22T06:00:00.000Z" };
    expect(shouldMarkRead(unread, true, true)).toBe(true);
    // Merely appearing first in the list is not an explicit open.
    expect(shouldMarkRead(unread, false, true)).toBe(false);
    expect(shouldMarkRead(unread, true, false)).toBe(false);
    expect(shouldMarkRead({ unread: false, unreadAt: unread.unreadAt }, true, true)).toBe(false);
    expect(shouldMarkRead(undefined, true, true)).toBe(false);
  });

  it("keeps a restored or filtered conversation until the full session list says it is gone", () => {
    expect(resolvedAgentSessionId("session-42", [], false)).toBe("session-42");
    expect(resolvedAgentSessionId("session-42", ["session-42", "session-41"], true)).toBe("session-42");
    // The filtered rows may no longer include session-42 after a reply, but the
    // full product session list still does, so the open conversation survives.
    expect(resolvedAgentSessionId("session-42", ["session-42"], true)).toBe("session-42");
    expect(resolvedAgentSessionId("missing", ["session-41"], true)).toBeNull();
    expect(resolvedAgentSessionId(null, ["session-41"], true)).toBeNull();
  });

  it("keeps following within the bottom tolerance", () => {
    expect(isNearMessageBottom({ scrollHeight: 1_000, scrollTop: 452, clientHeight: 500 })).toBe(true);
    expect(isNearMessageBottom({ scrollHeight: 1_000, scrollTop: 451, clientHeight: 500 })).toBe(false);
  });

  it("scrolls to a just-sent reply even after scrolling up, while an arrival keeps the position", () => {
    // Sending is the person's own action: the newest content must come into
    // view whether or not they had scrolled up through history.
    expect(shouldScrollMessagesAfterChange(true, false)).toBe(true);
    expect(shouldScrollMessagesAfterChange(true, true)).toBe(true);
    // A message arriving on its own only follows when the view already does.
    expect(shouldScrollMessagesAfterChange(false, true)).toBe(true);
    expect(shouldScrollMessagesAfterChange(false, false)).toBe(false);
  });

  it("resets when an already-selected one-pane conversation becomes visible", () => {
    expect(shouldResetMessageView(false, false, true)).toBe(true);
    expect(shouldResetMessageView(false, true, true)).toBe(false);
    expect(shouldResetMessageView(false, true, false)).toBe(false);
    expect(shouldResetMessageView(true, false, false)).toBe(true);
  });

  it("finds new and streamed messages without treating reordering as new", () => {
    const a = { id: "a", text: "first" };
    const b = { id: "b", text: "second" };
    expect(changedMessageIds([a, b], [a, b, { id: "c", text: "third" }])).toEqual(["c"]);
    expect(changedMessageIds([a, b], [b, a])).toEqual([]);
    expect(changedMessageIds([a], [{ id: "a", text: "first, still streaming" }])).toEqual(["a"]);
  });

  it("omits the redundant identity label only for the user's messages", () => {
    expect(messageLabelKey("user")).toBeNull();
    expect(messageLabelKey("agent")).toBe("agentSessionCodex");
    expect(messageLabelKey("agent", "claude_code")).toBe("agentClaudeCode");
    expect(messageLabelKey("agent", "opencode")).toBe("agentOpenCode");
    expect(messageLabelKey("plan")).toBe("agentSessionPlan");
  });

  it("keeps one optimistic reply bubble through queueing and failure", () => {
    expect(outgoingReply(undefined, {
      text: "发布", occurredAt: "2026-09-21T00:00:00Z", status: "sending",
    })).toEqual({ text: "发布", occurredAt: "2026-09-21T00:00:00Z", status: "sending" });
    expect(outgoingReply({
      id: "command-1", kind: "message", text: "发布", status: "queued", createdAt: "2026-09-21T00:00:00Z",
    })).toMatchObject({ text: "发布", occurredAt: "2026-09-21T00:00:00Z", status: "queued", commandId: "command-1" });
    expect(outgoingReply({
      id: "command-1", kind: "message", text: "发布", status: "failed", error: "offline", createdAt: "2026-09-21T00:00:00Z",
    })).toMatchObject({ status: "failed", error: "offline" });
    expect(outgoingReply({
      id: "command-1", kind: "message", text: "发布", status: "delivery_unknown",
      createdAt: "2026-09-21T00:00:00Z",
    })).toMatchObject({ status: "delivery_unknown", commandId: "command-1" });
  });

  it("protects only command updates that happen while a detail poll is in flight (AND-215)", () => {
    const oldCommand = {
      id: "older-command", kind: "message", text: "上一条", status: "delivered", createdAt: "2026-09-25T00:00:01Z",
    } as const;
    const newCommand = {
      id: "new-command", kind: "message", text: "继续", status: "queued", createdAt: "2026-09-25T00:00:01Z",
    } as const;
    const base = {
      id: "session-1", dispatchId: "dispatch-1", agentKind: "codex", status: "idle",
      updatedAt: "2026-09-25T00:00:00Z", messages: [], activities: [], canReply: true,
      canResolveDelivery: false,
    } as const;

    // The POST writes a new command after this poll starts. Its equal timestamp
    // must not let the older response erase or replace it.
    expect(mergeAgentSessionSnapshot(
      { ...base, command: oldCommand },
      { ...base, command: newCommand },
      { ...base, command: oldCommand },
    ).command).toEqual(newCommand);
    expect(mergeAgentSessionSnapshot(base, { ...base, command: newCommand }, base).command).toEqual(newCommand);

    // The response can already contain the same command at a newer status. It
    // wins immediately; a genuinely stale status cannot move the cache back.
    expect(mergeAgentSessionSnapshot(base, { ...base, command: newCommand }, {
      ...base,
      command: { ...newCommand, status: "delivered", deliveredAt: "2026-09-25T00:00:02Z" },
    }).command?.status).toBe("delivered");
    expect(mergeAgentSessionSnapshot(base, { ...base, command: { ...newCommand, status: "delivering" } }, {
      ...base,
      command: newCommand,
    }).command?.status).toBe("delivering");

    // A command that was already cached when the poll began is not protected:
    // the response remains authoritative and can clear it.
    expect(mergeAgentSessionSnapshot(
      { ...base, command: oldCommand },
      { ...base, command: oldCommand },
      base,
    ).command).toBeUndefined();
  });

  it("uses the POST result while the first detail request still has no new command (AND-215)", () => {
    const submitted = {
      id: "new-command", kind: "message", text: "继续", status: "queued", createdAt: "2026-09-25T00:00:01Z",
    } as const;
    const older = {
      id: "older-command", kind: "message", text: "上一条", status: "delivered", createdAt: submitted.createdAt,
    } as const;

    expect(latestAgentSessionCommand(undefined, submitted)).toEqual(submitted);
    expect(latestAgentSessionCommand(older, submitted)).toEqual(submitted);
    expect(latestAgentSessionCommand({
      ...submitted, status: "delivered", deliveredAt: "2026-09-25T00:00:02Z",
    }, submitted)?.status).toBe("delivered");
  });

  it("stops synthesizing a reply once it is delivered or cancelled", () => {
    const command = { id: "command-1", kind: "message", text: "发布", createdAt: "2026-09-21T00:00:00Z" } as const;
    expect(outgoingReply({ ...command, status: "delivered" })).toBeNull();
    expect(outgoingReply({ ...command, status: "cancelled" })).toBeNull();
  });

  it("keeps a delivered reply visible until its mirror lands (AND-219)", () => {
    const command = { id: "command-1", kind: "message", text: "继续", createdAt: "2026-09-25T00:00:00Z" } as const;
    // No mirrored message yet: the bubble stays so the reply never vanishes
    // beside a command that says delivered.
    expect(outgoingReply({ ...command, status: "delivered" }, undefined, false))
      .toMatchObject({ text: "继续", status: "delivered", commandId: "command-1" });
    // The mirror arrived: the real message replaces the bubble.
    expect(outgoingReply({ ...command, status: "delivered" }, undefined, true)).toBeNull();
  });

  it("sees the mirror in a same-text user message or an attachment bubble (AND-219)", () => {
    const command = { id: "command-1", kind: "message", text: "继续", createdAt: "2026-09-25T00:00:00Z" } as const;
    expect(replyMirrorArrived({ ...command, status: "delivered" }, [], [])).toBe(false);
    expect(replyMirrorArrived({ ...command, status: "delivered" }, [
      { id: "m1", sourceId: "m1", role: "agent", text: "收到", occurredAt: "2026-09-25T00:00:10Z" },
    ], [])).toBe(false);
    expect(replyMirrorArrived({ ...command, status: "delivered" }, [
      { id: "m2", sourceId: "m2", role: "user", text: "继续", occurredAt: "2026-09-25T00:00:30Z" },
    ], [])).toBe(true);
    // Clock drift: a mirror stamped slightly before the command still counts.
    expect(replyMirrorArrived({ ...command, status: "delivered" }, [
      { id: "m3", sourceId: "m3", role: "user", text: "继续", occurredAt: "2026-09-24T23:59:30Z" },
    ], [])).toBe(true);

    const attachmentCommand = {
      id: "command-2", kind: "message", text: "看图", createdAt: "2026-09-25T00:00:00Z", status: "delivered",
      attachments: [{ id: "a1", filename: "f.png", kind: "image", contentType: "image/png", sizeBytes: 1, sha256: "0", createdAt: "2026-09-25T00:00:00Z" }],
    } as const;
    expect(replyMirrorArrived(attachmentCommand, [
      { id: "m4", sourceId: "m4", role: "user", text: "看图", occurredAt: "2026-09-25T00:01:00Z" },
    ], [])).toBe(false);
    expect(replyMirrorArrived(attachmentCommand, [], [
      { commandId: "command-2", text: "看图", createdAt: "2026-09-25T00:00:05Z", status: "delivered", attachments: [] },
    ])).toBe(true);
  });

  it("reads a session as working while its reply is still on its way (AND-195)", () => {
    const command = { id: "command-1", kind: "message", text: "继续", createdAt: "2026-09-25T00:00:00Z" } as const;
    // Submitting, queueing and delivering all mean the turn is about to run.
    expect(effectiveAgentSessionStatus("idle", undefined, true)).toBe("active");
    expect(effectiveAgentSessionStatus("idle", { ...command, status: "queued" })).toBe("active");
    expect(effectiveAgentSessionStatus("idle", { ...command, status: "delivering" })).toBe("active");
    // Delivered is handed back to the machine's own state, and a failed command
    // is not a running session.
    expect(effectiveAgentSessionStatus("idle", { ...command, status: "delivered" })).toBe("idle");
    expect(effectiveAgentSessionStatus("idle", { ...command, status: "failed" })).toBe("idle");
    // A state that already says something a person has to read keeps its wording.
    for (const status of ["active", "suspended", "stalled", "unavailable", "failed"] as const) {
      expect(effectiveAgentSessionStatus(status, { ...command, status: "queued" })).toBe(status);
    }
  });

  it("has a bottom-of-conversation label for every session state", () => {
    expect(activityLabelKey("active")).toBe("agentSessionActivityActive");
    expect(activityLabelKey("idle")).toBe("agentSessionActivityIdle");
    expect(activityLabelKey("suspended")).toBe("agentSessionActivitySuspended");
    expect(activityLabelKey("stalled")).toBe("agentSessionActivityStalled");
    expect(activityLabelKey("unavailable")).toBe("agentSessionActivityUnavailable");
    expect(activityLabelKey("unavailable", true)).toBe("agentSessionActivityUnavailableQueued");
    expect(activityLabelKey("failed")).toBe("agentSessionActivityFailed");
  });

  it("distinguishes finished work from missing reply permissions", () => {
    expect(replyBlockedLabelKey("work_finished")).toBe("agentSessionWorkFinishedReadOnly");
    expect(replyBlockedLabelKey("operate_permission")).toBe("agentSessionOperateReadOnly");
    expect(replyBlockedLabelKey("ai_permission")).toBe("agentSessionReadOnly");
  });

  it("keeps lifecycle reply blocks distinct and falls back to neutral copy", () => {
    expect(replyBlockedLabelKey("archived")).toBe("agentSessionArchivedReadOnly");
    expect(replyBlockedLabelKey("source_archived")).toBe("agentSessionSourceArchivedReadOnly");
    expect(replyBlockedLabelKey("node_revoked")).toBe("agentNodeRevokedReadOnly");
    expect(replyBlockedLabelKey(undefined)).toBe("agentSessionUnavailableReadOnly");
  });

  it("formats one or several question answers for the Claude host", () => {
    expect(questionAnswerText("", { title: "Ship it?" }, "Yes", 1)).toBe("Yes");
    const first = questionAnswerText("", { header: "Scope", title: "Which scope?" }, "Complete", 2);
    expect(first).toBe("Scope: Complete");
    expect(questionAnswerText(first, { header: "Risk", title: "Accept risk?" }, "No", 2))
      .toBe("Scope: Complete\nRisk: No");
    expect(questionAnswerText(first, { header: "Scope", title: "Which scope?" }, "Small", 2))
      .toBe("Scope: Small");
  });

  it("answers a keyed OpenCode field under its key, not its title", () => {
    const field = { title: "范围", key: "scope" };
    expect(questionAnswerLabel(field)).toBe("scope");
    expect(questionAnswerText("", field, "小", 1)).toBe("scope: 小");
  });

  it("toggles a multi-select field without dropping its other values", () => {
    const field = { title: "标签", key: "tags", multiSelect: true };
    const first = toggleQuestionOption("", field, "甲", 2);
    expect(first).toBe("tags: 甲");
    const second = toggleQuestionOption(first, field, "乙", 2);
    expect(second).toBe("tags: 甲、乙");
    expect(toggleQuestionOption(second, field, "甲", 2)).toBe("tags: 乙");
    expect(toggleQuestionOption("tags: 甲", field, "甲", 2)).toBe("");
  });

  it("reads one keyed field's value without splitting it on the separator", () => {
    const field = { title: "备注", key: "note" };
    expect(questionAnswerValue("note: 今天、明天", field)).toBe("今天、明天");
    expect(questionAnswerValues("note: 今天、明天", field)).toEqual(["今天", "明天"]);
  });

  it("matches a settled question's picked option exactly, multi-select by part", () => {
    expect(answeredOptionSelected({ answered: "始终允许" }, "始终允许")).toBe(true);
    expect(answeredOptionSelected({ answered: "始终允许" }, "允许一次")).toBe(false);
    expect(answeredOptionSelected({}, "始终允许")).toBe(false);
    const multi = { answered: "小、完整", multiSelect: true };
    expect(answeredOptionSelected(multi, "小")).toBe(true);
    expect(answeredOptionSelected(multi, "完整")).toBe(true);
    expect(answeredOptionSelected(multi, "大")).toBe(false);
    // A single-select answer containing the separator must not match a part.
    expect(answeredOptionSelected({ answered: "小、完整" }, "小")).toBe(false);
  });
});
