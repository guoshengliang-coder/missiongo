import { ITEM_STATUSES, ITEM_TYPES, type WorkItemStatus, type WorkItemType } from "./types";

export const ITEM_HISTORY_MARKER = "missiongo:item-detail";

export interface ListFilters {
  readonly productId: string;
  readonly status: WorkItemStatus | "all";
  readonly type: WorkItemType | "all";
  readonly search: string;
}

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

export function itemListUrl(url: URL = new URL(window.location.href)): string {
  const next = new URL(url);
  next.searchParams.delete("item");
  return `${next.pathname}${next.search}${next.hash}`;
}

/**
 * Filters live in the URL so a view can be refreshed, bookmarked and pasted to
 * someone else. Anything unrecognised falls back to the unfiltered value rather
 * than throwing, because these values come from whatever the address bar holds.
 */
export function filtersFromUrl(url: URL = new URL(window.location.href)): ListFilters {
  const status = url.searchParams.get("status");
  const type = url.searchParams.get("type");
  return {
    productId: url.searchParams.get("product")?.trim() ?? "",
    status: status && (ITEM_STATUSES as readonly string[]).includes(status) ? (status as WorkItemStatus) : "all",
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
  set("status", filters.status === "all" ? "" : filters.status);
  set("type", filters.type === "all" ? "" : filters.type);
  set("q", filters.search.trim());
  return `${next.pathname}${next.search}${next.hash}`;
}

/** How many filters are narrowing the list, ignoring the product selector. */
export function activeFilterCount(filters: ListFilters): number {
  return [filters.status !== "all", filters.type !== "all", Boolean(filters.search.trim())].filter(Boolean).length;
}
