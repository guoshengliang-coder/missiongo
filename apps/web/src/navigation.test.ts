import { describe, expect, it } from "vitest";

import { itemDetailUrl, itemKeyFromUrl, itemListUrl } from "./navigation";

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
