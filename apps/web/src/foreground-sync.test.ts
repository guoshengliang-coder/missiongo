import { describe, expect, it } from "vitest";

import { FOREGROUND_SYNC_STALE_MS, foregroundSyncTargets } from "./foreground-sync";

const now = Date.UTC(2026, 8, 25, 5, 0, 0);

describe("foreground sync target selection (AND-192)", () => {
  it("picks the active queries whose data is stale", () => {
    expect(foregroundSyncTargets([
      { queryKey: ["items"], active: true, updatedAt: now - FOREGROUND_SYNC_STALE_MS },
      { queryKey: ["item", "AND-1"], active: true, updatedAt: now - FOREGROUND_SYNC_STALE_MS - 1 },
      { queryKey: ["products"], active: true, updatedAt: now - 1_000 },
      { queryKey: ["agent-sessions"], active: false, updatedAt: now - 10 * FOREGROUND_SYNC_STALE_MS },
      { queryKey: ["components"], active: true, updatedAt: 0 },
    ], now)).toEqual([["items"], ["item", "AND-1"]]);
  });

  it("leaves data inside the threshold alone", () => {
    expect(foregroundSyncTargets(
      [{ queryKey: ["a"], active: true, updatedAt: now - FOREGROUND_SYNC_STALE_MS + 1 }],
      now,
    )).toEqual([]);
  });

  it("keeps every stale active query, not just the first", () => {
    const entries = ["a", "b", "c"].map((key) => ({
      queryKey: [key],
      active: true,
      updatedAt: now - FOREGROUND_SYNC_STALE_MS * 2,
    }));
    expect(foregroundSyncTargets(entries, now)).toEqual([["a"], ["b"], ["c"]]);
  });
});