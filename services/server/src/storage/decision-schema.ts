/** Decision snapshots and audit receipts share a single transaction. No execution queue. */
export const DECISION_SCHEMA = `
CREATE TABLE decision_records (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES managed_runs(id) ON DELETE CASCADE,
  decision_key TEXT NOT NULL,
  snapshot_json TEXT NOT NULL CHECK (json_valid(snapshot_json)),
  UNIQUE(run_id, decision_key)
);
CREATE TABLE decision_events (
  decision_id TEXT NOT NULL REFERENCES decision_records(id) ON DELETE CASCADE,
  sequence INTEGER NOT NULL CHECK (sequence > 0),
  account_id TEXT NOT NULL,
  operation TEXT NOT NULL CHECK (operation IN ('create','revise','explain','approve','revoke')),
  idempotency_key TEXT NOT NULL,
  payload_digest TEXT NOT NULL,
  result_json TEXT NOT NULL CHECK (json_valid(result_json)),
  created_at TEXT NOT NULL,
  PRIMARY KEY(decision_id, sequence),
  UNIQUE(decision_id, account_id, operation, idempotency_key)
);
`;
