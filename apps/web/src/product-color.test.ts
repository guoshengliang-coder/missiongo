import { describe, expect, it } from "vitest";

import { PRODUCT_BADGE_COLORS, productBadgeColor } from "./product-color";

/** The two products this workspace actually holds, which is where the bug showed. */
const HERMES_GO = "afde17c0-2829-41e9-be45-0fb03816b99c";
const MISSION_GO = "ba7d2621-ff9c-47ae-b211-78ca258026f7";

describe("product badge colour", () => {
  it("gives the two existing products colours that can be told apart", () => {
    expect(productBadgeColor(HERMES_GO)).not.toBe(productBadgeColor(MISSION_GO));
  });

  it("always returns a colour from the palette", () => {
    for (const id of [HERMES_GO, MISSION_GO, "", "x", "0".repeat(80)]) {
      expect(PRODUCT_BADGE_COLORS).toContain(productBadgeColor(id));
    }
  });

  it("stays the same for one id, so a product does not recolour when another is added", () => {
    expect(productBadgeColor(HERMES_GO)).toBe(productBadgeColor(HERMES_GO));
  });

  it("spreads a batch of ids across most of the palette", () => {
    const ids = Array.from({ length: 60 }, (_, index) => `product-${index}-${index * 7}`);
    const used = new Set(ids.map(productBadgeColor));
    expect(used.size).toBeGreaterThanOrEqual(PRODUCT_BADGE_COLORS.length - 1);
  });
});
