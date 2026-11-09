import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";

// Reports are Actions evidence supplied explicitly by a reviewer, not a signed
// attestation. This calculator never changes CI mode or branch protection.
export function summarizeObservations(reports, ledger, configDigest) {
  assert.equal(ledger.version, 1);
  assert.ok(Array.isArray(ledger.reviews));
  const reviews = new Map();
  for (const review of ledger.reviews) {
    assert.ok(typeof review.runId === "string" && typeof review.attempt === "string" && typeof review.note === "string" && review.note.trim());
    assert.ok(["pass", "false_positive", "regression"].includes(review.decision));
    const key = `${review.runId}/${review.attempt}`;
    assert.ok(!reviews.has(key), "Duplicate review"); reviews.set(key, review);
  }
  let invalid = 0, unrelated = 0, unreviewed = 0, reviewed = 0, falsePositives = 0, regressions = 0;
  const days = new Set(), identities = new Set();
  for (const report of reports) {
    if (typeof report.configDigest !== "string") { invalid++; continue; }
    if (report.configDigest !== configDigest) { unrelated++; continue; }
    const key = `${report.runId}/${report.attempt}`;
    assert.ok(!identities.has(key), "Duplicate report/run attempt"); identities.add(key);
    const valid = report.version === 1 && /^\d+$/.test(report.runId ?? "") && /^\d+$/.test(report.attempt ?? "")
      && /^[a-f0-9]{40}$/.test(report.head ?? "") && report.dirty === false && !report.experiment && report.calibration?.valid === true
      && Number.isFinite(Date.parse(report.measuredAt)) && ["passed", "exceeded"].includes(report.status)
      && Array.isArray(report.targets) && report.targets.length === 3
      && JSON.stringify(report.targets.map(t => t.name).sort()) === JSON.stringify(["item-list", "item-summary", "merge-deliveries"])
      && report.targets.every(t => ["passed", "exceeded"].includes(t.status))
      && (report.status === "passed" ? report.targets.every(t => t.status === "passed") : report.targets.some(t => t.status === "exceeded"));
    if (!valid) { invalid++; continue; }
    const review = reviews.get(key);
    if (!review || review.configDigest !== configDigest || review.head !== report.head) { unreviewed++; continue; }
    assert.equal(review.decision === "pass", report.status === "passed", "Review contradicts the measured result");
    reviewed++;
    if (review.decision === "false_positive") falsePositives++;
    if (review.decision === "regression") regressions++;
    days.add(new Date(report.measuredAt).toISOString().slice(0, 10));
  }
  const sorted = [...days].sort();
  const spanDays = sorted.length ? (Date.parse(sorted.at(-1)) - Date.parse(sorted[0])) / 86_400_000 : 0;
  // At least 7 full elapsed days, with evidence every UTC day in the window.
  const continuous = sorted.length >= 8 && sorted.length === spanDays + 1;
  return { version: 1, configDigest, reports: reports.length, reviewed, unreviewed, invalid, unrelated,
    falsePositives, regressions, falsePositiveRate: reviewed ? falsePositives / reviewed : null,
    firstDay: sorted[0] ?? null, lastDay: sorted.at(-1) ?? null, spanDays, continuous,
    eligibleForBlockingReview: continuous && falsePositives === 0 && regressions === 0 && unreviewed === 0 && invalid === 0,
    limitation: "Review eligibility only: verify original Actions evidence and approve a separate PR; no automatic promotion" };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const paths = process.argv.slice(2);
  assert.ok(paths.length, "Pass explicit downloaded report.json paths; no evidence is not zero false positives");
  const configDigest = createHash("sha256").update(readFileSync(new URL("../tests/performance/server-budgets.json", import.meta.url))).digest("hex");
  const ledger = JSON.parse(readFileSync(new URL("../tests/performance/observations.json", import.meta.url)));
  console.log(JSON.stringify(summarizeObservations(paths.map(p => JSON.parse(readFileSync(p))), ledger, configDigest), null, 2));
}
