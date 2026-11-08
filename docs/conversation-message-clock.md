# Conversation message time

The list's `activityAt` now means the latest actual conversation message time.
It is projected from `session_message_times` into `session_message_clocks`, keyed
by dispatch or external conversation identity. Console sorting, mirrored-group
aggregation and the existing shared list row use this projection. No component
or CSS exception was added. A conversation without trustworthy message dates
uses its creation time, never its snapshot/metadata timestamp.

Accepted user messages (including attachment-only messages), explicit plan and
progress messages use their authoritative server creation time. Native text,
plans, questions and generated-image messages use their source occurrence date.
Stable source IDs own their first reliable date; streams, old-message edits,
duplicate reports and reordering cannot advance it. Undated historical records
remain readable but cannot manufacture current activity. Offline new replies
keep their original time. Tool/execution records are excluded.

Snapshot freshness, original activity diagnostics, settings revisions, running
state, archive state and unread remain separate. No read/unread acknowledgement,
task status, approval authority or work-item state is changed by clock repair.
Older nodes' `activityAt` metadata cannot affect the new projection.

## Native behavior

The macOS Codex adapter reads idle history without starting an approval observer.
An active turn, pending input or explicit control request still uses its approval
channel. After a healthy idle read with no pending request, observation ends.
Reading a source snapshot never derives message activity from `thread.updatedAt`.
Settings continue to use the existing desired/applied revision protocol.

Linux Codex item pages and OpenCode messages now carry their original dates.
Claude's live stream retains the first message date across text growth. Missing
dates from older nodes remain unknown rather than becoming the polling time.

## Migration and operator correction

Migration 202611081212 seeds clocks only from the previously verified unread
source frontier, accepted user commands and explicit progress reports. Legacy
message `occurred_at` can be a receipt-time fallback and is not used as proof.
The migration does not rewrite original messages or clear unread.

`scripts/repair-conversation-times.mjs` requires explicit `--account-id` and
`--product-id`; `--database` is a private operator path. Default mode is read-only
and exports only identities, dates and evidence digests. It works before the
migration so its preview can be reviewed before deployment and backup.

Optional `--source-evidence` accepts metadata independently extracted from the
exact original native history: session ID/reference, latest visible message
date, message count and source-file SHA-256. It never takes message bodies or
executes a source file. Evidence identity must still match the scoped session.

After deploying the migration, `--apply --plan <preview> --backup <sqlite-backup>`
reconciles only reviewed candidates, logs previous/corrected times and evidence,
and skips sessions whose latest source/projection changed. Unresolved sessions
are reported separately, never assigned the current time. The write runs in one
transaction and retries are idempotent. Preserve preview, backup and result
outside Git. A rollback requires checking the recorded projection against newer
message evidence; restoring an entire database over new conversations is not an
acceptable correction.

## Validation

Service tests cover yesterday's reply with today's metadata/settings, repeated
streams, history backfill, status/archive changes, offline replies, server user
messages and external mirrors. Migration tests reject receipt-time pollution.
Operator tests cover scope, backups, concurrent new messages and retry safety.
macOS tests verify idle observation versus active approval subscriptions. Linux
tests retain source timestamps through item pagination. UI tests fix the clock
and verify yesterday's label across metadata/settings refresh at phone/desktop
widths. CI and real post-deploy/node observations remain separate evidence.
