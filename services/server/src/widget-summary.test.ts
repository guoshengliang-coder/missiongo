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
    });
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
