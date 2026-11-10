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
comment payloads, 20 item-backed deliveries, 20 source conversations and 10 batches. Item bodies also carry ~4KiB synthetic text, representative of persisted list JSON.
Nine batches have domain-created development and release evidence; one remains
active. Claims use the real MCP protocol; delivery proposals/confirmation/batch
creation use the domain APIs. Historical integration outcomes are synthetic.
Assertions require a full list page, valid pending deliveries, published and
merging progress, and all 25 source/integration session progress entries. Invalid
authorization/scope cannot silently skip the expensive branches.

Targets reuse the actual synchronous operations composed by the merge-deliveries
HTTP route (list, batches, attention, sessionProgress), plus item list and summary.
This excludes HTTP/authentication/network cost. No implementation algorithm is
copied. Seven samples after warmup are retained, taking their median. Score
**process CPU milliseconds (user + system)** for the synchronous work, retaining
each sample's monotonic wall time separately. Summary reads are grouped to reduce
sub-millisecond timer noise. A later wall-only local run over budgeted normal code
during contention: the baseline changed ~20% but wall time changed much more.
CPU scoring avoids classifying descheduling as extra CPU computation. It includes
process GC/background CPU and is not an end-user response latency SLA.

The independent baseline is a fixed single-product read, 10,000 operations per
sample. `scale = measured baseline / reference baseline`; effective target budget
is `reference target budget × scale`. It never calibrates against the hot target
itself. Zero/non-finite samples are errors; out-of-range scale or noisy IQR is
explicitly invalid. Bounds do not clamp enormous slowdowns into passing results.
Mathematical tests cover common machine drift versus isolated 5x regressions.
Real CI calibration still needs the observation period; this is no promise that
all CPU, SQLite, memory and scheduler effects scale identically.

Initial darwin-arm64 Node 22.23.2 low-contention wall measurements were ~825ms for the full associated
merge projection, ~88ms for a 100-item list, ~0.027ms for summary and ~0.006ms for
the product baseline. This larger associated fixture already exceeds the item's
illustrative 100–150ms. Initial reference budgets are 1250/140/0.09ms: reviewed
headroom above normal, below 5× normal. They are not production latency SLAs.
**Do not shrink the fixture to meet an assumed 150ms figure.** Any configuration
change must explain measured data, calibration/shape changes and reason in its PR.
The runner prints suggested values; it never edits budgets or accepts a regression.
The same numerical budgets were retained when changing the explicit unit to CPU
time, rather than increasing limits to hide the wall-only failure. First CPU run:
~840 CPU ms / 821 wall ms merge, ~92 CPU ms list; calibration ~0.0065 CPU ms/read.

Initial local performance-process time was ~11.5s including ~3.8s fixture creation;
the HTTP tests add ~2s plus test startup. The <30s CI-increment goal must still be
checked on actual Actions steps; local duration alone does not prove it.
An independent parent process kills the performance child after the configured
25s CI wall deadline (120s locally for deliberate mutation experiments), including
when synchronous code cannot service a timer. It reports an **invalid/incomplete**
measurement, advisory exit 0 or blocking exit 1; it never fabricates target values.
Correctness/configuration errors keep their failure codes in either mode.
The deadline bounds the performance child, not artifact upload, TypeScript startup
or HTTP contracts; actual complete CI increment remains to be measured.

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

To verify that scheduling delay does not masquerade as extra synchronous CPU,
use the `scheduling` mutation with the same command: it adds a deliberate 500ms
sleep to each merge projection. The CPU budget should pass while recorded wall
time increases. This synthetic pause is not an actual CI-machine drift measurement.

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

The calculator recomputes calibration and target results from the complete raw
CPU samples and the exact current configuration. It validates wall samples,
sample counts, units, fixture shape, finite numeric values, stage timing, effective
budgets and derived status; a `passed` label alone is not evidence.
Calibration wall samples multiplied by baseline iterations must fit
`calibrationMs`; all target wall samples multiplied by their own iterations must
collectively fit `samplesMs`. Each comparison has only a fixed 0.01ms rounding
allowance, not a percentage that could hide large inconsistencies. CPU and wall
time are not compared directly: process/background CPU may exceed elapsed wall.

It reconciles both directions: reports without matching reviews are unreviewed;
current-configuration reviews without reports appear in `missingReports` and
`missingReportReviews`. `knownFalsePositiveReviews` / `knownRegressionReviews`
include those known but missing results, so omitting a file cannot erase them.
Older configurations are separate. Run/attempt/head/config must match.

The calculator reports `falsePositives / reviewed valid samples`, null when there
are none or evidence is missing, invalid or unreviewed, with those counts separately.
For promotion review it requires **at least 168 actually elapsed hours**, as well
as evidence on every UTC calendar day (at least eight dates), zero known false
positives/regressions and no unreviewed/invalid/missing samples. `elapsedHours`
and `spanDays` use complete timestamps; `calendarSpanDays` and `continuous` only
describe day coverage. Covering eight date labels alone is insufficient.
The calculator captures one review clock (`Date.now()` in the CLI), returns it as
`reviewedAt`, and rejects any sample timestamp later than that clock. Tests inject
a fixed millisecond review time; changing the system date is unnecessary. There
is no future-time grace period that can manufacture elapsed observation time.
If a source clock is ahead, correct/verify its clock or review once that timestamp
is actually in the past; future reports cannot contribute to the window.
Verify that the set includes all relevant runs: the calculator can detect omissions
known to the ledger, but cannot discover runs absent from both inputs or sign them.
Its `eligibleForBlockingReview` is review evidence only. Current ledger is empty;
no week or zero-misfire record has been claimed.

Only after reviewing that evidence, propose a separate PR changing `ciMode` to
`blocking`, explaining the window/run IDs, false-positive rate and actual CI
increment. Keep the existing required check names. This first implementation
detects performance regressions in CI but deliberately does not block on thresholds.
The real HTTP correctness contract blocks immediately.


## AND-489 release smoke and rebaseline

The initial 1250/140 CPU-ms limits above are historical: persisted display rows
made the previous merge/list limits insensitive. The current shared CPU limits
are 0.8/2/0.09 ms, with 100 iterations for sub-millisecond targets. They are read
from this same versioned file by both CI and the release runner. The fixture keeps
200 items and 40,000 events; ten batches and representative item bodies prevent
empty/small persisted display payloads from hiding cost. Reference numbers are
CPU work, not request latency promises. Budget changes reset the config digest
and observation window; `ciMode` remains advisory.

The separate `release.httpTargets` entries are wall milliseconds for authenticated
loopback HTTP, not CPU samples: merge 4ms, lightweight list+summary 25ms, and
claim-next 3ms (empty and controlled work). Merge/list retain the independent product-read CPU calibration; empty claim uses
a separate loopback health wall baseline (1ms reference), and work claim combines
1/3 CPU with 2/3 HTTP scale. Both reuse the existing median/calibration/target
evaluation code. Initial
backup measurements normalized to ~0.52–0.54 CPU ms merge / ~1.15–1.24 CPU ms full
list, with HTTP ~2.3–2.6 / ~15.4–16.6 ms. Controlled work claim is heavier than an
empty claim (~1.85 vs ~0.86–1.06 normalized wall ms), so its allowance includes that
branch. Values are versioned review decisions, never automatically raised by the
runner. Production payload/shape changes can legitimately fail an absolute budget;
review the complete samples rather than interpreting a block as proof of a bug.

See `docs/release-coverage.md` for installation and data handling. CI uses only
synthetic backups; real snapshot bodies, account identifiers and credentials must
never enter reports or artifacts. The release process enforces blocking even
though CI remains advisory. A green advisory run does not authorize publication.

Isolated backup experiments use the real candidate worker and leave the
independent calibration unchanged. They require the same explicit SSH/backup
scope as a normal smoke. Select one target at a time:

```sh
PERFORMANCE_MUTATION=release-fivefold-merge-deliveries node --import ./tests/performance/mutation-loader.mjs scripts/release-performance.mjs --root <checkout> --host <configured-host> --backups-dir <existing-backup-directory> --product-id <bound-product>
```

Use `release-fivefold-item-list` and `release-fivefold-claim-next` for the other
targets. These repeat actual domain reads and/or complete HTTP requests five times;
they are bounded simulated regressions, not a reproduction of the old incident.
They must fail because the selected target exceeds its budget, not because
another target or preparation failed. Reports identify the experiment and cannot
be treated as normal performance evidence. Never enable a mutation for a release.


### Audited cross-runtime HTTP calibration

Release configuration v2 keeps all target limits unchanged. Node 22.13's HTTP
transport measured much faster than 22.23: a standalone health control was about
0.166ms vs 1.52ms. Applying SQLite CPU scale to every HTTP target let a real 5x
empty-claim experiment remain below budget on 22.13. That nonzero exit came only
from the diagnostic-publication guard and was not detection evidence.

The health endpoint is independent of the claim queue. Its seven grouped wall
samples calibrate transport-sensitive empty claims. Work claims additionally do
SQLite writes, so their reviewed effective scale is 1/3 product CPU + 2/3 health
wall scale. Merge/list HTTP and synchronous CPU targets keep product CPU scale.
Reports retain both raw calibrations and each target's calibration kind/scale;
either invalid calibration blocks publication. No target calibrates against
itself, no runtime automatically raises limits, and no Node-version allowlist is
used. Configuration-digest changes restart the advisory observation window.

Diagnostic reports now distinguish `measurementStatus` from `diagnosticOutcome`.
Only a selected target actually `exceeded` with valid CPU and HTTP calibration
counts as `detected`. A forced diagnostic refusal, another target's failure, or
invalid measurement is not proof that the selected regression was caught.

## Console session reads (AND-498)

`node scripts/console-performance.mjs` measures the actual list, recent-detail and
stored-history HTTP handlers through inject, including authorization and JSON
serialization, with synthetic data only. It runs separately from the regression
budget supervisor; existing budget values and CI advisory policy are unchanged.
Build TypeScript first. Do not run a measurement concurrently with other builds
or tests. The optional comparison exits nonzero unless **each** handler's median
wall time improves by at least 50%; CPU time, SQL execution count, returned rows,
response bytes and all seven warmed samples are retained, never substituted for
one another. Missing/incomplete reports are not a pass.

Use the same current runner for both checkouts (the baseline needs built types
and its own dependencies):

```sh
node scripts/console-performance.mjs --source <baseline-checkout> --mirrors 40 --output <baseline-report.json>
node scripts/console-performance.mjs --mirrors 40 --compare <baseline-report.json> --output <current-report.json>
```

Run a second pair with `--mirrors 0`. Both shapes have 200 dispatch conversations,
one with 10,000 stored 1 KiB messages and 199 with 20 messages each. The mirrored
shape adds 40 external records on those same conversations, including a complete
10,000-message mirror of the target. The list must still return exactly 200
merged conversations; both history endpoints must return exactly 50 messages.
Fixtures use direct history seeding, not a single oversized node snapshot.

Reports identify source SHA, dirty state, environment and shape; source paths,
message payloads, credentials and SQL are not included. Row counts measure JS
result rows (including statement execution results), not SQLite VM scan steps.
These are local synthetic comparisons, not a production latency SLA or a claim
that a screenshot's unidentified failed request has been reproduced.
