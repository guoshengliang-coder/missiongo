/** Human attestations settle one item/execution; they are never physical stop receipts or delivery evidence. */
const invalidate = (source: "external" | "dispatch", execution: string) => `
  INSERT INTO item_execution_activity(source,execution_id,generation) VALUES ('${source}',${execution},1)
    ON CONFLICT(source,execution_id) DO UPDATE SET generation=generation+1;
  UPDATE item_execution_stop_confirmations SET invalidated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
    WHERE source='${source}' AND execution_id=${execution} AND invalidated_at IS NULL;
`;
export const EXECUTION_STOP_SCHEMA = `
  CREATE TABLE item_execution_activity (
    source TEXT NOT NULL CHECK(source IN ('external','dispatch')),
    execution_id TEXT NOT NULL,
    generation INTEGER NOT NULL,
    PRIMARY KEY(source,execution_id)
  );
  CREATE TABLE item_execution_stop_confirmations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    item_id TEXT NOT NULL REFERENCES work_items(id) ON DELETE CASCADE,
    source TEXT NOT NULL CHECK(source IN ('external','dispatch')),
    execution_id TEXT NOT NULL,
    evidence_key TEXT NOT NULL,
    confirmed_by TEXT NOT NULL REFERENCES accounts(id),
    note TEXT NOT NULL,
    confirmed_at TEXT NOT NULL,
    invalidated_at TEXT
  );
  CREATE INDEX item_execution_stop_lookup ON item_execution_stop_confirmations(item_id,source,execution_id);

  CREATE TRIGGER invalidate_external_stop_on_activity AFTER UPDATE OF native_snapshot_json,progress_status ON external_agent_sessions
  WHEN json_extract(NEW.native_snapshot_json,'$.status') IN ('active','stalled')
    OR json_extract(NEW.native_snapshot_json,'$.turnState.turnActive')=1
    OR NEW.progress_status NOT IN ('completed','failed')
  BEGIN
    ${invalidate("external", "NEW.id")}
  END;
  CREATE TRIGGER invalidate_dispatch_stop_on_activity AFTER UPDATE OF status,turn_state_json ON agent_sessions
  WHEN NEW.status IN ('active','stalled') OR json_extract(NEW.turn_state_json,'$.turnActive')=1
  BEGIN
    ${invalidate("dispatch", "NEW.dispatch_id")}
  END;
  CREATE TRIGGER invalidate_external_stop_on_command AFTER INSERT ON external_native_commands
  BEGIN
    ${invalidate("external", "NEW.session_id")}
  END;
  CREATE TRIGGER invalidate_dispatch_stop_on_command AFTER INSERT ON agent_session_commands
  BEGIN
    ${invalidate("dispatch", "(SELECT dispatch_id FROM agent_sessions WHERE id=NEW.session_id)")}
  END;
  CREATE TRIGGER invalidate_external_stop_on_delivery AFTER UPDATE OF status ON external_native_commands
  WHEN NEW.status IN ('queued','delivering','delivery_unknown') AND NEW.status!=OLD.status
  BEGIN
    ${invalidate("external", "NEW.session_id")}
  END;
  CREATE TRIGGER invalidate_dispatch_stop_on_delivery AFTER UPDATE OF status ON agent_session_commands
  WHEN NEW.status IN ('queued','delivering','delivery_unknown') AND NEW.status!=OLD.status
  BEGIN
    ${invalidate("dispatch", "(SELECT dispatch_id FROM agent_sessions WHERE id=NEW.session_id)")}
  END;
  CREATE TRIGGER invalidate_external_stop_on_message AFTER INSERT ON external_native_messages
  BEGIN
    ${invalidate("external", "NEW.session_id")}
  END;
  CREATE TRIGGER invalidate_dispatch_stop_on_message AFTER INSERT ON agent_session_messages
  BEGIN
    ${invalidate("dispatch", "(SELECT dispatch_id FROM agent_sessions WHERE id=NEW.session_id)")}
  END;
`;
