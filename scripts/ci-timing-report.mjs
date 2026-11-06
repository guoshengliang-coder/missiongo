#!/usr/bin/env node
import { appendFileSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const milliseconds = (start, end) => {
  if (!start || !end) return null;
  const duration = Date.parse(end) - Date.parse(start);
  return Number.isFinite(duration) && duration >= 0 ? duration : null;
};
const cell = value => String(value ?? "—").replace(/[|\r\n<>]/g, " ");
const seconds = value => value == null ? "—" : `${(value / 1000).toFixed(1)}s`;

export function buildTimingReport({ jobs, reports, plan, catalog, identity, warnings = [] }) {
  const issues = [...warnings], audit = [], visual = [];
  for (const report of reports) {
    if (!report || report.version !== 1 || report.head !== identity.head || report.runId !== identity.runId || report.attempt !== identity.attempt
      || !["audit", "visual"].includes(report.kind) || !Array.isArray(report.tests) || !Number.isFinite(report.durationMs)
      || !Number.isInteger(report.shard) || report.shard < 1 || !Number.isInteger(report.expectedTests) || report.expectedTests < 1
      || report.tests.some(t => !t || typeof t.id !== "string" || !/^tests\/ui\/[\w.-]+\.spec\.ts$/.test(t.file) || !Number.isFinite(t.durationMs) || t.durationMs < 0)) {
      issues.push("Invalid or stale UI timing report"); continue;
    }
    (report.kind === "audit" ? audit : visual).push(report);
  }
  const wanted = ["full", "targeted"].includes(plan?.mode) && Array.isArray(plan.shards) ? plan.shards : [];
  if (audit.length !== wanted.length || new Set(audit.map(r => r.shard)).size !== audit.length
    || wanted.some(shard => !audit.some(r => r.shard === shard))) issues.push("Missing or duplicate audit timing shards");
  if (visual.length !== (plan?.visual ? 1 : 0)) issues.push("Missing or duplicate visual timing report");
  const files = {};
  for (const report of audit) for (const test of report.tests) {
    files[test.file] ??= { durationMs: 0, attempts: 0 };
    files[test.file].durationMs += test.durationMs; files[test.file].attempts++;
  }
  const actual = Object.keys(files).sort();
  const expected = (plan?.mode === "full" ? catalog : plan?.auditFiles ?? []).slice().sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) issues.push("UI timing files do not cover the selected catalog");
  for (const report of [...audit, ...visual]) {
    const ids = report.tests.map(t => t.id);
    if (report.status !== "passed" || report.mode !== plan?.mode || report.tests.length !== report.expectedTests
      || new Set(ids).size !== ids.length || report.tests.some(t => t.retry !== 0 || t.status !== "passed" || t.expectedStatus !== "passed")) {
      issues.push("UI timing contains failure, retry, skip or incomplete execution");
    }
  }
  const allIds = audit.flatMap(r => r.tests.map(t => t.id));
  if (new Set(allIds).size !== allIds.length) issues.push("Duplicate audit test execution across shards");
  for (const report of audit) {
    const selected = (plan?.mode === "full" ? plan.shardFiles?.[report.shard - 1] : plan?.auditFiles) ?? [];
    if (JSON.stringify([...new Set(report.tests.map(t => t.file))].sort()) !== JSON.stringify([...selected].sort())) issues.push("Timing shard does not match planned files");
  }
  if (!plan || !["full", "targeted", "skip", "snapshots"].includes(plan.mode) || plan.head !== identity.head) issues.push("Missing or stale UI plan");
  const summaryJobs = jobs.filter(j => j.name !== "ci-timing-report").map(job => ({
    name: job.name, status: job.status, conclusion: job.conclusion,
    // Job creation follows dependency readiness; workflow creation would
    // incorrectly count dependency execution as runner queue time.
    queueMs: job.conclusion === "skipped" ? null : milliseconds(job.created_at, job.started_at),
    durationMs: milliseconds(job.started_at, job.completed_at),
    steps: (job.steps ?? []).map(step => ({ name: step.name, conclusion: step.conclusion, durationMs: milliseconds(step.started_at, step.completed_at) })),
  })).sort((a, b) => (b.durationMs ?? 0) - (a.durationMs ?? 0));
  if (!summaryJobs.length || summaryJobs.some(j => j.status !== "completed" || !["success", "skipped"].includes(j.conclusion))) issues.push("CI jobs failed, cancelled or unavailable");
  return { version: 1, ...identity, mode: plan?.mode ?? "unknown", warnings: [...new Set(issues)],
    eligibleForWeights: plan?.mode === "full" && issues.length === 0,
    jobs: summaryJobs,
    shards: audit.map(r => ({ shard: r.shard, durationMs: r.durationMs, testCount: r.expectedTests, status: r.status })).sort((a, b) => a.shard - b.shard),
    files: Object.entries(files).map(([file, data]) => ({ file, ...data })).sort((a, b) => b.durationMs - a.durationMs),
  };
}

export function markdown(report) {
  return ["## CI timing", "", `UI mode: **${cell(report.mode)}** · Eligible weight sample: **${report.eligibleForWeights ? "yes" : "no"}**`, "",
    ...report.warnings.map(w => `- ${cell(w)}`), "",
    `Run: ${cell(report.runId)} · Attempt: ${cell(report.attempt)}`, "",
    "| Job | Result | Queue | Execution |", "| --- | --- | --- | --- |",
    ...report.jobs.map(j => `| ${cell(j.name)} | ${cell(j.conclusion ?? j.status)} | ${seconds(j.queueMs)} | ${seconds(j.durationMs)} |`), "",
    "### UI shards", "", "| Shard | Tests | Duration |", "| --- | --- | --- |",
    ...report.shards.map(s => `| ${s.shard} | ${s.testCount} | ${seconds(s.durationMs)} |`), "",
    "### Slowest UI files", "", "| File | Attempts | Test duration |", "| --- | --- | --- |",
    ...report.files.slice(0, 15).map(f => `| ${cell(f.file)} | ${f.attempts} | ${seconds(f.durationMs)} |`), "",
    "Queue is job creation to runner start, excluding dependency execution. Missing, invalid or skipped queue timings are shown as —. Execution includes setup and teardown; file durations sum test attempts. Jobs run concurrently: do not add these values to estimate workflow elapsed time. This report covers only the displayed attempt and excludes its own job. Reports never change coverage or weights automatically.", ""].join("\n");
}

export async function fetchJobs({ repository, runId, attempt, token, fetcher = fetch }) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository) || !/^\d+$/.test(runId) || !/^\d+$/.test(attempt)) throw new Error("Invalid workflow identity");
  const jobs = [];
  for (let page = 1; ; page++) {
    // Attempt-specific endpoint excludes old jobs when only failed jobs rerun.
    const response = await fetcher(`https://api.github.com/repos/${repository}/actions/runs/${runId}/attempts/${attempt}/jobs?per_page=100&page=${page}`,
      { headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${token}`, "X-GitHub-Api-Version": "2026-03-10" }, signal: AbortSignal.timeout(20_000) });
    if (!response.ok) throw new Error(`Jobs API returned ${response.status}`);
    const data = await response.json();
    if (!Array.isArray(data.jobs)) throw new Error("Invalid jobs response");
    jobs.push(...data.jobs);
    if (data.jobs.length < 100) return jobs;
  }
}

async function main() {
  const identity = { head: process.env.GITHUB_SHA, runId: process.env.GITHUB_RUN_ID, attempt: process.env.GITHUB_RUN_ATTEMPT };
  const warnings = [], reports = [];
  let jobs = [], plan;
  try { jobs = await fetchJobs({ ...identity, repository: process.env.GITHUB_REPOSITORY, token: process.env.GITHUB_TOKEN }); }
  catch (error) { warnings.push(error.message); }
  try { plan = JSON.parse(process.env.UI_TEST_PLAN); } catch { warnings.push("UI plan unavailable"); }
  try {
    for (const file of readdirSync("ci-timings").filter(f => /^ui-(audit|visual)-\d+\.json$/.test(f))) {
      try { reports.push(JSON.parse(readFileSync(resolve("ci-timings", file), "utf8"))); }
      catch { warnings.push(`Unreadable timing file: ${file}`); }
    }
  } catch { warnings.push("UI timing artifacts unavailable"); }
  const catalog = readdirSync("tests/ui").filter(f => f.endsWith("audit.spec.ts")).map(f => `tests/ui/${f}`);
  const report = buildTimingReport({ jobs, reports, plan, catalog, identity, warnings });
  mkdirSync("ci-timings", { recursive: true });
  writeFileSync("ci-timings/summary.json", JSON.stringify(report, null, 2) + "\n");
  const text = markdown(report);
  writeFileSync("ci-timings/summary.md", text);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, text);
  console.log(text);
}
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) await main();
