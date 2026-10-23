import { MutationObserver, QueryClient, QueryObserver, type InfiniteData } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { WorkItemListPage } from "./api";
import { applyConfirmedItemTransition } from "./confirmed-item-transition";
import type { WorkItem } from "./types";

type ItemListData = InfiniteData<WorkItemListPage, number | null>;
const listKey = ["items", "product", "pending_verification", "all", ""];

function item(status: WorkItem["status"] = "pending_verification"): WorkItem {
  return {
    id: "item", key: "TEST-1", productId: "product", affectedComponentIds: [],
    type: "bug", priority: "normal", status, title: "A reported issue", description: "",
    diagnosticSummary: { logCount: 0, logFileCount: 0, contextEntryCount: 0 },
    attachments: [], createdAt: "2026-10-01T00:00:00Z", updatedAt: "2026-10-02T00:00:00Z",
  };
}

function pages(items: WorkItem[] = [item()]): ItemListData {
  return {
    pages: [{
      items, nextBeforeSequence: 1,
      summary: {
        total: 3, productTotal: 3,
        byStatus: { inbox: 0, ready: 0, in_progress: 0, development_complete: 0, on_hold: 0, pending_verification: 2, done: 1, cancelled: 0 },
      },
    }],
    pageParams: [null],
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

const clients: QueryClient[] = [];
function client() {
  const value = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  clients.push(value);
  return value;
}
afterEach(() => { for (const value of clients.splice(0)) value.clear(); });

describe("confirmed item transitions", () => {
  it("settles the write and updates the screen while list and timeline reads are still pending", async () => {
    const cache = client();
    cache.setQueryData(["item", "TEST-1"], item());
    const listRead = deferred<ItemListData>();
    const timelineRead = deferred<unknown[]>();
    const list = new QueryObserver(cache, { queryKey: listKey, initialData: pages(), staleTime: Infinity, queryFn: () => listRead.promise });
    const timeline = new QueryObserver(cache, { queryKey: ["timeline", "TEST-1"], initialData: [], staleTime: Infinity, queryFn: () => timelineRead.promise });
    const stopList = list.subscribe(() => {});
    const stopTimeline = timeline.subscribe(() => {});
    const mutation = new MutationObserver(cache, {
      mutationFn: async () => item("done"),
      onSuccess: (updated) => applyConfirmedItemTransition(cache, updated),
    });

    await mutation.mutate(undefined);

    expect(mutation.getCurrentResult().isSuccess).toBe(true);
    expect(list.getCurrentResult().isFetching).toBe(true);
    expect(timeline.getCurrentResult().isFetching).toBe(true);
    expect(cache.getQueryData<WorkItem>(["item", "TEST-1"])?.status).toBe("done");
    const page = cache.getQueryData<ItemListData>(listKey)?.pages[0];
    expect(page?.items).toEqual([]);
    expect(page?.summary.byStatus).toMatchObject({ pending_verification: 1, done: 2 });
    expect(page?.summary.total).toBe(3);
    stopList();
    stopTimeline();
  });

  it("keeps a confirmed success when the background refresh fails", async () => {
    const cache = client();
    const read = deferred<ItemListData>();
    const list = new QueryObserver(cache, { queryKey: listKey, initialData: pages(), staleTime: Infinity, queryFn: () => read.promise });
    const stop = list.subscribe(() => {});
    const mutation = new MutationObserver(cache, {
      mutationFn: async () => item("done"),
      onSuccess: (updated) => applyConfirmedItemTransition(cache, updated),
    });
    await mutation.mutate(undefined);
    read.reject(new Error("Refresh unavailable"));

    await vi.waitFor(() => expect(list.getCurrentResult().isError).toBe(true));
    expect(mutation.getCurrentResult().isSuccess).toBe(true);
    expect(cache.getQueryData<WorkItem>(["item", "TEST-1"])?.status).toBe("done");
    expect(cache.getQueryData<ItemListData>(listKey)?.pages[0]?.items).toEqual([]);
    stop();
  });

  it("ignores pre-write responses that arrive after the confirmed status", async () => {
    const cache = client();
    const staleDetail = deferred<WorkItem>();
    const staleList = deferred<ItemListData>();
    const freshList = deferred<ItemListData>();
    const readList = vi.fn().mockImplementationOnce(() => staleList.promise).mockImplementation(() => freshList.promise);
    const detail = new QueryObserver(cache, { queryKey: ["item", "TEST-1"], initialData: item(), staleTime: Infinity, queryFn: () => staleDetail.promise });
    const list = new QueryObserver(cache, { queryKey: listKey, initialData: pages(), staleTime: Infinity, queryFn: readList });
    const stopDetail = detail.subscribe(() => {});
    const stopList = list.subscribe(() => {});
    const detailRequest = detail.refetch();
    const listRequest = list.refetch();

    await applyConfirmedItemTransition(cache, item("done"));
    staleDetail.resolve(item());
    staleList.resolve(pages());
    await Promise.all([detailRequest, listRequest]);

    expect(readList).toHaveBeenCalledTimes(2);
    expect(cache.getQueryData<WorkItem>(["item", "TEST-1"])?.status).toBe("done");
    expect(cache.getQueryData<ItemListData>(listKey)?.pages[0]?.items).toEqual([]);
    stopDetail();
    stopList();
  });

  it("updates loaded pages without losing pagination or creator names, and does not adjust counts twice", async () => {
    const cache = client();
    const cached = {
      ...item(), verificationReturn: { at: "2026-10-01T00:00:00Z", note: "An earlier return" },
      createdBy: { kind: "human" as const, accountId: "person", name: "A person" },
    };
    cache.setQueryData(["item", "TEST-1"], cached);
    const allKey = ["items", "product", "all", "all", ""];
    const data = pages([cached]);
    data.pages.unshift({ ...data.pages[0]!, items: [{ ...item(), key: "TEST-2" }] });
    data.pageParams.push(2);
    cache.setQueryData(allKey, data);
    const unrelatedKey = ["items", "other-product", "all", "all", ""];
    cache.setQueryData(unrelatedKey, pages());
    const searchedKey = ["items", "product", "all", "all", "something else"];
    cache.setQueryData(searchedKey, pages([]), { updatedAt: 1 });

    await applyConfirmedItemTransition(cache, item("done"));
    await applyConfirmedItemTransition(cache, item("done"));

    const updated = cache.getQueryData<ItemListData>(allKey)!;
    expect(updated.pageParams).toEqual(data.pageParams);
    expect(updated.pages[1]?.nextBeforeSequence).toBe(1);
    expect(updated.pages[1]?.items[0]).toMatchObject({ status: "done", createdBy: { name: "A person" } });
    expect(updated.pages.every((page) => page.summary.byStatus.done === 2)).toBe(true);
    expect(cache.getQueryData<WorkItem>(["item", "TEST-1"])?.createdBy).toEqual(cached.createdBy);
    expect(cache.getQueryData<WorkItem>(["item", "TEST-1"])?.verificationReturn).toBeUndefined();
    expect(cache.getQueryData<ItemListData>(unrelatedKey)).toEqual(pages());
    expect(cache.getQueryState(unrelatedKey)?.isInvalidated).toBe(false);
    expect(cache.getQueryData<ItemListData>(searchedKey)?.pages[0]?.summary.byStatus.done).toBe(1);
    expect(cache.getQueryState(searchedKey)?.dataUpdatedAt).toBe(1);
  });

  it("removes cancelled work from the all-status list", async () => {
    const cache = client();
    const allKey = ["items", "product", "all", "all", ""];
    cache.setQueryData(allKey, pages());
    await applyConfirmedItemTransition(cache, item("cancelled"));
    expect(cache.getQueryData<ItemListData>(allKey)?.pages[0]?.items).toEqual([]);
  });

  it("updates an open detail link with a lowercase key", async () => {
    const cache = client();
    cache.setQueryData(["item", "test-1"], item());
    cache.setQueryData(["timeline", "test-1"], []);
    await applyConfirmedItemTransition(cache, item("done"));
    expect(cache.getQueryData<WorkItem>(["item", "test-1"])?.status).toBe("done");
    expect(cache.getQueryState(["timeline", "test-1"])?.isInvalidated).toBe(true);
  });

  it("does not change the screen when the status write is rejected", async () => {
    const cache = client();
    cache.setQueryData(["item", "TEST-1"], item());
    cache.setQueryData(listKey, pages());
    const mutation = new MutationObserver(cache, {
      mutationFn: async (): Promise<WorkItem> => { throw new Error("Write rejected"); },
      onSuccess: (updated) => applyConfirmedItemTransition(cache, updated),
    });
    await expect(mutation.mutate(undefined)).rejects.toThrow("Write rejected");
    expect(cache.getQueryData<WorkItem>(["item", "TEST-1"])?.status).toBe("pending_verification");
    expect(cache.getQueryData<ItemListData>(listKey)).toEqual(pages());
    expect(cache.getQueryState(listKey)?.isInvalidated).toBe(false);
  });
});
