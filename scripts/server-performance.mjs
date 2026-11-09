import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { calibration, evaluateTarget, performanceExitCode, performanceMarkdown, validateBudget } from "./performance-budget.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const output = resolve(root, "ci-diagnostics/server-performance");
const started = performance.now();
const modeArgument = process.argv.slice(2);
if (modeArgument.some(arg => !["--mode=blocking", "--mode=advisory"].includes(arg)) || modeArgument.length > 1) {
  throw new Error("Usage: node scripts/server-performance.mjs [--mode=blocking|--mode=advisory]");
}
mkdirSync(output, { recursive: true });
// Never leave a stale green report when a later measurement cannot start.
writeFileSync(resolve(output, "report.json"), JSON.stringify({ version: 1, status: "incomplete" }));
writeFileSync(resolve(output, "summary.md"), "Server performance measurement incomplete.\n");
let fixture;
try {
  const bytes = readFileSync(new URL("../tests/performance/server-budgets.json", import.meta.url));
  const config = validateBudget(JSON.parse(bytes));
  const mode = modeArgument[0]?.split("=")[1] ?? (process.env.CI ? config.ciMode : "blocking");
  const { serverFixture } = await import("../tests/performance/server-fixture.mjs");
  const fixtureStarted = performance.now();
  fixture = await serverFixture(config.shape);
  const fixtureMs = performance.now() - fixtureStarted;
  const sample = (fn, iterations) => {
    const before = performance.now();
    for (let i = 0; i < iterations; i++) fn();
    return (performance.now() - before) / iterations;
  };
  // Baseline is independent of all measured targets; warm it before scoring.
  sample(fixture.baseline, config.baseline.iterations);
  const calibrationStarted = performance.now();
  const baseline = Array.from({ length: config.samples }, () => sample(fixture.baseline, config.baseline.iterations));
  const calibrated = calibration(baseline, config.baseline);
  const calibrationMs = performance.now() - calibrationStarted;
  const warmupStarted = performance.now();
  for (let i = 0; i < config.warmups; i++) for (const [name, fn] of Object.entries(fixture.targets)) sample(fn, config.targets[name].iterations);
  const warmupMs = performance.now() - warmupStarted;
  const samplesStarted = performance.now();
  const targets = Object.entries(fixture.targets).map(([name, fn]) => evaluateTarget(name,
    Array.from({ length: config.samples }, () => sample(fn, config.targets[name].iterations)), config.targets[name], calibrated));
  const samplesMs = performance.now() - samplesStarted;
  const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  const dirty = Boolean(execFileSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" }).trim());
  const report = { version: 1, measuredAt: new Date().toISOString(), head, dirty, experiment: process.env.PERFORMANCE_MUTATION ?? null, runId: process.env.GITHUB_RUN_ID ?? null,
    attempt: process.env.GITHUB_RUN_ATTEMPT ?? null, platform: process.platform, arch: process.arch, node: process.version,
    configDigest: createHash("sha256").update(bytes).digest("hex"), mode, shape: fixture.shape, calibration: calibrated, targets,
    status: !calibrated.valid ? "invalid" : targets.some(t => t.status === "exceeded") ? "exceeded" : "passed",
    timings: { fixtureMs, calibrationMs, warmupMs, samplesMs, totalMs: performance.now() - started } };
  const markdown = performanceMarkdown(report);
  writeFileSync(resolve(output, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  writeFileSync(resolve(output, "summary.md"), markdown);
  console.log(markdown);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, markdown);
  if (report.status !== "passed") console.warn("::warning::Server performance budget exceeded or invalid; inspect measured and suggested budgets in the report before changing configuration.");
  process.exitCode = performanceExitCode(mode, targets);
} catch (cause) {
  // Configuration/fixture/runtime errors are correctness failures in either
  // mode. No stack, credentials or host paths enter downloadable diagnostics.
  const error = { version: 1, status: "error", reason: "Budget configuration, fixture or measurement failed; inspect the local/CI command log" };
  writeFileSync(resolve(output, "report.json"), `${JSON.stringify(error)}\n`);
  writeFileSync(resolve(output, "summary.md"), `Server performance measurement ERROR. ${error.reason}\n`);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `\n## Server performance budget\n\nMeasurement **ERROR**. ${error.reason}\n`);
  console.error(error.reason);
  console.error(cause);
  process.exitCode = 1;
} finally { if (fixture) await fixture.app.close(); }
