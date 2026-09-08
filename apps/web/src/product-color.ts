/**
 * Colours for the generated product badge.
 *
 * The first version derived a hue from the product id with `(total * 31 + code)
 * % 360`. Hashing straight into the hue circle looks even but is not: the first
 * two real products landed on 31 and 26 degrees -- both the same brown, five
 * degrees apart, which nobody can tell apart at 22 pixels. A badge that cannot
 * be told from the next one has no reason to be coloured at all.
 *
 * So the colour comes from a fixed set instead. Ten hues spread around the
 * circle, all at one saturation and lightness so they read as a family and all
 * carry white text at the same contrast.
 */
export const PRODUCT_BADGE_COLORS = [
  "#2c6fce", // blue
  "#0d8a86", // teal
  "#3d8b3f", // green
  "#9a7714", // amber
  "#c1611c", // orange
  "#c03a2f", // red
  "#bd2e6d", // magenta
  "#7b47c0", // violet
  "#4a51b5", // indigo
  "#556270", // slate
] as const;

/**
 * Stable per product: the same id always gets the same colour, so a product
 * does not change appearance when another one is added or removed. Hashing into
 * a small set can still collide once there are more products than colours --
 * ten is deliberately more than this workspace is expected to hold.
 */
export function productBadgeColor(productId: string): string {
  const hash = [...productId].reduce((total, character) => (total * 31 + character.charCodeAt(0)) % 1_000_003, 7);
  return PRODUCT_BADGE_COLORS[hash % PRODUCT_BADGE_COLORS.length]!;
}
