import { describe, expect, it } from "vitest";

import {
  activityLabelKey,
  agentAttentionCounts,
  agentSessionDetailRefetchInterval,
  agentSessionsRefetchInterval,
  archivableVisibleSessionIds,
  agentSessionMatches,
  byLatestActivity,
  changedMessageIds,
  DEFAULT_AGENT_KIND_FILTER,
  DEFAULT_AGENT_SESSION_FILTER,
  formatAgentMessageTime,
  isNearMessageBottom,
  messageLabelKey,
  outgoingReply,
  questionAnswerText,
  replyBlockedLabelKey,
  resolvedAgentSessionId,
  shouldMarkRead,
  shouldResetMessageView,
} from "./agent-session-view";
import type { AgentSessionSummary } from "./types";

describe("agent session message view", () => {
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

  it("opens on all conversations by default", () => {
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
  });

  it("stops synthesizing a reply once it is delivered or cancelled", () => {
    const command = { id: "command-1", kind: "message", text: "发布", createdAt: "2026-09-21T00:00:00Z" } as const;
    expect(outgoingReply({ ...command, status: "delivered" })).toBeNull();
    expect(outgoingReply({ ...command, status: "cancelled" })).toBeNull();
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
});
