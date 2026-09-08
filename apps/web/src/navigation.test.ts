import { describe, expect, it } from "vitest";

import {
  filtersFromUrl,
  filtersToUrl,
  itemDetailUrl,
  itemHistoryOp,
  itemKeyFromUrl,
  itemListUrl,
} from "./navigation";

describe("item navigation", () => {
  it("creates shareable detail URLs without dropping other query parameters", () => {
    const url = new URL("https://example.test/workspace?view=compact#top");
    expect(itemDetailUrl("MG-42", url)).toBe("/workspace?view=compact&item=MG-42#top");
  });

  it("reads and removes the item query parameter", () => {
    const url = new URL("https://example.test/?item=MG-42&view=compact");
    expect(itemKeyFromUrl(url)).toBe("MG-42");
    expect(itemListUrl(url)).toBe("/?view=compact");
  });
});

describe("history depth when clicking through the list", () => {
  /**
   * Models what the browser stack does as openItemPage runs, so the regression
   * is caught here rather than by clicking five items in a real browser.
   */
  function walk(itemKeys: readonly string[]): readonly string[] {
    const stack = ["/?product=p1"];
    let selected: string | null = null;
    for (const itemKey of itemKeys) {
      if (selected === itemKey) continue;
      const url = itemDetailUrl(itemKey, new URL(`https://example.test${stack.at(-1)!}`));
      if (itemHistoryOp(selected) === "push") stack.push(url);
      else stack[stack.length - 1] = url;
      selected = itemKey;
    }
    return stack;
  }

  it("keeps one detail entry however many items are opened", () => {
    expect(walk(["MG-1"])).toEqual(["/?product=p1", "/?product=p1&item=MG-1"]);
    expect(walk(["MG-1", "MG-2", "MG-3", "MG-4", "MG-5"]))
      .toEqual(["/?product=p1", "/?product=p1&item=MG-5"]);
  });

  it("lands back on the list after a single step back", () => {
    const stack = [...walk(["MG-1", "MG-2", "MG-3", "MG-4", "MG-5"])];
    stack.pop();
    expect(itemKeyFromUrl(new URL(`https://example.test${stack.at(-1)!}`))).toBeNull();
  });
});

describe("list filters in the URL", () => {
  it("round-trips a filtered view", () => {
    const url = new URL("https://example.test/?product=p1&status=in_progress&type=bug&q=%E7%AD%BE%E6%94%B6");
    const filters = filtersFromUrl(url);
    expect(filters).toEqual({ productId: "p1", status: "in_progress", type: "bug", search: "签收" });
    expect(filtersToUrl(filters, url)).toBe("/?product=p1&status=in_progress&type=bug&q=%E7%AD%BE%E6%94%B6");
  });

  it("opens on the work that is waiting when the URL says nothing", () => {
    const url = new URL("https://example.test/?product=p1");
    expect(filtersFromUrl(url)).toEqual({ productId: "p1", status: "ready", type: "all", search: "" });
  });

  it("drops the status only when it is already the default", () => {
    const url = new URL("https://example.test/?product=p1&status=done&type=bug&q=csv");
    const back = { productId: "p1", status: "ready", type: "all", search: "" } as const;
    expect(filtersToUrl(back, url)).toBe("/?product=p1");
  });

  it("keeps a link to the whole list pointing at the whole list", () => {
    const url = new URL("https://example.test/?product=p1&type=bug&q=csv");
    const everything = { productId: "p1", status: "all", type: "all", search: "" } as const;
    const link = filtersToUrl(everything, url);
    expect(link).toBe("/?product=p1&status=all");
    expect(filtersFromUrl(new URL(link, url))).toEqual(everything);
  });

  it("keeps the open item and any unrelated parameters", () => {
    const url = new URL("https://example.test/?item=MG-42&view=compact");
    expect(filtersToUrl({ productId: "p1", status: "done", type: "all", search: "" }, url))
      .toBe("/?item=MG-42&view=compact&product=p1&status=done");
  });

  it("falls back to the default view for values the app does not recognise", () => {
    const url = new URL("https://example.test/?status=archived&type=epic&q=%20%20");
    expect(filtersFromUrl(url)).toEqual({ productId: "", status: "ready", type: "all", search: "" });
  });
});
