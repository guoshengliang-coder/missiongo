import type { AgentSessionFilter } from "./agent-session-view";
import { ITEM_STATUSES, ITEM_TYPES, type WorkItemStatus, type WorkItemType } from "./types";

export const ITEM_HISTORY_MARKER = "missiongo:item-detail";

/**
 * Marks the history entry an overlay adds while it is open.
 *
 * The capture sheet used to be React state alone, so it left no history entry
 * at all. Inside the Android shell that is the difference between closing the
 * sheet and closing the app: the shell's back callback asks the WebView whether
 * it canGoBack(), and with nothing pushed the answer is no. The same press on
 * mobile web left the site. See AND-28.
 */
export const OVERLAY_HISTORY_MARKER = "missiongo:overlay";

/**
 * The navigation drawer's entry. Separate from the capture sheet's, because the
 * two can be open at once and popstate has to know which one this entry closed.
 */
export const SIDEBAR_HISTORY_MARKER = "missiongo:sidebar";

/** The full-screen Agent console is one level above item management. */
export const AGENT_CONSOLE_HISTORY_MARKER = "missiongo:agent-console";

/**
 * A conversation is a separate level only where the console is a one-pane
 * mobile layout. Wider layouts already keep the conversation list visible.
 */
export const AGENT_CONVERSATION_HISTORY_MARKER = "missiongo:agent-conversation";

/** Records the layout that produced the current console entry across a WebView recreation. */
export const AGENT_CONSOLE_LAYOUT_KEY = "missiongo:agent-console-layout";

export type AgentConsoleLayout = "single" | "wide";

/**
 * How many of its own history entries the app can still unwind from this state.
 *
 * Both markers accumulate: opening the capture sheet over an item detail pushes
 * a state carrying the detail's marker as well, so the count is how deep the app
 * is rather than which screen is on top. The Android shell reads this to decide
 * between popping a level and leaving. See AND-28.
 */
export function backDepthFromState(state: unknown): number {
  if (typeof state !== "object" || state === null) return 0;
  const markers = state as Record<string, unknown>;
  return (markers[ITEM_HISTORY_MARKER] ? 1 : 0)
    + (markers[OVERLAY_HISTORY_MARKER] ? 1 : 0)
    + (markers[SIDEBAR_HISTORY_MARKER] ? 1 : 0)
    + (markers[AGENT_CONSOLE_HISTORY_MARKER] ? 1 : 0)
    + (markers[AGENT_CONVERSATION_HISTORY_MARKER] ? 1 : 0);
}

export function agentConsoleIsOpen(url: URL = new URL(window.location.href)): boolean {
  return url.searchParams.get("console") === "agent";
}

export function agentSessionIdFromUrl(url: URL = new URL(window.location.href)): string | null {
  if (!agentConsoleIsOpen(url)) return null;
  const value = url.searchParams.get("session")?.trim();
  return value || null;
}

/**
 * Console state lives in the URL so Android WebView restoration can rebuild the
 * same screen after an Activity recreation. Filters and other unrelated query
 * parameters are deliberately preserved.
 */
export function agentConsoleUrl(
  sessionId: string | null,
  url: URL = new URL(window.location.href),
): string {
  const next = new URL(url);
  next.searchParams.set("console", "agent");
  if (sessionId) next.searchParams.set("session", sessionId);
  else next.searchParams.delete("session");
  return `${next.pathname}${next.search}${next.hash}`;
}

const AGENT_CONSOLE_FILTERS: readonly AgentSessionFilter[] = ["attention", "active", "all", "failed", "archived"];

/**
 * A link can open the console on one of its filters: the Android widget opens
 * it on "needs attention" (AND-149). It is read once, when the page loads; the
 * exit URL drops it, so the entries the console pushes afterwards do not carry
 * it and a later restore follows whatever filter the person moved to.
 */
export function agentConsoleFilterFromUrl(url: URL = new URL(window.location.href)): AgentSessionFilter | null {
  if (!agentConsoleIsOpen(url)) return null;
  const value = url.searchParams.get("consoleFilter");
  return AGENT_CONSOLE_FILTERS.find((filter) => filter === value) ?? null;
}

export function agentConsoleExitUrl(url: URL = new URL(window.location.href)): string {
  const next = new URL(url);
  next.searchParams.delete("console");
  next.searchParams.delete("session");
  next.searchParams.delete("consoleFilter");
  return `${next.pathname}${next.search}${next.hash}`;
}

export function agentConsoleLayoutFromState(state: unknown): AgentConsoleLayout | null {
  if (typeof state !== "object" || state === null) return null;
  const value = (state as Record<string, unknown>)[AGENT_CONSOLE_LAYOUT_KEY];
  return value === "single" || value === "wide" ? value : null;
}

export interface ListFilters {
  readonly productId: string;
  readonly status: WorkItemStatus | "all";
  readonly type: WorkItemType | "all";
  readonly search: string;
}

/**
 * The list opens on the work that is waiting rather than on everything, because
 * the full list is mostly noise. That makes "all" a deliberate choice rather
 * than the absence of one, so it has to be written into the URL: a link without
 * a status is the default view, not the unfiltered one.
 */
export const DEFAULT_STATUS: WorkItemStatus = "ready";

export const EMPTY_FILTERS: ListFilters = { productId: "", status: "all", type: "all", search: "" };

export function itemKeyFromUrl(url: URL = new URL(window.location.href)): string | null {
  const value = url.searchParams.get("item")?.trim();
  return value || null;
}

export function itemDetailUrl(itemKey: string, url: URL = new URL(window.location.href)): string {
  const next = new URL(url);
  next.searchParams.set("item", itemKey);
  return `${next.pathname}${next.search}${next.hash}`;
}

/**
 * Which history operation should be used to open an item detail.
 *
 * Pushing on every open is what made "back" walk through every item that had
 * been looked at instead of returning to the list: five items looked at meant
 * five entries to unwind. Only leaving the list is a navigation worth
 * remembering; swapping one detail for another replaces the entry, so there is
 * never more than one detail on the stack and a single back returns to the list.
 */
export function itemHistoryOp(selectedItemKey: string | null): "push" | "replace" {
  return selectedItemKey === null ? "push" : "replace";
}

export function itemListUrl(url: URL = new URL(window.location.href)): string {
  const next = new URL(url);
  next.searchParams.delete("item");
  return `${next.pathname}${next.search}${next.hash}`;
}

/**
 * Filters live in the URL so a view can be refreshed, bookmarked and pasted to
 * someone else. Anything unrecognised falls back to the default rather than
 * throwing, because these values come from whatever the address bar holds.
 */
export function filtersFromUrl(url: URL = new URL(window.location.href)): ListFilters {
  const status = url.searchParams.get("status");
  const type = url.searchParams.get("type");
  return {
    productId: url.searchParams.get("product")?.trim() ?? "",
    status: status === "all" || (status && (ITEM_STATUSES as readonly string[]).includes(status))
      ? (status as WorkItemStatus | "all")
      : DEFAULT_STATUS,
    type: type && (ITEM_TYPES as readonly string[]).includes(type) ? (type as WorkItemType) : "all",
    search: url.searchParams.get("q")?.trim() ?? "",
  };
}

export function filtersToUrl(filters: ListFilters, url: URL = new URL(window.location.href)): string {
  const next = new URL(url);
  const set = (name: string, value: string) => {
    if (value) next.searchParams.set(name, value);
    else next.searchParams.delete(name);
  };
  set("product", filters.productId);
  set("status", filters.status === DEFAULT_STATUS ? "" : filters.status);
  set("type", filters.type === "all" ? "" : filters.type);
  set("q", filters.search.trim());
  return `${next.pathname}${next.search}${next.hash}`;
}
