import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { calibration, evaluateTarget } from "./performance-budget.mjs";
import { summarizeObservations } from "./performance-observations.mjs";

const digest = "c".repeat(64), head = "a".repeat(40);
const config = JSON.parse(readFileSync(new URL("../tests/performance/server-budgets.json", import.meta.url)));
const samples = value => Array(config.samples).fill(value);
const report = (day, status = "passed") => {
  const calibrated = calibration(samples(config.baseline.referenceMs), config.baseline);
  return { version: 1, runId: String(100 + day), attempt: "1", head, dirty: false, experiment: null,
    configDigest: digest, measuredAt: `2026-01-${String(day).padStart(2, "0")}T12:00:00.000Z`, status,
    timingUnit: config.timingUnit, mode: config.ciMode, platform: "linux", arch: "x64", node: "v22.13.0",
    shape: { ...config.shape, items: 200, events: 40000, deliveries: 20 },
    calibration: { ...calibrated, wallSamplesMs: samples(config.baseline.referenceMs) },
    targets: Object.entries(config.targets).map(([name, budget]) => {
      const value = budget.budgetMs * (status === "passed" ? 0.5 : 2);
      return { ...evaluateTarget(name, samples(value), budget, calibrated), wallSamplesMs: samples(value) };
    }), timings: { fixtureMs: 3000, calibrationMs: 500, warmupMs: 1000, samplesMs: 6000, totalMs: 11000 } };
};
const ledger = reports => ({ version: 1, reviews: reports.map(r => ({ runId: r.runId, attempt: r.attempt, head,
  configDigest: digest, decision: r.status === "passed" ? "pass" : "false_positive", note: "Human evidence review" })) });
const summarize = (reports, reviews = ledger(reports)) => summarizeObservations(reports, reviews, digest, config);
const week = () => Array.from({ length: 8 }, (_, i) => report(i + 1));

test("no evidence, local/dirty/invalid runs and unreviewed warnings never prove zero false positives", () => {
  assert.equal(summarize([]).falsePositiveRate, null);
  assert.equal(summarize([report(1, "exceeded")], ledger([])).unreviewed, 1);
  for (const edit of [r => r.runId = null, r => r.dirty = true, r => r.calibration.valid = false,
    r => r.status = "incomplete", r => r.targets = [], r => r.experiment = "fivefold", r => r.targets[0].name = "wrong", r => delete r.configDigest]) {
    const broken = report(1); edit(broken);
    const result = summarize([broken], ledger([report(1)]));
    assert.equal(result.invalid, 1); assert.equal(result.eligibleForBlockingReview, false);
  }
});

test("requires 168 real elapsed hours as well as daily coverage", () => {
  const reports = week();
  assert.equal(summarize(reports).eligibleForBlockingReview, true);
  assert.equal(summarize(reports).elapsedHours, 168);
  reports[0].measuredAt = "2026-01-01T23:59:00.000Z";
  reports.at(-1).measuredAt = "2026-01-08T00:01:00.000Z";
  const short = summarize(reports);
  assert.equal(short.continuous, true);
  assert.equal(short.calendarSpanDays, 7);
  assert.ok(short.elapsedHours < 168);
  assert.equal(short.eligibleForBlockingReview, false);
  const boundary = week();
  boundary.at(-1).measuredAt = "2026-01-08T11:59:59.999Z";
  assert.equal(summarize(boundary).eligibleForBlockingReview, false);
  boundary.at(-1).measuredAt = "2026-01-08T12:00:00.000Z";
  assert.equal(summarize(boundary).eligibleForBlockingReview, true);
  for (const selected of [week().slice(1), week().filter((_, i) => i !== 3)]) assert.equal(summarize(selected).eligibleForBlockingReview, false);
});

test("a reviewed false positive cannot disappear when its report is omitted", () => {
  const reports = week(), reviews = ledger(reports);
  reviews.reviews.push({ ...reviews.reviews[0], runId: "999", decision: "false_positive" });
  const result = summarize(reports, reviews);
  assert.equal(result.reviewed, 8);
  assert.equal(result.missingReports, 1);
  assert.equal(result.knownFalsePositiveReviews, 1);
  assert.equal(result.missingReportReviews[0].decision, "false_positive");
  assert.equal(result.falsePositiveRate, null);
  assert.equal(result.eligibleForBlockingReview, false);
  for (const decision of ["pass", "regression"]) {
    reviews.reviews.at(-1).decision = decision;
    assert.equal(summarize(reports, reviews).eligibleForBlockingReview, false);
  }
});

test("reconciliation binds report and review to the same run, attempt, head and config", () => {
  const reports = week(), changed = structuredClone(reports);
  changed[3].configDigest = "d".repeat(64);
  const mixed = summarize(changed, ledger(reports));
  assert.equal(mixed.unrelated, 1); assert.equal(mixed.missingReports, 1);
  assert.equal(mixed.eligibleForBlockingReview, false);
  const wrongHead = ledger(reports); wrongHead.reviews[2].head = "b".repeat(40);
  assert.equal(summarize(reports, wrongHead).unreviewed, 1);
  const wrongAttempt = ledger(reports); wrongAttempt.reviews[2].attempt = "2";
  assert.equal(summarize(reports, wrongAttempt).missingReports, 1);
  const otherConfig = ledger(reports); otherConfig.reviews.push({ ...otherConfig.reviews[0], runId: "999", configDigest: "d".repeat(64) });
  assert.equal(summarize(reports, otherConfig).eligibleForBlockingReview, true);
  assert.throws(() => summarize([reports[0], reports[0]], ledger([reports[0]])));
});

test("status-only reports without numeric evidence are invalid", () => {
  const reports = week();
  const bare = reports.map(r => ({ version: 1, runId: r.runId, attempt: r.attempt, head: r.head, dirty: false,
    configDigest: digest, measuredAt: r.measuredAt, status: "passed", calibration: { valid: true },
    targets: r.targets.map(t => ({ name: t.name, status: "passed" })) }));
  const result = summarize(bare, ledger(reports));
  assert.equal(result.reviewed, 0); assert.equal(result.invalid, 8);
  assert.equal(result.falsePositiveRate, null); assert.equal(result.eligibleForBlockingReview, false);
});

test("raw samples, derived calibration, shape, units and budgets must agree", () => {
  const reports = week();
  for (const edit of [
    r => delete r.calibration.samplesMs, r => r.calibration.samplesMs.pop(), r => r.calibration.samplesMs[0] = NaN,
    r => r.calibration.scale *= 2, r => r.calibration.referenceMs *= 2, r => r.calibration.relativeIqr = -1,
    r => delete r.targets[0].samplesMs, r => r.targets[0].samplesMs[0] = Infinity, r => r.targets[0].wallSamplesMs[0] = 0,
    r => r.targets[0].medianMs *= 2, r => r.targets[0].normalizedMs *= 2,
    r => r.targets[0].effectiveBudgetMs *= 2, r => r.targets[0].referenceBudgetMs *= 2,
    r => r.targets[0].suggestedReferenceBudgetMs *= 2, r => r.targets[0].status = "exceeded",
    r => r.shape.events--, r => r.timingUnit = "wall-ms", r => r.mode = "ignore", r => delete r.node,
    r => r.measuredAt = "2026-02-31T12:00:00.000Z",
    r => delete r.timings, r => r.timings.samplesMs = -1, r => r.timings.totalMs = 1,
  ]) {
    const mutated = structuredClone(reports); edit(mutated[3]);
    const result = summarize(mutated, ledger(reports));
    assert.equal(result.invalid, 1); assert.equal(result.eligibleForBlockingReview, false);
  }
});

test("false positive rate is unavailable for incomplete evidence and never inferred from green advisory CI", () => {
  const reports = [report(1), report(2, "exceeded"), report(3, "exceeded")];
  const incomplete = summarize(reports, ledger(reports.slice(0, 2)));
  assert.equal(incomplete.falsePositives, 1); assert.equal(incomplete.unreviewed, 1);
  assert.equal(incomplete.falsePositiveRate, null); assert.equal(incomplete.eligibleForBlockingReview, false);
  assert.equal(summarize(reports).falsePositiveRate, 2 / 3);
  const contradictory = ledger(reports); contradictory.reviews[1].decision = "pass";
  assert.throws(() => summarize(reports, contradictory));
});
