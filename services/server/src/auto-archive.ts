import type { MissionGoDatabase } from "./storage/database.js";

/**
 * A hand-off is finished once none of its items is still open and at least one
 * was accepted: every item is done or cancelled, and not all cancelled (AND-129).
 * A batch where everything was cancelled is not "finished work" and stays for a
 * person to look at.
 */
const FINISHED_DISPATCHES_SQL = `
  SELECT di.dispatch_id FROM dispatch_items di JOIN work_items w ON w.id = di.item_id
  GROUP BY di.dispatch_id
  HAVING SUM(w.status NOT IN ('done', 'cancelled')) = 0 AND SUM(w.status = 'done') > 0`;

const NO_PENDING_COMMAND_SQL = `
  NOT EXISTS (
    SELECT 1 FROM agent_session_commands c
    WHERE c.session_id = agent_sessions.id AND c.status IN ('queued', 'delivering')
  )`;

/**
 * Archive, in MissionGo, every conversation of these dispatches whose items are
 * now all finished. Deliberately quiet: it moves neither the activity clock
 * (ordering) nor the unread clock, so a finished conversation drops out of the
 * list instead of jumping to its top. A session with a reply still queued or
 * being delivered is left alone and retried when that command settles. A person
 * who restored an auto-archived conversation keeps it: suppressed rows are
 * never archived again automatically.
 */
export function autoArchiveFinishedDispatches(
  database: MissionGoDatabase,
  dispatchIds: readonly string[],
  now: string = new Date().toISOString(),
): void {
  if (dispatchIds.length === 0) return;
  const placeholders = dispatchIds.map(() => "?").join(", ");
  database.connection.prepare(
    `UPDATE agent_sessions
     SET archived_at = ?, archive_source = 'missiongo', archive_reason = 'auto', updated_at = ?
     WHERE archived_at IS NULL AND auto_archive_suppressed = 0
       AND dispatch_id IN (${placeholders})
       AND dispatch_id IN (${FINISHED_DISPATCHES_SQL})
       AND ${NO_PENDING_COMMAND_SQL}`,
  ).run(now, now, ...dispatchIds);
  database.connection.prepare(
    `UPDATE dispatches SET archived_at = ?, archive_reason = 'auto'
     WHERE archived_at IS NULL AND auto_archive_suppressed = 0
       AND status IN ('launched', 'failed', 'cancelled')
       AND NOT EXISTS (SELECT 1 FROM agent_sessions s WHERE s.dispatch_id = dispatches.id)
       AND id IN (${placeholders})
       AND id IN (${FINISHED_DISPATCHES_SQL})`,
  ).run(now, ...dispatchIds);
}

/** Run the finished-hand-off check for every dispatch that carried this item. */
export function autoArchiveForItem(database: MissionGoDatabase, itemId: string, now?: string): void {
  const rows = database.connection
    .prepare("SELECT dispatch_id FROM dispatch_items WHERE item_id = ?")
    .all(itemId) as unknown as Array<{ dispatch_id: string }>;
  autoArchiveFinishedDispatches(database, rows.map((row) => row.dispatch_id), now);
}

/** The one-time catch-up for conversations that finished before AND-129 shipped. */
export const AUTO_ARCHIVE_BACKFILL_SQL = {
  sessions: `UPDATE agent_sessions
    SET archived_at = ?, archive_source = 'missiongo', archive_reason = 'auto', updated_at = ?
    WHERE archived_at IS NULL AND auto_archive_suppressed = 0
      AND dispatch_id IN (${FINISHED_DISPATCHES_SQL})
      AND ${NO_PENDING_COMMAND_SQL}`,
  dispatches: `UPDATE dispatches SET archived_at = ?, archive_reason = 'auto'
    WHERE archived_at IS NULL AND auto_archive_suppressed = 0
      AND status IN ('launched', 'failed', 'cancelled')
      AND NOT EXISTS (SELECT 1 FROM agent_sessions s WHERE s.dispatch_id = dispatches.id)
      AND id IN (${FINISHED_DISPATCHES_SQL})`,
} as const;
