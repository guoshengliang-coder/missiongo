import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { proposeWeights, validateSample, writeProposal } from "./update-ui-weights.mjs";

const catalog = Array.from({ length: 9 }, (_, i) => `tests/ui/file-${i}.audit.spec.ts`);
function sample(runId = "123") {
  return { version: 1, mode: "full", eligibleForWeights: true, warnings: [], head: "a".repeat(40), runId, attempt: "1",
    jobs: ["ui-plan", "web-and-server", "ui", "ui-visual", "android", "macos", "linux-node", ...Array.from({ length: 8 }, (_, i) => `ui-audit (${i + 1})`)].map(name => ({ name, status: "completed", conclusion: "success" })),
    shards: Array.from({ length: 8 }, (_, i) => ({ shard: i + 1, status: "passed", testCount: i === 0 ? 2 : 1, durationMs: 1234 })),
    files: catalog.map((file, i) => ({ file, attempts: 1, durationMs: i + 1234.5 })) };
}
const old = { version: 1, seconds: { [catalog[0]]: 100, "tests/ui/removed.audit.spec.ts": 50 } };

test("two independent complete samples yield deterministic rounded means and allocation estimates", () => {
  const a = sample(), b = sample("456"); b.files[0].durationMs = 2469;
  const proposal = proposeWeights([b, a], catalog, old);
  assert.deepEqual(proposal.weights.sampleRuns, [123, 456]); assert.equal(proposal.weights.seconds[catalog[0]], 1.9);
  assert.equal(proposal.weights.seconds[catalog[1]], 1.2); assert.deepEqual(Object.keys(proposal.weights.seconds), catalog);
  assert.deepEqual(proposal.review.added, catalog.slice(1)); assert.equal(proposal.review.removed.length, 1);
  assert.equal(proposal.review.beforeSeconds.length, 8); assert.equal(proposal.review.afterSeconds.length, 8);
  assert.throws(() => proposeWeights([a], catalog, old), /at least two/);
  b.runId = a.runId; b.attempt = "2"; assert.throws(() => proposeWeights([a, b], catalog, old), /independent/);
});

test("partial/stale/failed/tampered shapes cannot silently update weights", () => {
  const mutations = [
    s => { s.eligibleForWeights = false; }, s => { s.mode = "targeted"; }, s => s.warnings.push("stale"),
    s => { s.head = "invalid"; }, s => { s.runId = "1e4"; }, s => { s.attempt = "Infinity"; },
    s => s.jobs.pop(), s => { s.jobs[0].conclusion = "failure"; }, s => { s.jobs[1].status = "in_progress"; },
    s => s.jobs.push({ ...s.jobs[0], conclusion: "skipped" }), s => s.shards.pop(), s => { s.shards[0].status = "failed"; },
    s => { s.shards[0].shard = 2; }, s => { s.shards[0].durationMs = null; }, s => s.files.pop(),
    s => { s.files[0].file = "/private/untrusted.audit.spec.ts"; }, s => { s.files[0].file = s.files[1].file; },
    s => { s.files[0].durationMs = -1; }, s => { s.files[0].attempts++; }, s => { s.files[0].durationMs = Infinity; },
  ];
  for (const change of mutations) { const s = sample(); change(s); assert.throws(() => validateSample(s, catalog), String(change)); }
});

test("preview never mutates tracked data; output collisions/symlinks and dirty explicit writes are refused", t => {
  const root = mkdtempSync(join(tmpdir(), "mg-ui-weights-")); t.after(() => rmSync(root, { recursive: true, force: true }));
  const git = (...args) => execFileSync("git", args, { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
  git("init", "-b", "main"); mkdirSync(join(root, "tests/ui"), { recursive: true });
  const target = join(root, "tests/ui/audit-durations.json"), initial = JSON.stringify(old);
  writeFileSync(target, initial); git("add", ".");
  git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", "commit", "-m", "fixture");
  const proposal = proposeWeights([sample(), sample("456")], catalog, old), output = join(root, "candidate.json");
  assert.equal(JSON.parse(writeProposal({ root, proposal })).version, 1); assert.equal(readFileSync(target, "utf8"), initial);
  writeProposal({ root, proposal, output }); assert.equal(readFileSync(target, "utf8"), initial);
  assert.throws(() => writeProposal({ root, proposal, output }), /EEXIST/);
  assert.throws(() => writeProposal({ root, proposal, output: target }), /preserved/);
  const link = join(root, "link.json"); symlinkSync(target, link); assert.throws(() => writeProposal({ root, proposal, output: link }), /preserved/);
  writeFileSync(target, "local edit"); assert.throws(() => writeProposal({ root, proposal, write: true }), /preserved/);
  git("add", "."); assert.throws(() => writeProposal({ root, proposal, write: true }), /preserved/);
  writeFileSync(target, initial); git("add", "tests/ui/audit-durations.json");
  writeProposal({ root, proposal, write: true }); assert.deepEqual(JSON.parse(readFileSync(target, "utf8")), proposal.weights);
});
