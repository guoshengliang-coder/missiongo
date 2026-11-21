import assert from "node:assert/strict";
import { test } from "node:test";
import { fixtureMeasurementReport, resampleFixtureOnce } from "../tests/release/fixture-measurement.mjs";

const evidence = () => ({ version: 2, head: "a".repeat(40), calibration: { valid: true }, httpCalibration: { valid: true }, status: "failed", failureKind: "regression",
  cpuTargets: Array.from({ length: 3 }, () => ({ status: "passed" })), httpTargets: Array.from({ length: 4 }, () => ({ status: "exceeded" })),
  cleaned: true, cleanupSucceeded: true, stages: ["settings", "discovery", "transfer", "validation", "compile", "measurement", "cleanup"]
    .map(name => ({ name, status: name === "measurement" ? "failed" : "passed" })) });
const result = report => ({ status: 1, stdout: JSON.stringify(report, null, 2), signal: null });

test("fixture report parsing accepts the final complete measurement, never truncated output", () => {
  const r = result(evidence()); r.stdout = '{"artifacts":[]}\n' + r.stdout;
  assert.equal(fixtureMeasurementReport(r).cleaned, true);
  assert.equal(fixtureMeasurementReport({ stdout: r.stdout.slice(0, -2) }), null);
});
test("version fixture records rejection and returns the unchanged second result, at most once", () => {
  let calls = 0, observations = 0; const first = result(evidence()), second = { status: 1, stderr: "Web changed since" };
  assert.equal(resampleFixtureOnce(() => ++calls === 1 ? first : second, { purpose: "version-guard", rejected: r => { observations++; assert.equal(r.status, "failed"); } }), second);
  assert.equal(calls, 2); assert.equal(observations, 1);
  calls = 0;
  assert.equal(resampleFixtureOnce(() => { calls++; return first; }, { purpose: "version-guard", rejected: () => {} }), first);
  assert.equal(calls, 2);
});
test("only invalid calibration can resample a diagnostic; a genuine miss remains a failure", () => {
  const report = { ...evidence(), status: "invalid", experiment: "release-fivefold-merge-deliveries", measurementStatus: "failed", diagnosticOutcome: "not_detected" };
  let calls = 0;
  resampleFixtureOnce(() => { calls++; return result(report); }, { purpose: "diagnostic-calibration", rejected: () => assert.fail("Valid calibration cannot retry a diagnostic miss") });
  assert.equal(calls, 1);
  report.httpCalibration.valid = false; calls = 0;
  resampleFixtureOnce(() => { calls++; return result(report); }, { purpose: "diagnostic-calibration", rejected: () => {} });
  assert.equal(calls, 2);
});
test("setup, cleanup, incomplete stages, process errors and successful runs never resample", () => {
  for (const change of [r => { r.cleaned = false; }, r => { r.cleanupSucceeded = false; }, r => { r.failureKind = "preparation"; },
    r => { r.stages.pop(); }, r => { r.stages[0].status = "failed"; }, r => { r.cpuTargets.pop(); },
    r => { delete r.calibration.valid; }, r => { r.version = 99; }]) {
    const report = evidence(); change(report); let calls = 0;
    resampleFixtureOnce(() => { calls++; return result(report); }, { purpose: "version-guard", rejected: () => assert.fail("Incomplete measurement cannot retry") });
    assert.equal(calls, 1);
  }
  for (const first of [{ ...result(evidence()), signal: "SIGTERM" }, { ...result(evidence()), status: 0 }, { ...result(evidence()), error: new Error("timeout") }]) {
    let calls = 0; assert.equal(resampleFixtureOnce(() => { calls++; return first; }, { purpose: "version-guard", rejected: () => assert.fail() }), first); assert.equal(calls, 1);
  }
});
