import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { calibration, evaluateTarget, median, performanceExitCode, performanceMarkdown, validateBudget } from "./performance-budget.mjs";

const config = JSON.parse(readFileSync(new URL("../tests/performance/server-budgets.json", import.meta.url)));
const samples = value => [value, value * 0.98, value * 1.02, value, value, value, value * 20];
const score = scale => calibration(samples(config.baseline.referenceMs * scale), config.baseline);
const budget = { budgetMs: 100, iterations: 1 };

test("whole-machine drift rescales the budget while isolated 5x regressions fail", () => {
  for (const scale of [0.25, 1, 2, 4]) {
    const calibrated = score(scale);
    assert.equal(calibrated.valid, true);
    const normal = evaluateTarget("merge-deliveries", samples(70 * scale), budget, calibrated);
    assert.equal(normal.status, "passed");
    assert.equal(normal.normalizedMs, 70);
    const slow = evaluateTarget("merge-deliveries", samples(350 * scale), budget, calibrated);
    assert.equal(slow.status, "exceeded");
    assert.equal(slow.suggestedReferenceBudgetMs, 525);
    assert.equal(slow.medianMs, 350 * scale);
    assert.equal(slow.effectiveBudgetMs, 100 * scale);
  }
});

test("advisory changes only exit policy, never the failed measurement", () => {
  const row = evaluateTarget("item-list", samples(350), budget, score(1));
  assert.equal(performanceExitCode("advisory", [row]), 0);
  assert.equal(row.status, "exceeded");
  assert.equal(performanceExitCode("blocking", [row]), 1);
  assert.equal(performanceExitCode("blocking", [{ status: "passed" }]), 0);
  assert.throws(() => performanceExitCode("ignore", [row]));
});

test("extreme or noisy calibration is invalid, never an unlimited pass", () => {
  for (const scale of [0.01, 100]) {
    const calibrated = score(scale);
    assert.equal(calibrated.valid, false);
    const row = evaluateTarget("item-list", samples(1), budget, calibrated);
    assert.equal(row.status, "invalid");
    assert.equal(performanceExitCode("blocking", [row]), 1);
  }
  assert.equal(calibration([0.001, 0.002, 0.003, 0.006, 0.03, 0.04, 0.06], config.baseline).valid, false);
  for (const invalid of [[], [0], [NaN], [Infinity], [-1]]) assert.throws(() => median(invalid));
});

test("versioned configuration rejects missing reasons, modes, targets and invalid bounds", () => {
  assert.equal(validateBudget(config), config);
  for (const edit of [c => c.version++, c => c.ciMode = "skip", c => c.reason = "", c => c.samples = 2,
    c => c.warmups = 0, c => c.baseline.referenceMs = 0, c => c.baseline.maxScale = 1000,
    c => c.shape.batches = 0, c => delete c.targets["merge-deliveries"], c => c.targets["item-list"].iterations = 0,
    c => c.timingUnit = "wall-ms", c => c.maxCiDurationMs = 0, c => c.maxLocalDurationMs = 999999]) {
    const changed = structuredClone(config); edit(changed); assert.throws(() => validateBudget(changed));
  }
});

test("reports preserve all samples and show measured, effective and suggested budgets", () => {
  const original = samples(350), before = [...original];
  const row = evaluateTarget("merge-deliveries", original, budget, score(1));
  assert.deepEqual(original, before);
  assert.deepEqual(row.samplesMs, before);
  const markdown = performanceMarkdown({ mode: "advisory", status: "exceeded", head: "a".repeat(40), configDigest: "b".repeat(64),
    shape: { items: 200, events: 40000, deliveries: 20, batches: 5 }, calibration: score(1), targets: [row],
    timings: { fixtureMs: 1, calibrationMs: 1, warmupMs: 1, samplesMs: 1, totalMs: 4 } });
  for (const text of ["advisory", "exceeded", "350.0", "100.0", "525.0", "do not block CI", "200 items", "40000 events"]) assert.ok(markdown.includes(text), text);
});
