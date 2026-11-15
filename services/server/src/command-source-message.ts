import type { DatabaseSync } from "node:sqlite";
import { invalidInput } from "./errors.js";

interface SourceRow { id: string; source_id: string; priority: number }

/** Exact native IDs take precedence over legacy answer IDs. A client alias
 * must identify exactly one source; repeated text/clocks never establish it. */
function resolvedSources(rows: readonly SourceRow[]): ReadonlyMap<string, string> {
  const grouped = new Map<string, SourceRow[]>();
  for (const row of rows) {
    const group = grouped.get(row.id);
    if (group) group.push(row); else grouped.set(row.id, [row]);
  }
  const result = new Map<string, string>();
  for (const [id, candidates] of grouped) {
    const priority = Math.min(...candidates.map(row => row.priority));
    const sources = new Set(candidates.filter(row => row.priority === priority).map(row => row.source_id));
    if (sources.size === 1) result.set(id, [...sources][0]!);
  }
  return result;
}

/** Each branch uses the exact-session source/client index, including long
 * sessions. Native identity remains intact; the client key is only an alias. */
function sourceQuery(external: boolean, batch: boolean): string {
  const messages = external ? "external_native_messages" : "agent_session_messages";
  const commands = external ? "external_native_commands" : "agent_session_commands";
  const role = external ? "json_extract(m.payload_json,'$.role')" : "m.role";
  const phase = external ? "json_extract(m.payload_json,'$.phase')" : "m.phase";
  const client = external ? "json_extract(m.payload_json,'$.clientMessageId')" : "m.client_message_id";
  const where = `${external ? "" : "c.kind='message' AND "}${batch ? "c.id IN (SELECT value FROM json_each(?))" : "c.id=?"}
    AND ${role}='user' AND COALESCE(${phase},'')<>'execution'`;
  return `SELECT c.id,m.source_id,CASE WHEN m.source_id=c.id THEN 0 ELSE 1 END AS priority
    FROM ${commands} c JOIN ${messages} m ON m.session_id=c.session_id AND m.source_id IN (c.id,'answer-'||c.id) WHERE ${where}
    UNION ALL SELECT c.id,m.source_id,2 AS priority
    FROM ${commands} c JOIN ${messages} m ON m.session_id=c.session_id AND ${client}=c.id WHERE ${where}`;
}

export function commandSourceMessage(db: DatabaseSync, commandId: string, external = false): { sourceMessageId?: string } {
  const rows = db.prepare(sourceQuery(external, false)).all(commandId, commandId) as unknown as SourceRow[];
  const sourceMessageId = resolvedSources(rows).get(commandId);
  return sourceMessageId ? { sourceMessageId } : {};
}

/** Request-local batch projection follows the same provenance as a single read. */
export function commandSourceMessages(db: DatabaseSync, commandIds: readonly string[]): ReadonlyMap<string, string> {
  if (!commandIds.length) return new Map();
  const ids = JSON.stringify([...new Set(commandIds)]);
  return resolvedSources(db.prepare(sourceQuery(false, true)).all(ids, ids) as unknown as SourceRow[]);
}

/** A read-only native history job can enrich an already stored source, never
 * create a new transcript entry, change its order or infer an execution. */
export function backfillClientMessageIds(db: DatabaseSync, sessionId: string,
  messages: readonly { sourceId: string; role: string; phase?: string | null | undefined; clientMessageId?: string | undefined }[]): void {
  for (const message of messages) {
    if (message.role !== "user" || message.phase === "execution" || !message.clientMessageId) continue;
    const stored = db.prepare("SELECT client_message_id FROM agent_session_messages WHERE session_id=? AND source_id=? AND role='user' AND COALESCE(phase,'')<>'execution'")
      .get(sessionId, message.sourceId) as { client_message_id: string | null } | undefined;
    if (stored?.client_message_id && stored.client_message_id !== message.clientMessageId) throw invalidInput("Message client identity changed.");
    if (stored) {
      db.prepare("UPDATE agent_session_messages SET client_message_id=? WHERE session_id=? AND source_id=?")
        .run(message.clientMessageId, sessionId, message.sourceId);
    }
    const external = db.prepare("SELECT payload_json FROM external_native_messages WHERE session_id=? AND source_id=?")
      .get(sessionId, message.sourceId) as { payload_json: string } | undefined;
    if (external) {
      const payload = JSON.parse(external.payload_json);
      if (payload.clientMessageId && payload.clientMessageId !== message.clientMessageId) throw invalidInput("Message client identity changed.");
      if (payload.role === "user" && payload.phase !== "execution") {
        db.prepare("UPDATE external_native_messages SET payload_json=? WHERE session_id=? AND source_id=?")
          .run(JSON.stringify({ ...payload, clientMessageId: message.clientMessageId }), sessionId, message.sourceId);
      }
    }
  }
}
