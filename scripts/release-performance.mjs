import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { validateBudget } from "./performance-budget.mjs";
import { runPerformanceGroup } from "./performance-watchdog.mjs";
import { completeMeasurementProgress, monotonicMs, readStageProgress, temporaryDataBytes } from "./release-performance-stages.mjs";

export async function cleanupPerformanceDirectory(directory, timeoutMs) {
  const result = await runPerformanceGroup(["-e", "require('node:fs').rmSync(process.argv[1],{recursive:true,force:true})", directory], timeoutMs, { stdio: "ignore", env: { PATH: process.env.PATH ?? "", TMPDIR: tmpdir() } });
  return result.status === 0 && !result.timedOut && !result.cancelled && !result.failed && !existsSync(directory);
}

export async function runReleasePerformance(settings, { worker = join(dirname(fileURLToPath(import.meta.url)), "release-performance-worker.mjs"), runGroup = runPerformanceGroup, cleanup = cleanupPerformanceDirectory, now = monotonicMs } = {}) {
  const started = now();
  const config = validateBudget(JSON.parse(readFileSync(join(settings.root, "tests/performance/server-budgets.json"))));
  const budget = config.release;
  const directory = mkdtempSync(join(tmpdir(), "missiongo-perf-"));
  let report, progress, peakTempBytes = 0, cleaned = false, cleanupSucceeded = false, cleanupMs;
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
    if (progress && (progress.startedMonotonicMs < started || progress.startedMonotonicMs > now())) {
      return { kind: "contract", stage, reason: "Invalid cross-process stage clock" };
    }
    if (progress?.stages.some(row => progress.startedMonotonicMs + row.startedMs
      + (row.status === "running" ? 0 : row.durationMs) > now() + 0.001)) {
      return { kind: "contract", stage, reason: "Stage evidence extends into the future" };
    }
    const measurement = progress?.stages.find(row => row.name === "measurement");
    if (measurement) {
      const measurementStart = progress.startedMonotonicMs + measurement.startedMs;
      if (measurementStart > now()) return { kind: "contract", stage, reason: "Invalid stage start time" };
      if (measurementStart - started >= budget.preparationMs) return { kind: "preparation", stage, reason: "Environment preparation deadline exceeded" };
      const measurementMs = measurement.status === "running" ? now() - measurementStart : measurement.durationMs;
      if (measurementMs >= budget.measurementMs) return { kind: "measurement", stage, reason: "Application measurement deadline exceeded" };
    } else if (elapsed >= budget.preparationMs) return { kind: "preparation", stage, reason: "Environment preparation deadline exceeded" };
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
      else if (!completeMeasurementProgress(progress)) report = { ...report, status: "invalid", stage,
        failureKind: "contract", reason: "Missing or incomplete stage evidence" };
    }
  } catch {
    report = { status: "invalid", stage: progress?.stage ?? "settings", failureKind: "resource", reason: "Temporary data limit or supervisor check failed" };
  } finally {
    progress = readStageProgress(directory) ?? progress;
    const beforeCleanup = now();
    try { cleanupSucceeded = await cleanup(directory, Math.max(1, Math.min(budget.cleanupMs, budget.maxDurationMs - (beforeCleanup - started)))); }
    catch { cleanupSucceeded = false; }
    cleaned = !existsSync(directory);
    cleanupMs = now() - beforeCleanup;
  }
  if (report.experiment) {
    report.measurementStatus = report.status;
    const target = /^release-fivefold-(.+)$/.exec(report.experiment)?.[1];
    const selected = [...(report.cpuTargets ?? []), ...(report.httpTargets ?? [])].filter(row => row.name === target);
    const validEvidence = report.status !== "invalid" && completeMeasurementProgress(progress, { allowFailedMeasurement: true });
    const detected = validEvidence && report.calibration?.valid === true && report.httpCalibration?.valid === true && selected.some(row => row.status === "exceeded");
    report.diagnosticOutcome = detected ? "detected" : "not_detected";
    report.status = detected ? "failed" : "invalid";
    if (validEvidence) report.reason = detected ? "Diagnostic regression detected; experiments cannot authorize publication" : "Diagnostic target did not exceed its budget; nonzero exit is not detection evidence";
    else report.reason ??= "Diagnostic stage evidence is missing or invalid";
  }
  const stages = progress?.stages ?? [];
  const last = stages.at(-1);
  if (last?.status === "running") {
    last.durationMs = Math.max(0, now() - progress.startedMonotonicMs - cleanupMs - last.startedMs);
    last.status = report.status === "passed" ? "passed" : "failed";
  }
  report.stages = [...stages, { name: "cleanup", durationMs: cleanupMs, status: cleaned && cleanupSucceeded && cleanupMs < budget.cleanupMs ? "passed" : "failed" }];
  report.limits = budget;
  report.peakTempBytes = peakTempBytes;
  report.totalMs = now() - started;
  report.cleaned = cleaned;
  report.cleanupSucceeded = cleanupSucceeded;
  if (!cleaned) report.cleanupResource = basename(directory);
  if (!cleaned || !cleanupSucceeded || cleanupMs >= budget.cleanupMs) { report.status = "invalid"; report.failureKind = "cleanup"; report.reason = "Temporary data cleanup failed or exceeded its deadline"; }
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
