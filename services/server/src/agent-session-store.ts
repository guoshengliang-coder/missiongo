import { createHash, randomUUID } from "node:crypto";

import { isAcceptedSessionUrl, nodeConnectionState, type AgentKind, type NodeConnectionState } from "@missiongo/domain";

import type { AgentAttentionClassification, AgentAttentionKind as ClassifiedAttentionKind } from "./ai-title.js";
import { conflict, invalidInput, notFound } from "./errors.js";
import type { MissionGoDatabase } from "./storage/database.js";

export type AgentSessionStatus = "active" | "idle" | "suspended" | "stalled" | "unavailable" | "failed";
export type AgentMessageRole = "user" | "agent" | "plan";
export type AgentSessionCommandStatus = "queued" | "delivering" | "delivered" | "failed" | "cancelled";
export type AgentAttentionState = "pending" | "needed" | "not_needed";
export type AgentAttentionKind = Exclude<ClassifiedAttentionKind, "none"> | "uncertain";

export interface AgentSessionAttention {
  readonly state: AgentAttentionState;
  readonly kind?: AgentAttentionKind;
  readonly reason?: string;
  readonly model?: string;
  /** Opaque fingerprint of the latest visible content, used for race-safe dismissal. */
  readonly revision?: string;
  readonly dismissed?: boolean;
}

export interface AgentSessionMessageInput {
  readonly sourceId: string;
  readonly turnId?: string;
  readonly role: AgentMessageRole;
  readonly phase?: string;
  readonly text: string;
  readonly questions?: readonly {
    readonly header?: string;
    readonly title: string;
    readonly options?: readonly string[];
    readonly multiSelect?: boolean;
  }[];
}

export interface AgentSessionActivity {
  readonly id: string;
  readonly title: string;
  readonly detail?: string;
}

export interface AgentSessionCommand {
  readonly id: string;
  readonly kind: "message" | "interrupt";
  readonly text: string;
  readonly turnId?: string;
  readonly status: AgentSessionCommandStatus;
  readonly error?: string;
  readonly createdAt: string;
  readonly deliveredAt?: string;
  readonly cancelledAt?: string;
}

export interface AgentSessionSnapshot {
  readonly id: string;
  readonly dispatchId: string;
  readonly agentKind: "codex" | "claude_code";
  readonly status: AgentSessionStatus;
  readonly lastError?: string;
  readonly updatedAt: string;
  readonly archivedAt?: string;
  readonly archivedSource?: "missiongo" | "source";
  readonly messages: readonly (AgentSessionMessageInput & { readonly id: string })[];
  readonly activities: readonly AgentSessionActivity[];
  readonly command?: AgentSessionCommand;
  /** False once every linked item is done. */
  readonly replyable: boolean;
}

export interface AgentSessionListItem {
  readonly id: string;
  readonly agentSessionId?: string;
  readonly dispatchId: string;
  readonly agentKind: AgentKind;
  readonly status: AgentSessionStatus;
  readonly lastError?: string;
  readonly updatedAt: string;
  readonly activityAt: string;
  readonly archivedAt?: string;
  readonly archivedSource?: "missiongo" | "source";
  readonly nodeName: string;
  readonly nodeConnectionState: NodeConnectionState;
  readonly nodeLastSeenAt?: string;
  readonly nodeRevoked: boolean;
  readonly mode: string;
  readonly dispatchStatus: string;
  readonly sessionName?: string;
  readonly sessionUrl?: string;
  readonly createdAt: string;
  readonly items: readonly {
    readonly key: string;
    readonly title: string;
    readonly productId: string;
  }[];
  readonly latestMessage?: Pick<AgentSessionMessageInput, "role" | "text">;
  readonly command?: AgentSessionCommand;
  readonly attention: AgentSessionAttention;
  readonly needsAttention: boolean;
  /** Kept for clients shipped before the broader "needs attention" wording. */
  readonly waitingForReply: boolean;
  readonly retryable: boolean;
  readonly stoppable: boolean;
  readonly replyable: boolean;
  readonly activityKey: string;
}

export interface NodeAgentSession {
  readonly id: string;
  readonly dispatchId: string;
  readonly agentKind: "codex" | "claude_code";
  readonly sessionRef: string;
  readonly status: AgentSessionStatus;
  readonly lifecycle: "keep" | "close";
  readonly occupiesExecutionSlot: boolean;
  readonly command?: AgentSessionCommand;
}

interface SessionRow {
  id: string;
  dispatch_id: string;
  agent_kind: "codex" | "claude_code";
  agent_session_ref: string;
  status: AgentSessionStatus;
  last_error: string | null;
  updated_at: string;
  archived_at: string | null;
  archive_source: "missiongo" | "source" | null;
  activities_json: string;
}

interface SessionListRow {
  session_id: string | null;
  dispatch_id: string;
  agent_kind: AgentKind;
  session_status: AgentSessionStatus | null;
  session_last_error: string | null;
  session_updated_at: string | null;
  session_activity_at: string | null;
  session_archived_at: string | null;
  session_archive_source: "missiongo" | "source" | null;
  session_activities_json: string | null;
  dispatch_archived_at: string | null;
  dispatch_error: string | null;
  node_name: string;
  node_last_seen_at: string | null;
  node_revoked_at: string | null;
  mode: string;
  dispatch_status: string;
  session_name: string | null;
  session_url: string | null;
  created_at: string;
  delivered_at: string | null;
  completed_at: string | null;
}

interface CommandRow {
  id: string;
  kind: "message" | "interrupt";
  text: string;
  turn_id: string | null;
  status: AgentSessionCommandStatus;
  error: string | null;
  created_at: string;
  delivered_at: string | null;
  cancelled_at: string | null;
}

interface AttentionRow {
  message_hash: string;
  state: AgentAttentionState;
  kind: AgentAttentionKind | null;
  reason: string | null;
  model: string | null;
  dismissed_message_hash: string | null;
  dismissed_at: string | null;
  dismissed_by_account_id: string | null;
}

const MAX_MESSAGE_LENGTH = 100_000;
const MAX_COMMAND_LENGTH = 20_000;
const MAX_MESSAGES_PER_SNAPSHOT = 2_000;
const MAX_ACTIVITIES_PER_SNAPSHOT = 100;
const SOURCE_ARCHIVE_POLL_MS = 30_000;

function requiredText(value: string, field: string, maximum: number): string {
  const text = value.trim();
  if (!text) throw invalidInput(`${field} is required.`);
  if (text.length > maximum) throw invalidInput(`${field} must be ${maximum} characters or fewer.`);
  return text;
}

function attentionMessageHash(
  status: AgentSessionStatus,
  message: {
    source_id: string;
    role: AgentMessageRole;
    phase: string | null;
    text: string;
    questions_json: string | null;
  } | undefined,
): string {
  return createHash("sha256").update(JSON.stringify([
    status,
    message?.source_id ?? "",
    message?.role ?? "",
    message?.phase ?? "",
    message?.text ?? "",
    message?.questions_json ?? "",
  ])).digest("hex");
}

function attentionContentHash(
  message: {
    source_id: string;
    role: AgentMessageRole;
    phase: string | null;
    text: string;
    questions_json: string | null;
  } | undefined,
): string {
  return createHash("sha256").update(JSON.stringify([
    message?.source_id ?? "",
    message?.role ?? "",
    message?.phase ?? "",
    message?.text ?? "",
    message?.questions_json ?? "",
  ])).digest("hex");
}

function normalizedSourceActivityAt(value: string | undefined, now: string): string | undefined {
  if (!value) return undefined;
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) throw invalidInput("activityAt must be an ISO 8601 timestamp.");
  const nowMilliseconds = Date.parse(now);
  if (milliseconds > nowMilliseconds + 5 * 60_000) {
    throw invalidInput("activityAt cannot be more than five minutes in the future.");
  }
  return new Date(Math.min(milliseconds, nowMilliseconds)).toISOString();
}

function hasQuestions(value: string | null | undefined): boolean {
  if (!value) return false;
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) && parsed.length > 0;
  } catch {
    return false;
  }
}

function explicitlyRequestsApproval(text: string): boolean {
  const chinese = /(?:请|需要|等待|待)(?:你|您)?[^。！？\n]{0,40}(?:批准|审批|确认|同意|授权|回复|答复)[^。！？\n]{0,80}(?:(?:后|之后)[^。！？\n]{0,30}(?:继续|开始|执行|实施|动手|推进)|(?:才能|方可)[^。！？\n]{0,30}(?:继续|开始|执行|实施|动手|推进))[^。！？\n]{0,40}[。！？]?\s*$/u;
  const english = /(?:please\s+)?(?:approve|confirm|reply|respond)[^.!?\n]{0,80}(?:before\s+(?:i|we)\s+(?:continue|start|proceed)|so\s+(?:i|we)\s+can\s+(?:continue|start|proceed)|then\s+(?:i|we)(?:'ll|\s+will)?\s+(?:continue|start|proceed))[^.!?\n]{0,40}[.!?]?\s*$/iu;
  const waiting = /\bwaiting\s+for\s+(?:your\s+)?(?:approval|confirmation|reply|response)\s+before\s+(?:continuing|starting|proceeding)\b[^.!?\n]{0,40}[.!?]?\s*$/iu;
  return chinese.test(text) || english.test(text) || waiting.test(text);
}

function deterministicAttention(
  status: AgentSessionStatus,
  message: {
    role: AgentMessageRole;
    text: string;
    questions_json: string | null;
  } | undefined,
): AgentSessionAttention | undefined {
  if (status === "stalled") {
    return {
      state: "needed",
      kind: "uncertain",
      reason: "会话连续 30 分钟没有输出且进程树 CPU 无进展，MissionGo 未自动终止。",
    };
  }
  if (hasQuestions(message?.questions_json)) {
    return { state: "needed", kind: "answer", reason: "AI 提出了需要回答的问题。" };
  }
  if (status !== "idle" || !message) return undefined;
  if (message.role === "plan") {
    return { state: "needed", kind: "approval", reason: "AI 正在等待计划审批。" };
  }
  if (message.role === "agent" && explicitlyRequestsApproval(message.text)) {
    return { state: "needed", kind: "approval", reason: "AI 明确要求批准或确认后再继续。" };
  }
  return undefined;
}

function initialAttention(
  status: AgentSessionStatus,
  message: {
    role: AgentMessageRole;
    text: string;
    questions_json: string | null;
  } | undefined,
): AgentSessionAttention {
  return deterministicAttention(status, message)
    ?? (status === "idle" && message?.role === "agent" ? { state: "pending" } : { state: "not_needed" });
}

function boundedAttentionText(text: string): string {
  if (text.length <= 20_000) return text;
  return `${text.slice(0, 2_000)}\n\n[中间内容已省略]\n\n${text.slice(-17_950)}`;
}

export class AgentSessionStore {
  constructor(private readonly database: MissionGoDatabase) {}

  createForDispatch(input: { dispatchId: string; nodeId: string; sessionRef: string }): string {
    const dispatch = this.database.connection
      .prepare("SELECT agent_kind FROM dispatches WHERE id = ? AND node_id = ?")
      .get(input.dispatchId, input.nodeId) as unknown as { agent_kind: string } | undefined;
    if (!dispatch) throw notFound("Dispatch");
    if (dispatch.agent_kind !== "codex" && dispatch.agent_kind !== "claude_code") {
      throw invalidInput("This agent does not support mirrored sessions.");
    }
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
          (id, dispatch_id, node_id, agent_kind, agent_session_ref, status, created_at, updated_at, activity_at)
         VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?)`,
      )
      .run(id, input.dispatchId, input.nodeId, dispatch.agent_kind, sessionRef, now, now, now);
    return id;
  }

  getForAccount(accountId: string, sessionId: string): AgentSessionSnapshot {
    const row = this.database.connection
      .prepare(
        `SELECT s.id, s.dispatch_id, s.agent_kind, s.agent_session_ref, s.status, s.last_error, s.updated_at,
                s.archived_at, s.archive_source, s.activities_json
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
      ...(row.archived_at ? { archivedAt: row.archived_at } : {}),
      ...(row.archive_source ? { archivedSource: row.archive_source } : {}),
      activities: JSON.parse(row.activities_json) as AgentSessionActivity[],
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
      replyable: !this.itemsCompleted(sessionId),
    };
  }

  /**
   * The account's AI hand-offs, newest activity first.
   *
   * Product authorization is deliberately applied by the HTTP boundary: this
   * store knows which account created a dispatch, but not which of that
   * account's product grants are still effective today. Item product ids travel
   * with each row so the boundary can make that decision without leaking a
   * title or preview first.
   */
  listForAccount(accountId: string, limit = 100): readonly AgentSessionListItem[] {
    const rows = this.database.connection
      .prepare(
        `SELECT s.id AS session_id, d.id AS dispatch_id, d.agent_kind,
                s.status AS session_status, s.last_error AS session_last_error,
                s.updated_at AS session_updated_at, s.activity_at AS session_activity_at,
                s.archived_at AS session_archived_at, s.archive_source AS session_archive_source,
                s.activities_json AS session_activities_json,
                COALESCE(n.nickname, n.name) AS node_name, n.last_seen_at AS node_last_seen_at,
                n.revoked_at AS node_revoked_at, d.mode, d.status AS dispatch_status,
                d.session_name, d.session_url, d.error AS dispatch_error,
                d.created_at, d.delivered_at, d.completed_at, d.archived_at AS dispatch_archived_at
         FROM dispatches d
         LEFT JOIN agent_sessions s ON s.dispatch_id = d.id
         JOIN nodes n ON n.id = d.node_id
         WHERE d.account_id = ?
         ORDER BY COALESCE(s.activity_at, d.archived_at, d.completed_at, d.delivered_at, d.created_at) DESC
         LIMIT ?`,
      )
      .all(accountId, limit) as unknown as SessionListRow[];
    const items = this.database.connection.prepare(
      `SELECT w.item_key, w.title, w.product_id, w.status
       FROM dispatch_items di JOIN work_items w ON w.id = di.item_id
       WHERE di.dispatch_id = ? ORDER BY di.position`,
    );
    const latestMessage = this.database.connection.prepare(
      `SELECT id, source_id, role, phase, text, questions_json FROM agent_session_messages
       WHERE session_id = ? ORDER BY position DESC, observed_at DESC, id DESC LIMIT 1`,
    );
    const attentionForSession = this.database.connection.prepare(
      `SELECT message_hash, state, kind, reason, model,
              dismissed_message_hash, dismissed_at, dismissed_by_account_id
       FROM agent_session_attention WHERE session_id = ?`,
    );
    return rows.map((row) => {
      const itemRows = items.all(row.dispatch_id) as unknown as Array<{
        item_key: string;
        title: string;
        product_id: string;
        status: string;
      }>;
      const message = row.session_id
        ? latestMessage.get(row.session_id) as unknown as {
          id: string; source_id: string; role: AgentMessageRole; phase: string | null;
          text: string; questions_json: string | null;
        } | undefined
        : undefined;
      const command = row.session_id ? this.latestCommand(row.session_id) : undefined;
      const inferredStatus: AgentSessionStatus = row.dispatch_status === "failed"
        ? "failed"
        : row.dispatch_status === "cancelled"
          ? "unavailable"
          : row.dispatch_status === "launched"
            && itemRows.every((item) => item.status !== "ready" && item.status !== "in_progress")
            ? "idle"
            : "active";
      const status = row.session_status ?? inferredStatus;
      const updatedAt = row.session_updated_at ?? row.dispatch_archived_at
        ?? row.completed_at ?? row.delivered_at ?? row.created_at;
      const activityAt = row.session_activity_at ?? row.dispatch_archived_at
        ?? row.completed_at ?? row.delivered_at ?? row.created_at;
      const archivedAt = row.session_archived_at ?? row.dispatch_archived_at;
      const archivedSource = row.session_archive_source ?? (row.dispatch_archived_at ? "missiongo" : null);
      const lastError = row.session_last_error ?? row.dispatch_error;
      const connectionState = row.node_revoked_at
        ? "offline"
        : nodeConnectionState(row.node_last_seen_at ?? undefined);
      const messageHash = attentionMessageHash(status, message);
      const contentHash = attentionContentHash(message);
      const cachedAttention = row.session_id
        ? attentionForSession.get(row.session_id) as unknown as AttentionRow | undefined
        : undefined;
      const pendingReply = command?.kind === "message"
        && (command.status === "queued" || command.status === "delivering");
      const replyAlreadyHandled = cachedAttention?.message_hash === messageHash
        && cachedAttention.state === "not_needed"
        && !cachedAttention.reason
        && !cachedAttention.model;
      const directAttention = deterministicAttention(status, message);
      const manuallyDismissed = cachedAttention?.dismissed_message_hash === contentHash;
      const attention: AgentSessionAttention = status === "stalled" && directAttention
        ? { ...directAttention, revision: contentHash }
        : pendingReply
          ? { state: "not_needed", revision: contentHash }
          : manuallyDismissed
            ? { state: "not_needed", reason: "已由用户标记为无需处理。", revision: contentHash, dismissed: true }
            : replyAlreadyHandled
              ? { state: "not_needed", revision: contentHash }
              : directAttention
                ? { ...directAttention, revision: contentHash }
                : cachedAttention?.message_hash === messageHash
                  ? {
                      state: cachedAttention.state,
                      ...(cachedAttention.kind ? { kind: cachedAttention.kind } : {}),
                      ...(cachedAttention.reason ? { reason: cachedAttention.reason } : {}),
                      ...(cachedAttention.model ? { model: cachedAttention.model } : {}),
                      revision: contentHash,
                    }
                  : { ...initialAttention(status, message), revision: contentHash };
      const needsAttention = attention.state === "needed";
      return {
        id: row.session_id ?? `dispatch:${row.dispatch_id}`,
        ...(row.session_id ? { agentSessionId: row.session_id } : {}),
        dispatchId: row.dispatch_id,
        agentKind: row.agent_kind,
        status,
        ...(lastError ? { lastError } : {}),
        updatedAt,
        activityAt,
        ...(archivedAt ? { archivedAt } : {}),
        ...(archivedSource ? { archivedSource } : {}),
        nodeName: row.node_name,
        nodeConnectionState: connectionState,
        ...(row.node_last_seen_at ? { nodeLastSeenAt: row.node_last_seen_at } : {}),
        nodeRevoked: Boolean(row.node_revoked_at),
        mode: row.mode,
        dispatchStatus: row.dispatch_status,
        ...(row.session_name ? { sessionName: row.session_name } : {}),
        ...(row.session_url ? { sessionUrl: row.session_url } : {}),
        createdAt: row.created_at,
        items: itemRows.map((item) => ({ key: item.item_key, title: item.title, productId: item.product_id })),
        ...(message ? { latestMessage: { role: message.role, text: message.text } } : {}),
        ...(command ? { command: this.mapCommand(command) } : {}),
        attention,
        needsAttention,
        activities: row.session_activities_json
          ? JSON.parse(row.session_activities_json) as AgentSessionActivity[]
          : [],
        waitingForReply: needsAttention,
        retryable: ["failed", "cancelled"].includes(row.dispatch_status)
          && itemRows.length > 0 && itemRows.every((item) => item.status === "ready"),
        stoppable: row.dispatch_status === "queued"
          || Boolean(row.session_id && (row.session_status === "active" || row.session_status === "stalled")),
        replyable: row.session_id ? !this.itemsCompleted(row.session_id) : false,
        activityKey: createHash("sha256").update(JSON.stringify([
          row.dispatch_status, status, lastError ?? "", row.session_archived_at ?? "",
          row.dispatch_archived_at ?? "",
          row.session_archive_source ?? "", connectionState, Boolean(row.node_revoked_at),
          message?.id ?? "", message?.text ?? "",
          message?.questions_json ?? "", command?.id ?? "", command?.status ?? "",
          row.session_activities_json ?? "[]",
        ])).digest("hex"),
      };
    });
  }

  setArchived(accountId: string, sessionId: string, archived: boolean): AgentSessionSnapshot {
    const session = this.database.connection
      .prepare(
        `SELECT s.archived_at, s.archive_source FROM agent_sessions s JOIN dispatches d ON d.id = s.dispatch_id
         WHERE s.id = ? AND d.account_id = ?`,
      )
      .get(sessionId, accountId) as unknown as {
        archived_at: string | null; archive_source: "missiongo" | "source" | null;
      } | undefined;
    if (!session) throw notFound("Agent session");
    if (!archived && session.archive_source === "source") {
      throw conflict("agent_session_source_archived", "Restore this session in Codex before continuing.");
    }
    if (archived && this.pendingCommand(sessionId)) {
      throw conflict("agent_command_pending", "Cancel or deliver the queued command before archiving this session.");
    }
    if (Boolean(session.archived_at) === archived) return this.getForAccount(accountId, sessionId);

    const now = new Date().toISOString();
    this.database.connection
      .prepare(
        "UPDATE agent_sessions SET archived_at = ?, archive_source = ?, updated_at = ?, activity_at = ? WHERE id = ?",
      )
      .run(archived ? now : null, archived ? "missiongo" : null, now, now, sessionId);
    return this.getForAccount(accountId, sessionId);
  }

  dismissAttention(accountId: string, sessionId: string, expectedRevision: string): void {
    const session = this.database.connection
      .prepare(
        `SELECT s.id, s.status FROM agent_sessions s JOIN dispatches d ON d.id = s.dispatch_id
         WHERE s.id = ? AND d.account_id = ?`,
      )
      .get(sessionId, accountId) as unknown as { id: string; status: AgentSessionStatus } | undefined;
    if (!session) throw notFound("Agent session");
    if (session.status === "stalled") {
      throw conflict("agent_attention_stalled", "A stalled session cannot be dismissed as a message-classification mistake.");
    }
    const message = this.database.connection.prepare(
      `SELECT source_id, role, phase, text, questions_json FROM agent_session_messages
       WHERE session_id = ? ORDER BY position DESC, observed_at DESC, id DESC LIMIT 1`,
    ).get(sessionId) as unknown as {
      source_id: string; role: AgentMessageRole; phase: string | null; text: string; questions_json: string | null;
    } | undefined;
    if (!message) throw conflict("agent_attention_unavailable", "This session has no visible message to dismiss.");
    const revision = attentionContentHash(message);
    if (revision !== expectedRevision) {
      throw conflict("agent_attention_changed", "The session received new content; review it before dismissing attention.");
    }
    const now = new Date().toISOString();
    const messageHash = attentionMessageHash(session.status, message);
    this.database.connection.prepare(
      `INSERT INTO agent_session_attention
        (session_id, message_hash, state, kind, reason, model, updated_at,
         dismissed_message_hash, dismissed_at, dismissed_by_account_id)
       VALUES (?, ?, 'not_needed', NULL, NULL, NULL, ?, ?, ?, ?)
       ON CONFLICT(session_id) DO UPDATE SET
         message_hash = excluded.message_hash,
         state = 'not_needed', kind = NULL, reason = NULL, model = NULL,
         updated_at = excluded.updated_at,
         dismissed_message_hash = excluded.dismissed_message_hash,
         dismissed_at = excluded.dismissed_at,
         dismissed_by_account_id = excluded.dismissed_by_account_id`,
    ).run(sessionId, messageHash, now, revision, now, accountId);
  }

  enqueue(accountId: string, sessionId: string, textValue: string): AgentSessionCommand {
    const text = requiredText(textValue, "text", MAX_COMMAND_LENGTH);
    const session = this.database.connection
      .prepare(
        `SELECT s.id, s.archived_at FROM agent_sessions s JOIN dispatches d ON d.id = s.dispatch_id
         WHERE s.id = ? AND d.account_id = ?`,
      )
      .get(sessionId, accountId) as unknown as { id: string; archived_at: string | null } | undefined;
    if (!session) throw notFound("Agent session");
    if (this.itemsCompleted(sessionId)) {
      throw conflict("agent_session_work_finished", "The linked work items are done; move them back to ready and dispatch again to rework them.");
    }
    if (session.archived_at) throw conflict("agent_session_archived", "Restore this session before replying.");
    if (this.pendingCommand(sessionId)) {
      throw conflict("agent_reply_pending", "This session already has a pending reply.");
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
      .prepare("UPDATE agent_sessions SET updated_at = ?, activity_at = ? WHERE id = ?")
      .run(now, now, sessionId);
    this.database.connection
      .prepare(
        `UPDATE agent_session_attention
         SET state = 'not_needed', kind = NULL, reason = NULL, model = NULL, updated_at = ?
         WHERE session_id = ?`,
      )
      .run(now, sessionId);
    return { id, kind: "message", text, status: "queued", createdAt: now };
  }

  enqueueInterrupt(accountId: string, sessionId: string): AgentSessionCommand {
    const session = this.database.connection
      .prepare(
        `SELECT s.id, s.status, s.archived_at FROM agent_sessions s JOIN dispatches d ON d.id = s.dispatch_id
         WHERE s.id = ? AND d.account_id = ?`,
      )
      .get(sessionId, accountId) as unknown as {
        id: string; status: AgentSessionStatus; archived_at: string | null;
      } | undefined;
    if (!session) throw notFound("Agent session");
    if (session.archived_at) throw conflict("agent_session_archived", "Restore this session before stopping it.");
    if (session.status !== "active" && session.status !== "stalled") {
      throw conflict("agent_not_running", "This agent session is not currently running.");
    }
    const pending = this.pendingCommand(sessionId);
    if (pending?.kind === "interrupt") {
      throw conflict("agent_stop_pending", "This session already has a queued stop request.");
    }
    if (pending?.status === "delivering") {
      throw conflict("agent_reply_delivering", "A reply is already being delivered; try stopping again shortly.");
    }
    const turn = this.database.connection
      .prepare(
        `SELECT turn_id FROM agent_session_messages
         WHERE session_id = ? AND turn_id IS NOT NULL
         ORDER BY position DESC, observed_at DESC, id DESC LIMIT 1`,
      )
      .get(sessionId) as unknown as { turn_id: string } | undefined;
    if (!turn?.turn_id) throw conflict("agent_turn_unavailable", "The active agent turn is not visible yet.");
    const id = randomUUID();
    const now = new Date().toISOString();
    this.database.transaction(() => {
      if (pending) {
        this.database.connection
          .prepare(
            `UPDATE agent_session_commands SET status = 'cancelled', error = ?, cancelled_at = ?
             WHERE id = ? AND status = 'queued'`,
          )
          .run("已被终止任务请求取代", now, pending.id);
      }
      this.database.connection
        .prepare(
          `INSERT INTO agent_session_commands (id, session_id, account_id, kind, text, turn_id, status, created_at)
           VALUES (?, ?, ?, 'interrupt', ?, ?, 'queued', ?)`,
        )
        .run(id, sessionId, accountId, "停止当前任务", turn.turn_id, now);
      this.database.connection
        .prepare("UPDATE agent_sessions SET updated_at = ?, activity_at = ? WHERE id = ?")
        .run(now, now, sessionId);
    });
    return { id, kind: "interrupt", text: "停止当前任务", turnId: turn.turn_id, status: "queued", createdAt: now };
  }

  cancel(accountId: string, sessionId: string, commandId: string): AgentSessionCommand {
    const command = this.database.connection
      .prepare(
        `SELECT c.id, c.kind, c.text, c.turn_id, c.status, c.error, c.created_at, c.delivered_at, c.cancelled_at
         FROM agent_session_commands c
         JOIN agent_sessions s ON s.id = c.session_id
         JOIN dispatches d ON d.id = s.dispatch_id
         WHERE c.id = ? AND c.session_id = ? AND d.account_id = ?`,
      )
      .get(commandId, sessionId, accountId) as unknown as CommandRow | undefined;
    if (!command) throw notFound("Agent session command");
    if (command.kind !== "message") {
      throw conflict("agent_reply_not_pending", "Only a queued reply can be cancelled.");
    }
    if (command.status === "cancelled") return this.mapCommand(command);
    if (command.status !== "queued") {
      throw conflict("agent_reply_not_pending", "Only a queued reply can be cancelled.");
    }

    const now = new Date().toISOString();
    this.database.transaction(() => {
      const changed = this.database.connection
        .prepare(
          `UPDATE agent_session_commands SET status = 'cancelled', cancelled_at = ?
           WHERE id = ? AND session_id = ? AND status = 'queued'`,
        )
        .run(now, commandId, sessionId);
      if (changed.changes === 0) {
        throw conflict("agent_reply_changed", "The queued reply changed before it could be cancelled.");
      }
      this.database.connection
        .prepare("UPDATE agent_sessions SET updated_at = ?, activity_at = ? WHERE id = ?")
        .run(now, now, sessionId);
      this.database.connection
        .prepare(
          `UPDATE agent_session_attention
           SET state = 'needed', kind = 'uncertain', reason = ?, model = NULL, updated_at = ?
           WHERE session_id = ?`,
        )
        .run("回复已取消，请重新确认是否仍需处理。", now, sessionId);
    });
    return this.mapCommand({ ...command, status: "cancelled", cancelled_at: now });
  }

  listForNode(nodeId: string): readonly NodeAgentSession[] {
    const sourceArchiveBefore = new Date(Date.now() - SOURCE_ARCHIVE_POLL_MS).toISOString();
    const rows = this.database.connection
      .prepare(
        `SELECT id, dispatch_id, agent_kind, agent_session_ref, status, last_error, updated_at
         FROM agent_sessions s
         WHERE node_id = ?
         AND (archived_at IS NULL OR (archive_source = 'source' AND updated_at <= ?))
         AND (
           status IN ('active', 'stalled', 'unavailable') OR EXISTS (
             SELECT 1 FROM agent_session_commands c
             WHERE c.session_id = s.id AND c.status IN ('queued', 'delivering')
           ) OR s.updated_at <= ?
         )
         ORDER BY archive_source = 'source', updated_at DESC LIMIT 100`,
      )
      .all(nodeId, sourceArchiveBefore, sourceArchiveBefore) as unknown as SessionRow[];
    return rows.map((row) => {
      const command = this.pendingCommand(row.id);
      return {
        id: row.id,
        dispatchId: row.dispatch_id,
        agentKind: row.agent_kind,
        sessionRef: row.agent_session_ref,
        status: row.status,
        lifecycle: row.agent_kind === "claude_code" && this.itemsCompleted(row.id) ? "close" : "keep",
        occupiesExecutionSlot: row.status === "active" || row.status === "stalled",
        ...(command ? { command: this.mapCommand(command) } : {}),
      };
    });
  }

  countExecutionSlots(nodeId: string): number {
    const row = this.database.connection
      .prepare("SELECT COUNT(*) AS count FROM agent_sessions WHERE node_id = ? AND status IN ('active', 'stalled')")
      .get(nodeId) as unknown as { count: number };
    return row.count;
  }

  recordSnapshot(input: {
    nodeId: string;
    sessionId: string;
    status: AgentSessionStatus;
    messages: readonly AgentSessionMessageInput[];
    activities?: readonly AgentSessionActivity[];
    error?: string;
    commandId?: string;
    commandStatus?: "delivering" | "delivered" | "failed";
    commandError?: string;
    sourceArchived?: boolean;
    sessionUrl?: string;
    activityAt?: string;
  }): void {
    if (input.messages.length > MAX_MESSAGES_PER_SNAPSHOT) {
      throw invalidInput(`messages must contain ${MAX_MESSAGES_PER_SNAPSHOT} entries or fewer.`);
    }
    if ((input.activities?.length ?? 0) > MAX_ACTIVITIES_PER_SNAPSHOT) {
      throw invalidInput(`activities must contain ${MAX_ACTIVITIES_PER_SNAPSHOT} entries or fewer.`);
    }
    const activities = (input.activities ?? []).map((activity) => ({
      id: requiredText(activity.id, "activity id", 200),
      title: requiredText(activity.title, "activity title", 500),
      ...(activity.detail ? { detail: requiredText(activity.detail, "activity detail", 500) } : {}),
    }));
    const activitiesJson = JSON.stringify(activities);
    const messages = input.messages.map((message, position) => ({
      sourceId: requiredText(message.sourceId, "sourceId", 200),
      turnId: message.turnId?.slice(0, 200) || null,
      role: message.role,
      phase: message.phase?.slice(0, 50) || null,
      text: requiredText(message.text, "message text", MAX_MESSAGE_LENGTH),
      questionsJson: message.questions ? JSON.stringify(message.questions) : null,
      position,
    }));
    const latestMessage = messages.at(-1);
    const messageHash = attentionMessageHash(input.status, latestMessage ? {
      source_id: latestMessage.sourceId,
      role: latestMessage.role,
      phase: latestMessage.phase,
      text: latestMessage.text,
      questions_json: latestMessage.questionsJson,
    } : undefined);
    const initialAttentionState = initialAttention(input.status, latestMessage ? {
      role: latestMessage.role,
      text: latestMessage.text,
      questions_json: latestMessage.questionsJson,
    } : undefined);
    const session = this.database.connection
      .prepare(
        `SELECT id, status, last_error, archived_at, archive_source, activities_json, activity_at
         FROM agent_sessions WHERE id = ? AND node_id = ?`,
      )
      .get(input.sessionId, input.nodeId) as unknown as {
        id: string;
        status: AgentSessionStatus;
        last_error: string | null;
        archived_at: string | null;
        archive_source: "missiongo" | "source" | null;
        activities_json: string;
        activity_at: string;
      } | undefined;
    if (!session) throw notFound("Agent session");
    const now = new Date().toISOString();
    const sourceActivityAt = normalizedSourceActivityAt(input.activityAt, now);
    const error = input.error?.slice(0, 2_000) || null;
    const sessionUrl = input.sessionUrl?.trim();
    if (sessionUrl && !isAcceptedSessionUrl(sessionUrl)) {
      throw invalidInput("Session URL must be an https:// address or a codex://threads/<id> link.");
    }
    const storedMessages = this.database.connection
      .prepare(
        `SELECT source_id, turn_id, role, phase, text, questions_json, position
         FROM agent_session_messages WHERE session_id = ?`,
      )
      .all(input.sessionId) as unknown as Array<{
        source_id: string;
        turn_id: string | null;
        role: AgentMessageRole;
        phase: string | null;
        text: string;
        questions_json: string | null;
        position: number;
      }>;
    const storedBySource = new Map(storedMessages.map((message) => [message.source_id, message]));
    const messagesChanged = messages.some((message) => {
      const stored = storedBySource.get(message.sourceId);
      return !stored
        || stored.turn_id !== message.turnId
        || stored.role !== message.role
        || stored.phase !== message.phase
        || stored.text !== message.text
        || stored.questions_json !== message.questionsJson
        || stored.position !== message.position;
    });
    const archiveChanged = input.sourceArchived === true
      ? !session.archived_at || session.archive_source === null
      : input.sourceArchived === false && session.archive_source === "source";
    const activityChanged = session.status !== input.status
      || session.last_error !== error
      || messagesChanged
      || session.activities_json !== activitiesJson
      || archiveChanged
      || Boolean(input.commandId && input.commandStatus);
    const nextActivityAt = activityChanged ? sourceActivityAt ?? now : session.activity_at;
    this.database.transaction(() => {
      this.database.connection
        .prepare(
          `UPDATE agent_sessions
           SET status = ?, last_error = ?, activities_json = ?, updated_at = ?,
               activity_at = ?
           WHERE id = ?`,
        )
        .run(input.status, error, activitiesJson, now, nextActivityAt, input.sessionId);
      if (input.sourceArchived === true) {
        this.database.connection
          .prepare(
            `UPDATE agent_sessions
             SET archived_at = COALESCE(archived_at, ?),
                 archive_source = CASE WHEN archive_source = 'missiongo' THEN archive_source ELSE 'source' END
             WHERE id = ?`,
          )
          .run(now, input.sessionId);
      } else if (input.sourceArchived === false) {
        this.database.connection
          .prepare(
            `UPDATE agent_sessions SET archived_at = NULL, archive_source = NULL
             WHERE id = ? AND archive_source = 'source'`,
          )
          .run(input.sessionId);
      }
      if (sessionUrl) {
        this.database.connection.prepare(
          `UPDATE dispatches SET session_url = ?
           WHERE id = (SELECT dispatch_id FROM agent_sessions WHERE id = ?)`,
        ).run(sessionUrl, input.sessionId);
      }
      const upsert = this.database.connection.prepare(
        `INSERT INTO agent_session_messages
          (id, session_id, source_id, turn_id, role, phase, text, questions_json, position, observed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(session_id, source_id) DO UPDATE SET
           turn_id = excluded.turn_id, role = excluded.role, phase = excluded.phase,
           text = excluded.text, questions_json = excluded.questions_json,
           position = excluded.position, observed_at = excluded.observed_at`,
      );
      messages.forEach((message) => {
        upsert.run(
          randomUUID(), input.sessionId, message.sourceId, message.turnId,
          message.role, message.phase, message.text,
          message.questionsJson, message.position, now,
        );
      });
      this.database.connection.prepare(
        `INSERT INTO agent_session_attention
          (session_id, message_hash, state, kind, reason, model, updated_at)
         VALUES (?, ?, ?, ?, ?, NULL, ?)
         ON CONFLICT(session_id) DO UPDATE SET
           message_hash = excluded.message_hash,
           state = excluded.state,
           kind = excluded.kind,
           reason = excluded.reason,
           model = NULL,
           updated_at = excluded.updated_at
         WHERE agent_session_attention.message_hash <> excluded.message_hash`,
      ).run(
        input.sessionId,
        messageHash,
        initialAttentionState.state,
        initialAttentionState.kind ?? null,
        initialAttentionState.reason ?? null,
        now,
      );
      if (input.commandId && input.commandStatus) {
        const sourceStatus = input.commandStatus === "delivering" ? "status = 'queued'" : "status IN ('queued', 'delivering')";
        const changed = this.database.connection
          .prepare(
            `UPDATE agent_session_commands SET status = ?, error = ?, delivered_at = ?
             WHERE id = ? AND session_id = ? AND ${sourceStatus}`,
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

  pendingAttention(sessionId: string): { readonly messageHash: string; readonly text: string } | undefined {
    const session = this.database.connection.prepare(
      `SELECT s.status, a.message_hash, a.state
       FROM agent_sessions s JOIN agent_session_attention a ON a.session_id = s.id
       WHERE s.id = ?`,
    ).get(sessionId) as unknown as {
      status: AgentSessionStatus;
      message_hash: string;
      state: AgentAttentionState;
    } | undefined;
    if (!session || session.state !== "pending") return undefined;
    const message = this.database.connection.prepare(
      `SELECT source_id, role, phase, text, questions_json
       FROM agent_session_messages WHERE session_id = ?
       ORDER BY position DESC, observed_at DESC, id DESC LIMIT 1`,
    ).get(sessionId) as unknown as {
      source_id: string;
      role: AgentMessageRole;
      phase: string | null;
      text: string;
      questions_json: string | null;
    } | undefined;
    if (!message || message.role !== "agent"
      || attentionMessageHash(session.status, message) !== session.message_hash) return undefined;
    return { messageHash: session.message_hash, text: boundedAttentionText(message.text) };
  }

  completeAttention(
    sessionId: string,
    messageHash: string,
    classification: AgentAttentionClassification,
  ): boolean {
    const changed = this.database.connection.prepare(
      `UPDATE agent_session_attention
       SET state = ?, kind = ?, reason = ?, model = ?, updated_at = ?
       WHERE session_id = ? AND message_hash = ? AND state = 'pending'`,
    ).run(
      classification.needsAttention ? "needed" : "not_needed",
      classification.kind === "none" ? null : classification.kind,
      classification.reason,
      classification.model,
      new Date().toISOString(),
      sessionId,
      messageHash,
    );
    return changed.changes === 1;
  }

  failAttention(sessionId: string, messageHash: string): boolean {
    const changed = this.database.connection.prepare(
      `UPDATE agent_session_attention
       SET state = 'needed', kind = 'uncertain', reason = ?, model = NULL, updated_at = ?
       WHERE session_id = ? AND message_hash = ? AND state = 'pending'`,
    ).run(
      "AI 判断暂时不可用，请人工确认是否需要处理。",
      new Date().toISOString(),
      sessionId,
      messageHash,
    );
    return changed.changes === 1;
  }

  private pendingCommand(sessionId: string): CommandRow | undefined {
    return this.database.connection
      .prepare(
        `SELECT id, kind, text, turn_id, status, error, created_at, delivered_at, cancelled_at
         FROM agent_session_commands
         WHERE session_id = ? AND status IN ('queued', 'delivering')
         ORDER BY created_at DESC, rowid DESC LIMIT 1`,
      )
      .get(sessionId) as unknown as CommandRow | undefined;
  }

  private itemsCompleted(sessionId: string): boolean {
    const rows = this.database.connection.prepare(
      `SELECT w.status FROM agent_sessions s
       JOIN dispatch_items di ON di.dispatch_id = s.dispatch_id
       JOIN work_items w ON w.id = di.item_id
       WHERE s.id = ?`,
    ).all(sessionId) as unknown as Array<{ status: string }>;
    return rows.length > 0 && rows.every((row) => row.status === "done");
  }

  private latestCommand(sessionId: string): CommandRow | undefined {
    return this.database.connection
      .prepare(
        `SELECT id, kind, text, turn_id, status, error, created_at, delivered_at, cancelled_at
         FROM agent_session_commands WHERE session_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1`,
      )
      .get(sessionId) as unknown as CommandRow | undefined;
  }

  private mapCommand(row: CommandRow): AgentSessionCommand {
    return {
      id: row.id,
      kind: row.kind,
      text: row.text,
      ...(row.turn_id ? { turnId: row.turn_id } : {}),
      status: row.status,
      ...(row.error ? { error: row.error } : {}),
      createdAt: row.created_at,
      ...(row.delivered_at ? { deliveredAt: row.delivered_at } : {}),
      ...(row.cancelled_at ? { cancelledAt: row.cancelled_at } : {}),
    };
  }
}
