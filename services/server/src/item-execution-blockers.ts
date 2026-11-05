import { createHash } from "node:crypto";
import { NODE_ONLINE_WINDOW_MS } from "@missiongo/domain";
import type { MissionGoDatabase } from "./storage/database.js";

export interface ItemExecutionBlocker {
  id: string;
  source: "external" | "dispatch" | "performer" | "ai" | "managed";
  executionId: string;
  sessionId?: string;
  status: string;
  progressStatus?: string;
  nodeName?: string;
  lastObservedAt?: string;
  error?: string;
  scope?: string;
  reason: "active" | "commands_pending" | "connection_unknown" | "execution_open";
  canConfirmStopped: boolean;
  revision: string;
}

interface SessionObservation {
  source: "external" | "dispatch";
  id: string; session_id: string | null; session_ref: string | null; status: string | null; progress_status: string | null;
  progress_updated_at: string | null; generation: number; activity_generation: number; dispatch_status: string | null;
  native: number; turn_json: string | null; node_name: string | null; last_seen_at: string | null;
  revoked_at: string | null; observed_at: string | null; error: string | null;
  pending: number; last_command: string | null; last_message: number | null; closed_at: number | null;
}
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

/** A stable work checkpoint, independent of repeated unavailable/heartbeat observations. */
export function executionObservationKey(row: SessionObservation): string {
  return digest([row.source, row.id, row.generation, row.progress_status, row.progress_updated_at,
    row.dispatch_status, row.last_command, row.last_message, row.activity_generation]);
}

interface PerformerObservation {
  id: string; item_id: string; kind: string; session_id: string | null; status: string; scope: string;
  account_id: string; stop_generation: number;
}
function performerObservation(database: MissionGoDatabase, itemId: string, id: string): PerformerObservation {
  return database.connection.prepare("SELECT id,item_id,kind,session_id,status,scope,account_id,stop_generation FROM item_executions WHERE item_id=? AND id=?")
    .get(itemId,id) as unknown as PerformerObservation;
}
function performerEvidence(row: PerformerObservation, linked?: SessionObservation): string {
  return digest([row,linked ? executionObservationKey(linked) : null]);
}
function sessionReason(row: SessionObservation): ItemExecutionBlocker["reason"] | undefined {
  const terminal = row.source === "external" && ["completed", "failed"].includes(row.progress_status ?? "");
  const turn = JSON.parse(row.turn_json ?? "{}") as {turnActive?: boolean};
  if (row.pending) return "commands_pending";
  if (turn.turnActive || ["active", "stalled"].includes(row.status ?? "")) return "active";
  if (!row.native) return terminal ? undefined : "execution_open";
  if (!row.session_id || row.source === "dispatch" && (row.dispatch_status !== "launched" || row.session_ref?.startsWith("pending:"))) return "execution_open";
  const oldest = new Date(Date.now() - NODE_ONLINE_WINDOW_MS).toISOString();
  if (!["idle", "suspended"].includes(row.status ?? "") || row.revoked_at || !row.last_seen_at
    || row.last_seen_at < oldest || !row.observed_at || row.observed_at < oldest) return "connection_unknown";
  return undefined;
}
function canCheckSession(row: SessionObservation, reason: ItemExecutionBlocker["reason"] | undefined): boolean {
  return Boolean(row.session_id) && (row.source !== "dispatch" || row.dispatch_status === "launched" && !row.session_ref?.startsWith("pending:"))
    && reason !== "active" && reason !== "commands_pending";
}
function sessionObservations(database: MissionGoDatabase, itemId: string, excludeDispatchId = ""): SessionObservation[] {
  return database.connection.prepare(`SELECT 'external' AS source,s.id,s.id AS session_id,s.session_ref,
    json_extract(s.native_snapshot_json,'$.status') AS status,s.progress_status,s.updated_at AS progress_updated_at,
    s.native_generation AS generation,COALESCE((SELECT generation FROM item_execution_activity WHERE source='external' AND execution_id=s.id),0) AS activity_generation,NULL AS dispatch_status,
    (s.native_node_id IS NOT NULL OR s.native_snapshot_json IS NOT NULL) AS native,
    json_extract(s.native_snapshot_json,'$.turnState') AS turn_json,
    COALESCE(n.nickname,n.name) AS node_name,n.last_seen_at,n.revoked_at,s.native_synced_at AS observed_at,
    json_extract(s.native_snapshot_json,'$.error') AS error,
    EXISTS(SELECT 1 FROM external_native_commands c WHERE c.session_id=s.id AND c.status IN ('queued','delivering','delivery_unknown')) AS pending,
    (SELECT id FROM external_native_commands c WHERE c.session_id=s.id ORDER BY rowid DESC LIMIT 1) AS last_command,
    (SELECT MAX(rowid) FROM external_native_messages m WHERE m.session_id=s.id) AS last_message,
    (SELECT MAX(timeline_seq) FROM work_item_events e WHERE e.item_id=i.item_id AND e.history_source_key IS NULL
      AND e.created_at>=s.created_at AND e.to_status IN ('development_complete','pending_verification','done','cancelled')) AS closed_at
    FROM external_agent_sessions s JOIN external_agent_session_items i ON i.session_id=s.id
    LEFT JOIN nodes n ON n.id=s.native_node_id WHERE i.item_id=? AND i.link_kind='handling'
    UNION ALL SELECT 'dispatch',d.id,s.id,s.agent_session_ref,s.status,NULL,NULL,0,COALESCE((SELECT generation FROM item_execution_activity WHERE source='dispatch' AND execution_id=d.id),0),d.status,1,s.turn_state_json,
    COALESCE(n.nickname,n.name),n.last_seen_at,n.revoked_at,s.updated_at,s.last_error,
    EXISTS(SELECT 1 FROM agent_session_commands c WHERE c.session_id=s.id AND c.status IN ('queued','delivering','delivery_unknown')),
    (SELECT id FROM agent_session_commands c WHERE c.session_id=s.id ORDER BY rowid DESC LIMIT 1),
    (SELECT MAX(rowid) FROM agent_session_messages m WHERE m.session_id=s.id),
    (SELECT MAX(timeline_seq) FROM work_item_events e WHERE e.item_id=i.item_id AND e.history_source_key IS NULL
      AND e.created_at>=d.created_at AND e.to_status IN ('development_complete','pending_verification','done','cancelled'))
    FROM dispatches d JOIN dispatch_items i ON i.dispatch_id=d.id JOIN nodes n ON n.id=d.node_id
    LEFT JOIN agent_sessions s ON s.dispatch_id=d.id
    WHERE i.item_id=? AND d.id!=? AND d.status IN ('queued','delivered','launched')`)
    .all(itemId, itemId, excludeDispatchId) as unknown as SessionObservation[];
}

/** Unknown connections are not physical stop evidence, nor does progress completion alone release them. */
export function itemExecutionBlockers(database: MissionGoDatabase, itemId: string, excludeDispatchId = "", excludeExternalSessionId = ""): ItemExecutionBlocker[] {
  const db = database.connection;
  const item = db.prepare("SELECT revision FROM work_items WHERE id=?").get(itemId) as {revision: number};
  const rows = sessionObservations(database,itemId,excludeDispatchId).filter(row=>row.source!=="external" || row.id!==excludeExternalSessionId);
  const resolutions = db.prepare(`SELECT source,execution_id,evidence_key FROM item_execution_stop_confirmations
    WHERE item_id=? AND invalidated_at IS NULL`).all(itemId) as {source:string;execution_id:string;evidence_key:string}[];
  const blockers: ItemExecutionBlocker[] = [];
  for (const row of rows) {
    const reason = sessionReason(row);
    if (!reason) continue;
    const key = executionObservationKey(row);
    // Only an explicit human attestation of this exact historical execution can settle unknown health.
    // New activity/commands invalidate attestations in the database; an active observation always wins.
    if (canCheckSession(row,reason) && resolutions.some(r => r.source === row.source && r.execution_id === row.id && r.evidence_key === key)) continue;
    blockers.push({id: `${row.source}:${row.id}`, source: row.source, executionId: row.id,
      ...(row.session_id ? {sessionId: row.session_id} : {}), status: row.status ?? row.progress_status ?? row.dispatch_status ?? "unknown",
      ...(row.progress_status ? {progressStatus: row.progress_status} : {}), ...(row.node_name ? {nodeName: row.node_name} : {}),
      ...(row.observed_at ? {lastObservedAt: row.observed_at} : {}), ...(row.error ? {error: row.error} : {}), reason,
      canConfirmStopped: canCheckSession(row,reason),
      revision: digest([item.revision, key, row.status, row.turn_json, row.observed_at, reason, row.closed_at]),
    });
  }
  const other = db.prepare(`SELECT 'performer' AS source,id,status FROM item_executions
      WHERE item_id=? AND status IN ('assigned','working','blocked')
    UNION ALL SELECT 'ai',id,status FROM ai_executions WHERE item_id=? AND status IN ('created','running','waiting_for_human')
    UNION ALL SELECT 'managed',s.id,s.status FROM managed_runs r JOIN managed_stages s ON s.run_id=r.id,
      json_each(r.scope_json,'$.itemKeys') i JOIN work_items w ON w.item_key=i.value
      WHERE w.id=? AND s.status IN ('ready','running','waiting_for_human','unknown')`).all(itemId,itemId,itemId) as {source: "performer"|"ai"|"managed";id:string;status:string}[];
  const performerChecks = db.prepare("SELECT execution_id,evidence_key FROM item_performer_stop_confirmations WHERE item_id=? AND invalidated_at IS NULL")
    .all(itemId) as {execution_id:string;evidence_key:string}[];
  for (const row of other) {
    if (row.source !== "performer") {
      blockers.push({id:`${row.source}:${row.id}`,source:row.source,executionId:row.id,status:row.status,
        reason:"execution_open",canConfirmStopped:false,revision:digest([item.revision,row])});
      continue;
    }
    const performer = performerObservation(database,itemId,row.id);
    const linked = performer.session_id ? rows.find(source=>source.session_id === performer.session_id) : undefined;
    // A scoped execution and its source session must each be checked. A confirmation never conceals source activity.
    const reason = linked && sessionReason(linked);
    const canConfirmStopped = !performer.session_id || Boolean(linked && canCheckSession(linked,reason));
    const key = performerEvidence(performer,linked);
    if (canConfirmStopped && performerChecks.some(check=>check.execution_id === row.id && check.evidence_key === key)) continue;
    blockers.push({id:`performer:${row.id}`,source:"performer",executionId:row.id,status:row.status,scope:performer.scope,
      ...(performer.session_id ? {sessionId:performer.session_id} : {}),
      reason:reason === "active" || reason === "commands_pending" ? reason : "execution_open",canConfirmStopped,
      revision:digest([item.revision,key,linked])});
  }
  return blockers;
}

/** Freeze meaningful old work, not heartbeat/read timestamps. The target's planning activity is separate. */
export function itemExecutionCheckpoint(database:MissionGoDatabase,itemId:string,excludeDispatchId="",excludeExternalSessionId=""):string {
  const sessions=sessionObservations(database,itemId,excludeDispatchId)
    .filter(row=>row.source!=="external" || row.id!==excludeExternalSessionId)
    .map(row=>[row.source,row.id,executionObservationKey(row)]).sort((a,b)=>String(a[1]).localeCompare(String(b[1])));
  const db=database.connection;
  return digest([sessions,db.prepare("SELECT id,status,stop_generation FROM item_executions WHERE item_id=? ORDER BY id").all(itemId),
    db.prepare("SELECT id,status FROM ai_executions WHERE item_id=? ORDER BY id").all(itemId),
    db.prepare(`SELECT s.id,s.status FROM managed_runs r JOIN managed_stages s ON s.run_id=r.id,
      json_each(r.scope_json,'$.itemKeys') i JOIN work_items w ON w.item_key=i.value WHERE w.id=? ORDER BY s.id`).all(itemId)]);
}

/** Called only within the cookie-authenticated human confirmation transaction, after checking the revision. */
export function confirmItemExecutionStopped(database: MissionGoDatabase, itemId: string, blocker: ItemExecutionBlocker,
  accountId: string, note: string, now: string): void {
  // The key is read from the same source projection used to assess blockers, not supplied by the caller.
  // A separate work checkpoint lets harmless repeated unavailable observations retain the attestation.
  const db = database.connection;
  if (blocker.source === "performer") {
    const row = performerObservation(database,itemId,blocker.executionId);
    const linked = row.session_id ? sessionObservations(database,itemId).find(source=>source.session_id === row.session_id) : undefined;
    db.prepare(`INSERT INTO item_performer_stop_confirmations(item_id,execution_id,evidence_key,confirmed_by,note,confirmed_at)
      VALUES (?,?,?,?,?,?)`).run(itemId,row.id,performerEvidence(row,linked),accountId,note,now);
    return;
  }
  const external = blocker.source === "external";
  const row = db.prepare(external ? `SELECT 'external' AS source,s.id,s.native_generation AS generation,COALESCE((SELECT generation FROM item_execution_activity WHERE source='external' AND execution_id=s.id),0) AS activity_generation,
      s.progress_status,s.updated_at AS progress_updated_at,NULL AS dispatch_status,
      (SELECT id FROM external_native_commands c WHERE c.session_id=s.id ORDER BY rowid DESC LIMIT 1) AS last_command,
      (SELECT MAX(rowid) FROM external_native_messages m WHERE m.session_id=s.id) AS last_message
      FROM external_agent_sessions s JOIN external_agent_session_items i ON i.session_id=s.id WHERE s.id=? AND i.item_id=?`
    : `SELECT 'dispatch' AS source,d.id,0 AS generation,COALESCE((SELECT generation FROM item_execution_activity WHERE source='dispatch' AND execution_id=d.id),0) AS activity_generation,NULL AS progress_status,NULL AS progress_updated_at,d.status AS dispatch_status,
      (SELECT id FROM agent_session_commands c WHERE c.session_id=s.id ORDER BY rowid DESC LIMIT 1) AS last_command,
      (SELECT MAX(rowid) FROM agent_session_messages m WHERE m.session_id=s.id) AS last_message
      FROM dispatches d JOIN dispatch_items i ON i.dispatch_id=d.id LEFT JOIN agent_sessions s ON s.dispatch_id=d.id
      WHERE d.id=? AND i.item_id=?`).get(blocker.executionId,itemId) as unknown as SessionObservation;
  db.prepare(`INSERT INTO item_execution_stop_confirmations(item_id,source,execution_id,evidence_key,confirmed_by,note,confirmed_at)
    VALUES (?,?,?,?,?,?,?)`).run(itemId,blocker.source,blocker.executionId,executionObservationKey(row),accountId,note,now);
}
