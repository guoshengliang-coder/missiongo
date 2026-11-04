/** Extend human stop checks to interrupted work without rewriting source execution history. */
export const INTERRUPTED_EXECUTION_STOP_SCHEMA = `
  DROP TRIGGER invalidate_external_stop_on_activity;
  CREATE TRIGGER invalidate_external_stop_on_activity AFTER UPDATE OF native_snapshot_json ON external_agent_sessions
  WHEN json_extract(NEW.native_snapshot_json,'$.status') IN ('active','stalled')
    OR json_extract(NEW.native_snapshot_json,'$.turnState.turnActive')=1
  BEGIN
    INSERT INTO item_execution_activity(source,execution_id,generation) VALUES ('external',NEW.id,1)
      ON CONFLICT(source,execution_id) DO UPDATE SET generation=generation+1;
    UPDATE item_execution_stop_confirmations SET invalidated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE source='external' AND execution_id=NEW.id AND invalidated_at IS NULL;
  END;
  CREATE TRIGGER invalidate_external_stop_on_progress AFTER UPDATE OF progress_status,updated_at ON external_agent_sessions
  WHEN NEW.progress_status NOT IN ('completed','failed')
    AND (NEW.progress_status IS NOT OLD.progress_status OR NEW.updated_at IS NOT OLD.updated_at)
  BEGIN
    INSERT INTO item_execution_activity(source,execution_id,generation) VALUES ('external',NEW.id,1)
      ON CONFLICT(source,execution_id) DO UPDATE SET generation=generation+1;
    UPDATE item_execution_stop_confirmations SET invalidated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE source='external' AND execution_id=NEW.id AND invalidated_at IS NULL;
  END;

  ALTER TABLE item_executions ADD COLUMN stop_generation INTEGER NOT NULL DEFAULT 0;
  CREATE TABLE item_performer_stop_confirmations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    item_id TEXT NOT NULL REFERENCES work_items(id) ON DELETE CASCADE,
    execution_id TEXT NOT NULL REFERENCES item_executions(id) ON DELETE CASCADE,
    evidence_key TEXT NOT NULL,
    confirmed_by TEXT NOT NULL REFERENCES accounts(id),
    note TEXT NOT NULL,
    confirmed_at TEXT NOT NULL,
    invalidated_at TEXT
  );
  CREATE INDEX item_performer_stop_lookup ON item_performer_stop_confirmations(item_id,execution_id);
  CREATE TRIGGER invalidate_linked_performer_stop_on_insert AFTER INSERT ON item_execution_activity
  BEGIN
    UPDATE item_performer_stop_confirmations SET invalidated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE invalidated_at IS NULL AND execution_id IN (
        SELECT id FROM item_executions WHERE session_id=CASE WHEN NEW.source='external' THEN NEW.execution_id
          ELSE (SELECT id FROM agent_sessions WHERE dispatch_id=NEW.execution_id) END);
  END;
  CREATE TRIGGER invalidate_linked_performer_stop_on_update AFTER UPDATE OF generation ON item_execution_activity
  BEGIN
    UPDATE item_performer_stop_confirmations SET invalidated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE invalidated_at IS NULL AND execution_id IN (
        SELECT id FROM item_executions WHERE session_id=CASE WHEN NEW.source='external' THEN NEW.execution_id
          ELSE (SELECT id FROM agent_sessions WHERE dispatch_id=NEW.execution_id) END);
  END;
  CREATE TRIGGER invalidate_performer_stop_on_activity
  AFTER UPDATE OF status,scope,kind,session_id,account_id,result,started_at,ended_at,updated_at ON item_executions
  BEGIN
    UPDATE item_executions SET stop_generation=stop_generation+1 WHERE id=NEW.id;
    UPDATE item_performer_stop_confirmations SET invalidated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE execution_id=NEW.id AND invalidated_at IS NULL;
  END;
`;
