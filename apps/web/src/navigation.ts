export const ITEM_HISTORY_MARKER = "missiongo:item-detail";

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
