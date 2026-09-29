/**
 * The console's type size (AND-247), and the Agent console chat body's own size
 * (AND-254).
 *
 * Three named steps over one multiplier, stored on the account so the same
 * reader gets the same size on every device. This module owns the browser half:
 * what the choice means to the DOM and how it survives the first paint. The
 * server owns the durable copy.
 *
 * The console-wide multiplier is applied in styles.css, not here: the root
 * element carries `data-font-scale` and the stylesheet rescales the `--text-*`
 * tokens. Medium is the base scale, so it needs no attribute and today's
 * rendering is unchanged.
 *
 * The chat body's size is the same three steps in a second setting with its own
 * attribute and its own cache. It is independent rather than a modifier of the
 * first: the stylesheet rescales the type tokens only inside the chat body, so
 * neither choice moves the other.
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

/**
 * The Agent console chat body's own size (AND-254).
 *
 * The same three named steps as the console-wide setting, but a second value:
 * its own root attribute and its own cached copy, so the two choices cannot
 * overwrite each other and one browser can hold different sizes for the
 * transcript and for the rest of the console.
 */
export const CONSOLE_FONT_SCALE_STORAGE_KEY = "missiongo.consoleFontScale";

/** Put the chat body's size on the root element, where styles.css selects on it. */
export function applyConsoleFontScale(scale: FontScale): void {
  document.documentElement.dataset.consoleFontScale = scale;
}

export function readStoredConsoleFontScale(): FontScale {
  try {
    return parseFontScale(localStorage.getItem(CONSOLE_FONT_SCALE_STORAGE_KEY));
  } catch {
    // A blocked store is not a reason to lose the setting; bootstrap reapplies it.
    return DEFAULT_FONT_SCALE;
  }
}

export function storeConsoleFontScale(scale: FontScale): void {
  try {
    localStorage.setItem(CONSOLE_FONT_SCALE_STORAGE_KEY, scale);
  } catch {
    // Same as the console-wide size: storage is the cache, not the setting.
  }
}
