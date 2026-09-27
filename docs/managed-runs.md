# Managed run ledger (AND-230)

## Delivered boundary

This is an **internal recording API**, not an execution or approval API. Nothing
instantiates it in HTTP, MCP, dispatch, a scheduler or a Node agent adapter. It
cannot start a process, approve an action, retry a delivery, or transition a work
item. AND-231 owns future formal approval. A successful ledger write is not
proof that a native agent ran, stopped, or respected its sandbox.

The domain contracts live in `packages/domain/src/managed-run.ts`; the server
store is `services/server/src/managed-run-store.ts`. No new dependency is needed.

## Scope and identity

`ManagedRunActor` is trusted server context: the authenticated account ID and
its currently authorized product IDs. **Never construct it from a request body.**
Every read and write checks account ownership and product membership, including
idempotent replays. The future HTTP/MCP adapter must authenticate, refresh product
permissions, and apply its own operation/approval policy before calling this
store. No formal authorization grant is implemented here.

A run freezes product ID, opaque repository mapping reference, ordered item
keys and contract revision. Creation validates that all keys exist in that
product in one transaction. This is a scope snapshot, not a copy of item bodies
or an approval contract. Repository references are recorded, not resolved to
filesystem paths; the future dispatcher must validate the actual node mapping.
The scope digest is server-computed SHA-256 of canonical JSON, **not a signature
or an approval**. Item order is meaningful in this first contract. There is no
scope-update API; changed scope requires a new run.

Scope references deliberately have no foreign keys to business items/products:
existing deletion behavior must not be blocked or cascade-delete audit history.
Historical reads still require the owning account and a trusted product grant.
Consumers must revalidate live targets before any future external operation.

## Store operations

- `createRun(actor, { scope, idempotencyKey })`: create run and first event.
- `getRun(actor, runId)`: current frozen scope and revision cursor.
- `createStage(actor, command)`: bind role, stage key and exact input commit.
- `beginAttempt(actor, command)`: record a new generation and native execution
  identity (harness, session reference, resolved model). These strings are
  caller-supplied evidence, not independently verified by this storage layer.
- `recordAttemptState(actor, command)`: record observation and evidence for the
  current generation without changing work-item status.
- `getStage` / `getAttempt`: scoped current state. Discover their IDs from events.
- `listEvents(actor, runId, after, limit)`: exclusive monotonic cursor, ascending
  order, at most 100 events. Page from the last returned sequence; an empty page
  means caught up at that instant, not that a run can never receive more events.

Every post-creation command includes `runId`, `expectedVersion`,
`contractRevision`, `scopeDigest` and `idempotencyKey`. Attempt commands also bind
the stage input commit; observations bind stage ID, attempt ID and generation.

Idempotency is scoped by account, operation, target and key. An exact retry
returns the **original response**, even after subsequent events; it does not
return current state or perform another mutation. Same key/different payload is
a conflict. Reload current state with the read methods. Never change the key to
blindly retry an unknown external side effect.

## State and concurrency

The first ledger is intentionally serial **per run**. One attempt in `running`,
`waiting_for_human` or `unknown` occupies the run slot, protected by a partial
unique index. This does not coordinate two different runs targeting the same
repository; a future workspace lease/fencing layer must do that before execution.

A ready or failed stage can record a new attempt. Running/waiting attempts may
move to waiting/running, unknown, success or failure as the transition table
allows. Unknown can only resolve to success/failure, and requires a non-empty
reconciliation evidence reference, retained with the result and immutable event.
That evidence is not automatically checked for truth. Terminal observations
cannot be rewritten. A failed stage can start another generation; a successful
stage needs a new stage for another code version. Late previous-generation
results are rejected. Exact old command replays only return their old receipt.

`BEGIN IMMEDIATE` serializes mutation checks, state writes, version increment and
event append. Failure rolls them all back. SQLite contention may return BUSY;
there is no silent retry loop. The caller may replay the same database command,
with the same key/payload, after reconciling; this does not authorize retrying an
external agent action. Old data cannot overwrite a newer generation, but this
is **not** an OS-level old-writer termination mechanism or exactly-once execution.

## Schema and migration

The UTC-numbered migration checks its receipt only after acquiring the write
transaction lock, then creates `managed_runs`, `managed_stages`,
`managed_attempts` and `managed_run_events` atomically with its receipt. A
deterministic two-connection interleaving test covers a peer finishing the
migration before this connection gets the lock; receipt-failure injection
checks DDL rollback and successful re-entry. Composite
foreign keys prevent cross-run attempt references, unique constraints guard
stage keys/generations/receipts, and triggers prevent changes to frozen scope or
committed events. The old `ai_executions`, leases, dispatches and sessions retain
their existing semantics.

The migration runs through the existing database startup path if this branch is
later deployed. Development tests only exercise temporary databases. Production
migration/deployment requires separate permission. Before any approved release,
back up the database and verify the restore procedure. Application rollback may
leave these additive tables in place; do not delete audit data as rollback.
A full database restore loses subsequent records and needs its own approval.

## Verification

Run from the repository root (build first: the race test uses compiled modules):

```sh
npm run build:types
npm run test --workspace @missiongo/domain -- src/managed-run.test.ts
npm run test --workspace @missiongo/server -- src/managed-run-store.test.ts src/storage/managed-run-migration.test.ts
npm run check
```

Tests use real temporary SQLite files, close/reopen, event-insertion fault
injection and two concurrent worker threads with independent database connections.
They cover frozen scope, bounded cursors, duplicate/payload-conflict receipts,
revoked caller grants, ownership and cross-stage references, stale versions and
generations, unknown reconciliation, late results, transaction rollback,
retained business-deletion behavior and migration re-entry. No paid model or
production database is used. These tests do not verify process recovery, actual
agent permissions, notifications, human approval, or mobile client behavior.
