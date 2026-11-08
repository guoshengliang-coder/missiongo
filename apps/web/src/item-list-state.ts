import type { WorkItemListPage } from "./api";
import type { WorkItemStatus } from "./types";

/** Compare only the first page's own summary, never a cached count from another scope. */
export function inconsistentItemPage(page: WorkItemListPage | undefined, status: WorkItemStatus | "all"): boolean {
  if (!page || page.items.length || !page.summary) return false;
  const expected = status === "all" ? page.summary.total - page.summary.byStatus.cancelled : page.summary.byStatus[status];
  return expected > 0;
}
