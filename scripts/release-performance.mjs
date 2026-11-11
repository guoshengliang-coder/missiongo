import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { validateBudget } from "./performance-budget.mjs";
import { runPerformanceGroup } from "./performance-watchdog.mjs";
import { readStageProgress, temporaryDataBytes } from "./release-performance-stages.mjs";

export async function cleanupPerformanceDirectory(directory, timeoutMs) {
  const result = await runPerformanceGroup(["-e", "require('node:fs').rmSync(process.argv[1],{recursive:true,force:true})", directory], timeoutMs, { stdio: "ignore", env: { PATH: process.env.PATH ?? "", TMPDIR: tmpdir() } });
  return result.status === 0 && !result.timedOut && !result.cancelled && !result.failed && !existsSync(directory);
}

export async function runReleasePerformance(settings, { worker = join(dirname(fileURLToPath(import.meta.url)), "release-performance-worker.mjs"), runGroup = runPerformanceGroup, cleanup = cleanupPerformanceDirectory, now = () => performance.now() } = {}) {
  const started = now();
  const config = validateBudget(JSON.parse(readFileSync(join(settings.root, "tests/performance/server-budgets.json"))));
  const budget = config.release;
  const directory = mkdtempSync(join(tmpdir(), "missiongo-perf-"));
  let report, progress, measurementStarted, peakTempBytes = 0, cleaned = false, cleanupMs;
  const inspect = () => {
    progress = readStageProgress(directory) ?? progress;
    const stage = progress?.stage ?? "settings";
    const elapsed = now() - started;
    try { peakTempBytes = Math.max(peakTempBytes, temporaryDataBytes(directory, budget.maxTempBytes)); }
    catch (error) {
      if (!Number.isFinite(error.observedBytes)) throw error;
      peakTempBytes = Math.max(peakTempBytes, error.observedBytes);
      return { kind: "resource", stage, reason: "Temporary data limit exceeded" };
    }
    if (stage === "measurement" && measurementStarted === undefined) measurementStarted = now();
    if (measurementStarted === undefined && elapsed >= budget.preparationMs) return { kind: "preparation", stage, reason: "Environment preparation deadline exceeded" };
    if (measurementStarted !== undefined && now() - measurementStarted >= budget.measurementMs) return { kind: "measurement", stage, reason: "Application measurement deadline exceeded" };
    return null;
  };
  try {
    const settingsPath = join(directory, "settings.json");
    writeFileSync(settingsPath, JSON.stringify(settings), { mode: 0o600 });
    const env = Object.fromEntries(["PATH", "HOME", "TMPDIR", "SYSTEMROOT", "SSH_AUTH_SOCK", "PERFORMANCE_MUTATION"].flatMap(k => process.env[k] ? [[k, process.env[k]]] : []));
    const result = await runGroup([...process.execArgv, worker, directory, settingsPath], Math.max(1, budget.maxDurationMs - budget.cleanupMs - (now() - started)),
      { cwd: settings.root, env, stdio: "ignore", monitor: inspect });
    progress = readStageProgress(directory) ?? progress;
    const stage = progress?.stage ?? "settings";
    // Check final footprints even when the child exits between monitor ticks.
    const violation = result.violation ?? inspect();
    if (result.timedOut || result.cancelled || result.failed || violation) {
      report = { status: "invalid", stage, failureKind: result.cancelled ? "cancelled" : violation?.kind ?? (stage === "measurement" ? "measurement" : "preparation"),
        reason: result.cancelled ? "Performance smoke cancelled" : violation?.reason ?? "Performance process group timed out or failed" };
    } else {
      try { report = JSON.parse(readFileSync(join(directory, "result.json"))); }
      catch { try { report = JSON.parse(readFileSync(join(directory, "error.json"))); } catch { report = { status: "error", stage, failureKind: stage === "measurement" ? "measurement" : "preparation", reason: "Performance worker returned no report" }; } }
      if (result.status !== 0 || report.status !== "passed") report.status = "failed";
    }
  } catch {
    report = { status: "invalid", stage: progress?.stage ?? "settings", failureKind: "resource", reason: "Temporary data limit or supervisor check failed" };
  } finally {
    progress = readStageProgress(directory) ?? progress;
    const beforeCleanup = now();
    try { cleaned = await cleanup(directory, Math.max(1, Math.min(budget.cleanupMs, budget.maxDurationMs - (beforeCleanup - started)))); }
    catch { cleaned = false; }
    cleaned = cleaned && !existsSync(directory);
    cleanupMs = now() - beforeCleanup;
  }
  if (report.experiment) {
    report.measurementStatus = report.status;
    const target = /^release-fivefold-(.+)$/.exec(report.experiment)?.[1];
    const selected = [...(report.cpuTargets ?? []), ...(report.httpTargets ?? [])].filter(row => row.name === target);
    const detected = report.calibration?.valid === true && report.httpCalibration?.valid === true && selected.some(row => row.status === "exceeded");
    report.diagnosticOutcome = detected ? "detected" : "not_detected";
    report.status = detected ? "failed" : "invalid";
    report.reason = detected ? "Diagnostic regression detected; experiments cannot authorize publication" : "Diagnostic target did not exceed its budget; nonzero exit is not detection evidence";
  }
  const stages = progress?.stages ?? [];
  const last = stages.at(-1);
  if (last?.status === "running") {
    last.durationMs = Math.max(0, now() - started - cleanupMs - last.startedMs);
    last.status = report.status === "passed" ? "passed" : "failed";
  }
  report.stages = [...stages, { name: "cleanup", durationMs: cleanupMs, status: cleaned && cleanupMs < budget.cleanupMs ? "passed" : "failed" }];
  report.limits = budget;
  report.peakTempBytes = peakTempBytes;
  report.totalMs = now() - started;
  report.cleaned = cleaned;
  if (!cleaned || cleanupMs >= budget.cleanupMs) { report.status = "invalid"; report.failureKind = "cleanup"; report.reason = "Temporary data cleanup failed or exceeded its deadline"; }
  if (report.totalMs >= budget.maxDurationMs) { report.status = "invalid"; report.reason = "Full smoke including cleanup exceeded the deadline"; }
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
