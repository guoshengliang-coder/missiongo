# Session unread recovery

Transcript persistence and notification delivery have separate meanings. Snapshot
reports are mirrors, not a stream of newly produced messages. Both dispatch and
external-native mirrors use `observeSessionUnread` in their storage transaction.

The server retains a source-message frontier and the last healthy execution
status across unavailable/suspended reports. New source IDs older than the
frontier are historical backfill; `execution` records never create unread. The shared domain transcript boundary
filters these from incoming conversation mirrors and hides legacy cached records.
Existing message edits, settings and polling metadata do not create unread.
New open-question revisions and execution completion/failure still do. Stable
event keys deduplicate retries. Event rows record reason, identity, source time
and server notification time, without message bodies. `read_at` continues to
acknowledge the server clock displayed by the client; source chronology is not
substituted for that clock. Acknowledgements also retain the covered source
boundary, and cannot consume a later notification in the same millisecond.

Compatibility uses fields already sent by supported native clients (`sourceId`,
`phase`, `occurredAt`); no client upgrade is needed. History-page results already
use a separate cache without notification side effects. Legacy messages without
a source timestamp remain eligible for one notification when first discovered,
rather than silently dropping potentially genuine output. Equal timestamps are
also conservative: different source IDs remain eligible. Source clocks alone
cannot prove ordering in these ambiguous cases. Existing unread is never cleared
by snapshot ingestion or schema migration.

## Repair of previously polluted unread

`scripts/repair-session-unread.mjs` is a domain-limited operator tool. It requires
an existing known-good database backup, an explicit node and a window no longer
than ten minutes. It defaults to dry-run and only outputs IDs/reasons/timestamps.
It does not expose message bodies or accept SQL. Use flags `--database`,
`--baseline`, `--node-id`, `--from`, `--until`; add `--apply` after reviewing the
candidate list. Backup files must be mounted read-only.

A repair requires that the same dispatch was read in the backup, its read clock
has not changed, it is still idle, all original messages are unchanged, and the
only added messages are execution records predating the baseline read clock.
Open questions, active turns and subsequent user commands exclude a candidate.
Ambiguous changes are skipped. Apply runs under a write transaction, compares
both current clocks, restores the backup unread clock and retains the original
polluted clock in `session_unread_repairs`. It never changes `read_at`, removes
messages or changes work-item status. To reverse a specific repair, restore its
recorded polluted clock only if both clocks still match the repair record;
never overwrite a later notification or acknowledgement.
