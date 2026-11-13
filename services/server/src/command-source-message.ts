import type { DatabaseSync } from "node:sqlite";

/** Only node-preserved client IDs establish a durable association. No text or
 * clock heuristic is written back as a source/execution fact. Both joins stay
 * inside the command's exact persisted session, including external bindings. */
export function commandSourceMessage(db: DatabaseSync, commandId: string, external = false): { sourceMessageId?: string } {
  const messages = external ? "external_native_messages" : "agent_session_messages";
  const commands = external ? "external_native_commands" : "agent_session_commands";
  const role = external ? "json_extract(m.payload_json,'$.role')" : "m.role";
  const phase = external ? "json_extract(m.payload_json,'$.phase')" : "m.phase";
  const row = db.prepare(`SELECT m.source_id FROM ${commands} c JOIN ${messages} m ON m.session_id=c.session_id
    AND m.source_id IN (c.id,'answer-'||c.id) WHERE c.id=? AND ${role}='user'
    AND COALESCE(${phase},'')<>'execution' ORDER BY CASE WHEN m.source_id=c.id THEN 0 ELSE 1 END LIMIT 1`)
    .get(commandId) as {source_id: string} | undefined;
  return row ? {sourceMessageId: row.source_id} : {};
}
