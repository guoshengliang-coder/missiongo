import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { validateBudget } from "./performance-budget.mjs";
import { runPerformanceChild } from "./performance-watchdog.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const output = resolve(root, "ci-diagnostics/server-performance");
const args = process.argv.slice(2), started = performance.now();
mkdirSync(output, { recursive: true });
// Invalidate previous output even if configuration/child startup fails.
writeFileSync(resolve(output, "report.json"), JSON.stringify({ version: 1, status: "incomplete" }));
writeFileSync(resolve(output, "summary.md"), "Server performance measurement incomplete.\n");
try {
  if (args.length > 1 || args.some(a => !["--mode=advisory", "--mode=blocking"].includes(a))) throw new Error("Invalid performance arguments");
  const config = validateBudget(JSON.parse(readFileSync(new URL("../tests/performance/server-budgets.json", import.meta.url))));
  const mode = args[0]?.split("=")[1] ?? (process.env.CI ? config.ciMode : "blocking");
  const limitMs = process.env.CI ? config.maxCiDurationMs : config.maxLocalDurationMs;
  const child = runPerformanceChild([...process.execArgv, fileURLToPath(new URL("./server-performance-worker.mjs", import.meta.url)), ...args], limitMs,
    { cwd: root, env: process.env, stdio: "inherit" });
  if (child.timedOut) {
    const report = { version: 1, status: "invalid", mode, experiment: process.env.PERFORMANCE_MUTATION ?? null,
      reason: "Performance process exceeded its wall-clock deadline; no completed budget measurement", limitMs, elapsedMs: performance.now() - started };
    const markdown = `## Server performance budget\n\nMeasurement **INVALID**: ${report.reason} (${limitMs}ms).\nMode: **${mode}**. Missing measurements are not a pass or a zero-false-positive observation.\n`;
    writeFileSync(resolve(output, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
    writeFileSync(resolve(output, "summary.md"), markdown);
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, markdown);
    console.warn(`::warning::${report.reason} (${limitMs}ms)`);
    process.exitCode = mode === "advisory" ? 0 : 1;
  } else {
    process.exitCode = child.failed || child.status === null ? 1 : child.status;
  }
} catch (cause) {
  writeFileSync(resolve(output, "report.json"), JSON.stringify({ version: 1, status: "error", reason: "Performance supervisor/configuration failed" }));
  writeFileSync(resolve(output, "summary.md"), "Performance supervisor/configuration ERROR. Inspect command log.\n");
  console.error(cause); process.exitCode = 1;
}
