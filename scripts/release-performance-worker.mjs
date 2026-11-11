import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { validateBudget } from "./performance-budget.mjs";
import { fetchBackup } from "./release-backup.mjs";
import { compilePerformanceCandidate } from "./release-performance-build.mjs";
import { restrictToLoopback } from "./release-performance-network.mjs";
import { stageRecorder } from "./release-performance-stages.mjs";

const [directory, settingsPath] = process.argv.slice(2);
const progress = stageRecorder(directory);
progress.start("settings");
try {
  const { root, host, backupsDir, productId } = JSON.parse(readFileSync(settingsPath));
  const bytes = readFileSync(join(root, "tests/performance/server-budgets.json"));
  const config = validateBudget(JSON.parse(bytes));
  const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  const dirty = Boolean(execFileSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" }).trim());
  const copied = await fetchBackup({ host, backupsDir, directory, maxBackupBytes: config.release.maxBackupBytes, stage: name => progress.start(name) });
  progress.start("compile");
  compilePerformanceCandidate(root);
  restrictToLoopback();
  const { measureBackup } = await import("./release-performance-measure.mjs");
  progress.start("measurement");
  const measurement = await measureBackup({ root, database: copied.database, directory, productId, config });
  progress.finish(measurement.status);
  const result = { version: 2, head, dirty, node: process.version, platform: process.platform, arch: process.arch,
    configDigest: createHash("sha256").update(bytes).digest("hex"), backup: copied.backup,
    measuredAt: new Date().toISOString(), experiment: process.env.PERFORMANCE_MUTATION ?? null, ...measurement,
    failureKind: measurement.status === "passed" ? null : [...(measurement.cpuTargets ?? []), ...(measurement.httpTargets ?? [])].some(t => t.status === "exceeded") ? "regression" : "measurement",
    timings: Object.fromEntries(progress.stages.map(row => [row.name + "Ms", row.durationMs])) };
  writeFileSync(join(directory, "result.json"), JSON.stringify(result), { mode: 0o600 });
  process.exitCode = result.status === "passed" ? 0 : 1;
} catch (error) {
  progress.finish("failed");
  const diagnoses = ["Backup size mismatch", "Backup digest mismatch", "Backup resource limit exceeded", "Compressed backup resource limit exceeded", "Backup transfer failed", "Unsupported backup format", "Unsafe backup directory", "Unsafe SQLite filename", "Invalid backup time", "Backup time is in the future", "Invalid backup size", "Invalid backup digest", "Backup lacks an active, authorized merge-history account", "Backup must exercise associated merge history", "Backup must exercise a full item page", "Smoke HTTP status mismatch", "Empty merge HTTP scope", "Incomplete HTTP item page", "No controlled dispatch claimed", "Claim long poll returned early", "Non-loopback network blocked", "Remote fetch blocked in backup smoke"];
  const diagnosis = diagnoses.find(value => typeof error?.message === "string" && error.message.startsWith(value)) ?? "Check local prerequisites, compressed stream and measurement coverage";
  writeFileSync(join(directory, "error.json"), JSON.stringify({ status: "error", reason: progress.stage === "measurement" ? "Application measurement failed" : "Environment preparation failed",
    failureKind: /resource limit/.test(diagnosis) ? "resource" : progress.stage === "measurement" ? "measurement" : "preparation", diagnosis, stage: progress.stage,
    smokeStep: ["scope", "node", "listen", "controlled-claim", "idle-claim", "cpu", "http", "work-claim"].includes(error?.smokeStep) ? error.smokeStep : null,
    code: typeof error?.code === "string" && /^[A-Z_]+$/.test(error.code) ? error.code : null }), { mode: 0o600 });
  process.exitCode = 1;
}
