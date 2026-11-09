# Server regression budgets

AND-488 covers two distinct regressions: HTTP idle claims returning early, and
synchronous list/projection work becoming much more expensive. This is synthetic
regression testing, not production monitoring or end-to-end load testing.

## Run and interpret

`npm run check` runs the real HTTP contracts with the server tests, then the
performance process **after** parallel tests/builds finish. `npm run check:performance`
also builds the current TypeScript before measuring. Do not benchmark concurrently
with other local builds. No production database or credentials are used.

The idle contract sends a JSON POST over real localhost HTTP with `waitMs=2000`
and asserts at least 1900ms elapsed. Slow hosts cannot fail that lower bound.
It also verifies disconnect aborts the waiter. Existing dispatch tests retain
capacity, wakeup and immediate-return behavior. `inject` alone cannot catch the
old IncomingMessage-close regression.

Performance defaults to blocking locally and `ciMode` from
[`server-budgets.json`](server-budgets.json) when `CI` is set. CI initially uses
**advisory**. Only threshold/invalid-measurement outcomes are advisory; malformed
configuration, invalid fixture state or a crashing runner still fail. Other
`npm run check` failures are never swallowed. Explicit diagnostic overrides:

```sh
npm run check:performance -- --mode=blocking
npm run check:performance -- --mode=advisory
```

Reports are written to ignored `ci-diagnostics/server-performance/report.json`
and `summary.md`. CI appends the summary and uploads `server-performance-<attempt>`
for 30 days even when check fails. A missing/incomplete report is missing evidence,
not a pass. The process overwrites stale reports at startup. A local report,
dirty checkout, mutation, invalid calibration or unrelated configuration is not
eligible evidence for promotion. Summary includes source SHA, configuration
digest, fixture shape, raw samples, calibration, measured/normalized times,
effective and suggested budgets, and stage durations. It contains no production
payloads, credentials or host paths.

## Fixture and calibration

The in-memory fixture has 200 items × 200 events (40,000 total), ~1KiB historical
comment payloads, 20 item-backed deliveries, 20 source conversations and 5 batches.
Four batches have domain-created development and release evidence; one remains
active. Claims use the real MCP protocol; delivery proposals/confirmation/batch
creation use the domain APIs. Historical integration outcomes are synthetic.
Assertions require a full list page, valid pending deliveries, published and
merging progress, and all 25 source/integration session progress entries. Invalid
authorization/scope cannot silently skip the expensive branches.

Targets reuse the actual synchronous operations composed by the merge-deliveries
HTTP route (list, batches, attention, sessionProgress), plus item list and summary.
This excludes HTTP/authentication/network cost. No implementation algorithm is
copied. Seven samples after warmup are retained, taking their median. Summary
reads are grouped to reduce sub-millisecond timer noise.

The independent baseline is a fixed single-product read, 10,000 operations per
sample. `scale = measured baseline / reference baseline`; effective target budget
is `reference target budget × scale`. It never calibrates against the hot target
itself. Zero/non-finite samples are errors; out-of-range scale or noisy IQR is
explicitly invalid. Bounds do not clamp enormous slowdowns into passing results.
Mathematical tests cover common machine drift versus isolated 5x regressions.
Real CI calibration still needs the observation period; this is no promise that
all CPU, SQLite, memory and scheduler effects scale identically.

Initial darwin-arm64 Node 22.23.2 measurements were ~825ms for the full associated
merge projection, ~88ms for a 100-item list, ~0.027ms for summary and ~0.006ms for
the product baseline. This larger associated fixture already exceeds the item's
illustrative 100–150ms. Initial reference budgets are 1250/140/0.09ms: reviewed
headroom above normal, below 5× normal. They are not production latency SLAs.
**Do not shrink the fixture to meet an assumed 150ms figure.** Any configuration
change must explain measured data, calibration/shape changes and reason in its PR.
The runner prints suggested values; it never edits budgets or accepts a regression.

Initial local performance-process time was ~11.5s including ~3.8s fixture creation;
the HTTP tests add ~2s plus test startup. The <30s CI-increment goal must still be
checked on actual Actions steps; local duration alone does not prove it.

## Diagnostic regression experiments

After `npm run build:types`, these opt-in commands change module loading only in
their own process; they do not edit source, compiled output, Git or normal CI.
They are expected to produce a nonzero blocking result:

```sh
PERFORMANCE_MUTATION=fivefold node --import ./tests/performance/mutation-loader.mjs scripts/server-performance.mjs --mode=blocking
PERFORMANCE_MUTATION=historical node --import ./tests/performance/mutation-loader.mjs scripts/server-performance.mjs --mode=blocking
```

`fivefold` repeats each actual target five times, leaving calibration unchanged.
`historical` removes per-batch presentation reuse and shared timeline arguments,
reinstating the two repeated-computation patterns from PR #536. It is a bounded
regression experiment, not a reconstruction of the production incident. Source
matching assertions fail if implementation changes, so stale experiments cannot
quietly run unchanged code. Preserve mutation reports separately before running a
normal measurement; mutation samples never count towards the observation week.

## Observe for at least a week, then review promotion

There is **no automatic date-based switch** and no branch-protection change.
Start a window with the first clean, valid Actions report for the exact budget
configuration. Download the original reports from PR/main and daily scheduled CI.
Verify their run/attempt, source SHA and configuration digest against Actions.
Review each sample in [`observations.json`](observations.json), adding:

```json
{
  "runId": "<Actions run id>",
  "attempt": "<attempt>",
  "head": "<40-character source SHA>",
  "configDigest": "<SHA-256 of the exact budget file>",
  "decision": "pass",
  "note": "<reviewer/date and original run evidence; explain every warning>"
}
```

For exceeded results classify as `false_positive` or `regression`; never mark an
exceeded result `pass` because advisory CI was green. Missing classification is
unreviewed, not zero false positives. Preserve original data, do not rewrite a
warning into a normal sample. Local/invalid runs do not count. Repeated run/attempt
files are rejected; reruns do not fill missing calendar days. Configuration changes
start a separate evidence window.

```sh
node scripts/performance-observations.mjs /path/to/run-a/report.json /path/to/run-b/report.json
```

The calculator reports `falsePositives / reviewed valid samples`, null when there
are none, with unreviewed, invalid and unrelated counts separately. For promotion
review it requires at least **seven full elapsed days**, evidence on every UTC
calendar day (at least eight dates), zero false positives/regressions and no
unreviewed/invalid samples in the supplied set. Verify that the set includes all
relevant runs: the calculator cannot discover omitted Actions evidence or sign it.
Its `eligibleForBlockingReview` is review evidence only. Current ledger is empty;
no week or zero-misfire record has been claimed.

Only after reviewing that evidence, propose a separate PR changing `ciMode` to
`blocking`, explaining the window/run IDs, false-positive rate and actual CI
increment. Keep the existing required check names. This first implementation
detects performance regressions in CI but deliberately does not block on thresholds.
The real HTTP correctness contract blocks immediately.
