import assert from "node:assert/strict";

const positive = value => Number.isFinite(value) && value > 0;
const integer = (value, min, max) => Number.isInteger(value) && value >= min && value <= max;
export function validateBudget(config) {
  assert.equal(config?.version, 1, "Unknown performance budget version");
  assert.ok(["advisory", "blocking"].includes(config.ciMode), "Invalid CI mode");
  assert.equal(config.timingUnit, "process-cpu-ms", "Budget units must match the synchronous CPU measurement");
  assert.ok(integer(config.maxCiDurationMs, 1000, 25_000) && integer(config.maxLocalDurationMs, config.maxCiDurationMs, 120_000), "Invalid process deadlines");
  assert.ok(typeof config.reason === "string" && config.reason.trim(), "Budget changes need a reason");
  assert.ok(typeof config.baselineEvidence === "string" && config.baselineEvidence.trim(), "Missing baseline evidence");
  assert.ok(integer(config.samples, 3, 15) && config.samples % 2 === 1, "Need an odd sample count, 3..15");
  assert.ok(integer(config.warmups, 1, 5), "Need bounded warmup");
  const shape = config.shape;
  assert.ok(shape && integer(shape.batches, 2, 20) && integer(shape.deliveriesPerBatch, 2, 20)
    && integer(shape.itemsPerDelivery, 1, 20) && integer(shape.eventsPerItem, 10, 1000)
    && integer(shape.payloadBytes, 128, 4096), "Invalid bounded fixture shape");
  assert.ok(shape.batches * shape.deliveriesPerBatch * shape.itemsPerDelivery >= 100, "Fixture must exercise a full list page");
  const b = config.baseline;
  assert.ok(b && positive(b.referenceMs) && integer(b.iterations, 100, 100_000)
    && positive(b.minScale) && b.minScale <= 1 && b.maxScale >= 1 && b.maxScale <= 20
    && positive(b.maxRelativeIqr) && b.maxRelativeIqr <= 1, "Invalid calibration bounds");
  assert.deepEqual(Object.keys(config.targets).sort(), ["item-list", "item-summary", "merge-deliveries"]);
  for (const target of Object.values(config.targets)) assert.ok(positive(target.budgetMs)
    && integer(target.iterations, 1, 10_000), "Invalid target budget");
  return config;
}

export function median(samples) {
  assert.ok(samples.length > 0 && samples.every(positive), "Timing samples must be finite and positive");
  const sorted = [...samples].sort((a, b) => a - b), middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

export function calibration(samples, baseline) {
  const measuredMs = median(samples), sorted = [...samples].sort((a, b) => a - b);
  const scale = measuredMs / baseline.referenceMs;
  const relativeIqr = (sorted[Math.floor(sorted.length * 0.75)] - sorted[Math.floor(sorted.length * 0.25)]) / measuredMs;
  const valid = scale >= baseline.minScale && scale <= baseline.maxScale && relativeIqr <= baseline.maxRelativeIqr;
  return { samplesMs: samples, medianMs: measuredMs, referenceMs: baseline.referenceMs, scale, relativeIqr, valid,
    reason: valid ? null : "Calibration outside reviewed scale/noise bounds; investigate runner, do not increase budgets automatically" };
}

export function evaluateTarget(name, samples, budget, calibrated) {
  const measuredMs = median(samples), normalizedMs = measuredMs / calibrated.scale;
  return { name, samplesMs: samples, medianMs: measuredMs, normalizedMs, referenceBudgetMs: budget.budgetMs,
    effectiveBudgetMs: budget.budgetMs * calibrated.scale,
    suggestedReferenceBudgetMs: Number((normalizedMs * 1.5).toPrecision(4)),
    status: !calibrated.valid ? "invalid" : normalizedMs > budget.budgetMs ? "exceeded" : "passed" };
}

export function performanceExitCode(mode, targets) {
  assert.ok(["advisory", "blocking"].includes(mode), "Unknown performance mode");
  return mode === "blocking" && targets.some(t => t.status !== "passed") ? 1 : 0;
}

export function performanceMarkdown(report) {
  const f = value => Number(value).toFixed(value < 1 ? 4 : 1);
  return ["## Server performance budget", "", `Mode: **${report.mode}** · Measurement: **${report.status}**`,
    ...(report.experiment ? [`Diagnostic mutation: **${report.experiment}**. Excluded from observation evidence.`] : []),
    report.mode === "advisory" ? "Performance warnings do not block CI during observation. Green CI is not a passing budget." : "Local/blocking mode fails on exceeded or invalid measurements.", "",
    `Commit: ${report.head} · Run/attempt: ${report.runId ?? "local"}/${report.attempt ?? "local"} · Config: ${report.configDigest}`,
    `Fixture: ${report.shape.items} items, ${report.shape.events} events, ${report.shape.deliveries} deliveries, ${report.shape.batches} batches.`,
    `Calibration: ${f(report.calibration.medianMs)} CPU ms/read, scale ${f(report.calibration.scale)}, relative IQR ${f(report.calibration.relativeIqr)} (${report.calibration.valid ? "valid" : "INVALID"}).`,
    ...(report.calibration.reason ? [report.calibration.reason] : []), "",
    "| Target | Median CPU ms | Median wall ms | Effective CPU budget ms | Normalized CPU ms | Suggested reference CPU ms | Result |",
    "|---|---:|---:|---:|---:|---:|---|",
    ...report.targets.map(t => `| ${t.name} | ${f(t.medianMs)} | ${t.wallSamplesMs ? f(median(t.wallSamplesMs)) : "unknown"} | ${f(t.effectiveBudgetMs)} | ${f(t.normalizedMs)} | ${f(t.suggestedReferenceBudgetMs)} | ${t.status} |`), "",
    "Suggested budgets are diagnostic data for review, never an automatic update or permission to accept a regression.",
    `Stages ms: fixture ${f(report.timings.fixtureMs)}, calibration ${f(report.timings.calibrationMs)}, warmup ${f(report.timings.warmupMs)}, samples ${f(report.timings.samplesMs)}, total ${f(report.timings.totalMs)}.`,
    "Total is this performance process, not the full CI increment; add the HTTP contract and runner overhead when reviewing the <30s goal.", ""].join("\n");
}
