import { describe, expect, it } from "vitest";

import { DEFAULT_LIST_PANE_WIDTH, MIN_LIST_PANE_WIDTH, clampListPaneWidth } from "./pane-layout";

describe("list pane width", () => {
  it("keeps a dragged width inside the readable range", () => {
    expect(clampListPaneWidth(420, 1200)).toBe(420);
    expect(clampListPaneWidth(10, 1200)).toBe(MIN_LIST_PANE_WIDTH);
    expect(clampListPaneWidth(1100, 1200)).toBe(720);
  });

  it("leaves the detail room when a wide-screen width reopens on a small one", () => {
    const dragged = clampListPaneWidth(900, 1800);
    expect(dragged).toBe(900);
    expect(clampListPaneWidth(dragged, 900)).toBe(540);
  });

  it("never returns a width the detail cannot survive, even on a tiny container", () => {
    expect(clampListPaneWidth(500, 200)).toBe(MIN_LIST_PANE_WIDTH);
  });

  it("falls back rather than propagating a junk stored value", () => {
    expect(clampListPaneWidth(Number.NaN, 1200)).toBe(DEFAULT_LIST_PANE_WIDTH);
  });
});
