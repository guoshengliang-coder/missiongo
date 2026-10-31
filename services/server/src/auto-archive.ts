import type { MissionGoDatabase } from "./storage/database.js";
import { conversationIdentityGroups, type ConversationIdentity } from "./conversation-identity.js";

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
    WHERE c.session_id = agent_sessions.id AND c.status IN ('queued', 'delivering', 'delivery_unknown')
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
  const accounts = database.connection.prepare(`SELECT DISTINCT account_id FROM dispatches WHERE id IN (${placeholders})`)
    .all(...dispatchIds) as { account_id: string }[];
  for (const account of accounts) autoArchiveFinishedConversations(database, account.account_id, now, dispatchIds);
}

interface ArchiveIdentity extends ConversationIdentity {
  source: "dispatch" | "external";
  dispatch_id: string | null;
  session_id: string | null;
  archived_at: string | null;
  suppressed: number;
  dispatch_status: string | null;
}

/** Quietly archive the whole displayed conversation, including external mirrors.
 * Pending/uncertain replies and a person's restore protect every member. */
export function autoArchiveFinishedConversations(
  database: MissionGoDatabase, accountId: string, now = new Date().toISOString(), ids?: readonly string[],
): void {
  const db = database.connection;
  database.transaction(() => {
    const identities = db.prepare(`SELECT COALESCE(s.id, 'dispatch:' || d.id) AS id,
      d.agent_kind AS agent, s.agent_session_ref AS ref, d.node_id AS node,
      EXISTS(SELECT 1 FROM managed_execution_intents m WHERE m.id=d.id) AS isolated,
      'dispatch' AS source, d.id AS dispatch_id, s.id AS session_id,
      CASE WHEN s.id IS NULL THEN d.archived_at ELSE s.archived_at END AS archived_at,
      CASE WHEN s.id IS NULL THEN d.auto_archive_suppressed ELSE s.auto_archive_suppressed END AS suppressed,
      d.status AS dispatch_status
      FROM dispatches d LEFT JOIN agent_sessions s ON s.dispatch_id=d.id WHERE d.account_id=?
      UNION ALL SELECT id,agent_kind,CASE WHEN ref_kind='native' THEN session_ref END,native_node_id,0,
      'external',NULL,id,archived_at,auto_archive_suppressed,NULL
      FROM external_agent_sessions WHERE account_id=?`).all(accountId, accountId) as unknown as ArchiveIdentity[];
    const dispatchItems = db.prepare("SELECT w.status FROM dispatch_items i JOIN work_items w ON w.id=i.item_id WHERE i.dispatch_id=?");
    const externalItems = db.prepare("SELECT w.status FROM external_agent_session_items i JOIN work_items w ON w.id=i.item_id WHERE i.session_id=?");
    const dispatchPending = db.prepare("SELECT 1 FROM agent_session_commands WHERE session_id=? AND status IN ('queued','delivering','delivery_unknown') LIMIT 1");
    const externalPending = db.prepare("SELECT 1 FROM external_native_commands WHERE session_id=? AND status IN ('queued','delivering','delivery_unknown') LIMIT 1");
    for (const group of conversationIdentityGroups(identities)) {
      if (ids && !group.some((row) => ids.includes(row.id) || (row.dispatch_id && ids.includes(row.dispatch_id)))) continue;
      if (group.every((row) => row.archived_at) || group.some((row) => row.suppressed)) continue;
      if (group.some((row) => row.source === "external" ? externalPending.get(row.id)
        : row.session_id ? dispatchPending.get(row.session_id) : !["launched", "failed", "cancelled"].includes(row.dispatch_status!))) continue;
      const statuses = group.flatMap((row) => (row.source === "external"
        ? externalItems.all(row.id) : dispatchItems.all(row.dispatch_id!)) as { status: string }[]);
      if (!statuses.some((item) => item.status === "done")
        || statuses.some((item) => !["done", "cancelled"].includes(item.status))) continue;
      for (const row of group) {
        if (row.archived_at) continue;
        if (row.source === "external") {
          db.prepare("UPDATE external_agent_sessions SET archived_at=?,archive_reason='auto' WHERE id=?").run(now, row.id);
        } else if (row.session_id) {
          db.prepare(`UPDATE agent_sessions SET archived_at=?,archive_source='missiongo',archive_reason='auto',
            updated_at=?,source_restore_pending=0 WHERE id=?`).run(now, now, row.id);
        } else {
          db.prepare("UPDATE dispatches SET archived_at=?,archive_reason='auto' WHERE id=?").run(now, row.dispatch_id!);
        }
      }
    }
  });
}

/** Every status write checks all native mirrors carrying this item. */
export function autoArchiveForItem(database: MissionGoDatabase, itemId: string, now?: string): void {
  const accounts = database.connection.prepare(`SELECT d.account_id FROM dispatch_items i JOIN dispatches d ON d.id=i.dispatch_id WHERE i.item_id=?
    UNION SELECT s.account_id FROM external_agent_session_items i JOIN external_agent_sessions s ON s.id=i.session_id WHERE i.item_id=?`)
    .all(itemId, itemId) as { account_id: string }[];
  for (const account of accounts) autoArchiveFinishedConversations(database, account.account_id, now);
}

/** Run once after adding external archive metadata; never touch source clients. */
export function backfillFinishedConversations(database: MissionGoDatabase): void {
  const accounts = database.connection.prepare("SELECT account_id FROM dispatches UNION SELECT account_id FROM external_agent_sessions")
    .all() as { account_id: string }[];
  for (const account of accounts) autoArchiveFinishedConversations(database, account.account_id);
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
