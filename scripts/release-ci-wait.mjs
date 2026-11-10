#!/usr/bin/env node
// Wait until a commit's check-runs exist and complete, then apply the same
// release CI assertion deploy uses. gh pr checks --watch cannot serve as a
// merge gate: while a freshly pushed head's run is still queued it happily
// reports the previous head's green result.
import { execFileSync } from "node:child_process";
import { assertReleaseCI } from "./release-ci.mjs";

function fail(message) { console.error(message); process.exit(1); }

const args = process.argv.slice(2);
const commit = args.find((arg) => /^[0-9a-f]{40}$/.test(arg));
if (!commit) fail("Usage: release-ci-wait.mjs <full-commit-sha> [--timeout seconds] [--interval seconds] [--quiet]");
const number = (name, fallback) => {
  const index = args.indexOf(name);
  const value = index >= 0 ? Number(args[index + 1]) : fallback;
  return Number.isSafeInteger(value) && value > 0 ? value * 1000 : fail(`Invalid ${name} value`);
};
const timeoutMs = number("--timeout", 1800);
const intervalMs = number("--interval", 30);
const quiet = args.includes("--quiet");

const deadline = Date.now() + timeoutMs;
let transientFailures = 0;
function checkRuns() {
  while (true) {
    try {
      const runs = JSON.parse(execFileSync("gh", ["api", "--paginate", "--slurp",
        `repos/:owner/:repo/commits/${commit}/check-runs?per_page=100`], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }))
        .flatMap((page) => page.check_runs);
      transientFailures = 0;
      return runs;
    } catch (error) {
      const detail = (error.stderr?.toString() || error.message).split("\n")[0];
      // Transient network failures must not be reported as CI failure.
      const transient = /TLS handshake|connection reset|context deadline|EOF|ETIMEDOUT|ECONNRESET|ECONNREFUSED|network is unreachable|502|503/i.test(detail);
      if (!transient || ++transientFailures > 6 || Date.now() + intervalMs > deadline) fail(`cannot read check-runs for ${commit}: ${detail}`);
      if (!quiet) console.log(`transient read failure (${transientFailures}/6), retrying in ${intervalMs / 1000}s: ${detail}`);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, intervalMs);
    }
  }
}

let runs = [];
while (true) {
  runs = checkRuns();
  const pending = runs.filter((run) => run.status !== "completed");
  if (runs.length > 0 && pending.length === 0) break;
  if (runs.length === 0 && !quiet) console.log(`waiting: no check-runs yet for ${commit.slice(0, 10)} (run may be queued)`);
  else if (!quiet) console.log(`waiting: ${pending.length}/${runs.length} check-runs unfinished`);
  if (Date.now() + intervalMs > deadline) fail(`timeout after ${timeoutMs / 1000}s waiting for CI on ${commit}`);
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, intervalMs);
}

try {
  assertReleaseCI(runs);
  const summary = runs.filter((run) => run.conclusion !== "success" && run.conclusion !== "skipped" && run.conclusion !== "neutral");
  console.log(`CI green on ${commit.slice(0, 10)}: ${runs.length} checks completed, ${summary.length} non-success`);
} catch (error) {
  fail(error.message);
}
