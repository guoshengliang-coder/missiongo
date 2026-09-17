import type { WorkItemListPage } from "./api";

export type ListSummary = WorkItemListPage["summary"];

/** One cached `["items", productId, status, type, search]` entry, as the query cache reports it. */
export interface CachedListQuery {
  readonly queryKey: readonly unknown[];
  readonly data: unknown;
  readonly dataUpdatedAt: number;
}

/**
 * The counts to show while the list for a newly picked status is still loading
 * (AND-62).
 *
 * The status filter is part of the list's query key, so switching tabs lands on
 * a cache entry that may have no data yet -- and counting an empty page drew
 * every badge as 0 until the response came back. The server's summary never
 * looks at the status filter, so any other status's page for the same product,
 * type and search carries exactly the numbers we need. The newest one wins, so
 * a count the person just changed is not replaced by an older one.
 *
 * Nothing cached under those filters answers undefined: the caller shows a
 * placeholder rather than a number it does not have.
 */
export function cachedListSummary(
  queries: readonly CachedListQuery[],
  filters: { readonly productId: string; readonly type: string; readonly search: string },
): ListSummary | undefined {
  let newest: { summary: ListSummary; updatedAt: number } | undefined;
  for (const query of queries) {
    const [root, productId, , type, search] = query.queryKey;
    if (root !== "items" || productId !== filters.productId || type !== filters.type || search !== filters.search) continue;
    const summary = (query.data as { pages?: ReadonlyArray<{ summary?: ListSummary }> } | undefined)?.pages?.[0]?.summary;
    if (!summary) continue;
    if (!newest || query.dataUpdatedAt > newest.updatedAt) newest = { summary, updatedAt: query.dataUpdatedAt };
  }
  return newest?.summary;
}
