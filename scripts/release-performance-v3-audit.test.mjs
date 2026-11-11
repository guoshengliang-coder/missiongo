import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { runReleasePerformance } from "./release-performance.mjs";

const budget = JSON.parse(readFileSync(new URL("../tests/performance/server-budgets.json", import.meta.url)));
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "and505-audit-"));
  mkdirSync(join(root, "tests/performance"), { recursive: true });
  writeFileSync(join(root, "tests/performance/server-budgets.json"), JSON.stringify(budget));
  return { root, done: () => rmSync(root, { recursive: true, force: true }) };
}

// An independent supervisor oracle: do not invoke the production stage writer.
// This models a parent that is descheduled across a phase transition.
const names = ["settings", "discovery", "transfer", "validation", "compile", "measurement"];
function progress(measurementStart, endedAt, version = 2) {
  return { version, startedMonotonicMs: 0, stage: "measurement", stages: names.map((name, i) => ({
    name, startedMs: name === "measurement" ? measurementStart : Math.min(i, measurementStart),
    durationMs: name === "measurement" ? endedAt - measurementStart : 0, status: "passed",
  })) };
}

for (const [label, measurementStart, endedAt, kind] of [
  ["preparation crossed before its first observed measurement", 120001, 120002, "preparation"],
  ["measurement exceeded while the parent was descheduled", 10, 120011, "measurement"],
]) test(label, async () => {
  const f = fixture(); let clock = 0;
  try {
    const report = await runReleasePerformance({ root: f.root }, { now: () => clock, runGroup: async args => {
      const dir = args.at(-2);
      // Independent v2 record; pre-fix reproduction used the accepted v1 header.
      writeFileSync(join(dir, "progress.json"), JSON.stringify(progress(measurementStart, endedAt)));
      writeFileSync(join(dir, "result.json"), '{"status":"passed"}');
      clock = endedAt; return { status: 0 };
    } });
    assert.equal(report.status, "invalid"); assert.equal(report.failureKind, kind); assert.equal(report.cleaned, true);
  } finally { f.done(); }
});

test("a zero exit and passed label cannot replace missing stage evidence", async () => {
  const f = fixture();
  try {
    const report = await runReleasePerformance({ root: f.root }, { runGroup: async args => {
      writeFileSync(join(args.at(-2), "result.json"), '{"status":"passed"}'); return { status: 0 };
    } });
    assert.equal(report.status, "invalid"); assert.equal(report.failureKind, "contract"); assert.equal(report.cleaned, true);
  } finally { f.done(); }
});

test("cleanup cancellation after removal keeps actual deletion separate from command success", async () => {
  const f = fixture(); let seen;
  try {
    const report = await runReleasePerformance({ root: f.root }, { cleanup: async dir => { rmSync(dir, { recursive: true }); return false; }, runGroup: async args => {
      seen = args.at(-2); writeFileSync(join(seen, "result.json"), '{"status":"passed"}'); return { status: 0 };
    } });
    assert.equal(existsSync(seen), false); assert.equal(report.cleaned, true); assert.equal(report.status, "invalid"); assert.equal(report.failureKind, "cleanup");
  } finally { f.done(); }
});

test("overlapping or future completed stage records cannot authorize publication", async () => {
  for (const edit of [p => { p.stages[4].durationMs = 1000; }, p => { p.stages.at(-1).durationMs = 500; }]) {
    const f = fixture(); let clock = 0;
    try {
      const report = await runReleasePerformance({ root: f.root }, { now: () => clock, runGroup: async args => {
        const p = progress(5, 10); edit(p);
        writeFileSync(join(args.at(-2), "progress.json"), JSON.stringify(p));
        writeFileSync(join(args.at(-2), "result.json"), '{"status":"passed"}');
        clock = 10; return { status: 0 };
      } });
      assert.equal(report.status, "invalid"); assert.equal(report.failureKind, "contract");
    } finally { f.done(); }
  }
});

test("diagnostic metadata cannot turn missing stage proof into a detected regression", async () => {
  const f = fixture();
  try {
    const report = await runReleasePerformance({ root: f.root }, { runGroup: async args => {
      writeFileSync(join(args.at(-2), "result.json"), JSON.stringify({ status: "passed", experiment: "release-fivefold-item-list",
        calibration: { valid: true }, httpCalibration: { valid: true }, cpuTargets: [{ name: "item-list", status: "exceeded" }] }));
      return { status: 0 };
    } });
    assert.equal(report.diagnosticOutcome, "not_detected"); assert.equal(report.status, "invalid");
    assert.equal(report.failureKind, "contract"); assert.match(report.reason, /stage evidence/);
  } finally { f.done(); }
});
