import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { calibration, evaluateTarget, validateBudget } from "./performance-budget.mjs";

const positive = value => Number.isFinite(value) && value > 0;
const identifier = value => typeof value === "string" && /^[1-9]\d*$/.test(value);
const sha = value => typeof value === "string" && /^[a-f0-9]{40}$/.test(value);
const digest = value => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const sameNumber = (actual, expected) => Number.isFinite(actual) && Math.abs(actual - expected) <= Math.max(1e-9, Math.abs(expected) * 1e-8);
const samplesValid = (samples, count) => Array.isArray(samples) && samples.length === count && samples.every(positive);

/** Status labels alone are not measurement evidence. Recompute from raw CPU
 * samples and the exact versioned config; wall samples remain required context. */
function validMeasurement(report, config) {
  try {
    if (report.version !== 1 || !identifier(report.runId) || !identifier(report.attempt) || !sha(report.head)
      || report.dirty !== false || report.experiment !== null || report.mode !== config.ciMode || report.timingUnit !== config.timingUnit
      || typeof report.platform !== "string" || !report.platform || typeof report.arch !== "string" || !report.arch
      || typeof report.node !== "string" || !/^v\d+\.\d+\.\d+(?:[-+].*)?$/.test(report.node)
      || typeof report.measuredAt !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(report.measuredAt)
      || !Number.isFinite(Date.parse(report.measuredAt))) return false;
    const canonicalTime = report.measuredAt.includes(".") ? report.measuredAt : report.measuredAt.replace("Z", ".000Z");
    if (new Date(report.measuredAt).toISOString() !== canonicalTime) return false;
    const shape = config.shape, items = shape.batches * shape.deliveriesPerBatch * shape.itemsPerDelivery;
    assert.deepEqual(report.shape, { ...shape, items, events: items * shape.eventsPerItem, deliveries: shape.batches * shape.deliveriesPerBatch });
    const measured = report.calibration;
    if (!measured || !samplesValid(measured.samplesMs, config.samples) || !samplesValid(measured.wallSamplesMs, config.samples)) return false;
    const calculated = calibration(measured.samplesMs, config.baseline);
    if (!calculated.valid || measured.valid !== true || measured.reason !== calculated.reason
      || !["medianMs", "referenceMs", "scale", "relativeIqr"].every(key => sameNumber(measured[key], calculated[key]))) return false;
    if (!Array.isArray(report.targets)) return false;
    assert.deepEqual(report.targets.map(t => t.name).sort(), Object.keys(config.targets).sort());
    for (const target of report.targets) {
      if (!samplesValid(target.samplesMs, config.samples) || !samplesValid(target.wallSamplesMs, config.samples)) return false;
      const expected = evaluateTarget(target.name, target.samplesMs, config.targets[target.name], calculated);
      if (target.status !== expected.status || !["medianMs", "normalizedMs", "referenceBudgetMs", "effectiveBudgetMs", "suggestedReferenceBudgetMs"]
        .every(key => sameNumber(target[key], expected[key]))) return false;
    }
    const expectedStatus = report.targets.some(t => t.status === "exceeded") ? "exceeded" : "passed";
    if (report.status !== expectedStatus) return false;
    const stages = ["fixtureMs", "calibrationMs", "warmupMs", "samplesMs"];
    if (!report.timings || ![...stages, "totalMs"].every(key => positive(report.timings[key]))
      || report.timings.totalMs + 1e-6 < stages.reduce((sum, key) => sum + report.timings[key], 0)) return false;
    return true;
  } catch { return false; }
}

// Reports are Actions evidence supplied explicitly by a reviewer, not a signed
// attestation. This calculator never changes CI mode or branch protection.
export function summarizeObservations(reports, ledger, configDigest, config) {
  validateBudget(config);
  assert.ok(digest(configDigest), "Invalid expected configuration digest");
  assert.ok(Array.isArray(reports));
  assert.equal(ledger.version, 1);
  assert.ok(Array.isArray(ledger.reviews));
  const reviews = new Map();
  for (const review of ledger.reviews) {
    assert.ok(identifier(review.runId) && identifier(review.attempt) && sha(review.head) && digest(review.configDigest)
      && typeof review.note === "string" && review.note.trim(), "Incomplete review identity");
    assert.ok(["pass", "false_positive", "regression"].includes(review.decision));
    const key = `${review.runId}/${review.attempt}`;
    assert.ok(!reviews.has(key), "Duplicate review"); reviews.set(key, review);
  }
  let invalid = 0, unrelated = 0, unreviewed = 0, reviewed = 0, falsePositives = 0, regressions = 0;
  const days = new Set(), identities = new Set(), measuredTimes = [];
  for (const report of reports) {
    if (!report || !digest(report.configDigest)) { invalid++; continue; }
    if (report.configDigest !== configDigest) { unrelated++; continue; }
    const key = `${report.runId}/${report.attempt}`;
    assert.ok(!identities.has(key), "Duplicate report/run attempt"); identities.add(key);
    if (!validMeasurement(report, config)) { invalid++; continue; }
    const review = reviews.get(key);
    if (!review || review.configDigest !== configDigest || review.head !== report.head) { unreviewed++; continue; }
    assert.equal(review.decision === "pass", report.status === "passed", "Review contradicts the measured result");
    reviewed++;
    if (review.decision === "false_positive") falsePositives++;
    if (review.decision === "regression") regressions++;
    days.add(new Date(report.measuredAt).toISOString().slice(0, 10));
    measuredTimes.push(Date.parse(report.measuredAt));
  }
  const currentReviews = [...reviews.values()].filter(review => review.configDigest === configDigest);
  const missingReportReviews = currentReviews.filter(review => !identities.has(`${review.runId}/${review.attempt}`))
    .map(({ runId, attempt, head, decision }) => ({ runId, attempt, head, decision }));
  const knownFalsePositiveReviews = currentReviews.filter(review => review.decision === "false_positive").length;
  const knownRegressionReviews = currentReviews.filter(review => review.decision === "regression").length;
  const sorted = [...days].sort();
  const calendarSpanDays = sorted.length ? (Date.parse(sorted.at(-1)) - Date.parse(sorted[0])) / 86_400_000 : 0;
  const firstTime = measuredTimes.length ? Math.min(...measuredTimes) : null;
  const lastTime = measuredTimes.length ? Math.max(...measuredTimes) : null;
  const elapsedHours = firstTime === null ? 0 : (lastTime - firstTime) / 3_600_000;
  const continuous = sorted.length >= 8 && sorted.length === calendarSpanDays + 1;
  const missingReports = missingReportReviews.length;
  return { version: 1, configDigest, reports: reports.length, reviewed, unreviewed, invalid, unrelated,
    missingReports, missingReportReviews, knownFalsePositiveReviews, knownRegressionReviews,
    falsePositives, regressions, falsePositiveRate: reviewed && !missingReports && !invalid && !unreviewed ? falsePositives / reviewed : null,
    firstDay: sorted[0] ?? null, lastDay: sorted.at(-1) ?? null, calendarSpanDays,
    firstMeasuredAt: firstTime === null ? null : new Date(firstTime).toISOString(),
    lastMeasuredAt: lastTime === null ? null : new Date(lastTime).toISOString(), spanDays: elapsedHours / 24, elapsedHours, continuous,
    eligibleForBlockingReview: continuous && elapsedHours >= 168 && knownFalsePositiveReviews === 0 && knownRegressionReviews === 0
      && unreviewed === 0 && invalid === 0 && missingReports === 0,
    limitation: "Review eligibility only: verify original Actions evidence and approve a separate PR; no automatic promotion" };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const paths = process.argv.slice(2);
  assert.ok(paths.length, "Pass explicit downloaded report.json paths; no evidence is not zero false positives");
  const configBytes = readFileSync(new URL("../tests/performance/server-budgets.json", import.meta.url));
  const configDigest = createHash("sha256").update(configBytes).digest("hex");
  const ledger = JSON.parse(readFileSync(new URL("../tests/performance/observations.json", import.meta.url)));
  console.log(JSON.stringify(summarizeObservations(paths.map(p => JSON.parse(readFileSync(p))), ledger, configDigest, JSON.parse(configBytes)), null, 2));
}
