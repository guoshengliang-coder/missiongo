import { spawnSync } from "node:child_process";

/** A parent deadline also works when synchronous SQLite/JS blocks child timers. */
export function runPerformanceChild(args, timeoutMs, options = {}) {
  const child = spawnSync(process.execPath, args, { ...options, timeout: timeoutMs, killSignal: "SIGKILL" });
  return { status: child.status, timedOut: child.error?.code === "ETIMEDOUT", failed: Boolean(child.error) || Boolean(child.signal),
    signal: child.signal, error: child.error?.code ?? null };
}
