import { randomUUID } from "node:crypto";

import { conflict, invalidInput, notFound } from "./errors.js";
import type { MissionGoDatabase } from "./storage/database.js";

export type AgentSessionStatus = "active" | "idle" | "unavailable" | "failed";
export type AgentMessageRole = "user" | "agent" | "plan";

export interface AgentSessionMessageInput {
  readonly sourceId: string;
  readonly turnId?: string;
  readonly role: AgentMessageRole;
  readonly phase?: string;
  readonly text: string;
  readonly questions?: readonly { readonly title: string; readonly options?: readonly string[] }[];
}

export interface AgentSessionCommand {
  readonly id: string;
  readonly text: string;
  readonly status: "queued" | "delivered" | "failed";
  readonly error?: string;
  readonly createdAt: string;
  readonly deliveredAt?: string;
}

export interface AgentSessionSnapshot {
  readonly id: string;
  readonly dispatchId: string;
  readonly agentKind: "codex";
  readonly status: AgentSessionStatus;
  readonly lastError?: string;
  readonly updatedAt: string;
  readonly messages: readonly (AgentSessionMessageInput & { readonly id: string })[];
  readonly command?: AgentSessionCommand;
}

export interface NodeAgentSession {
  readonly id: string;
  readonly sessionRef: string;
  readonly status: AgentSessionStatus;
  readonly command?: AgentSessionCommand;
}

interface SessionRow {
  id: string;
  dispatch_id: string;
  agent_kind: "codex";
  agent_session_ref: string;
  status: AgentSessionStatus;
  last_error: string | null;
  updated_at: string;
}

interface CommandRow {
  id: string;
  text: string;
  status: "queued" | "delivered" | "failed";
  error: string | null;
  created_at: string;
  delivered_at: string | null;
}

const MAX_MESSAGE_LENGTH = 100_000;
const MAX_COMMAND_LENGTH = 20_000;
const MAX_MESSAGES_PER_SNAPSHOT = 2_000;

function requiredText(value: string, field: string, maximum: number): string {
  const text = value.trim();
  if (!text) throw invalidInput(`${field} is required.`);
  if (text.length > maximum) throw invalidInput(`${field} must be ${maximum} characters or fewer.`);
  return text;
}

export class AgentSessionStore {
  constructor(private readonly database: MissionGoDatabase) {}

  createForDispatch(input: { dispatchId: string; nodeId: string; sessionRef: string }): string {
    const dispatch = this.database.connection
      .prepare("SELECT agent_kind FROM dispatches WHERE id = ? AND node_id = ?")
      .get(input.dispatchId, input.nodeId) as unknown as { agent_kind: string } | undefined;
    if (!dispatch) throw notFound("Dispatch");
    if (dispatch.agent_kind !== "codex") throw invalidInput("Only Codex dispatches have mirrored sessions.");
    const sessionRef = requiredText(input.sessionRef, "sessionRef", 200);
    const existing = this.database.connection
      .prepare("SELECT id FROM agent_sessions WHERE dispatch_id = ?")
      .get(input.dispatchId) as unknown as { id: string } | undefined;
    if (existing) return existing.id;
    const id = randomUUID();
    const now = new Date().toISOString();
    this.database.connection
      .prepare(
        `INSERT INTO agent_sessions
          (id, dispatch_id, node_id, agent_kind, agent_session_ref, status, created_at, updated_at)
         VALUES (?, ?, ?, 'codex', ?, 'active', ?, ?)`,
      )
      .run(id, input.dispatchId, input.nodeId, sessionRef, now, now);
    return id;
  }

  getForAccount(accountId: string, sessionId: string): AgentSessionSnapshot {
    const row = this.database.connection
      .prepare(
        `SELECT s.id, s.dispatch_id, s.agent_kind, s.agent_session_ref, s.status, s.last_error, s.updated_at
         FROM agent_sessions s JOIN dispatches d ON d.id = s.dispatch_id
         WHERE s.id = ? AND d.account_id = ?`,
      )
      .get(sessionId, accountId) as unknown as SessionRow | undefined;
    if (!row) throw notFound("Agent session");
    const messages = this.database.connection
      .prepare(
        `SELECT id, source_id, turn_id, role, phase, text, questions_json
         FROM agent_session_messages WHERE session_id = ? ORDER BY position, observed_at, id`,
      )
      .all(sessionId) as unknown as Array<{
        id: string; source_id: string; turn_id: string | null; role: AgentMessageRole;
        phase: string | null; text: string; questions_json: string | null;
      }>;
    const command = this.latestCommand(sessionId);
    return {
      id: row.id,
      dispatchId: row.dispatch_id,
      agentKind: row.agent_kind,
      status: row.status,
      ...(row.last_error ? { lastError: row.last_error } : {}),
      updatedAt: row.updated_at,
      messages: messages.map((message) => ({
        id: message.id,
        sourceId: message.source_id,
        ...(message.turn_id ? { turnId: message.turn_id } : {}),
        role: message.role,
        ...(message.phase ? { phase: message.phase } : {}),
        text: message.text,
        ...(message.questions_json
          ? { questions: JSON.parse(message.questions_json) as Array<{ title: string; options?: string[] }> }
          : {}),
      })),
      ...(command ? { command: this.mapCommand(command) } : {}),
    };
  }

  enqueue(accountId: string, sessionId: string, textValue: string): AgentSessionCommand {
    const text = requiredText(textValue, "text", MAX_COMMAND_LENGTH);
    const session = this.database.connection
      .prepare(
        `SELECT s.id FROM agent_sessions s JOIN dispatches d ON d.id = s.dispatch_id
         WHERE s.id = ? AND d.account_id = ?`,
      )
      .get(sessionId, accountId) as unknown as { id: string } | undefined;
    if (!session) throw notFound("Agent session");
    if (this.queuedCommand(sessionId)) {
      throw conflict("agent_reply_pending", "This session already has a queued reply.");
    }
    const id = randomUUID();
    const now = new Date().toISOString();
    this.database.connection
      .prepare(
        `INSERT INTO agent_session_commands (id, session_id, account_id, text, status, created_at)
         VALUES (?, ?, ?, ?, 'queued', ?)`,
      )
      .run(id, sessionId, accountId, text, now);
    this.database.connection
      .prepare("UPDATE agent_sessions SET updated_at = ? WHERE id = ?")
      .run(now, sessionId);
    return { id, text, status: "queued", createdAt: now };
  }

  listForNode(nodeId: string): readonly NodeAgentSession[] {
    const rows = this.database.connection
      .prepare(
        `SELECT id, dispatch_id, agent_kind, agent_session_ref, status, last_error, updated_at
         FROM agent_sessions s
         WHERE node_id = ? AND (
           status IN ('active', 'unavailable') OR EXISTS (
             SELECT 1 FROM agent_session_commands c WHERE c.session_id = s.id AND c.status = 'queued'
           )
         )
         ORDER BY updated_at DESC LIMIT 100`,
      )
      .all(nodeId) as unknown as SessionRow[];
    return rows.map((row) => {
      const command = this.queuedCommand(row.id);
      return {
        id: row.id,
        sessionRef: row.agent_session_ref,
        status: row.status,
        ...(command ? { command: this.mapCommand(command) } : {}),
      };
    });
  }

  recordSnapshot(input: {
    nodeId: string;
    sessionId: string;
    status: AgentSessionStatus;
    messages: readonly AgentSessionMessageInput[];
    error?: string;
    commandId?: string;
    commandStatus?: "delivered" | "failed";
    commandError?: string;
  }): void {
    if (input.messages.length > MAX_MESSAGES_PER_SNAPSHOT) {
      throw invalidInput(`messages must contain ${MAX_MESSAGES_PER_SNAPSHOT} entries or fewer.`);
    }
    const session = this.database.connection
      .prepare("SELECT id FROM agent_sessions WHERE id = ? AND node_id = ?")
      .get(input.sessionId, input.nodeId) as unknown as { id: string } | undefined;
    if (!session) throw notFound("Agent session");
    const now = new Date().toISOString();
    this.database.transaction(() => {
      this.database.connection
        .prepare("UPDATE agent_sessions SET status = ?, last_error = ?, updated_at = ? WHERE id = ?")
        .run(input.status, input.error?.slice(0, 2_000) || null, now, input.sessionId);
      const upsert = this.database.connection.prepare(
        `INSERT INTO agent_session_messages
          (id, session_id, source_id, turn_id, role, phase, text, questions_json, position, observed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(session_id, source_id) DO UPDATE SET
           turn_id = excluded.turn_id, role = excluded.role, phase = excluded.phase,
           text = excluded.text, questions_json = excluded.questions_json,
           position = excluded.position, observed_at = excluded.observed_at`,
      );
      input.messages.forEach((message, position) => {
        const sourceId = requiredText(message.sourceId, "sourceId", 200);
        const text = requiredText(message.text, "message text", MAX_MESSAGE_LENGTH);
        upsert.run(
          randomUUID(), input.sessionId, sourceId, message.turnId?.slice(0, 200) || null,
          message.role, message.phase?.slice(0, 50) || null, text,
          message.questions ? JSON.stringify(message.questions) : null, position, now,
        );
      });
      if (input.commandId && input.commandStatus) {
        const changed = this.database.connection
          .prepare(
            `UPDATE agent_session_commands SET status = ?, error = ?, delivered_at = ?
             WHERE id = ? AND session_id = ? AND status = 'queued'`,
          )
          .run(
            input.commandStatus,
            input.commandError?.slice(0, 2_000) || null,
            input.commandStatus === "delivered" ? now : null,
            input.commandId,
            input.sessionId,
          );
        if (changed.changes === 0) {
          throw conflict("agent_reply_changed", "The queued reply no longer matches this session.");
        }
      }
    });
  }

  private queuedCommand(sessionId: string): CommandRow | undefined {
    return this.database.connection
      .prepare(
        `SELECT id, text, status, error, created_at, delivered_at
         FROM agent_session_commands WHERE session_id = ? AND status = 'queued' ORDER BY created_at DESC LIMIT 1`,
      )
      .get(sessionId) as unknown as CommandRow | undefined;
  }

  private latestCommand(sessionId: string): CommandRow | undefined {
    return this.database.connection
      .prepare(
        `SELECT id, text, status, error, created_at, delivered_at
         FROM agent_session_commands WHERE session_id = ? ORDER BY created_at DESC LIMIT 1`,
      )
      .get(sessionId) as unknown as CommandRow | undefined;
  }

  private mapCommand(row: CommandRow): AgentSessionCommand {
    return {
      id: row.id,
      text: row.text,
      status: row.status,
      ...(row.error ? { error: row.error } : {}),
      createdAt: row.created_at,
      ...(row.delivered_at ? { deliveredAt: row.delivered_at } : {}),
    };
  }
}
