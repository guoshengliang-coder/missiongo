import { describe, expect, it } from "vitest";

import {
  activeFilterCount,
  filtersFromUrl,
  filtersToUrl,
  itemDetailUrl,
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

describe("list filters in the URL", () => {
  it("round-trips a filtered view", () => {
    const url = new URL("https://example.test/?product=p1&status=in_progress&type=bug&q=%E7%AD%BE%E6%94%B6");
    const filters = filtersFromUrl(url);
    expect(filters).toEqual({ productId: "p1", status: "in_progress", type: "bug", search: "签收" });
    expect(filtersToUrl(filters, url)).toBe("/?product=p1&status=in_progress&type=bug&q=%E7%AD%BE%E6%94%B6");
  });

  it("drops filters that are back at their unfiltered value", () => {
    const url = new URL("https://example.test/?product=p1&status=ready&type=bug&q=csv");
    const cleared = { productId: "p1", status: "all", type: "all", search: "" } as const;
    expect(filtersToUrl(cleared, url)).toBe("/?product=p1");
  });

  it("keeps the open item and any unrelated parameters", () => {
    const url = new URL("https://example.test/?item=MG-42&view=compact");
    expect(filtersToUrl({ productId: "p1", status: "ready", type: "all", search: "" }, url))
      .toBe("/?item=MG-42&view=compact&product=p1&status=ready");
  });

  it("falls back to unfiltered for values the app does not recognise", () => {
    const url = new URL("https://example.test/?status=archived&type=epic&q=%20%20");
    expect(filtersFromUrl(url)).toEqual({ productId: "", status: "all", type: "all", search: "" });
  });

  it("counts only the filters that narrow the list", () => {
    expect(activeFilterCount({ productId: "p1", status: "all", type: "all", search: "" })).toBe(0);
    expect(activeFilterCount({ productId: "p1", status: "ready", type: "bug", search: " csv " })).toBe(3);
    expect(activeFilterCount({ productId: "p1", status: "all", type: "all", search: "   " })).toBe(0);
  });
});
