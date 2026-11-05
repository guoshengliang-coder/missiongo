#!/usr/bin/env node
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { balancedAuditShards } from "./ui-shards.mjs";

const requiredJobs = ["ui-plan", "web-and-server", "ui", "ui-visual", "android", "macos", "linux-node", ...Array.from({ length: 8 }, (_, i) => `ui-audit (${i + 1})`)];
const positive = value => Number.isFinite(value) && value > 0;
const integer = value => Number.isSafeInteger(value) && value > 0;

export function validateSample(report, catalog) {
  if (!report || report.version !== 1 || report.mode !== "full" || report.eligibleForWeights !== true
    || !Array.isArray(report.warnings) || report.warnings.length || !/^[a-f0-9]{40}$/.test(report.head ?? "")
    || !/^[1-9]\d*$/.test(report.runId ?? "") || !integer(Number(report.runId)) || !/^[1-9]\d*$/.test(report.attempt ?? "") || !integer(Number(report.attempt))) throw new Error("Expected a complete successful CI timing report");
  if (!Array.isArray(report.jobs) || requiredJobs.some(name => (report.jobs.filter(j => j?.name === name).length !== 1 || !report.jobs.some(j => j?.name === name && j.status === "completed" && j.conclusion === "success")))
    || report.jobs.some(j => !j || j.status !== "completed" || !["success", "skipped"].includes(j.conclusion))) throw new Error("CI jobs are missing, failed, cancelled or unfinished");
  if (!Array.isArray(report.shards) || report.shards.length !== 8 || report.shards.some(s => !s || !integer(s.shard) || s.shard > 8 || s.status !== "passed" || !integer(s.testCount) || !positive(s.durationMs))
    || new Set(report.shards.map(s => s.shard)).size !== 8) throw new Error("Expected all eight successful UI shards");
  if (!Array.isArray(report.files) || report.files.some(f => !f || !catalog.includes(f.file) || !positive(f.durationMs) || !integer(f.attempts))
    || new Set(report.files.map(f => f.file)).size !== catalog.length
    || report.files.length !== catalog.length
    || report.files.reduce((n, f) => n + f.attempts, 0) !== report.shards.reduce((n, s) => n + s.testCount, 0)) throw new Error("Timing files must cover the current catalog exactly once with matching test counts");
  return report;
}

export function proposeWeights(reports, catalog, old) {
  if (reports.length < 2) throw new Error("Use at least two independent complete successful runs");
  reports.forEach(report => validateSample(report, catalog));
  if (new Set(reports.map(r => Number(r.runId))).size !== reports.length) throw new Error("Duplicate runs or rerun attempts cannot be independent samples");
  const seconds = Object.fromEntries([...catalog].sort().map(file => [file, Math.max(.1, Math.round(reports.reduce((sum, r) => sum + r.files.find(f => f.file === file).durationMs, 0) / reports.length / 100) / 10)]));
  const weights = { version: 1, sampleRuns: reports.map(r => Number(r.runId)).sort((a, b) => a - b), seconds };
  const loads = estimates => balancedAuditShards(catalog, estimates).map(bucket => Math.round(bucket.reduce((sum, file) => sum + seconds[file], 0) * 10) / 10);
  return { weights, review: { samples: reports.map(r => ({ runId: r.runId, attempt: r.attempt, head: r.head })),
    added: catalog.filter(file => !(file in old.seconds)), removed: Object.keys(old.seconds).filter(file => !catalog.includes(file)),
    beforeSeconds: loads(old.seconds), afterSeconds: loads(seconds),
    note: "Simulation uses the proposed file estimates; actual runner and queue times can differ." } };
}

export function writeProposal({ root, proposal, output, write = false }) {
  root = realpathSync(root);
  const target = resolve(root, "tests/ui/audit-durations.json");
  const text = JSON.stringify(proposal.weights, null, 2) + "\n";
  if (write) {
    if (output) throw new Error("Choose --output or --write");
    if (lstatSync(target).isSymbolicLink() || execFileSync("git", ["status", "--porcelain", "--", "tests/ui/audit-durations.json"], { cwd: root, encoding: "utf8" }).trim()) throw new Error("Existing weight changes were preserved; commit or review them first");
    const temporary = `${target}.proposal-${process.pid}`;
    writeFileSync(temporary, text, { flag: "wx" }); renameSync(temporary, target);
  } else if (output) {
    const path = resolve(realpathSync(dirname(resolve(output))), basename(resolve(output)));
    const tracked = spawnSync("git", ["ls-files", "--error-unmatch", "--", relative(root, path)], { cwd: root, stdio: "pipe" }).status === 0;
    if (path === target || tracked || (existsSync(path) && lstatSync(path).isSymbolicLink())) throw new Error("Use --write for weights; other tracked files and symlinks are preserved");
    writeFileSync(path, text, { flag: "wx" });
  }
  return text;
}

function main() {
  const { values } = parseArgs({ options: { report: { type: "string", multiple: true }, output: { type: "string" }, write: { type: "boolean", default: false } } });
  const root = process.cwd();
  const catalog = execFileSync("git", ["ls-files", "-z", "--", "tests/ui/*audit.spec.ts"], { cwd: root, encoding: "utf8" }).split("\0").filter(Boolean).sort();
  const old = JSON.parse(readFileSync(resolve(root, "tests/ui/audit-durations.json"), "utf8"));
  const reports = (values.report ?? []).map(file => JSON.parse(readFileSync(file, "utf8")));
  const proposal = proposeWeights(reports, catalog, old);
  const text = writeProposal({ root, proposal, output: values.output, write: values.write });
  console.error(JSON.stringify(proposal.review, null, 2));
  if (!values.output && !values.write) process.stdout.write(text);
  else console.log(values.write ? "Updated only tests/ui/audit-durations.json; review the diff before committing." : "Candidate written; tracked weights unchanged.");
}
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
