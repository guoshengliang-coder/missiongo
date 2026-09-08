export const LIST_PANE_WIDTH_KEY = "missiongo.listPaneWidth";

/** Roughly the old fixed track, so nobody's first look at the app changes. */
export const DEFAULT_LIST_PANE_WIDTH = 340;

/** Below this the row text stops being readable at all. */
export const MIN_LIST_PANE_WIDTH = 260;

/**
 * Keep the list readable and stop the detail being squeezed out of existence.
 *
 * The upper bound is a share rather than a fixed width because the stored value
 * outlives the window it was dragged in: a pane pulled wide on an external
 * monitor must not swallow the detail when the same browser reopens on a laptop.
 */
export function clampListPaneWidth(width: number, availableWidth: number): number {
  if (!Number.isFinite(width)) return DEFAULT_LIST_PANE_WIDTH;
  const max = Math.max(MIN_LIST_PANE_WIDTH, availableWidth * 0.6);
  return Math.round(Math.min(Math.max(width, MIN_LIST_PANE_WIDTH), max));
}

/** Reads the persisted width, falling back whenever storage is unusable or junk. */
export function readListPaneWidth(): number {
  try {
    const stored = Number(localStorage.getItem(LIST_PANE_WIDTH_KEY));
    return Number.isFinite(stored) && stored > 0 ? stored : DEFAULT_LIST_PANE_WIDTH;
  } catch {
    return DEFAULT_LIST_PANE_WIDTH;
  }
}
