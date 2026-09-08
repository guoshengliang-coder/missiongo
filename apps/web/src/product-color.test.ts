import { describe, expect, it } from "vitest";

import { PRODUCT_BADGE_COLORS, productBadgeColor } from "./product-color";

/** The two products this workspace actually holds, which is where the bug showed. */
const HERMES_GO = "afde17c0-2829-41e9-be45-0fb03816b99c";
const MISSION_GO = "ba7d2621-ff9c-47ae-b211-78ca258026f7";

/** Contrast against white, the colour the badge draws its prefix in. */
function contrastWithWhite(hex: string): number {
  const channel = (offset: number) => {
    const value = parseInt(hex.slice(1 + offset, 3 + offset), 16) / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };
  const luminance = 0.2126 * channel(0) + 0.7152 * channel(2) + 0.0722 * channel(4);
  return 1.05 / (luminance + 0.05);
}

describe("product badge colour", () => {
  it("gives each branded product its own brand colour", () => {
    expect(productBadgeColor(HERMES_GO)).toBe("#0b5fd0");
    expect(productBadgeColor(MISSION_GO)).toBe("#16765b");
  });

  it("keeps white readable on every colour a badge can take", () => {
    const everyColour = [...PRODUCT_BADGE_COLORS, productBadgeColor(HERMES_GO), productBadgeColor(MISSION_GO)];
    for (const colour of everyColour) {
      // 4.5:1 is the AA floor. #67E3B4, the MissionGo icon mint, sits at 1.59
      // and is why the badge uses --mint-dark instead.
      expect(contrastWithWhite(colour)).toBeGreaterThanOrEqual(4.5);
    }
    expect(contrastWithWhite("#67e3b4")).toBeLessThan(4.5);
  });

  it("falls back to the palette for a product with no brand of its own", () => {
    for (const id of ["", "x", "0".repeat(80), "9f1c0000-0000-4000-8000-000000000001"]) {
      expect(PRODUCT_BADGE_COLORS).toContain(productBadgeColor(id));
    }
  });

  it("stays the same for one id, so a product does not recolour when another is added", () => {
    expect(productBadgeColor(HERMES_GO)).toBe(productBadgeColor(HERMES_GO));
    expect(productBadgeColor("some-other-product")).toBe(productBadgeColor("some-other-product"));
  });

  it("spreads unbranded ids across most of the palette", () => {
    const ids = Array.from({ length: 60 }, (_, index) => `product-${index}-${index * 7}`);
    const used = new Set(ids.map(productBadgeColor));
    expect(used.size).toBeGreaterThanOrEqual(PRODUCT_BADGE_COLORS.length - 1);
  });
});
