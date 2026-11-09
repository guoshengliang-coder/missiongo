import { describe, expect, it } from "vitest";

import {
  activityLabelKey,
  dispatchActivityLabelKey,
  agentChatMessages,
  projectConversationMessages,
  approvalNeedsAction,
  approvalTitleKey,
  waitingStatusLabelKey,
  runWaitingLabelKey,
  agentOtherProjectCounts,
  agentUnreadCounts,
  agentSessionDetailRefetchInterval,
  agentSessionDispatchFailed,
  agentSessionsRefetchInterval,
  archivableVisibleSessionIds,
  agentSessionMatches,
  agentSessionCategory,
  answeredOptionSelected,
  byLatestActivity,
  canonicalAgentSessionId,
  changedMessageIds,
  DEFAULT_AGENT_KIND_FILTER,
  DEFAULT_AGENT_SESSION_FILTER,
  effectiveAgentSessionStatus,
  sessionReplyPresentation,
  formatAgentMessageTime,
  isNearMessageBottom,
  isAbnormalAgentSession,
  latestAgentSessionCommand,
  messageLabelKey,
  mergeAgentSessionSnapshot,
  outgoingReply,
  outgoingReplyStatusKey,
  questionAnswerLabel,
  questionAnswerText,
  questionAnswerValue,
  questionAnswerValues,
  replyMirrorArrived,
  toggleQuestionOption,
  replyBlockedLabelKey,
  resolvedAgentSessionId,
  sessionCountsAsUnread,
  sessionInlineError,
  sessionReplyDraft,
  sessionStatusDetail,
  shouldMarkRead,
  shouldResetMessageView,
  shouldScrollMessagesAfterChange,
  withSessionReplyDraft,
} from "./agent-session-view";
import type { AgentSessionSummary } from "./types";

it("resolves an old mirror link to the unified conversation without selecting an unrelated row", () => {
  const rows = [{ id: "dispatch-session", relatedSessionIds: ["dispatch-session", "progress-session"] }];
  expect(canonicalAgentSessionId("progress-session", rows)).toBe("dispatch-session");
  expect(canonicalAgentSessionId("different-session", rows)).toBe("different-session");
  expect(canonicalAgentSessionId(null, rows)).toBeNull();
});

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

  it("drops a card whose ask went away but keeps answered history (AND-239)", () => {
    const messages = [
      { id: "gone", sourceId: "permission-per_1", role: "agent" as const,
        text: "OpenCode 需要你授权后才能继续。", occurredAt: "2026-09-25T01:00:00Z",
        questions: [{ title: "OpenCode 请求使用 bash", options: ["允许一次"], withdrawn: true }] },
      { id: "answered", sourceId: "permission-per_2", role: "agent" as const,
        text: "OpenCode 需要你授权后才能继续。", occurredAt: "2026-09-25T01:00:01Z",
        questions: [{ title: "OpenCode 请求使用 bash", options: ["允许一次"], answered: "允许一次" }] },
      { id: "mixed", sourceId: "form-frm_1", role: "agent" as const,
        text: "OpenCode 想请你确认以下问题。", occurredAt: "2026-09-25T01:00:02Z",
        questions: [
          { title: "自动放行的字段", options: ["继续"], withdrawn: true },
          { title: "仍需确认的字段", options: ["继续"] },
        ] },
      { id: "plain", sourceId: "plain", role: "agent" as const,
        text: "没有卡片的消息", occurredAt: "2026-09-25T01:00:03Z" },
    ];
    const shown = agentChatMessages(messages, []);
    expect(shown.map((message) => message.text)).toEqual([
      "OpenCode 需要你授权后才能继续。",
      "OpenCode 想请你确认以下问题。",
      "没有卡片的消息",
    ]);
    expect(shown[0]?.questions?.[0]?.answered).toBe("允许一次");
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

  it("counts unread sessions once globally and once per distinct product, including failed but not running ones", () => {
    const sessions = [
      {
        id: "cross-product",
        unread: true,
        status: "idle",
        items: [
          { productId: "product-1" },
          { productId: "product-1" },
          { productId: "product-2" },
        ],
      },
      { id: "second", unread: true, status: "failed", items: [{ productId: "product-1" }] },
      { id: "settled", unread: false, needsAttention: true, items: [{ productId: "product-2" }] },
      { id: "archived", unread: true, status: "idle", archivedAt: "2026-09-21T00:00:00Z", items: [{ productId: "product-2" }] },
      { id: "running", unread: true, status: "active", items: [{ productId: "product-1" }] },
    ] as unknown as AgentSessionSummary[];

    const counts = agentUnreadCounts(sessions);
    expect(counts.total).toBe(2);
    expect([...counts.byProduct]).toEqual([
      ["product-1", 2],
      ["product-2", 1],
    ]);
  });

  it("counts unread as waiting, not as still running (AND-260)", () => {
    expect(sessionCountsAsUnread({ unread: true, status: "idle" })).toBe(true);
    expect(sessionCountsAsUnread({ unread: true, status: "stalled" })).toBe(true);
    expect(sessionCountsAsUnread({ unread: true, status: "failed" })).toBe(true);
    expect(sessionCountsAsUnread({ unread: true, status: "active" })).toBe(false);
    expect(sessionCountsAsUnread({ unread: false, status: "idle" })).toBe(false);
  });

  it("counts other-project attention and unread once, excluding archived and running (AND-419)", () => {
    const sessions = [
      { id: "selected", productId: "product-1", needsAttention: true, unread: true, status: "idle", items: [] },
      { id: "shared", productId: "product-2", needsAttention: true, unread: true, status: "idle", items: [{ productId: "product-1" }] },
      { id: "other-attention", productId: "product-2", needsAttention: true, unread: false, status: "idle", items: [] },
      { id: "other-unread", productId: "product-3", needsAttention: false, unread: true, status: "idle", items: [] },
      { id: "other-both", productId: "product-4", needsAttention: true, unread: true, status: "stalled", items: [{ productId: "product-2" }] },
      { id: "other-running", productId: "product-4", needsAttention: false, unread: true, status: "active", items: [] },
      { id: "other-archived", productId: "product-5", needsAttention: true, unread: true, status: "idle", archivedAt: "2026-09-21T00:00:00Z", items: [] },
    ] as unknown as AgentSessionSummary[];
    expect(agentOtherProjectCounts(sessions, "product-1")).toEqual({ attention: 2, unread: 2 });
    expect(agentOtherProjectCounts([], "product-1")).toEqual({ attention: 0, unread: 0 });
  });

  it("opens on all non-failed conversations by default", () => {
    expect(DEFAULT_AGENT_SESSION_FILTER).toBe("all");
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

  it("includes archived favorites while keeping regular archive and search filters independent", () => {
    const favorite = { id: "favorite", agentKind: "codex", status: "idle", favorite: true, archivedAt: "2026-11-07", nodeName: "Fixture",
      sessionName: "Key conversation", items: [], unread: false, needsAttention: false } as unknown as AgentSessionSummary;
    expect(agentSessionMatches(favorite, "favorites", "all", "key")).toBe(true);
    expect(agentSessionMatches(favorite, "favorites", "all", "missing")).toBe(false);
    expect(agentSessionMatches(favorite, "favorites", "claude_code", "")).toBe(false);
    expect(agentSessionMatches({ ...favorite, favorite: false }, "favorites", "all", "")).toBe(false);
    expect(agentSessionMatches(favorite, "all", "all", "")).toBe(false);
    expect(agentSessionMatches(favorite, "archived", "all", "")).toBe(true);
  });

  it("keeps abnormal conversations out of all while retaining them in failed", () => {
    const base = {
      id: "session-1", agentKind: "codex", needsAttention: false, unread: true,
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
      expect(agentSessionMatches(abnormal, "unread", "all", "")).toBe(true);
    }
    const healthy = { ...base, status: "idle" as const };
    expect(agentSessionMatches(healthy, "all", "all", "")).toBe(true);
    expect(agentSessionMatches(healthy, "failed", "all", "")).toBe(false);
    expect(agentSessionMatches({ ...healthy, unread: false }, "unread", "all", "")).toBe(false);
    // AND-260: the unread list holds what the badge counted, so a running
    // conversation with unread messages is not in it.
    expect(agentSessionMatches({ ...healthy, status: "active" as const }, "unread", "all", "")).toBe(false);
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

  it("labels a delivered reply as delivered while its mirror is still pending", () => {
    expect(outgoingReplyStatusKey("delivered")).toBe("agentSessionReplyDelivered");
    expect(outgoingReplyStatusKey("failed")).toBe("agentSessionReplyFailed");
    expect(outgoingReplyStatusKey("delivery_unknown")).toBe("agentSessionReplyDeliveryUnknown");
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

  it("hides only delivered plain replies before an explicitly paginated window (AND-428)", () => {
    const command = { id: "old", kind: "message", text: "继续", status: "delivered", createdAt: "2026-11-06T00:00:00Z" } as const;
    const messages = Array.from({ length: 50 }, (_, n) => ({ id: `m${n}`, sourceId: `m${n}`, role: "agent" as const,
      text: "后续正文", occurredAt: new Date(Date.parse(command.createdAt) + (n + 1) * 60_000).toISOString() }));
    for (const window of [messages, messages.slice(0, 2), [...messages].reverse()]) {
      expect(outgoingReply(command, undefined, replyMirrorArrived(command, window, [], true))).toBeNull();
      expect(replyMirrorArrived(command, window, [])).toBe(false);
    }
    for (const status of ["queued", "delivering", "delivery_unknown", "failed"] as const) {
      expect(replyMirrorArrived({ ...command, status }, messages, [], true)).toBe(false);
      expect(outgoingReply({ ...command, status }, undefined, false)?.status).toBe(status);
    }
    for (const occurredAt of [command.createdAt, "2026-11-05T23:59:00Z", "invalid"]) {
      expect(replyMirrorArrived(command, [{ ...messages[0]!, occurredAt }], [], true)).toBe(false);
    }
    expect(replyMirrorArrived(command, [], [], true)).toBe(false);
    expect(replyMirrorArrived({ ...command, createdAt: "invalid" }, messages, [], true)).toBe(false);
    expect(replyMirrorArrived({ ...command, attachments: [{ id: "a", filename: "image.png", kind: "image", contentType: "image/png", sizeBytes: 1, sha256: "0", createdAt: command.createdAt }] }, messages, [], true)).toBe(false);
    expect(replyMirrorArrived(command, [{ ...messages[0]!, role: "user", text: command.text }], [], true)).toBe(true);
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

  it("keeps a released session out of the error banner but explains it in the run details", () => {
    const release = "Claude Code 会话已空闲 2 小时，进程已挂起；发送下一条消息时会恢复。";
    expect(sessionInlineError("suspended", release)).toBeUndefined();
    expect(sessionStatusDetail("suspended", release, "本机 Claude 进程已释放")).toBe(release);
    // Without a node explanation the neutral copy still says what happened.
    expect(sessionStatusDetail("suspended", undefined, "本机 Claude 进程已释放")).toBe("本机 Claude 进程已释放");
    // Genuine failures keep both the banner and their own detail.
    for (const status of ["failed", "stalled", "unavailable"] as const) {
      expect(sessionInlineError(status, "boom")).toBe("boom");
      expect(sessionStatusDetail(status, "boom", "activity")).toBe("activity");
    }
    expect(sessionInlineError("idle", "boom")).toBe("boom");
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

  it("keeps native OpenCode confirmation answers bound to their request", () => {
    const question = { title: "确认协作草稿当前版本", key: "确认请求 form-443" };
    for (const choice of ["批准", "取消"]) {
      const answer = questionAnswerText("", question, choice, 1);
      expect(answer).toBe(`确认请求 form-443: ${choice}`);
      expect(questionAnswerValue(answer, question, 1)).toBe(choice);
    }
    expect(questionAnswerValue("批准", question, 1)).toBe("");
    expect(questionAnswerValue("确认请求 old-form: 批准", question, 1)).toBe("");
  });

  it("reads exactly the same single or labelled answer format that it writes (AND-347)", () => {
    const question = { header: "范围", title: "本次做什么？" };
    const option = "纳入本次：人工评论、MCP 都支持";
    for (const count of [1, 2]) {
      const draft = questionAnswerText("", question, option, count);
      expect(questionAnswerValue(draft, question, count)).toBe(option);
      expect(questionAnswerValue("自行决定", question, count)).toBe(count === 1 ? "自行决定" : "");
      expect(questionAnswerValue("", question, count)).toBe("");
    }
    expect(questionAnswerValue(option, { ...question, key: "scope" }, 1)).toBe("");
    expect(questionAnswerValue(option, question, 2)).toBe("");
  });

  it("toggles a single key-less multi-select and clears its last option (AND-347)", () => {
    const question = { title: "选择范围" };
    const first = toggleQuestionOption("", question, "甲", 1);
    const second = toggleQuestionOption(first, question, "乙", 1);
    expect(second).toBe("甲、乙");
    expect(questionAnswerValues(second, question, 1)).toEqual(["甲", "乙"]);
    expect(toggleQuestionOption(second, question, "甲", 1)).toBe("乙");
    expect(toggleQuestionOption("乙", question, "乙", 1)).toBe("");
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

describe("reply drafts stay with one conversation (AND-252)", () => {
  it("reads nothing for no session or for a conversation never written to", () => {
    expect(sessionReplyDraft({}, "session-1")).toBe("");
    expect(sessionReplyDraft({ "session-1": "Scope: Complete" }, null)).toBe("");
    expect(sessionReplyDraft({ "session-1": "Scope: Complete" }, undefined)).toBe("");
    expect(sessionReplyDraft({ "session-1": "Scope: Complete" }, "session-2")).toBe("");
  });

  it("keeps a session's picked answer out of every other session", () => {
    let drafts: Readonly<Record<string, string>> = {};
    drafts = withSessionReplyDraft(drafts, "session-1", "Scope: Complete\nRisk: No");
    // Switching to session-2 shows its own (empty) draft, not session-1's.
    expect(sessionReplyDraft(drafts, "session-2")).toBe("");
    drafts = withSessionReplyDraft(drafts, "session-2", "Only here");
    expect(sessionReplyDraft(drafts, "session-1")).toBe("Scope: Complete\nRisk: No");
    expect(sessionReplyDraft(drafts, "session-2")).toBe("Only here");
  });

  it("applies a functional update against that session's own draft", () => {
    const drafts = withSessionReplyDraft({ "session-2": "other" }, "session-1", "start");
    const next = withSessionReplyDraft(drafts, "session-1", (current) => `${current}!`);
    expect(sessionReplyDraft(next, "session-1")).toBe("start!");
    expect(sessionReplyDraft(next, "session-2")).toBe("other");
  });

  it("drops an emptied draft and returns the same record when nothing changed", () => {
    const drafts = { "session-1": "x", "session-2": "y" };
    expect(withSessionReplyDraft(drafts, "session-1", "x")).toBe(drafts);
    expect(withSessionReplyDraft(drafts, "session-3", "")).toBe(drafts);
    const cleared = withSessionReplyDraft(drafts, "session-1", "");
    expect(cleared).toEqual({ "session-2": "y" });
    expect("session-1" in cleared).toBe(false);
  });
});

describe("authorization intervention visibility (AND-272)", () => {
  const approval = { id: "review", kind: "auto" as const, status: "inProgress",
    turnId: "turn", action: "fixture command", startedAtMs: 1 };
  it("hides automatic review progress and completed decisions", () => {
    expect(approvalNeedsAction(undefined)).toBe(false);
    for (const status of ["inProgress", "pending", "approved", "cancelled"]) {
      expect(approvalNeedsAction({ ...approval, status })).toBe(false);
    }
    expect(approvalNeedsAction({ ...approval, kind: "manual", status: "approved" })).toBe(false);
    expect(approvalNeedsAction({ ...approval, kind: "manual", status: "denied" })).toBe(false);
    expect(approvalNeedsAction({ ...approval, kind: "manual", status: "resolved" })).toBe(false);
    expect(approvalNeedsAction({ ...approval, kind: "manual", status: "pending", decision: "accept" })).toBe(false);
  });
  it("keeps manual requests, denials and retry failure feedback", () => {
    expect(approvalNeedsAction({ ...approval, kind: "manual", status: "pending" })).toBe(true);
    expect(approvalNeedsAction({ ...approval, kind: "manual", status: "unavailable" })).toBe(true);
    expect(approvalNeedsAction({ ...approval, status: "denied" })).toBe(true);
    for (const retryStatus of ["queued", "delivering", "delivered", "restored"] as const) {
      expect(approvalNeedsAction({ ...approval, status: "denied", retryId: "retry", retryStatus })).toBe(false);
    }
    expect(approvalNeedsAction({ ...approval, status: "denied", retryId: "retry", retryStatus: "failed", retryError: "offline" })).toBe(true);
  });
});

describe("dispatch result rejection", () => {
  it("distinguishes a rejected receipt from silence, while preserving launch state labels", () => {
    const session = { dispatchStatus: "delivered", status: "failed", agentKind: "codex" } as const;
    expect(dispatchActivityLabelKey(session)).toBe("agentConsoleDispatchTimedOut");
    expect(dispatchActivityLabelKey({ ...session, dispatchResultRejected: true })).toBe("agentConsoleDispatchResultRejected");
    expect(dispatchActivityLabelKey({ ...session, status: "active" })).toBe("agentConsoleDispatchLaunching");
    expect(dispatchActivityLabelKey({ ...session, dispatchStatus: "launched" })).toBe("agentConsoleDispatchLaunched");
  });
});

it("keeps a freshly observed idle runtime idle while a reply waits for delivery", () => {
  expect(effectiveAgentSessionStatus("idle", { status: "queued" }, false, true)).toBe("idle");
  expect(effectiveAgentSessionStatus("idle", { status: "delivering" }, false, true)).toBe("idle");
  expect(effectiveAgentSessionStatus("idle", { status: "queued" })).toBe("active");
});


it("keeps project-only unread attribution and hides only the launch instruction", () => {
  const counts = agentUnreadCounts([{ id: "project-session", productId: "p1", status: "idle", unread: true, items: [] }]);
  expect(counts.total).toBe(1);
  expect(counts.byProduct.get("p1")).toBe(1);
  const bootstrap = { role: "user", text: "这是用户从 MissionGo 控制台发起的项目会话，不关联工作条目。\n本条是启动说明" };
  const human = { role: "user", text: "先讨论方案" };
  const messages = [bootstrap, { role: "agent", text: "准备就绪" }, human, bootstrap];
  expect(projectConversationMessages(messages, true)).toEqual(messages.slice(1));
  expect(projectConversationMessages(messages, false)).toBe(messages);
  expect(projectConversationMessages([human], true)).toEqual([human]);
});

describe("requestKind copy mapping (AND-408)", () => {
  const prompt = { id: "prompt", kind: "manual" as const, status: "pending",
    turnId: "turn", action: "fixture", startedAtMs: 1 };
  it("maps the approval card title by request kind, neutral for legacy rows", () => {
    expect(approvalTitleKey({ ...prompt, requestKind: "question" })).toBe("agentQuestionTitle");
    expect(approvalTitleKey({ ...prompt, requestKind: "confirmation" })).toBe("agentConfirmationTitle");
    expect(approvalTitleKey({ ...prompt, requestKind: "permission" })).toBe("agentApprovalTitle");
    expect(approvalTitleKey(prompt)).toBe("agentNeutralApprovalTitle");
    expect(approvalTitleKey({ ...prompt, kind: "auto" })).toBe("agentApprovalAutoTitle");
  });
  it("maps waiting pills and run labels, keeping other agents untouched", () => {
    expect(waitingStatusLabelKey({ agentKind: "codex", approval: { ...prompt, requestKind: "question" } })).toBe("agentSessionWaitingQuestionStatus");
    expect(waitingStatusLabelKey({ agentKind: "codex", approval: { ...prompt, requestKind: "confirmation" } })).toBe("agentSessionWaitingConfirmationStatus");
    expect(waitingStatusLabelKey({ agentKind: "codex", approval: { ...prompt, requestKind: "permission" } })).toBe("agentSessionWaitingApprovalStatus");
    expect(waitingStatusLabelKey({ agentKind: "codex", approval: prompt })).toBe("agentSessionWaitingPendingStatus");
    expect(waitingStatusLabelKey({ agentKind: "codex", approval: undefined })).toBe("agentSessionWaitingPendingStatus");
    expect(waitingStatusLabelKey({ agentKind: "claude_code", approval: undefined })).toBe("agentSessionWaitingStatus");
    expect(runWaitingLabelKey({ agentKind: "codex", approval: { ...prompt, requestKind: "question" } })).toBe("agentRunQuestion");
    expect(runWaitingLabelKey({ agentKind: "codex", approval: { ...prompt, requestKind: "confirmation" } })).toBe("agentRunConfirmation");
    expect(runWaitingLabelKey({ agentKind: "codex", approval: { ...prompt, requestKind: "permission" } })).toBe("agentRunApproval");
    expect(runWaitingLabelKey({ agentKind: "codex", approval: prompt })).toBe("agentRunWaiting");
    expect(runWaitingLabelKey({ agentKind: "opencode", approval: undefined })).toBe("agentRunWaiting");
  });
});


it("keeps integration, development and unlinked categories exclusive with legacy fallback (AND-435)", () => {
  const base = {id:"one",agentKind:"codex" as const,status:"idle" as const,nodeName:"Fixture",needsAttention:false,unread:false,items:[]};
  const item = {key:"EX-1",title:"Task",productId:"product"};
  const sameName = {...base,sessionName:"集成会话"};
  for (const [session,category] of [
    [base,"unlinked"], [{...base,items:[item]},"linked"],
    [{...base,sessionPurpose:"integration" as const},"integration"],
    [{...base,sessionPurpose:"integration" as const,items:[item]},"integration"],
    [sameName,"unlinked"],
  ] as const) {
    expect(agentSessionCategory(session)).toBe(category);
    for (const filter of ["unlinked","linked","integration"] as const) {
      expect(agentSessionMatches(session,"all","all","",filter)).toBe(filter===category);
    }
    expect(agentSessionMatches(session,"all","all","","all")).toBe(true);
    expect(agentSessionMatches(session,"all","claude_code","",category)).toBe(false);
    expect(agentSessionMatches(session,"all","all","missing",category)).toBe(false);
    expect(agentSessionMatches({...session,archivedAt:"2026-11-06T01:00:00Z"},"archived","all","",category)).toBe(true);
  }
});

it("excludes tagged execution records without hiding original JSON messages", () => {
  const text = '{"command":"user example"}';
  const base = { id: "message", sourceId: "message", role: "agent" as const, occurredAt: "2026-11-07T00:00:00Z" };
  expect(agentChatMessages([{ ...base, phase: "execution", text: "private" }, { ...base, id: "reply", sourceId: "reply", text }], []).map(message => message.text)).toEqual([text]);
});


describe("message delivery presentation (AND-487)", () => {
  const message = { id: "new-message", kind: "message", text: "继续", status: "queued", createdAt: "2026-11-09T00:01:00Z" } as const;
  const stop = { ...message, id: "stop", kind: "interrupt", status: "delivered", stopConfirmed: true, createdAt: "2026-11-09T00:02:00Z" } as const;
  it("shows delivery even when the native turn is idle, without changing execution status", () => {
    expect(effectiveAgentSessionStatus("idle", message, false, true)).toBe("idle");
    expect(sessionReplyPresentation("idle", message)?.labelKey).toBe("agentReplyQueuedShort");
    expect(sessionReplyPresentation("idle", { ...message, status: "delivering" })?.labelKey).toBe("agentReplyDeliveringShort");
    expect(sessionReplyPresentation("idle", message, true)?.labelKey).toBe("agentReplySendingShort");
    expect(sessionReplyPresentation("suspended", message)?.iconStatus).toBe("active");
  });
  it("keeps unknown delivery static and respects terminal commands and runtime faults", () => {
    expect(sessionReplyPresentation("idle", { ...message, status: "delivery_unknown" })).toEqual({
      labelKey: "agentReplyDeliveryUnknownShort", iconStatus: "waiting", visualStatus: "idle",
    });
    for (const status of ["delivered", "failed", "cancelled"] as const) expect(sessionReplyPresentation("idle", { ...message, status })).toBeUndefined();
    for (const status of ["failed", "unavailable", "stalled"] as const) expect(sessionReplyPresentation(status, message)).toBeUndefined();
    expect(sessionReplyPresentation("idle", { ...message, kind: "interrupt" })).toBeUndefined();
  });
  it("does not revive an older message after a confirmed stop, but allows new input", () => {
    expect(sessionReplyPresentation("idle", message, false, stop)).toBeUndefined();
    expect(sessionReplyPresentation("idle", { ...message, createdAt: "2026-11-09T00:03:00Z" }, false, stop)?.iconStatus).toBe("active");
    expect(sessionReplyPresentation("idle", message, true, stop)?.labelKey).toBe("agentReplySendingShort");
  });
});
