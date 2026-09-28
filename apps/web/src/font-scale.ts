/**
 * The console's type size (AND-247).
 *
 * Three named steps over one multiplier, stored on the account so the same
 * reader gets the same size on every device. This module owns the browser half:
 * what the choice means to the DOM and how it survives the first paint. The
 * server owns the durable copy.
 *
 * The multiplier is applied in styles.css, not here: the root element carries
 * `data-font-scale` and the stylesheet rescales the `--text-*` tokens. Medium is
 * the base scale, so it needs no attribute and today's rendering is unchanged.
 */

export const FONT_SCALES = ["small", "medium", "large"] as const;
export type FontScale = (typeof FONT_SCALES)[number];

export const DEFAULT_FONT_SCALE: FontScale = "medium";

/**
 * Where the last choice is kept for the next load. The server value is what
 * counts; this is only a cache, so the size is right before bootstrap returns
 * rather than flipping a moment later.
 */
export const FONT_SCALE_STORAGE_KEY = "missiongo.fontScale";

export function isFontScale(value: unknown): value is FontScale {
  return typeof value === "string" && (FONT_SCALES as readonly string[]).includes(value);
}

/** A stored or reported value, with anything unrecognised read as the default. */
export function parseFontScale(value: string | null | undefined): FontScale {
  return isFontScale(value) ? value : DEFAULT_FONT_SCALE;
}

/** Put the size on the root element, where styles.css selects on it. */
export function applyFontScale(scale: FontScale): void {
  document.documentElement.dataset.fontScale = scale;
}

export function readStoredFontScale(): FontScale {
  try {
    return parseFontScale(localStorage.getItem(FONT_SCALE_STORAGE_KEY));
  } catch {
    // A blocked or unreadable store is not a reason to lose the setting; the
    // server holds the real one and reapplies it once bootstrap answers.
    return DEFAULT_FONT_SCALE;
  }
}

export function storeFontScale(scale: FontScale): void {
  try {
    localStorage.setItem(FONT_SCALE_STORAGE_KEY, scale);
  } catch {
    // Same as reading: storage is the cache, not the setting.
  }
}
