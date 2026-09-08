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
 * circle, each darkened until white text on it clears 5.4:1 -- comfortably past
 * the 4.5:1 AA floor and close enough to each other that the badges read as one
 * family. Picking hues at a single lightness instead is what a palette wants to
 * do and is wrong here: at equal lightness a yellow-green and a blue are miles
 * apart on contrast, and four of the first ten sat below AA until the test
 * below measured them.
 */
export const PRODUCT_BADGE_COLORS = [
  "#2968c2", // blue
  "#0b7673", // teal
  "#347836", // green
  "#836511", // amber
  "#a65318", // orange
  "#c03a2f", // red
  "#bd2e6d", // magenta
  "#7b47c0", // violet
  "#4a51b5", // indigo
  "#556270", // slate
] as const;

/**
 * Products that have a brand of their own use it, rather than whatever the hash
 * happens to land on. Both values are the light-mode primary from that product's
 * own design file, picked so the badge's white text still clears AA:
 *
 * - Hermes GO #0B5FD0, from its DESIGN.md section 2.1 -- the deep blue facet of
 *   its launcher icon (#005EE3) held at the same hue and pushed one step darker
 *   so white reaches 5.90:1.
 * - MissionGo #16765B, the --mint-dark token in styles.css, at 5.56:1. Not the
 *   icon's #67E3B4: that mint is a background for dark ink and carries white at
 *   1.59:1, which is unreadable. The badge draws its prefix in white, so the
 *   readable green is the one that belongs here.
 *
 * Ids rather than key prefixes, because a prefix can be edited and an id cannot.
 * A product missing from this table -- any new one -- falls through to the
 * palette above and still gets a colour nobody had to choose.
 */
const BRAND_BADGE_COLORS: Readonly<Record<string, string>> = {
  "afde17c0-2829-41e9-be45-0fb03816b99c": "#0b5fd0", // Hermes GO
  "ba7d2621-ff9c-47ae-b211-78ca258026f7": "#16765b", // MissionGo
};

/**
 * Stable per product: the same id always gets the same colour, so a product
 * does not change appearance when another one is added or removed. Hashing into
 * a small set can still collide once there are more products than colours --
 * ten is deliberately more than this workspace is expected to hold.
 */
export function productBadgeColor(productId: string): string {
  const brand = BRAND_BADGE_COLORS[productId];
  if (brand) return brand;
  const hash = [...productId].reduce((total, character) => (total * 31 + character.charCodeAt(0)) % 1_000_003, 7);
  return PRODUCT_BADGE_COLORS[hash % PRODUCT_BADGE_COLORS.length]!;
}
