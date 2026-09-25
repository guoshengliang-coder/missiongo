import { describe, expect, it } from "vitest";

import { compactItemKeys, sessionTitle } from "./agent-session-title";

const session = (items: readonly { key: string; title?: string }[], sessionName?: string) => ({
  id: "session-1",
  ...(sessionName ? { sessionName } : {}),
  items: items.map((item) => ({ key: item.key, title: item.title ?? "条目标题", productId: "product-1" })),
});

describe("how a dispatch session's title writes out its item keys", () => {
  it("writes the product prefix once and keeps only the numbers after it", () => {
    expect(compactItemKeys(["AND-169", "AND-168", "AND-167", "AND-166"])).toBe("AND-169、168、167、166");
  });

  it("spells the prefix out again when the dispatch spans products", () => {
    expect(compactItemKeys(["AND-169", "IOS-3", "AND-170"])).toBe("AND-169、IOS-3、AND-170");
  });

  it("keeps a single key, a non-keyed key, and an empty list as they are", () => {
    expect(compactItemKeys(["AND-169"])).toBe("AND-169");
    expect(compactItemKeys(["AND-169", "adhoc", "AND-170"])).toBe("AND-169、adhoc、170");
    expect(compactItemKeys([])).toBe("");
  });

  it("shows the compact keys followed by the first item's title", () => {
    expect(sessionTitle(session([{ key: "AND-169" }, { key: "AND-168", title: "另一条" }]))).toBe(
      "AND-169、168 · 条目标题",
    );
  });

  it("falls back to the session name, then the id, when the session has no items", () => {
    expect(sessionTitle(session([], "派单会话"))).toBe("派单会话");
    expect(sessionTitle(session([]))).toBe("session-1");
  });
});
