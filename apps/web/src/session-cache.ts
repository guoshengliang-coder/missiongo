import type { QueryClient } from "@tanstack/react-query";

/** Keep recent conversations in page memory only. Active views are never
 * evicted; detached snapshots have both an age and a total-size/count bound. */
export function retainSessionCache(client: QueryClient, maxEntries = 12, maxBytes = 16 * 1024 * 1024) {
  client.setQueryDefaults(["agent-session"], { gcTime: 15 * 60_000 });
  const sizes = new WeakMap<object, number>();
  let queued = false, stopped = false;
  const prune = () => {
    queued = false;
    if (stopped) return;
    const queries = client.getQueryCache().findAll({ queryKey: ["agent-session"] })
      .filter(q => q.getObserversCount() === 0 && q.state.fetchStatus === "idle")
      .sort((a,b) => b.state.dataUpdatedAt - a.state.dataUpdatedAt);
    let bytes = 0;
    queries.forEach((q,index) => {
      const data = q.state.data;
      if (data && typeof data === "object") {
        let size = sizes.get(data);
        if (size === undefined) { size = JSON.stringify(data).length * 2; sizes.set(data, size); }
        bytes += size;
      }
      if (index >= maxEntries || bytes > maxBytes) client.removeQueries({ queryKey: q.queryKey, exact: true });
    });
  };
  const unsubscribe = client.getQueryCache().subscribe(event => {
    if (event.query.queryKey[0] !== "agent-session" || event.type === "removed" || queued) return;
    queued = true; queueMicrotask(prune);
  });
  return () => { stopped = true; unsubscribe(); };
}
