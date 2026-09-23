import { describe, expect, it } from "vitest";

import { widgetSummary, type WidgetSummarySession } from "./widget-summary.js";

function session(id: string, overrides: Partial<WidgetSummarySession> = {}): WidgetSummarySession {
  return { id, status: "idle", needsAttention: false, items: [{ productId: "p1" }], ...overrides };
}

describe("widgetSummary (AND-149)", () => {
  const now = new Date("2026-09-23T04:00:00.000Z");

  it("counts the way the console filters do and leaves archived conversations out", () => {
    const summary = widgetSummary([
      session("a", { needsAttention: true }),
      session("b", { status: "active" }),
      session("c", { status: "failed" }),
      session("d", { command: { status: "failed" } }),
      session("e", { needsAttention: true, status: "active", archivedAt: "2026-09-22T00:00:00.000Z" }),
    ], new Map(), now);

    expect(summary).toEqual({
      generatedAt: "2026-09-23T04:00:00.000Z",
      agent: { attention: 1, active: 1, failed: 2, attentionProductId: "p1", attentionSessionId: "a" },
      items: { ready: 0, readyProductId: null },
      attentionEntries: [
        {
          sessionId: "a",
          itemKeys: [],
          productId: "p1",
          kind: "uncertain",
          excerpt: "",
          revision: "",
        },
      ],
    });
  });

  it("describes each waiting conversation for a notification (AND-150)", () => {
    const summary = widgetSummary([
      session("a", {
        needsAttention: true,
        items: [{ productId: "p2" }, { productId: "p1", key: "AND-7" }],
        attention: { kind: "answer", reason: "AI 提出了需要回答的问题。", revision: "rev-a" },
        latestMessageText: "汇总接口放在哪里？\n需要你定一下。",
      }),
      session("b", {
        needsAttention: true,
        attention: { revision: "rev-b" },
        latestMessageText: "x".repeat(200),
      }),
      session("c", { needsAttention: false }),
    ], new Map(), now);

    expect(summary.attentionEntries).toEqual([
      {
        sessionId: "a",
        itemKeys: ["AND-7"],
        productId: "p2",
        kind: "answer",
        reason: "AI 提出了需要回答的问题。",
        excerpt: "汇总接口放在哪里？ 需要你定一下。",
        revision: "rev-a",
      },
      {
        sessionId: "b",
        itemKeys: [],
        productId: "p1",
        kind: "uncertain",
        excerpt: `${"x".repeat(140)}…`,
        revision: "rev-b",
      },
    ]);
    expect(summary.attentionEntries).toHaveLength(summary.agent.attention);
  });

  it("names a conversation only when it is the single one that needs the person", () => {
    const summary = widgetSummary([
      session("a", { needsAttention: true }),
      session("b", { needsAttention: true }),
    ], new Map(), now);

    expect(summary.agent.attention).toBe(2);
    expect(summary.agent).not.toHaveProperty("attentionSessionId");
  });

  it("sends a tap to the busiest product, counting each conversation once per product", () => {
    const summary = widgetSummary([
      // Three items in p1 are still one conversation there.
      session("a", { needsAttention: true, items: [{ productId: "p1" }, { productId: "p1" }, { productId: "p1" }] }),
      session("b", { needsAttention: true, items: [{ productId: "p2" }] }),
      session("c", { needsAttention: true, items: [{ productId: "p2" }, { productId: "p1" }] }),
    ], new Map([["p1", 2], ["p2", 5], ["p3", 0]]), now);

    // p1 and p2 each have two; the tie goes to the product seen first.
    expect(summary.agent.attentionProductId).toBe("p1");
    expect(summary.items).toEqual({ ready: 7, readyProductId: "p2" });
  });

  it("has nowhere to send a tap when there is nothing to open", () => {
    const summary = widgetSummary([session("a")], new Map([["p1", 0]]), now);

    expect(summary.agent.attentionProductId).toBeNull();
    expect(summary.items.readyProductId).toBeNull();
  });
});
