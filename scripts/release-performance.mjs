import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { validateBudget } from "./performance-budget.mjs";
import { runPerformanceGroup } from "./performance-watchdog.mjs";

export async function runReleasePerformance(settings, { worker = join(dirname(fileURLToPath(import.meta.url)), "release-performance-worker.mjs"), runGroup = runPerformanceGroup } = {}) {
  const started = performance.now();
  const config = validateBudget(JSON.parse(readFileSync(join(settings.root, "tests/performance/server-budgets.json"))));
  const directory = mkdtempSync(join(tmpdir(), "missiongo-perf-"));
  let report;
  try {
    const settingsPath = join(directory, "settings.json");
    writeFileSync(settingsPath, JSON.stringify(settings), { mode: 0o600 });
    const env = Object.fromEntries(["PATH", "HOME", "TMPDIR", "SYSTEMROOT", "SSH_AUTH_SOCK", "PERFORMANCE_MUTATION"].flatMap(k => process.env[k] ? [[k, process.env[k]]] : []));
    // Reserve five seconds for group teardown and removal, both inside total.
    const result = await runGroup([...process.execArgv, worker, directory, settingsPath], Math.max(1, config.release.maxDurationMs - 5000 - (performance.now() - started)),
      { cwd: settings.root, env, stdio: "ignore" });
    if (result.timedOut || result.cancelled || result.failed) report = { status: "invalid", reason: "Performance process group timed out, was cancelled or failed" };
    else {
      try { report = JSON.parse(readFileSync(join(directory, "result.json"))); }
      catch { try { report = JSON.parse(readFileSync(join(directory, "error.json"))); } catch { report = { status: "error", reason: "Performance worker returned no report" }; } }
      if (result.status !== 0 || report.status !== "passed") report.status = "failed";
    }
  } finally {
    // Cleanup failures propagate, so a stale database can never return success.
    rmSync(directory, { recursive: true, force: true });
  }
  if (report.experiment) { report.status = "failed"; report.reason = "Diagnostic experiments cannot authorize publication"; }
  report.totalMs = performance.now() - started;
  report.cleaned = true;
  if (report.totalMs >= config.release.maxDurationMs) { report.status = "invalid"; report.reason = "Full smoke including cleanup exceeded the deadline"; }
  return report;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2), allowed = ["--root", "--host", "--backups-dir", "--product-id"];
    assert.ok(args.length === 8 && args.every((a, i) => i % 2 || allowed.includes(a)) && new Set(args.filter((_, i) => i % 2 === 0)).size === 4, "Invalid smoke arguments");
    const values = Object.fromEntries(allowed.map(flag => [flag, args[args.indexOf(flag) + 1]]));
    const report = await runReleasePerformance({ root: resolve(values["--root"]), host: values["--host"], backupsDir: values["--backups-dir"], productId: values["--product-id"] });
    console.log(JSON.stringify(report, null, 2));
    process.exitCode = report.status === "passed" ? 0 : 1;
  } catch { console.error("Release performance smoke failed; deployment refused. Check local prerequisites and cleanup."); process.exitCode = 1; }
}
