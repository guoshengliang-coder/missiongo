// Domain-limited repair of execution-only unread pollution against a known-good
// backup. Dry-run by default. Never exports message text or changes read_at.
import { DatabaseSync } from "node:sqlite";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";

export function repairSessionUnread({ database, baseline, nodeId, from, until, apply = false }) {
  if (!nodeId || !Number.isFinite(Date.parse(from)) || !Number.isFinite(Date.parse(until))
    || Date.parse(until) < Date.parse(from) || Date.parse(until) - Date.parse(from) > 600_000) {
    throw new Error("A node ID and an explicit window of at most ten minutes are required.");
  }
  const db = new DatabaseSync(database, { readOnly: !apply });
  const old = new DatabaseSync(baseline, { readOnly: true });
  const results = [];
  try {
    if (apply) {
      db.exec(`CREATE TABLE IF NOT EXISTS session_unread_repairs (
        dispatch_id TEXT NOT NULL, polluted_at TEXT NOT NULL, restored_at TEXT,
        read_at TEXT NOT NULL, repaired_at TEXT NOT NULL, PRIMARY KEY(dispatch_id,polluted_at)
      ) STRICT`);
      db.exec("BEGIN IMMEDIATE");
    }
    const rows = db.prepare(`SELECT d.id,d.read_at,d.unread_at,s.id session_id,s.status,s.turn_state_json
      FROM dispatches d JOIN agent_sessions s ON s.dispatch_id=d.id
      WHERE d.node_id=? AND d.unread_at>=? AND d.unread_at<=? AND d.unread_at>d.read_at`).all(nodeId, from, until);
    const messages = (connection, id) => connection.prepare(`SELECT source_id,role,phase,text,questions_json,occurred_at
      FROM agent_session_messages WHERE session_id=?`).all(id);
    for (const row of rows) {
      const previous = old.prepare(`SELECT d.read_at,d.unread_at,s.id session_id,s.status
        FROM dispatches d JOIN agent_sessions s ON s.dispatch_id=d.id WHERE d.id=? AND d.node_id=?`).get(row.id,nodeId);
      let reason;
      if (!previous || !previous.read_at || previous.read_at !== row.read_at
        || (previous.unread_at && previous.unread_at > previous.read_at)) reason = "baseline_not_read_or_ack_changed";
      else if (row.status !== "idle" || previous.status !== "idle") reason = "not_stable_idle";
      else {
        const before = new Map(messages(old,previous.session_id).map(m => [m.source_id,m]));
        const current = messages(db,row.session_id);
        const turn = JSON.parse(row.turn_state_json || "{}");
        const pending = current.some(m => m.questions_json && JSON.parse(m.questions_json).some(q => q.answered === undefined && !q.withdrawn));
        const added = current.filter(m => !before.has(m.source_id));
        const changed = current.some(m => before.has(m.source_id) && JSON.stringify(m) !== JSON.stringify(before.get(m.source_id)));
        if (pending || turn.waitingForInput || turn.waitingForPermission || turn.turnActive) reason = "pending_action";
        else if (changed || before.size + added.length !== current.length) reason = "existing_messages_changed";
        else if (!added.length || added.some(m => m.phase !== "execution" || !Number.isFinite(Date.parse(m.occurred_at))
          || Date.parse(m.occurred_at) > Date.parse(previous.read_at))) reason = "not_proven_execution_only";
        else if (db.prepare(`SELECT 1 FROM agent_session_commands WHERE session_id=? AND created_at>? LIMIT 1`)
          .get(row.session_id, from)) reason = "subsequent_user_command";
      }
      if (reason) { results.push({ id: row.id, action: "skip", reason }); continue; }
      if (apply) {
        db.prepare(`INSERT OR IGNORE INTO session_unread_repairs VALUES (?,?,?,?,?)`)
          .run(row.id,row.unread_at,previous.unread_at,row.read_at,new Date().toISOString());
        const result = db.prepare(`UPDATE dispatches SET unread_at=? WHERE id=? AND unread_at=? AND read_at=?`)
          .run(previous.unread_at,row.id,row.unread_at,row.read_at);
        if (result.changes !== 1) throw new Error("Concurrent unread change; repair rolled back.");
      }
      results.push({ id: row.id, action: apply ? "repaired" : "candidate", pollutedAt: row.unread_at, restoredAt: previous.unread_at });
    }
    if (apply) db.exec("COMMIT");
    return results;
  } catch (error) {
    if (apply && db.isTransaction) db.exec("ROLLBACK");
    throw error;
  } finally { old.close(); db.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { values } = parseArgs({ options: {
    database: { type: "string" }, baseline: { type: "string" }, "node-id": { type: "string" },
    from: { type: "string" }, until: { type: "string" }, apply: { type: "boolean", default: false },
  } });
  if (!values.database || !values.baseline) throw new Error("--database and --baseline are required.");
  console.log(JSON.stringify(repairSessionUnread({ ...values, nodeId: values["node-id"] })));
}
