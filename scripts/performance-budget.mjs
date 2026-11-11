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
  const r = config.release;
  assert.ok(r?.version === 3 && r.timingUnit === "wall-ms" && r.maxDurationMs === 245000, "Invalid release performance contract");
  assert.ok(r.preparationMs === 120000 && r.measurementMs === 120000 && r.cleanupMs === 5000
    && r.maxDurationMs === r.preparationMs + r.measurementMs + r.cleanupMs, "Invalid release stage deadlines");
  assert.ok(r.maxBackupBytes === 512 * 1024 * 1024 && r.maxTempBytes === 2 * 1024 * 1024 * 1024, "Invalid release resource limits");
  assert.ok(typeof r.reason === "string" && r.reason.trim(), "Release budgets need a reason");
  assert.deepEqual(Object.keys(r.httpTargets).sort(), ["claim-next", "item-list", "merge-deliveries"]);
  for (const target of Object.values(r.httpTargets)) assert.ok(positive(target.budgetMs) && integer(target.iterations, 1, 100), "Invalid HTTP budget");
  const h = r.httpBaseline;
  assert.ok(h && positive(h.referenceMs) && integer(h.iterations, 10, 100)
    && positive(h.minScale) && h.minScale <= 1 && h.maxScale >= 1 && h.maxScale <= 20
    && positive(h.maxRelativeIqr) && h.maxRelativeIqr <= 1, "Invalid independent HTTP calibration");
  assert.ok(positive(r.claimWorkCpuShare) && r.claimWorkCpuShare < 1, "Invalid work-claim calibration mix");
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


// Empty claims are dominated by HTTP transport; using SQLite CPU calibration
// hid fivefold regressions on Node 22.13's much faster transport. Work claims
// also perform SQLite writes: keep an explicit reviewed CPU contribution.
export function releaseTargetCalibration(name, config, cpu, http) {
  if (name === "claim-next") return http;
  if (name !== "claim-next-work") return cpu;
  const share = config.release.claimWorkCpuShare;
  return { scale: share * cpu.scale + (1 - share) * http.scale,
    valid: cpu.valid && http.valid, cpuShare: share, cpuScale: cpu.scale, httpScale: http.scale };
}
