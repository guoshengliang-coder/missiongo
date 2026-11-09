import { describe, expect, it } from "vitest";

import { productCount } from "./message-counts";

describe("inbox per-project counts (AND-493)", () => {
  const rows = [{ productId: "a", count: 3 }, { productId: "b", count: 1 }];

  it("reads the count registered for a product", () => {
    expect(productCount(rows, "a")).toBe(3);
    expect(productCount(rows, "b")).toBe(1);
  });

  it("treats an unlisted product as zero, so no number is drawn", () => {
    expect(productCount(rows, "c")).toBe(0);
    expect(productCount(undefined, "a")).toBe(0);
  });
});
