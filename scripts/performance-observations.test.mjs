import assert from "node:assert/strict";
import { test } from "node:test";
import { summarizeObservations } from "./performance-observations.mjs";

const digest = "c".repeat(64), head = "a".repeat(40);
const report = (day, status = "passed") => ({ version: 1, runId: String(100 + day), attempt: "1", head, dirty: false,
  configDigest: digest, measuredAt: `2026-01-${String(day).padStart(2, "0")}T12:00:00Z`, status, calibration: { valid: true },
  targets: ["merge-deliveries", "item-list", "item-summary"].map(name => ({ name, status })) });
const ledger = reports => ({ version: 1, reviews: reports.map(r => ({ runId: r.runId, attempt: r.attempt, head,
  configDigest: digest, decision: r.status === "passed" ? "pass" : "false_positive", note: "Human evidence review" })) });

test("no evidence, local/dirty/invalid runs and unreviewed warnings never prove zero false positives", () => {
  assert.equal(summarizeObservations([], ledger([]), digest).falsePositiveRate, null);
  const r = report(1, "exceeded");
  assert.equal(summarizeObservations([r], ledger([]), digest).unreviewed, 1);
  for (const edit of [r => r.runId = null, r => r.dirty = true, r => r.calibration.valid = false,
    r => r.status = "incomplete", r => r.targets = [], r => r.experiment = "fivefold", r => r.targets[0].name = "wrong", r => delete r.configDigest]) {
    const broken = report(1); edit(broken);
    const result = summarizeObservations([broken], ledger([report(1)]), digest);
    assert.equal(result.invalid, 1); assert.equal(result.eligibleForBlockingReview, false);
  }
});

test("requires seven elapsed days with daily reviewed evidence and a single configuration", () => {
  const reports = Array.from({ length: 8 }, (_, i) => report(i + 1));
  assert.equal(summarizeObservations(reports, ledger(reports), digest).eligibleForBlockingReview, true);
  for (const selected of [reports.slice(1), reports.filter((_, i) => i !== 3)]) assert.equal(summarizeObservations(selected, ledger(selected), digest).eligibleForBlockingReview, false);
  const changed = structuredClone(reports); changed[3].configDigest = "d".repeat(64);
  assert.equal(summarizeObservations(changed, ledger(reports), digest).eligibleForBlockingReview, false);
});

test("false positive rate uses reviewed samples, not green advisory outcomes", () => {
  const reports = [report(1), report(2, "exceeded"), report(3, "exceeded")];
  const result = summarizeObservations(reports, ledger(reports.slice(0, 2)), digest);
  assert.equal(result.falsePositiveRate, 0.5); assert.equal(result.unreviewed, 1);
  assert.equal(result.eligibleForBlockingReview, false);
  const contradictory = ledger(reports); contradictory.reviews[1].decision = "pass";
  assert.throws(() => summarizeObservations(reports, contradictory, digest));
  assert.throws(() => summarizeObservations([reports[0], reports[0]], ledger([reports[0]]), digest));
});
