import assert from "node:assert/strict";
import { test } from "node:test";
import { buildTimingReport, fetchJobs, markdown } from "./ci-timing-report.mjs";
import UITimingReporter from "./ui-timing-reporter.mjs";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const identity = { head: "a".repeat(40), runId: "123", attempt: "1" };
const catalog = ["tests/ui/a.audit.spec.ts", "tests/ui/b.audit.spec.ts"];
function fixture() {
  return { identity, catalog, plan: { ...identity, mode: "full", visual: true, shards: [1, 2], shardFiles: catalog.map(f => [f]) },
    jobs: [{ name: "ui", status: "completed", conclusion: "success", started_at: "2026-01-01T00:00:00Z", completed_at: "2026-01-01T00:00:03Z" }],
    reports: [...catalog, "tests/ui/visual.spec.ts"].map((file, i) => ({ version: 1, ...identity, kind: i === 2 ? "visual" : "audit", shard: i === 2 ? 1 : i + 1,
      mode: "full", status: "passed", durationMs: 1000, expectedTests: 1,
      tests: [{ id: `test-${i}`, file, durationMs: 123.5, status: "passed", expectedStatus: "passed", retry: 0 }] })) };
}

test("complete successful reports retain precise timings and can be used to review weights", () => {
  const report = buildTimingReport(fixture());
  assert.equal(report.eligibleForWeights, true);
  assert.deepEqual(report.warnings, []);
  assert.equal(report.jobs[0].durationMs, 3000);
  assert.equal(report.files[0].durationMs, 123.5);
  assert.match(markdown(report), /Eligible weight sample: \*\*yes\*\*/);
});

test("missing/stale/duplicate reports, changed allocations, retries and failed jobs never become weight samples", () => {
  const cases = [
    f => f.reports.pop(), f => { f.reports[0].attempt = "0"; }, f => f.reports.push(f.reports[0]),
    f => { f.reports[0].tests[0].retry = 1; }, f => { f.reports[0].tests[0].status = "failed"; },
    f => { f.reports[0].tests[0].expectedStatus = "failed"; }, f => { f.reports[0].status = "interrupted"; },
    f => { f.jobs[0].conclusion = "cancelled"; }, f => { f.reports[0].tests = []; },
    f => { f.plan.mode = "targeted"; }, f => { f.plan.head = "b".repeat(40); },
    f => { f.reports[1].tests[0].file = catalog[0]; }, f => { f.reports[1].tests[0].id = "test-0"; },
    f => { f.reports[0].tests[0].file = "/private/absolute/path.spec.ts"; }, f => f.reports.push(null),
  ];
  for (const change of cases) {
    const f = fixture(); change(f);
    assert.equal(buildTimingReport(f).eligibleForWeights, false, String(change));
  }
});

test("planned skips produce an explicit non-sample report and markdown escapes API names", () => {
  const f = fixture(); f.plan = { ...identity, mode: "skip", visual: false, shards: [], auditFiles: [] }; f.reports = [];
  f.jobs[0].name = "job|<script>\nnext";
  const report = buildTimingReport(f);
  assert.equal(report.eligibleForWeights, false); assert.deepEqual(report.warnings, []);
  assert(!markdown(report).includes("<script>"));
});

test("job collection paginates the current attempt and fails visibly on API errors", async () => {
  const urls = [];
  const args = { repository: "owner/repo", runId: "123", attempt: "2", token: "fixture-only" };
  const jobs = await fetchJobs({ ...args, fetcher: async url => { urls.push(url); return { ok: true, json: async () => ({ jobs: Array.from({ length: urls.length === 1 ? 100 : 1 }, () => ({})) }) }; } });
  assert.equal(jobs.length, 101); assert(urls.every(u => u.includes("/attempts/2/jobs"))); assert(urls[1].endsWith("page=2"));
  await assert.rejects(fetchJobs({ ...args, fetcher: async () => ({ ok: false, status: 403 }) }), /403/);
});

test("Playwright reporter writes only relative locations and numeric/status data, preserving failed attempts", t => {
  const directory = mkdtempSync(join(tmpdir(), "mg-timing-")); t.after(() => rmSync(directory, { recursive: true, force: true }));
  const reporter = new UITimingReporter({ directory });
  reporter.onBegin({}, { allTests: () => [{}] });
  reporter.onTestEnd({ id: "t1", location: { file: join(process.cwd(), catalog[0]) }, expectedStatus: "passed" },
    { duration: 333.3, status: "failed", retry: 1, stdout: ["must not be copied"] });
  reporter.onEnd({ status: "failed", duration: 500 });
  const report = JSON.parse(readFileSync(join(directory, "ui-audit-1.json"), "utf8"));
  assert.equal(report.tests[0].file, catalog[0]); assert.equal(report.tests[0].retry, 1); assert.equal(report.tests[0].durationMs, 333.3);
  assert(!JSON.stringify(report).includes("must not be copied"));
});
