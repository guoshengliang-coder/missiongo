import { isConversationMessage } from "@missiongo/domain";
import { createHash } from "node:crypto";
import type { MissionGoDatabase } from "./storage/database.js";

export interface UnreadMessage {
  sourceId: string;
  role: string;
  phase?: string | null | undefined;
  occurredAt?: string | null | undefined;
  questions?: readonly { answered?: string; withdrawn?: boolean }[] | null | undefined;
}
interface State { source_at: string | null; healthy_status: string | null; cycle: number }
const healthy = (status: string) => status !== "unavailable" && status !== "suspended";
const pending = (message: UnreadMessage) => message.questions?.some(q => q.answered === undefined && !q.withdrawn) === true;
const timestamp = (value?: string | null) => value && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : undefined;
const visible = (message: UnreadMessage) => message.role !== "user" && isConversationMessage(message);

/** Snapshot storage is not a notification event. Keep a durable source frontier
 * and last healthy status across transport failures and node restarts. The
 * notification clock remains server-owned, independent of source chronology. */
export function observeSessionUnread(database: MissionGoDatabase, input: {
  key: string; previousStatus: string; status: string; now: string;
  messages: readonly UnreadMessage[]; stored: readonly UnreadMessage[];
}): boolean {
  const db = database.connection;
  const old = new Map(input.stored.map(message => [message.sourceId, message]));
  const seed = input.stored.filter(visible).map(message => timestamp(message.occurredAt)).filter((v): v is string => Boolean(v)).sort().at(-1);
  const state = db.prepare("SELECT source_at,healthy_status,cycle FROM session_unread_state WHERE session_key=?").get(input.key) as State | undefined;
  const frontier = state ? state.source_at ?? undefined : seed;
  const priorStatus = state?.healthy_status ?? (healthy(input.previousStatus) ? input.previousStatus : null);
  let sourceAt = frontier;
  let cycle = state?.cycle ?? 0;
  if (input.status === "active" && priorStatus !== "active") cycle++;
  const events: { key: string; reason: string; sourceAt?: string | undefined }[] = [];
  for (const message of input.messages) {
    if (!visible(message)) continue;
    const previous = old.get(message.sourceId);
    const occurredAt = timestamp(message.occurredAt);
    const questionVersion = (value: UnreadMessage) => JSON.stringify(value.questions?.filter(q => q.answered === undefined && !q.withdrawn));
    // Sources can omit the server's answer/withdrawal acknowledgement when
    // replaying a card. Omission must not reopen an already settled question.
    const questionIdentity = (q: NonNullable<UnreadMessage["questions"]>[number]) => {
      const { answered: _answered, withdrawn: _withdrawn, ...identity } = q;
      return JSON.stringify(identity);
    };
    const effective = { ...message, questions: message.questions?.map(q => {
      const prior = previous?.questions?.find(oldQuestion => questionIdentity(oldQuestion) === questionIdentity(q));
      return prior && (prior.answered !== undefined || prior.withdrawn) ? prior : q;
    }) };
    const newQuestion = pending(effective) && (!previous || questionVersion(effective) !== questionVersion(previous));
    // A question newly attached to an existing message is a current action,
    // even though the message itself has an old source timestamp.
    const historical = occurredAt && frontier && occurredAt < frontier;
    if ((!previous && !historical) || (newQuestion && (previous || !historical))) {
      events.push({ key: newQuestion ? `question:${message.sourceId}:${createHash("sha256").update(questionVersion(effective)).digest("hex")}` : `message:${message.sourceId}`,
        reason: newQuestion ? "pending_question" : "new_output", sourceAt: occurredAt });
    }
    if (occurredAt && (!sourceAt || occurredAt > sourceAt)) sourceAt = occurredAt;
  }
  if (healthy(input.status) && (priorStatus || input.stored.length === 0) && priorStatus !== input.status
    && (["failed", "stalled"].includes(input.status) || (priorStatus === "active" && input.status === "idle"))) {
    events.push({ key: `status:${cycle}:${input.status}`, reason: `turn_${input.status}` });
  }
  let unread = false;
  for (const event of events) {
    const result = db.prepare(`INSERT OR IGNORE INTO session_unread_events(session_key,event_key,reason,source_at,received_at)
      VALUES (?,?,?,?,?)`).run(input.key, event.key, event.reason, event.sourceAt ?? null, input.now);
    unread ||= result.changes > 0;
  }
  db.prepare(`INSERT INTO session_unread_state(session_key,source_at,healthy_status,cycle) VALUES (?,?,?,?)
    ON CONFLICT(session_key) DO UPDATE SET source_at=excluded.source_at,healthy_status=excluded.healthy_status,cycle=excluded.cycle`)
    .run(input.key, sourceAt ?? null, healthy(input.status) ? input.status : priorStatus, cycle);
  return unread;
}

/** Acknowledge only the source events covered by the displayed server clock. */
export function acknowledgeSessionUnread(database: MissionGoDatabase, key: string, through: string): void {
  database.connection.prepare(`UPDATE session_unread_state SET read_source_at=(
    SELECT MAX(stamp) FROM (
      SELECT read_source_at AS stamp FROM session_unread_state WHERE session_key=?
      UNION ALL SELECT source_at FROM session_unread_events WHERE session_key=? AND received_at<=?
    )
  ) WHERE session_key=?`).run(key, key, through, key);
}
