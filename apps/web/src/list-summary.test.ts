import { describe, expect, it } from "vitest";

import { cachedListSummary, type CachedListQuery, type ListSummary } from "./list-summary";

const summary = (ready: number): ListSummary => ({
  total: ready + 2,
  productTotal: ready + 5,
  byStatus: { inbox: 1, ready, in_progress: 1, development_complete: 0, on_hold: 0, pending_verification: 0, done: 0, cancelled: 0 },
});

const page = (value: ListSummary | undefined) => (value ? { pages: [{ items: [], summary: value }], pageParams: [null] } : undefined);

const entry = (key: readonly unknown[], value: ListSummary | undefined, dataUpdatedAt: number): CachedListQuery => ({
  queryKey: key,
  data: page(value),
  dataUpdatedAt,
});

const filters = { productId: "p1", type: "all", search: "" };

describe("cachedListSummary", () => {
  it("borrows the counts from another status under the same filters", () => {
    const queries = [entry(["items", "p1", "ready", "all", ""], summary(6), 10)];
    expect(cachedListSummary(queries, filters)).toEqual(summary(6));
  });

  it("prefers the newest entry, so a count just changed is not undone", () => {
    const queries = [
      entry(["items", "p1", "ready", "all", ""], summary(6), 10),
      entry(["items", "p1", "done", "all", ""], summary(5), 20),
      entry(["items", "p1", "inbox", "all", ""], summary(4), 15),
    ];
    expect(cachedListSummary(queries, filters)?.byStatus.ready).toBe(5);
  });

  it("ignores other products, types and searches, whose counts differ", () => {
    const queries = [
      entry(["items", "p2", "ready", "all", ""], summary(1), 30),
      entry(["items", "p1", "ready", "bug", ""], summary(2), 30),
      entry(["items", "p1", "ready", "all", "crash"], summary(3), 30),
      entry(["products"], summary(9), 30),
    ];
    expect(cachedListSummary(queries, filters)).toBeUndefined();
  });

  it("skips entries that have not loaded yet", () => {
    const queries = [
      entry(["items", "p1", "done", "all", ""], undefined, 40),
      entry(["items", "p1", "ready", "all", ""], summary(6), 10),
    ];
    expect(cachedListSummary(queries, filters)).toEqual(summary(6));
  });
});
