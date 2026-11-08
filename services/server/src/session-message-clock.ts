import { isConversationMessage } from "@missiongo/domain";
import type { DatabaseSync } from "node:sqlite";

/** A message clock is independent of snapshot, settings, execution and unread
 * clocks. A source ID owns its first trustworthy time, including during streams.
 * Missing source dates are deliberately not replaced with poll/receipt time. */
export function observeMessageTimes(db: DatabaseSync, key: string, messages: readonly {
  sourceId: string; phase?: string | null | undefined; occurredAt?: string | null | undefined;
}[], now = new Date().toISOString()): void {
  const insert = db.prepare(`INSERT OR IGNORE INTO session_message_times(session_key,source_id,occurred_at,provenance)
    VALUES (?,?,?,'source_message')`);
  let changed = false;
  for (const message of messages) {
    if (!isConversationMessage(message) || !message.occurredAt) continue;
    const stamp = Date.parse(message.occurredAt);
    if (!Number.isFinite(stamp) || stamp > Date.parse(now) + 60_000) continue;
    changed = insert.run(key, `native:${message.sourceId}`, new Date(stamp).toISOString()).changes > 0 || changed;
  }
  if (changed) refreshMessageTime(db, key);
}

/** Server-accepted user messages and explicit progress/plan messages have an
 * authoritative creation time. Call inside the message's own transaction. */
export function recordMessageTime(db: DatabaseSync, key: string, sourceId: string, at: string): void {
  const result = db.prepare(`INSERT OR IGNORE INTO session_message_times(session_key,source_id,occurred_at,provenance)
    VALUES (?,?,?,'server_message')`).run(key, sourceId, at);
  if (result.changes) refreshMessageTime(db, key);
}

function refreshMessageTime(db: DatabaseSync, key: string): void {
  db.prepare(`INSERT INTO session_message_clocks(session_key,message_at)
    SELECT session_key,MAX(occurred_at) FROM session_message_times WHERE session_key=? GROUP BY session_key
    ON CONFLICT(session_key) DO UPDATE SET message_at=excluded.message_at`).run(key);
}
