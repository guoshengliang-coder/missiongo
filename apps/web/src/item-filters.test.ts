import { describe, expect, it } from "vitest";
import { appendItemFilters, readItemFilters } from "./item-filters";
import { itemFilterKey } from "@missiongo/domain";
import { filtersFromUrl, filtersToUrl } from "./navigation";

describe("combined filters and shared URLs", () => {
  it("round-trips all dimensions without losing a selected detail or status", () => {
    const input = {
      productId: "p1",
      status: "in_progress" as const,
      type: "all" as const,
      search: "search",
      builder: "mine",
      types: ["bug", "requirement"] as const,
      priorities: ["high"] as const,
      proposerKeys: [JSON.stringify(["agent", "client", "name"])],
      sourceComponentIds: ["module"],
      createdFrom: "2026-10-01",
      createdTo: "2026-10-29",
      updatedFrom: "2026-10-02",
      updatedTo: "2026-10-28",
    };
    const url = new URL("https://example.test/?item=TEST-1");
    const serialized = filtersToUrl(input, url);
    expect(serialized).toContain("item=TEST-1");
    expect(filtersFromUrl(new URL(serialized, url))).toEqual(input);
  });
  it("drops invalid calendar days and malformed arrays on a shared URL", () => {
    const params = new URLSearchParams({
      createdFrom: "9999-99-99",
      createdTo: "2026-02-30",
      types: '["unknown","bug"]',
      priorities: "not JSON",
    });
    expect(readItemFilters(params)).toEqual({ types: ["bug"] });
  });
  it("turns an inclusive local day into correct UTC boundaries", () => {
    const params = new URLSearchParams();
    appendItemFilters(
      params,
      { createdFrom: "2026-10-01", createdTo: "2026-10-01" },
      true,
    );
    expect(new Date(params.get("createdFrom")!).getHours()).toBe(0);
    expect(new Date(params.get("createdFrom")!).getDate()).toBe(1);
    expect(new Date(params.get("createdTo")!).getHours()).toBe(0);
    expect(new Date(params.get("createdTo")!).getDate()).toBe(2);
  });
  it("normalizes equivalent multi-select orders for cache and batch selection scopes", () => {
    expect(
      itemFilterKey({
        types: ["bug", "task", "bug"],
        priorities: ["high", "low"],
      }),
    ).toBe(
      itemFilterKey({ priorities: ["low", "high"], types: ["task", "bug"] }),
    );
  });
});
