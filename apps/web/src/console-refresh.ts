import type { Query, QueryClient } from "@tanstack/react-query";

/** Each key owns its retry and dirty version. A slow auxiliary read never holds
 * the conversation's next read behind a Promise.all barrier. */
export function consoleRefresh(client: QueryClient, idle: () => void) {
  type Task = { query: Query; version: number; running: boolean; failures: number; timer?: ReturnType<typeof setTimeout> | undefined };
  const tasks = new Map<string, Task>();
  let stopped = false, generation = 0, resetting = false;
  const run = async (task: Task) => {
    if (stopped || resetting || task.running || task.timer || document.visibilityState === "hidden") return;
    const epoch = generation, version = task.version;
    task.running = true;
    try {
      // Join an initial/mutation read, then read after the notification. Never
      // cancel another consumer's request or mistake its old snapshot for ours.
      if (task.query.state.fetchStatus === "fetching") await task.query.promise?.catch(() => {});
      if (stopped || epoch !== generation) return;
      await client.invalidateQueries({ queryKey: task.query.queryKey, exact: true }, { throwOnError: true, cancelRefetch: false });
      if (stopped || epoch !== generation) return;
      task.failures = 0;
      if (task.version === version) tasks.delete(task.query.queryHash);
    } catch {
      if (stopped || epoch !== generation) return;
      task.timer = setTimeout(() => { task.timer = undefined; void run(task); }, Math.min(30_000, 1000 * 2 ** Math.min(task.failures++, 5)));
    } finally {
      if (!stopped && epoch === generation) {
        task.running = false;
        if (tasks.has(task.query.queryHash)) void run(task);
        if (!tasks.size) idle();
      }
    }
  };
  const add = (queries: Query[], onlyMissing = false) => {
    if (stopped) return;
    const priority = (query: Query) => query.queryKey[0] === "bootstrap" ? 0 : query.queryKey[0] === "agent-session" ? 1 : 2;
    for (const query of [...queries].sort((a,b) => priority(a) - priority(b))) {
      if (onlyMissing && tasks.has(query.queryHash)) continue;
      const task = tasks.get(query.queryHash) ?? { query, version: 0, running: false, failures: 0 };
      task.version++;
      tasks.set(query.queryHash, task);
      // Inactive snapshots become stale immediately, including while hidden.
      void client.invalidateQueries({ queryKey: query.queryKey, exact: true, refetchType: "none" });
    }
    queueMicrotask(() => { tasks.forEach(task => void run(task)); if (!tasks.size && !resetting && !stopped) idle(); });
  };
  const clear = () => { generation++; tasks.forEach(task => { if (task.timer) clearTimeout(task.timer); }); tasks.clear(); };
  return {
    add,
    resume: () => tasks.forEach(task => void run(task)),
    reset: async () => {
      clear(); resetting = true; const epoch = generation;
      await client.cancelQueries();
      if (stopped || epoch !== generation) return;
      client.removeQueries({ predicate: q => q.queryKey[0] !== "bootstrap" && q.getObserversCount() === 0 });
      resetting = false;
      add(client.getQueryCache().getAll().sort((a,b) => Number(b.queryKey[0] === "bootstrap") - Number(a.queryKey[0] === "bootstrap")));
    },
    stop: () => {
      stopped = true;
      void client.cancelQueries({ predicate: query => tasks.has(query.queryHash) });
      clear();
    },
  };
}
