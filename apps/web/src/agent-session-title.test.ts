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

  it("keeps a project conversation's name and leads with the keys linked during it", () => {
    const roundLabel = (round: number) => `第${round}轮`;
    expect(sessionTitle({ ...session([], "这是什么问题？"), productId: "product-1" }, roundLabel)).toBe("这是什么问题？");
    expect(sessionTitle({ ...session([{ key: "AND-169" }], "这是什么问题？"), productId: "product-1", round: 2 }, roundLabel))
      .toBe("AND-169 · 这是什么问题？");
    expect(sessionTitle({ ...session([{ key: "AND-169" }, { key: "IOS-3" }], "这是什么问题？"), productId: "product-1" }))
      .toBe("AND-169、IOS-3 · 这是什么问题？");
  });

  it("keeps the round label off a linked project conversation", () => {
    expect(sessionTitle({ ...session([{ key: "AND-169" }], "这是什么问题？"), productId: "product-1", round: 2 }, (round) => `第${round}轮`))
      .toBe("AND-169 · 这是什么问题？");
  });

  it("names the dispatch round from the second attempt on, when the caller has wording for it", () => {
    const roundLabel = (round: number) => `第${round}轮`;
    const first = { ...session([{ key: "AND-169" }]), round: 1 };
    const second = { ...session([{ key: "AND-169" }]), round: 2 };
    expect(sessionTitle(first, roundLabel)).toBe("AND-169 · 条目标题");
    expect(sessionTitle(second, roundLabel)).toBe("AND-169 · 条目标题 第2轮");
    // Without a label the title is unchanged, and a session MissionGo did not
    // dispatch has no round to show.
    expect(sessionTitle(second)).toBe("AND-169 · 条目标题");
    expect(sessionTitle(session([{ key: "AND-169" }]), roundLabel)).toBe("AND-169 · 条目标题");
  });
});
