import { spawnSync } from "node:child_process";

/** A parent deadline also works when synchronous SQLite/JS blocks child timers. */
export function runPerformanceChild(args, timeoutMs, options = {}) {
  const child = spawnSync(process.execPath, args, { ...options, timeout: timeoutMs, killSignal: "SIGKILL" });
  return { status: child.status, timedOut: child.error?.code === "ETIMEDOUT", failed: Boolean(child.error) || Boolean(child.signal),
    signal: child.signal, error: child.error?.code ?? null };
}

/** Bound a whole worker group, including SSH/build grandchildren. The caller
 * owns temporary files and removes them after this promise settles. */
export async function runPerformanceGroup(args, timeoutMs, options = {}) {
  const { spawn } = await import("node:child_process");
  return new Promise(resolve => {
    const { monitor, pollMs = 25, ...spawnOptions } = options;
    const child = spawn(process.execPath, args, { ...spawnOptions, detached: true });
    let timedOut = false, cancelled = false, failed = false, violation = null;
    const kill = () => { try { process.kill(-child.pid, "SIGKILL"); } catch (e) { if (e.code !== "ESRCH") failed = true; } };
    const stop = () => { cancelled = true; kill(); };
    const poll = monitor ? setInterval(() => {
      try { violation = monitor() ?? null; }
      catch { violation = { kind: "resource", reason: "Temporary resource inspection failed" }; }
      if (violation) { clearInterval(poll); kill(); }
    }, pollMs) : null;
    const timer = setTimeout(() => { timedOut = true; kill(); }, timeoutMs);
    process.once("SIGINT", stop); process.once("SIGTERM", stop);
    child.once("error", () => { failed = true; });
    child.once("close", (status, signal) => {
      clearTimeout(timer); clearInterval(poll); process.removeListener("SIGINT", stop); process.removeListener("SIGTERM", stop);
      // Also kill a descendant that survived a worker's early exit.
      kill();
      resolve({ status, signal, timedOut, cancelled, failed, violation });
    });
  });
}
