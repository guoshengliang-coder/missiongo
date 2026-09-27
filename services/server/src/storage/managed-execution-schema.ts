import { executorConflictSql } from "./execution-ownership-sql.js";

export const MANAGED_EXECUTION_SCHEMA = `
  CREATE TABLE managed_executor_registrations (
    node_id TEXT PRIMARY KEY REFERENCES nodes(id),
    account_id TEXT NOT NULL,
    installation_id TEXT NOT NULL UNIQUE,
    mode TEXT NOT NULL CHECK (mode='single_node_local'),
    evidence TEXT NOT NULL,
    created_at TEXT NOT NULL
  ) STRICT;
  CREATE TABLE managed_execution_intents (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES managed_runs(id),
    stage_id TEXT NOT NULL,
    node_id TEXT NOT NULL,
    generation INTEGER NOT NULL CHECK (generation > 0),
    idempotency_key TEXT NOT NULL,
    payload_digest TEXT NOT NULL,
    ownership_held INTEGER NOT NULL CHECK (ownership_held IN (0,1)),
    snapshot_json TEXT NOT NULL CHECK (json_valid(snapshot_json)),
    UNIQUE(run_id,idempotency_key),
    UNIQUE(stage_id,generation),
    FOREIGN KEY(stage_id,run_id) REFERENCES managed_stages(id,run_id)
  ) STRICT;
  CREATE UNIQUE INDEX managed_execution_run_owner ON managed_execution_intents(run_id) WHERE ownership_held=1;
  CREATE UNIQUE INDEX managed_execution_node_owner ON managed_execution_intents(node_id) WHERE ownership_held=1;
  ALTER TABLE dispatches ADD COLUMN execution_generation INTEGER NOT NULL DEFAULT 1 CHECK (execution_generation > 0);
  CREATE TABLE managed_manual_reconciliations (
    dispatch_id TEXT NOT NULL REFERENCES dispatches(id),
    generation INTEGER NOT NULL,
    account_id TEXT NOT NULL,
    delivered_at TEXT NOT NULL,
    evidence TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY(dispatch_id,generation)
  ) STRICT;
  CREATE TRIGGER managed_manual_reacquire AFTER UPDATE OF status ON dispatches
    WHEN NEW.status='queued' AND EXISTS (SELECT 1 FROM managed_manual_reconciliations WHERE dispatch_id=NEW.id AND generation=NEW.execution_generation)
    BEGIN UPDATE dispatches SET execution_generation=execution_generation+1 WHERE id=NEW.id; END;
  CREATE TRIGGER managed_manual_evidence_immutable_update BEFORE UPDATE ON managed_manual_reconciliations BEGIN SELECT RAISE(ABORT,'immutable manual reconciliation'); END;
  CREATE TRIGGER managed_manual_evidence_immutable_delete BEFORE DELETE ON managed_manual_reconciliations BEGIN SELECT RAISE(ABORT,'immutable manual reconciliation'); END;
  CREATE TRIGGER managed_manual_message BEFORE INSERT ON agent_session_commands
    WHEN NEW.kind='message' AND EXISTS (
      SELECT 1 FROM agent_sessions s WHERE s.id=NEW.session_id AND (
        ${executorConflictSql("s.node_id", "s.dispatch_id")}))
    BEGIN SELECT RAISE(ABORT,'workspace_owned_or_reconciled'); END;
  CREATE TRIGGER managed_manual_settings BEFORE UPDATE OF desired_settings_json ON agent_sessions
    WHEN ${executorConflictSql("NEW.node_id", "NEW.dispatch_id")}
    BEGIN SELECT RAISE(ABORT,'workspace_owned_or_reconciled'); END;
  CREATE TRIGGER managed_manual_restore BEFORE UPDATE OF source_restore_pending,archived_at ON agent_sessions
    WHEN (NEW.source_restore_pending=1 OR (OLD.archived_at IS NOT NULL AND NEW.archived_at IS NULL)) AND (
      ${executorConflictSql("NEW.node_id", "NEW.dispatch_id")})
    BEGIN SELECT RAISE(ABORT,'workspace_owned_or_reconciled'); END;
  CREATE TRIGGER managed_manual_insert BEFORE INSERT ON dispatches
    WHEN NEW.status IN ('queued','delivered','launched') AND ${executorConflictSql("NEW.node_id", "NEW.id")}
    BEGIN SELECT RAISE(ABORT,'workspace_owned'); END;
  CREATE TRIGGER managed_manual_start BEFORE UPDATE OF status ON dispatches
    WHEN NEW.status IN ('queued','delivered','launched') AND ${executorConflictSql("NEW.node_id", "NEW.id")}
    BEGIN SELECT RAISE(ABORT,'workspace_owned'); END;
  CREATE TRIGGER managed_manual_message_generation AFTER INSERT ON agent_session_commands
    WHEN NEW.kind='message'
    BEGIN UPDATE dispatches SET execution_generation=execution_generation+1
      WHERE id=(SELECT dispatch_id FROM agent_sessions WHERE id=NEW.session_id)
      AND EXISTS (SELECT 1 FROM managed_manual_reconciliations m WHERE m.dispatch_id=dispatches.id AND m.generation=dispatches.execution_generation); END;
  CREATE TRIGGER managed_manual_settings_generation AFTER UPDATE OF desired_settings_json ON agent_sessions
    BEGIN UPDATE dispatches SET execution_generation=execution_generation+1 WHERE id=NEW.dispatch_id
      AND EXISTS (SELECT 1 FROM managed_manual_reconciliations m WHERE m.dispatch_id=dispatches.id AND m.generation=dispatches.execution_generation); END;
  CREATE TRIGGER managed_manual_restore_generation AFTER UPDATE OF source_restore_pending,archived_at ON agent_sessions
    WHEN NEW.source_restore_pending=1 OR (OLD.archived_at IS NOT NULL AND NEW.archived_at IS NULL)
    BEGIN UPDATE dispatches SET execution_generation=execution_generation+1 WHERE id=NEW.dispatch_id
      AND EXISTS (SELECT 1 FROM managed_manual_reconciliations m WHERE m.dispatch_id=dispatches.id AND m.generation=dispatches.execution_generation); END;
  CREATE TABLE managed_execution_bindings (
    intent_id TEXT PRIMARY KEY REFERENCES managed_execution_intents(id),
    repository_ref TEXT NOT NULL,
    product_id TEXT NOT NULL,
    account_id TEXT NOT NULL,
    node_id TEXT NOT NULL,
    repo_path TEXT NOT NULL
  ) STRICT;
  CREATE TRIGGER managed_bindings_immutable_update BEFORE UPDATE ON managed_execution_bindings BEGIN SELECT RAISE(ABORT,'immutable launch binding'); END;
  CREATE TRIGGER managed_bindings_immutable_delete BEFORE DELETE ON managed_execution_bindings BEGIN SELECT RAISE(ABORT,'immutable launch binding'); END;
  CREATE TABLE managed_execution_observations (
    intent_id TEXT NOT NULL REFERENCES managed_execution_intents(id),
    sequence INTEGER NOT NULL CHECK (sequence > 0),
    payload_digest TEXT NOT NULL,
    payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
    PRIMARY KEY(intent_id,sequence)
  ) STRICT;
  CREATE TRIGGER managed_observations_immutable_update BEFORE UPDATE ON managed_execution_observations BEGIN SELECT RAISE(ABORT,'immutable observation'); END;
  CREATE TRIGGER managed_observations_immutable_delete BEFORE DELETE ON managed_execution_observations BEGIN SELECT RAISE(ABORT,'immutable observation'); END;
  CREATE TABLE managed_execution_inputs (
    intent_id TEXT NOT NULL REFERENCES managed_execution_intents(id),
    idempotency_key TEXT NOT NULL,
    payload_digest TEXT NOT NULL,
    command_id TEXT NOT NULL REFERENCES agent_session_commands(id),
    PRIMARY KEY(intent_id,idempotency_key)
  ) STRICT;
  CREATE TABLE managed_execution_events (
    intent_id TEXT NOT NULL REFERENCES managed_execution_intents(id),
    sequence INTEGER NOT NULL,
    operation TEXT NOT NULL,
    snapshot_json TEXT NOT NULL CHECK (json_valid(snapshot_json)),
    created_at TEXT NOT NULL,
    PRIMARY KEY(intent_id,sequence)
  ) STRICT;
  CREATE TRIGGER managed_execution_events_immutable_update BEFORE UPDATE ON managed_execution_events BEGIN SELECT RAISE(ABORT,'immutable execution event'); END;
  CREATE TRIGGER managed_execution_events_immutable_delete BEFORE DELETE ON managed_execution_events BEGIN SELECT RAISE(ABORT,'immutable execution event'); END;
`;
