import type { InfiniteData, Query, QueryClient } from "@tanstack/react-query";

import type { WorkItemListPage } from "./api";
import type { WorkItem } from "./types";

type ItemListData = InfiniteData<WorkItemListPage, number | null>;

// Transition responses omit the display names added by the read endpoints.
function withCreatorName(updated: WorkItem, cached: WorkItem | undefined): WorkItem {
  return cached?.createdBy ? { ...updated, createdBy: cached.createdBy } : updated;
}

/**
 * Publish a successful status write immediately. Refetching an infinite list
 * can take several network round trips; those reads must not keep the write's
 * button pending or hide the result that the server already confirmed.
 */
export async function applyConfirmedItemTransition(client: QueryClient, updated: WorkItem): Promise<void> {
  const detailKey = ["item", updated.key];
  const listKey = ["items", updated.productId];
  // The API accepts lowercase keys in pasted detail links as well.
  const itemQueries = (root: "item" | "timeline") => ({
    predicate: (query: Query) => query.queryKey[0] === root
      && typeof query.queryKey[1] === "string" && query.queryKey[1].toUpperCase() === updated.key,
  });

  // A read started before the write may still return the previous status.
  // Cancelling it does not wait for its network response.
  await Promise.all([
    client.cancelQueries(itemQueries("item")),
    client.cancelQueries({ queryKey: listKey }),
    client.cancelQueries(itemQueries("timeline")),
  ]);

  client.setQueriesData<WorkItem>(itemQueries("item"), (cached) => withCreatorName(updated, cached));
  client.setQueryData<WorkItem>(detailKey, (cached) => withCreatorName(updated, cached));
  for (const query of client.getQueryCache().findAll({ queryKey: listKey })) {
    const cached = query.state.data as ItemListData | undefined;
    const previous = cached?.pages.flatMap((page) => page.items).find((item) => item.key === updated.key);
    // Without a cached row we cannot tell whether a search matches this item
    // or whether its summary already includes the write. Revalidate instead,
    // without marking its unchanged data as newly fetched.
    if (!cached || !previous) continue;
    const statusFilter = query.queryKey[2];
    const keepRow = statusFilter === "all" ? updated.status !== "cancelled" : statusFilter === updated.status;
    client.setQueryData<ItemListData>(query.queryKey, {
      ...cached,
      pages: cached.pages.map((page) => ({
        ...page,
        items: page.items.flatMap((item) => item.key !== updated.key
          ? [item]
          : keepRow ? [withCreatorName(updated, item)] : []),
        summary: previous.status === updated.status ? page.summary : {
          ...page.summary,
          byStatus: {
            ...page.summary.byStatus,
            [previous.status]: Math.max(0, page.summary.byStatus[previous.status] - 1),
            [updated.status]: page.summary.byStatus[updated.status] + 1,
          },
        },
      })),
    });
  }

  // Keep server ordering, pagination and the timeline authoritative, while the
  // mutation settles independently of these background reads.
  void client.invalidateQueries({ queryKey: listKey });
  void client.invalidateQueries(itemQueries("timeline"));
}
