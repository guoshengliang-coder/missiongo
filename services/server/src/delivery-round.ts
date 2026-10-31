import type { MissionGoDatabase } from "./storage/database.js";

/** Moving a card does not end its execution. Rework and changed requirements do. */
export function deliveryRound(database: MissionGoDatabase, itemId: string): string | null {
  const db = database.connection;
  const start = db.prepare(`SELECT id,timeline_seq FROM work_item_events WHERE item_id=? AND history_source_key IS NULL
    AND (event_type='status_changed' AND to_status='in_progress' OR event_type='execution_taken_over'
      OR event_type='builder_changed' AND json_extract(payload_json,'$.handoverId') IS NOT NULL)
    ORDER BY timeline_seq DESC LIMIT 1`).get(itemId) as {id:string;timeline_seq:number} | undefined;
  if (!start) return null;
  // A failed verification/new request must not be healed by the delivery it rejected,
  // even before the next Agent claims the work. A plain released/manual move is different.
  const rework = db.prepare(`SELECT 1 FROM work_item_events WHERE item_id=? AND history_source_key IS NULL AND timeline_seq>?
    AND event_type='status_changed' AND (json_extract(payload_json,'$.reason')='verification_failed'
      OR from_status='done' OR to_status='cancelled'
      OR json_extract(payload_json,'$.reason')='reopened' AND from_status='on_hold') LIMIT 1`).get(itemId,start.timeline_seq);
  if (rework) return null;
  // A newly registered association after a requirement edit must be verified afresh.
  const changed = db.prepare(`SELECT id FROM work_item_events WHERE item_id=? AND history_source_key IS NULL AND timeline_seq>?
    AND event_type='item_updated' AND (json_extract(payload_json,'$.deliveryScopeChanged')=1
      OR json_type(payload_json,'$.deliveryScopeChanged') IS NULL)
    ORDER BY timeline_seq DESC LIMIT 1`).get(itemId,start.timeline_seq) as {id:string} | undefined;
  return changed?.id ?? start.id;
}

export function queueDeliveryChecks(database: MissionGoDatabase, itemId: string, now: string): void {
  database.connection.prepare(`UPDATE status_handovers SET requested_at=?,retry_count=0
    WHERE item_id=?`).run(now,itemId);
}
