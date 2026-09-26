import { createHash, randomUUID } from "node:crypto";

import { isAcceptedSessionUrl, nodeConnectionState, type AgentKind, type NodeConnectionState } from "@missiongo/domain";

import type { AgentAttentionClassification, AgentAttentionKind as ClassifiedAttentionKind } from "./ai-title.js";
import type { AgentSessionAttachment, AgentSessionAttachments } from "./agent-session-attachments.js";
import { parseAgentModels, requireOfferedModel, type AgentRunSettings } from "./agent-settings.js";
import { autoArchiveFinishedDispatches } from "./auto-archive.js";
import { deliveredDispatchTimedOut } from "./dispatch-store.js";
import { conflict, invalidInput, notFound } from "./errors.js";
import type { MissionGoDatabase } from "./storage/database.js";

export type AgentSessionStatus = "active" | "idle" | "suspended" | "stalled" | "unavailable" | "failed";
export type AgentMessageRole = "user" | "agent" | "plan";
export type AgentSessionCommandStatus = "queued" | "delivering" | "delivery_unknown" | "delivered" | "failed" | "cancelled";
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
  readonly occurredAt?: string;
  readonly questions?: readonly {
    readonly header?: string;
    readonly title: string;
    /** The full ask behind a short title, e.g. an OpenCode form description. */
    readonly detail?: string;
    readonly options?: readonly string[];
    readonly multiSelect?: boolean;
    /** Reply key for a field whose title is not what a reply is matched on. */
    readonly key?: string;
    /** Non-choice input control; absent means a choice built from `options`. */
    readonly kind?: "text" | "number" | "boolean";
    readonly placeholder?: string;
    /** The question also takes an answer outside its options. */
    readonly custom?: boolean;
  }[];
}

export interface AgentSessionActivity {
  readonly id: string;
  readonly title: string;
  readonly detail?: string;
  readonly startedAt?: string;
}

export interface AgentSessionTurnState {
  readonly turnActive?: boolean;
  readonly waitingForInput?: boolean;
  readonly turnStartedAt?: string;
  readonly lastOutputAt?: string;
  readonly thinkingStartedAt?: string;
  readonly thinkingTokens?: number;
  readonly thinkingDurationSeconds?: number;
}

export interface AgentSessionCommand {
  readonly id: string;
  readonly kind: "message" | "interrupt";
  readonly text: string;
  readonly attachments?: readonly AgentSessionAttachment[];
  readonly turnId?: string;
  readonly status: AgentSessionCommandStatus;
  readonly error?: string;
  readonly createdAt: string;
  readonly deliveredAt?: string;
  readonly deliveringAt?: string;
  readonly cancelledAt?: string;
}

export interface AgentSessionSnapshot {
  readonly id: string;
  readonly dispatchId: string;
  readonly agentKind: "codex" | "claude_code" | "opencode";
  readonly status: AgentSessionStatus;
  readonly lastError?: string;
  readonly updatedAt: string;
  readonly archivedAt?: string;
  readonly archivedSource?: "missiongo" | "source";
  readonly messages: readonly (AgentSessionMessageInput & { readonly id: string })[];
  readonly attachmentMessages?: readonly {
    readonly commandId: string;
    readonly text: string;
    readonly createdAt: string;
    readonly status: AgentSessionCommandStatus;
    readonly attachments: readonly AgentSessionAttachment[];
  }[];
  readonly activities: readonly AgentSessionActivity[];
  readonly turnState: AgentSessionTurnState;
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
  readonly turnState?: AgentSessionTurnState;
  readonly lastError?: string;
  readonly updatedAt: string;
  readonly activityAt: string;
  readonly archivedAt?: string;
  readonly archivedSource?: "missiongo" | "source";
  readonly nodeId: string;
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
  /** Mode, model and effort this conversation runs with, and any change still on its way (AND-130). */
  readonly settings: AgentSessionSettings;
  /** Something a person should look at arrived after they last opened this conversation. */
  readonly unread: boolean;
  /** The unread clock; opening the conversation marks it read up to this value. */
  readonly unreadAt?: string;
}

export interface AgentSessionSettings {
  /** The mode in effect: the last change the Mac confirmed, else the dispatch's. */
  readonly mode: string;
  /** What the agent reported using; absent until it says. */
  readonly model?: string;
  readonly effort?: string;
  /**
   * Host of the custom endpoint the agent's requests actually go to (AND-161).
   * A third-party Anthropic-compatible proxy serves the official model ids, so
   * `model` alone cannot say where the answers come from; absent means the
   * machine reported no custom endpoint configured.
   */
  readonly modelEndpoint?: string;
  /** What the dispatch asked for; absent means the Mac's own configuration. */
  readonly requestedModel?: string;
  readonly requestedEffort?: string;
  /** A change a person asked for that the Mac has not confirmed yet. */
  readonly pending?: AgentRunSettings & { readonly revision: number };
  /** The last change the Mac could not apply. */
  readonly error?: string;
  /** False for a Mac whose client cannot change a running session, or a finished conversation. */
  readonly adjustable: boolean;
}

export interface NodeAgentSession {
  readonly id: string;
  readonly dispatchId: string;
  readonly agentKind: "codex" | "claude_code" | "opencode";
  readonly sessionRef: string;
  readonly status: AgentSessionStatus;
  readonly lifecycle: "keep" | "close";
  readonly occupiesExecutionSlot: boolean;
  readonly command?: AgentSessionCommand;
  /**
   * MissionGo archived this conversation -- automatically because its work
   * finished, or by a person (AND-129) -- so archive the Codex thread at the
   * source as well. A separate flag rather than a new lifecycle value, because
   * an older Mac would fail to decode one.
   */
  readonly archiveInSource?: true;
  /** A person restored it in MissionGo after the Codex thread was archived; restore the thread too. */
  readonly restoreInSource?: true;
  /** The latest mode/model/effort a person asked for; apply it when its revision is newer than the next field. */
  readonly desiredSettings?: AgentRunSettings & { readonly revision: number };
  /** The newest revision the Mac applied, or failed to apply -- either way, not to be sent again. */
  readonly appliedSettingsRevision: number;
}

interface SessionRow {
  id: string;
  dispatch_id: string;
  agent_kind: "codex" | "claude_code" | "opencode";
  agent_session_ref: string;
  status: AgentSessionStatus;
  last_error: string | null;
  updated_at: string;
  archived_at: string | null;
  archive_source: "missiongo" | "source" | null;
  activities_json: string;
  turn_state_json: string;
  archive_reason?: "auto" | null;
  source_archived_at?: string | null;
  source_archive_error?: string | null;
  source_restore_pending?: number;
  desired_settings_json?: string | null;
  settings_revision?: number;
  applied_settings_revision?: number;
  settings_error_revision?: number;
}

interface SessionSettingsColumns {
  agent_kind: AgentKind;
  dispatch_mode: string;
  dispatch_model: string | null;
  dispatch_effort: string | null;
  session_mode: string | null;
  session_model: string | null;
  session_model_endpoint: string | null;
  session_effort: string | null;
  desired_settings_json: string | null;
  settings_revision: number | null;
  applied_settings_revision: number | null;
  settings_error: string | null;
  settings_error_revision: number | null;
  node_agents_json: string;
}

function nodeAgentModels(agentsJson: string, agentKind: AgentKind) {
  const agents = JSON.parse(agentsJson) as Array<{ kind: string; models?: unknown }>;
  const agent = agents.find((entry) => entry.kind === agentKind);
  return agent ? parseAgentModels(agent.models) : undefined;
}

function sessionSettings(row: SessionSettingsColumns, open: boolean): AgentSessionSettings {
  const desired = row.desired_settings_json ? JSON.parse(row.desired_settings_json) as AgentRunSettings : undefined;
  const revision = row.settings_revision ?? 0;
  const settled = Math.max(row.applied_settings_revision ?? 0, row.settings_error_revision ?? 0);
  return {
    mode: row.session_mode ?? row.dispatch_mode,
    ...(row.session_model ? { model: row.session_model } : {}),
    ...(row.session_model_endpoint ? { modelEndpoint: row.session_model_endpoint } : {}),
    ...(row.session_effort ? { effort: row.session_effort } : {}),
    ...(row.dispatch_model ? { requestedModel: row.dispatch_model } : {}),
    ...(row.dispatch_effort ? { requestedEffort: row.dispatch_effort } : {}),
    ...(desired && revision > settled ? { pending: { ...desired, revision } } : {}),
    ...(row.settings_error && (row.settings_error_revision ?? 0) >= (row.applied_settings_revision ?? 0)
      ? { error: row.settings_error }
      : {}),
    adjustable: open && nodeAgentModels(row.node_agents_json, row.agent_kind) !== undefined,
  };
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
  session_turn_state_json: string | null;
  dispatch_archived_at: string | null;
  dispatch_error: string | null;
  node_id: string;
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
  unread_at: string | null;
  read_at: string | null;
}

type SessionListSettingsRow = SessionListRow & SessionSettingsColumns;

interface CommandRow {
  id: string;
  kind: "message" | "interrupt";
  text: string;
  turn_id: string | null;
  status: AgentSessionCommandStatus;
  error: string | null;
  created_at: string;
  delivered_at: string | null;
  delivering_at: string | null;
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

function normalizedSourceTimestamp(value: string | undefined, now: string, field: string): string | undefined {
  if (!value) return undefined;
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) throw invalidInput(`${field} must be an ISO 8601 timestamp.`);
  const nowMilliseconds = Date.parse(now);
  if (milliseconds > nowMilliseconds + 5 * 60_000) {
    throw invalidInput(`${field} cannot be more than five minutes in the future.`);
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

/**
 * How long a Mac may be silent before its active sessions read as
 * unavailable (AND-221). Past this, "running" describes a stale mirror, not
 * the machine: nothing can report the session, and every one of them frozen
 * at `active` kept occupying an execution slot with the console still saying
 * it was working. Read-time only — the stored status stays the node's last
 * word and is overwritten by the next snapshot a reconnected Mac sends.
 */
export const NODE_OFFLINE_SESSION_DEGRADE_MS = 30 * 60_000;

/**
 * A session whose Mac has been offline this long (or whose node was revoked)
 * is not running anything the server can vouch for. Returns the status the
 * console should read, and whether it was degraded (AND-221).
 */
export function offlineDegradedStatus(
  status: AgentSessionStatus,
  nodeLastSeenAt: string | null | undefined,
  nodeRevoked: boolean,
  now = Date.now(),
): { degraded: boolean; status: AgentSessionStatus } {
  if (status !== "active" && status !== "stalled") return { degraded: false, status };
  if (nodeRevoked) return { degraded: true, status: "unavailable" };
  const seen = Date.parse(nodeLastSeenAt ?? "");
  if (!Number.isFinite(seen) || now - seen < NODE_OFFLINE_SESSION_DEGRADE_MS) {
    return { degraded: false, status };
  }
  return { degraded: true, status: "unavailable" };
}

/**
 * How long MissionGo waits for the Mac to settle a reply it has already claimed
 * (AND-184). Before this, a command's whole life was driven by the node: a Mac
 * that went away mid-delivery left the one pending slot occupied forever, and
 * nothing in the server noticed.
 */
export const COMMAND_DELIVERING_TIMEOUT_MS = 30 * 60 * 1_000;
/**
 * How long a reply may wait behind a running turn before it is worth pointing
 * out. Waiting behind a long turn is legitimate, so this never fails the
 * command, it only surfaces it (AND-184).
 */
export const COMMAND_QUEUED_ALERT_MS = 180 * 60 * 1_000;
/** Stamped on a delivery the server stopped waiting for; also its alert marker. */
export const COMMAND_DELIVERY_TIMEOUT_ERROR =
  "Mac 认领回复后 30 分钟没有报告投递结果，MissionGo 已自动标记失败。请重新发送或检查该 Mac。";
export const COMMAND_DELIVERY_UNKNOWN_ERROR =
  "无法确认 Codex 是否收到这条回复。请先在 Codex 会话中核实，再选择已收到或未收到；MissionGo 不会自动重发。";

/**
 * Why a pending reply deserves attention, or undefined when it does not. A
 * command the server already failed for timeout keeps its alert until a new
 * reply replaces it; a normal queue and a normal delivery stay quiet, so a long
 * turn never looks like a fault (AND-184).
 */
export function stuckCommandReason(
  command: {
    status: AgentSessionCommandStatus;
    error: string | null;
    created_at: string;
    delivering_at: string | null;
  },
  now = Date.now(),
): string | undefined {
  if (command.status === "delivering") {
    const since = Date.parse(command.delivering_at ?? command.created_at);
    return Number.isFinite(since) && now - since >= COMMAND_DELIVERING_TIMEOUT_MS
      ? COMMAND_DELIVERY_TIMEOUT_ERROR
      : undefined;
  }
  if (command.status === "delivery_unknown") return command.error || COMMAND_DELIVERY_UNKNOWN_ERROR;
  if (command.status === "queued") {
    const since = Date.parse(command.created_at);
    return Number.isFinite(since) && now - since >= COMMAND_QUEUED_ALERT_MS
      ? "回复已排队超过 3 小时，Mac 仍未取走。可能节点离线或会话卡住，可停止后重新发送。"
      : undefined;
  }
  if (command.status === "failed" && command.error === COMMAND_DELIVERY_TIMEOUT_ERROR) {
    return COMMAND_DELIVERY_TIMEOUT_ERROR;
  }
  return undefined;
}

function boundedAttentionText(text: string): string {
  if (text.length <= 20_000) return text;
  return `${text.slice(0, 2_000)}\n\n[中间内容已省略]\n\n${text.slice(-17_950)}`;
}

/**
 * Whether a node snapshot contains something a person should come back for:
 * a new Agent or plan message, questions newly attached to one, a turn that
 * finished, or a session that failed or stalled. Everything else the node
 * reports -- connectivity, sync errors and their recovery, a re-read of the
 * same transcript, streamed text growing, the person's own delivered reply --
 * changes the mirror without making the conversation unread (AND-135).
 */
export function snapshotMakesUnread(
  previousStatus: AgentSessionStatus,
  nextStatus: AgentSessionStatus,
  messages: readonly { sourceId: string; role: AgentMessageRole; questionsJson: string | null }[],
  stored: ReadonlyMap<string, { questions_json: string | null }>,
): boolean {
  const newOutput = messages.some((message) => {
    if (message.role === "user") return false;
    const previous = stored.get(message.sourceId);
    return !previous || (!hasQuestions(previous.questions_json) && hasQuestions(message.questionsJson));
  });
  if (newOutput) return true;
  if (previousStatus === nextStatus) return false;
  return nextStatus === "failed"
    || nextStatus === "stalled"
    || (previousStatus === "active" && nextStatus === "idle");
}

export class AgentSessionStore {
  constructor(private readonly database: MissionGoDatabase, private readonly attachments?: AgentSessionAttachments) {}

  createForDispatch(input: { dispatchId: string; nodeId: string; sessionRef: string }): string {
    const dispatch = this.database.connection
      .prepare("SELECT agent_kind FROM dispatches WHERE id = ? AND node_id = ?")
      .get(input.dispatchId, input.nodeId) as unknown as { agent_kind: string } | undefined;
    if (!dispatch) throw notFound("Dispatch");
    if (dispatch.agent_kind !== "codex" && dispatch.agent_kind !== "claude_code" && dispatch.agent_kind !== "opencode") {
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
                s.archived_at, s.archive_source, s.activities_json, s.turn_state_json,
                n.last_seen_at AS node_last_seen_at, n.revoked_at AS node_revoked_at
         FROM agent_sessions s
         JOIN dispatches d ON d.id = s.dispatch_id
         JOIN nodes n ON n.id = s.node_id
         WHERE s.id = ? AND d.account_id = ?`,
      )
      .get(sessionId, accountId) as unknown as
        (SessionRow & { node_last_seen_at: string | null; node_revoked_at: string | null }) | undefined;
    if (!row) throw notFound("Agent session");
    const messages = this.database.connection
      .prepare(
        `SELECT id, source_id, turn_id, role, phase, text, questions_json, occurred_at
         FROM agent_session_messages WHERE session_id = ? ORDER BY position, observed_at, rowid`,
      )
      .all(sessionId) as unknown as Array<{
        id: string; source_id: string; turn_id: string | null; role: AgentMessageRole;
        phase: string | null; text: string; questions_json: string | null; occurred_at: string;
      }>;
    const command = this.latestCommand(sessionId);
    return {
      id: row.id,
      dispatchId: row.dispatch_id,
      agentKind: row.agent_kind,
      // Same read-time rule as the list (AND-221): a Mac nobody has heard
      // from in half an hour is not running this session.
      status: offlineDegradedStatus(
        row.status, row.node_last_seen_at, Boolean(row.node_revoked_at),
      ).status,
      ...(row.last_error ? { lastError: row.last_error } : {}),
      updatedAt: row.updated_at,
      ...(row.archived_at ? { archivedAt: row.archived_at } : {}),
      ...(row.archive_source ? { archivedSource: row.archive_source } : {}),
      activities: JSON.parse(row.activities_json) as AgentSessionActivity[],
      turnState: JSON.parse(row.turn_state_json) as AgentSessionTurnState,
      messages: messages.map((message) => ({
        id: message.id,
        sourceId: message.source_id,
        ...(message.turn_id ? { turnId: message.turn_id } : {}),
        role: message.role,
        ...(message.phase ? { phase: message.phase } : {}),
        text: message.text,
        occurredAt: message.occurred_at,
        ...(message.questions_json
          ? { questions: JSON.parse(message.questions_json) as Array<{ title: string; options?: string[] }> }
          : {}),
      })),
      ...(this.attachments ? { attachmentMessages: this.attachmentMessages(sessionId) } : {}),
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
    // Read paths are where the server's own timeout check runs (AND-184): no
    // resident timer, and the check happens exactly when somebody can see the
    // freed slot.
    this.failStuckDeliveringCommands();
    const rows = this.database.connection
      .prepare(
        `SELECT s.id AS session_id, d.id AS dispatch_id, d.agent_kind,
                s.status AS session_status, s.last_error AS session_last_error,
                s.updated_at AS session_updated_at, s.activity_at AS session_activity_at,
                s.archived_at AS session_archived_at, s.archive_source AS session_archive_source,
                s.activities_json AS session_activities_json,
                s.turn_state_json AS session_turn_state_json,
                d.node_id, COALESCE(n.nickname, n.name) AS node_name, n.last_seen_at AS node_last_seen_at,
                n.revoked_at AS node_revoked_at, d.mode, d.status AS dispatch_status,
                d.session_name, d.session_url, d.error AS dispatch_error,
                d.created_at, d.delivered_at, d.completed_at, d.archived_at AS dispatch_archived_at,
                d.unread_at, d.read_at,
                d.mode AS dispatch_mode, d.model AS dispatch_model, d.effort AS dispatch_effort,
                s.mode AS session_mode, s.model AS session_model,
                s.model_endpoint AS session_model_endpoint, s.effort AS session_effort,
                s.desired_settings_json, s.settings_revision, s.applied_settings_revision,
                s.settings_error, s.settings_error_revision, n.agents_json AS node_agents_json
         FROM dispatches d
         LEFT JOIN agent_sessions s ON s.dispatch_id = d.id
         JOIN nodes n ON n.id = d.node_id
         WHERE d.account_id = ?
         ORDER BY COALESCE(s.activity_at, d.archived_at, d.completed_at, d.delivered_at, d.created_at) DESC
         LIMIT ?`,
      )
      .all(accountId, limit) as unknown as SessionListSettingsRow[];
    const items = this.database.connection.prepare(
      `SELECT w.item_key, w.title, w.product_id, w.status
       FROM dispatch_items di JOIN work_items w ON w.id = di.item_id
       WHERE di.dispatch_id = ? ORDER BY di.position`,
    );
    const latestMessage = this.database.connection.prepare(
      `SELECT id, source_id, role, phase, text, questions_json FROM agent_session_messages
       WHERE session_id = ? ORDER BY position DESC, observed_at DESC, rowid DESC LIMIT 1`,
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
      const deliveryTimedOut = !row.session_id && row.dispatch_status === "delivered"
        && deliveredDispatchTimedOut(row.delivered_at);
      const inferredStatus: AgentSessionStatus = row.dispatch_status === "failed" || deliveryTimedOut
        ? "failed"
        : row.dispatch_status === "cancelled"
          ? "unavailable"
          : row.dispatch_status === "launched"
            && itemRows.every((item) => item.status !== "ready" && item.status !== "in_progress")
            ? "idle"
            : "active";
      // A Mac silent for half an hour (or revoked) is not running anything the
      // server can vouch for (AND-221): read its active sessions as
      // unavailable rather than "running".
      const offlineDegraded = offlineDegradedStatus(
        row.session_status ?? inferredStatus, row.node_last_seen_at, Boolean(row.node_revoked_at),
      );
      const status = offlineDegraded.status;
      const updatedAt = row.session_updated_at ?? row.dispatch_archived_at
        ?? row.completed_at ?? row.delivered_at ?? row.created_at;
      const activityAt = row.session_activity_at ?? row.dispatch_archived_at
        ?? row.completed_at ?? row.delivered_at ?? row.created_at;
      const archivedAt = row.session_archived_at ?? row.dispatch_archived_at;
      const archivedSource = row.session_archive_source ?? (row.dispatch_archived_at ? "missiongo" : null);
      const lastError = row.session_last_error ?? row.dispatch_error
        ?? (deliveryTimedOut ? "Mac 领取派单后超过 10 分钟仍未报告启动结果。请确认来源会话不存在，再手动重新派单。" : null);
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
      // A reply the Mac claimed but never settled, or one queued far longer than
      // a turn, is a fault the transcript cannot express (AND-184). Override the
      // message-derived attention so the console shows it; deliberately without a
      // revision, so nobody can dismiss a condition that is still true.
      const stuckReason = command ? stuckCommandReason(command) : undefined;
      // So is a session reading "running" on a Mac nobody has heard from in
      // half an hour (AND-221) — same discipline, still true until the Mac
      // reports again, so it cannot be dismissed either.
      const offlineReason = offlineDegraded.degraded
        ? row.node_revoked_at
          ? "该会话所属节点已被撤销，状态不再更新；如需继续请重新派单。"
          : "节点已离线超过 30 分钟，会话状态无法确认；节点恢复后会自动更正。"
        : undefined;
      const alertAttention: AgentSessionAttention = stuckReason
        ? { state: "needed", kind: "action", reason: stuckReason }
        : offlineReason
          ? { state: "needed", kind: "uncertain", reason: offlineReason }
          : attention;
      const needsAttention = alertAttention.state === "needed";
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
        nodeId: row.node_id,
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
        attention: alertAttention,
        needsAttention,
        activities: row.session_activities_json
          ? JSON.parse(row.session_activities_json) as AgentSessionActivity[]
          : [],
        ...(row.session_turn_state_json
          ? { turnState: JSON.parse(row.session_turn_state_json) as AgentSessionTurnState }
          : {}),
        waitingForReply: needsAttention,
        retryable: (["failed", "cancelled"].includes(row.dispatch_status) || deliveryTimedOut)
          && itemRows.length > 0 && itemRows.every((item) => item.status === "ready"),
        stoppable: row.dispatch_status === "queued"
          || Boolean(row.session_id && (row.session_status === "active" || row.session_status === "stalled")),
        replyable: row.session_id ? !this.itemsCompleted(row.session_id) : false,
        settings: sessionSettings(
          row,
          Boolean(row.session_id) && !archivedAt && !(row.session_id && this.itemsCompleted(row.session_id)),
        ),
        unread: Boolean(row.unread_at && (!row.read_at || row.unread_at > row.read_at)),
        ...(row.unread_at ? { unreadAt: row.unread_at } : {}),
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
    // A person's own archive is not an automatic one; a person's restore of an
    // automatic one must stick, so it switches the automatic path off for good.
    // Either way the Codex thread follows (AND-129): archiving asks the Mac to
    // archive it once more, and restoring one already archived there asks the
    // Mac to bring it back -- otherwise the next sync would read the thread as
    // archived at the source and archive the conversation again.
    this.database.connection
      .prepare(
        `UPDATE agent_sessions
         SET archived_at = ?, archive_source = ?, updated_at = ?, activity_at = ?,
             auto_archive_suppressed = CASE WHEN ? = 0 AND archive_reason = 'auto' THEN 1 ELSE auto_archive_suppressed END,
             archive_reason = NULL,
             source_archive_error = NULL,
             source_restore_pending = CASE WHEN ? = 0 AND source_archived_at IS NOT NULL THEN 1 ELSE 0 END
         WHERE id = ?`,
      )
      .run(
        archived ? now : null, archived ? "missiongo" : null, now, now,
        archived ? 1 : 0, archived ? 1 : 0, sessionId,
      );
    return this.getForAccount(accountId, sessionId);
  }

  /**
   * Mark a hand-off read up to the unread clock the client actually displayed.
   * Taking the client's value rather than "now" keeps a message that lands
   * between the list poll and this call unread.
   */
  markRead(accountId: string, dispatchId: string, through: string): void {
    if (!Number.isFinite(Date.parse(through))) throw invalidInput("through must be an ISO 8601 timestamp.");
    const changed = this.database.connection
      .prepare(
        `UPDATE dispatches SET read_at = ?
         WHERE id = ? AND account_id = ? AND (read_at IS NULL OR read_at < ?)`,
      )
      .run(through, dispatchId, accountId, through);
    if (changed.changes === 0) {
      const exists = this.database.connection
        .prepare("SELECT 1 FROM dispatches WHERE id = ? AND account_id = ?")
        .get(dispatchId, accountId);
      if (!exists) throw notFound("Dispatch");
    }
  }

  /**
   * Ask the Mac to change a running conversation's mode, model or effort
   * (AND-130). Fields left out keep their earlier request; the revision lets the
   * Mac apply each request once and report which one it is on.
   */
  requestSettings(accountId: string, sessionId: string, change: AgentRunSettings): AgentSessionSettings {
    const row = this.database.connection
      .prepare(
        `SELECT s.agent_kind, d.mode AS dispatch_mode, d.model AS dispatch_model, d.effort AS dispatch_effort,
                s.mode AS session_mode, s.model AS session_model,
                s.model_endpoint AS session_model_endpoint, s.effort AS session_effort,
                s.desired_settings_json, s.settings_revision, s.applied_settings_revision,
                s.settings_error, s.settings_error_revision, n.agents_json AS node_agents_json,
                s.archived_at
         FROM agent_sessions s JOIN dispatches d ON d.id = s.dispatch_id JOIN nodes n ON n.id = s.node_id
         WHERE s.id = ? AND d.account_id = ?`,
      )
      .get(sessionId, accountId) as unknown as (SessionSettingsColumns & { archived_at: string | null }) | undefined;
    if (!row) throw notFound("Agent session");
    if (row.archived_at) throw conflict("agent_session_archived", "Restore this session before changing it.");
    if (this.itemsCompleted(sessionId)) {
      throw conflict("agent_session_work_finished", "The linked work items are done; this session is finished.");
    }
    if (change.mode === undefined && change.model === undefined && change.effort === undefined) {
      throw invalidInput("Choose a mode, model or effort to change.");
    }
    const models = nodeAgentModels(row.node_agents_json, row.agent_kind);
    if (models === undefined) {
      throw conflict(
        "node_upgrade_required",
        "This Mac's MissionGo client cannot change a running session yet; update it first.",
      );
    }
    const earlier = row.desired_settings_json ? JSON.parse(row.desired_settings_json) as AgentRunSettings : {};
    const next: AgentRunSettings = { ...earlier, ...change };
    requireOfferedModel(row.agent_kind, models, next);
    this.database.connection
      .prepare(
        "UPDATE agent_sessions SET desired_settings_json = ?, settings_revision = settings_revision + 1 WHERE id = ?",
      )
      .run(JSON.stringify(next), sessionId);
    return sessionSettings({
      ...row,
      desired_settings_json: JSON.stringify(next),
      settings_revision: (row.settings_revision ?? 0) + 1,
    }, true);
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
       WHERE session_id = ? ORDER BY position DESC, observed_at DESC, rowid DESC LIMIT 1`,
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

  enqueue(accountId: string, sessionId: string, textValue: string, attachmentIds: readonly string[] = []): AgentSessionCommand {
    const text = textValue.trim();
    if (!text && attachmentIds.length === 0) throw invalidInput("text or attachments are required.");
    if (text.length > MAX_COMMAND_LENGTH) throw invalidInput(`text must be ${MAX_COMMAND_LENGTH} characters or fewer.`);
    if (attachmentIds.length && !this.attachments) throw invalidInput("Session attachments are unavailable.");
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
      throw conflict("agent_reply_pending", "This session has a pending or unconfirmed reply.");
    }
    const id = randomUUID();
    const now = new Date().toISOString();
    this.database.transaction(() => {
      this.database.connection
        .prepare(
          `INSERT INTO agent_session_commands (id, session_id, account_id, text, status, created_at)
           VALUES (?, ?, ?, ?, 'queued', ?)`,
        )
        .run(id, sessionId, accountId, text, now);
      this.attachments?.bind(sessionId, accountId, id, attachmentIds);
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
    });
    return { id, kind: "message", text, status: "queued", createdAt: now,
      ...(attachmentIds.length ? { attachments: this.attachments!.listForCommand(id) } : {}) };
  }

  belongsToNode(sessionId: string, nodeId: string): boolean {
    return Boolean(this.database.connection.prepare(
      "SELECT 1 FROM agent_sessions WHERE id = ? AND node_id = ?",
    ).get(sessionId, nodeId));
  }

  supportsAttachments(sessionId: string): boolean {
    const row = this.database.connection.prepare(
      `SELECT n.supports_chat_attachments AS supported FROM agent_sessions s
       JOIN nodes n ON n.id = s.node_id WHERE s.id = ?`,
    ).get(sessionId) as unknown as { supported: number } | undefined;
    return row?.supported === 1;
  }

  private attachmentMessages(sessionId: string): NonNullable<AgentSessionSnapshot["attachmentMessages"]> {
    const byCommand = new Map<string, AgentSessionAttachment[]>();
    for (const { commandId, ...attachment } of this.attachments!.listForSession(sessionId)) {
      const group = byCommand.get(commandId) ?? [];
      group.push(attachment);
      byCommand.set(commandId, group);
    }
    const rows = this.database.connection.prepare(
      "SELECT id, text, status, created_at FROM agent_session_commands WHERE session_id = ? AND kind = 'message' ORDER BY created_at, rowid",
    ).all(sessionId) as unknown as Array<{ id: string; text: string; status: AgentSessionCommandStatus; created_at: string }>;
    return rows.flatMap((row) => {
      const attachments = byCommand.get(row.id) ?? [];
      return attachments.length ? [{ commandId: row.id, text: row.text, status: row.status,
        createdAt: row.created_at, attachments }] : [];
    });
  }

  enqueueInterrupt(accountId: string, sessionId: string): AgentSessionCommand {
    const session = this.database.connection
      .prepare(
        `SELECT s.id, s.status, s.archived_at, s.agent_kind FROM agent_sessions s JOIN dispatches d ON d.id = s.dispatch_id
         WHERE s.id = ? AND d.account_id = ?`,
      )
      .get(sessionId, accountId) as unknown as {
        id: string; status: AgentSessionStatus; archived_at: string | null; agent_kind: AgentKind;
      } | undefined;
    if (!session) throw notFound("Agent session");
    if (session.archived_at) throw conflict("agent_session_archived", "Restore this session before stopping it.");
    if (session.status !== "active" && session.status !== "stalled") {
      throw conflict("agent_not_running", "This agent session is not currently running.");
    }
    const pending = this.pendingCommand(sessionId);
    if (pending?.kind === "interrupt") {
      // AND-213: pressing stop again while the queued request waits for the
      // Mac is a harmless confirmation, so return that command instead of a
      // 409 the consoles would print as an English error bar. A stop whose
      // delivery outcome is unknown stays rejected: nobody knows whether the
      // Mac already acted on it, and session snapshots hide such commands,
      // so echoing one back would only confuse the console.
      if (pending.status !== "delivery_unknown") return this.mapCommand(pending);
      throw conflict("agent_stop_pending", "This session already has a queued stop request.");
    }
    if (pending?.status === "delivering") {
      throw conflict("agent_reply_delivering", "A reply is already being delivered; try stopping again shortly.");
    }
    if (pending?.status === "delivery_unknown") {
      throw conflict("agent_reply_delivery_unknown", "Confirm the earlier reply in Codex before stopping this session.");
    }
    // Claude Code and Codex interrupts name the exact turn they may cut off, so
    // a stop needs a visible turn identifier first. OpenCode interrupts the
    // session by reference and its host reports no turn identifiers at all;
    // demanding one there made every stop fail with agent_turn_unavailable.
    const turnId = session.agent_kind === "opencode"
      ? null
      : (this.database.connection
          .prepare(
            `SELECT turn_id FROM agent_session_messages
             WHERE session_id = ? AND turn_id IS NOT NULL
             ORDER BY position DESC, observed_at DESC, rowid DESC LIMIT 1`,
          )
          .get(sessionId) as unknown as { turn_id: string } | undefined)?.turn_id ?? null;
    if (!turnId && session.agent_kind !== "opencode") {
      throw conflict("agent_turn_unavailable", "The active agent turn is not visible yet.");
    }
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
        .run(id, sessionId, accountId, "停止当前任务", turnId, now);
      this.database.connection
        .prepare("UPDATE agent_sessions SET updated_at = ?, activity_at = ? WHERE id = ?")
        .run(now, now, sessionId);
    });
    return {
      id, kind: "interrupt", text: "停止当前任务",
      ...(turnId ? { turnId } : {}),
      status: "queued", createdAt: now,
    };
  }

  cancel(accountId: string, sessionId: string, commandId: string): AgentSessionCommand {
    const command = this.database.connection
      .prepare(
        `SELECT c.id, c.kind, c.text, c.turn_id, c.status, c.error, c.created_at, c.delivered_at, c.delivering_at, c.cancelled_at
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

  /** Release an uncertain reply only after the account holder checks Codex. */
  resolveDeliveryUnknown(
    accountId: string, sessionId: string, commandId: string, outcome: "received" | "not_received",
  ): AgentSessionCommand {
    const command = this.database.connection.prepare(
      `SELECT c.id, c.kind, c.text, c.turn_id, c.status, c.error, c.created_at,
              c.delivered_at, c.delivering_at, c.cancelled_at, s.dispatch_id
       FROM agent_session_commands c
       JOIN agent_sessions s ON s.id = c.session_id
       JOIN dispatches d ON d.id = s.dispatch_id
       WHERE c.id = ? AND c.session_id = ? AND d.account_id = ?`,
    ).get(commandId, sessionId, accountId) as unknown as (CommandRow & { dispatch_id: string }) | undefined;
    if (!command) throw notFound("Agent session command");
    if (command.kind !== "message" || command.status !== "delivery_unknown") {
      throw conflict("agent_reply_not_unconfirmed", "Only a reply awaiting delivery confirmation can be resolved.");
    }
    const now = new Date().toISOString();
    const status = outcome === "received" ? "delivered" : "cancelled";
    const error = outcome === "received"
      ? "用户在 Codex 核实已收到这条回复。"
      : "用户在 Codex 核实未收到；可手动重新发送。";
    this.database.transaction(() => {
      const changed = this.database.connection.prepare(
        `UPDATE agent_session_commands
         SET status = ?, error = ?, delivered_at = ?, cancelled_at = ?
         WHERE id = ? AND session_id = ? AND status = 'delivery_unknown'`,
      ).run(status, error, outcome === "received" ? now : null, outcome === "not_received" ? now : null,
        commandId, sessionId);
      if (changed.changes !== 1) throw conflict("agent_reply_changed", "The reply changed before it was confirmed.");
      this.database.connection.prepare(
        "UPDATE agent_sessions SET updated_at = ?, activity_at = ? WHERE id = ?",
      ).run(now, now, sessionId);
      autoArchiveFinishedDispatches(this.database, [command.dispatch_id], now);
    });
    return this.mapCommand({ ...command, status, error,
      delivered_at: outcome === "received" ? now : null,
      cancelled_at: outcome === "not_received" ? now : null });
  }

  listForNode(nodeId: string): readonly NodeAgentSession[] {
    this.failStuckDeliveringCommands();
    const sourceArchiveBefore = new Date(Date.now() - SOURCE_ARCHIVE_POLL_MS).toISOString();
    const rows = this.database.connection
      .prepare(
        `SELECT id, dispatch_id, agent_kind, agent_session_ref, status, last_error, updated_at,
                archived_at, archive_source, archive_reason, source_archived_at, source_archive_error, source_restore_pending,
                desired_settings_json, settings_revision, applied_settings_revision, settings_error_revision
         FROM agent_sessions s
         WHERE node_id = ?
         AND (archived_at IS NULL OR (archive_source = 'source' AND updated_at <= ?)
           -- Finished work archived by MissionGo still needs the Mac once: a
           -- Codex thread to archive at the source, a Claude process to close.
           OR (archive_source = 'missiongo' AND agent_kind = 'codex'
             AND source_archived_at IS NULL AND source_archive_error IS NULL)
           OR (archive_source = 'missiongo' AND agent_kind = 'claude_code'
             AND source_archived_at IS NULL AND source_archive_error IS NULL)
           OR (archive_reason = 'auto' AND agent_kind = 'claude_code' AND status NOT IN ('suspended', 'failed')))
         AND (
           status IN ('active', 'stalled', 'unavailable') OR EXISTS (
             SELECT 1 FROM agent_session_commands c
             WHERE c.session_id = s.id AND c.status IN ('queued', 'delivering', 'delivery_unknown')
           ) OR s.settings_revision > MAX(s.applied_settings_revision, s.settings_error_revision)
           OR s.source_restore_pending = 1
           -- A source archive still owed goes out now, not after the idle cool-down.
           OR (archived_at IS NOT NULL AND archive_source = 'missiongo' AND agent_kind = 'codex'
             AND source_archived_at IS NULL AND source_archive_error IS NULL)
           OR (archived_at IS NOT NULL AND archive_source = 'missiongo' AND agent_kind = 'claude_code'
             AND source_archived_at IS NULL AND source_archive_error IS NULL)
           OR s.updated_at <= ?
         )
         ORDER BY archive_source = 'source', updated_at DESC LIMIT 100`,
      )
      .all(nodeId, sourceArchiveBefore, sourceArchiveBefore) as unknown as SessionRow[];
    return rows.map((row) => {
      const command = this.pendingCommand(row.id);
      const autoArchived = row.archive_reason === "auto";
      return {
        id: row.id,
        dispatchId: row.dispatch_id,
        agentKind: row.agent_kind,
        sessionRef: row.agent_session_ref,
        status: row.status,
        lifecycle: row.agent_kind === "claude_code" && !row.source_restore_pending
          && (Boolean(row.archived_at) || autoArchived || this.itemsCompleted(row.id)) ? "close" : "keep",
        occupiesExecutionSlot: row.status === "active" || row.status === "stalled",
        ...(command && command.status !== "delivery_unknown" ? { command: this.mapCommand(command) } : {}),
        ...(row.archive_source === "missiongo" && row.archived_at && row.agent_kind === "codex"
          && !row.source_archived_at && !row.source_archive_error
          ? { archiveInSource: true as const }
          : {}),
        ...(row.source_restore_pending ? { restoreInSource: true as const } : {}),
        ...(row.desired_settings_json && (row.settings_revision ?? 0) > 0
          ? {
              desiredSettings: {
                ...(JSON.parse(row.desired_settings_json) as AgentRunSettings),
                revision: row.settings_revision ?? 0,
              },
            }
          : {}),
        appliedSettingsRevision: Math.max(row.applied_settings_revision ?? 0, row.settings_error_revision ?? 0),
      };
    });
  }

  countExecutionSlots(nodeId: string): number {
    // Archived conversations must not hold a slot (AND-221): their Mac work is
    // done, and a session archived while `active` — its status frozen at the
    // last snapshot, because only a node poll updates it — used to keep
    // occupying one of the ten slots until the node could never claim again.
    const row = this.database.connection
      .prepare(
        `SELECT COUNT(*) AS count FROM agent_sessions
         WHERE node_id = ? AND status IN ('active', 'stalled') AND archived_at IS NULL`,
      )
      .get(nodeId) as unknown as { count: number };
    return row.count;
  }

  recordSnapshot(input: {
    nodeId: string;
    sessionId: string;
    status: AgentSessionStatus;
    messages: readonly AgentSessionMessageInput[];
    activities?: readonly AgentSessionActivity[];
    turnState?: AgentSessionTurnState;
    error?: string;
    commandId?: string;
    commandStatus?: "delivering" | "delivery_unknown" | "delivered" | "failed";
    commandError?: string;
    sourceArchived?: boolean;
    /** The node tried to archive the source thread MissionGo asked it to and could not. */
    sourceArchiveError?: string;
    /** The node restored the source thread MissionGo asked it to. */
    sourceRestored?: boolean;
    /** Model and effort the agent reports using (AND-130). */
    model?: string;
    effort?: string;
    /** Host of the custom endpoint the agent's requests go to (AND-161). */
    modelEndpoint?: string;
    /** The settings revision now applied -- or, with settingsError, the one that failed. */
    settingsRevision?: number;
    settingsError?: string;
    sessionUrl?: string;
    clearSessionUrl?: boolean;
    activityAt?: string;
  }): void {
    if (input.messages.length > MAX_MESSAGES_PER_SNAPSHOT) {
      throw invalidInput(`messages must contain ${MAX_MESSAGES_PER_SNAPSHOT} entries or fewer.`);
    }
    if ((input.activities?.length ?? 0) > MAX_ACTIVITIES_PER_SNAPSHOT) {
      throw invalidInput(`activities must contain ${MAX_ACTIVITIES_PER_SNAPSHOT} entries or fewer.`);
    }
    const now = new Date().toISOString();
    const activities = (input.activities ?? []).map((activity) => ({
      id: requiredText(activity.id, "activity id", 200),
      title: requiredText(activity.title, "activity title", 500),
      ...(activity.detail ? { detail: requiredText(activity.detail, "activity detail", 500) } : {}),
      ...(activity.startedAt ? { startedAt: normalizedSourceTimestamp(activity.startedAt, now, "activity startedAt") } : {}),
    }));
    const activitiesJson = JSON.stringify(activities);
    const turnState: AgentSessionTurnState = {
      ...(input.turnState?.turnActive !== undefined ? { turnActive: input.turnState.turnActive } : {}),
      ...(input.turnState?.waitingForInput !== undefined ? { waitingForInput: input.turnState.waitingForInput } : {}),
      ...(input.turnState?.turnStartedAt ? { turnStartedAt: normalizedSourceTimestamp(input.turnState.turnStartedAt, now, "turnStartedAt")! } : {}),
      ...(input.turnState?.lastOutputAt ? { lastOutputAt: normalizedSourceTimestamp(input.turnState.lastOutputAt, now, "lastOutputAt")! } : {}),
      ...(input.turnState?.thinkingStartedAt ? { thinkingStartedAt: normalizedSourceTimestamp(input.turnState.thinkingStartedAt, now, "thinkingStartedAt")! } : {}),
      ...(input.turnState?.thinkingTokens !== undefined ? { thinkingTokens: input.turnState.thinkingTokens } : {}),
      ...(input.turnState?.thinkingDurationSeconds !== undefined ? { thinkingDurationSeconds: input.turnState.thinkingDurationSeconds } : {}),
    };
    const turnStateJson = JSON.stringify(turnState);
    const messages = input.messages.map((message, position) => ({
      sourceId: requiredText(message.sourceId, "sourceId", 200),
      turnId: message.turnId?.slice(0, 200) || null,
      role: message.role,
      phase: message.phase?.slice(0, 50) || null,
      text: requiredText(message.text, "message text", MAX_MESSAGE_LENGTH),
      questionsJson: message.questions ? JSON.stringify(message.questions) : null,
      sourceOccurredAt: normalizedSourceTimestamp(message.occurredAt, now, "message occurredAt"),
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
        `SELECT id, dispatch_id, status, last_error, archived_at, archive_source, activities_json, turn_state_json, activity_at,
                source_restore_pending
         FROM agent_sessions WHERE id = ? AND node_id = ?`,
      )
      .get(input.sessionId, input.nodeId) as unknown as {
        id: string;
        dispatch_id: string;
        source_restore_pending: number;
        status: AgentSessionStatus;
        last_error: string | null;
        archived_at: string | null;
        archive_source: "missiongo" | "source" | null;
        activities_json: string;
        turn_state_json: string;
        activity_at: string;
      } | undefined;
    if (!session) throw notFound("Agent session");
    const sourceActivityAt = normalizedSourceTimestamp(input.activityAt, now, "activityAt");
    const error = input.error?.slice(0, 2_000) || null;
    const sessionUrl = input.sessionUrl?.trim();
    if (sessionUrl && input.clearSessionUrl) {
      throw invalidInput("Cannot set and clear session URL in one report.");
    }
    if (sessionUrl && !isAcceptedSessionUrl(sessionUrl)) {
      throw invalidInput("Session URL must be an https:// address or a codex://threads/<id> link.");
    }
    const storedMessages = this.database.connection
      .prepare(
        `SELECT source_id, turn_id, role, phase, text, questions_json, position, occurred_at
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
        occurred_at: string;
      }>;
    const storedBySource = new Map(storedMessages.map((message) => [message.source_id, message]));
    const messagesChanged = messages.some((message) => {
      const stored = storedBySource.get(message.sourceId);
      // Position is deliberately not compared: stored messages keep the
      // position they were first written with, so a mirror that arrives
      // trimmed to its newest messages does not count as a change (AND-222).
      return !stored
        || stored.turn_id !== message.turnId
        || stored.role !== message.role
        || stored.phase !== message.phase
        || stored.text !== message.text
        || stored.questions_json !== message.questionsJson;
    });
    // While a restore is on its way to the Mac, a snapshot still reading the
    // thread as archived is stale, not a new archive in Codex.
    const sourceArchived = session.source_restore_pending && input.sourceArchived === true && !input.sourceRestored
      ? undefined
      : input.sourceArchived;
    const archiveChanged = sourceArchived === true
      ? !session.archived_at || session.archive_source === null
      : sourceArchived === false && session.archive_source === "source";
    const activityChanged = session.status !== input.status
      || session.last_error !== error
      || messagesChanged
      || session.activities_json !== activitiesJson
      || session.turn_state_json !== turnStateJson
      || archiveChanged
      || Boolean(input.commandId && input.commandStatus);
    const nextActivityAt = activityChanged ? sourceActivityAt ?? now : session.activity_at;
    const unreadEvent = snapshotMakesUnread(session.status, input.status, messages, storedBySource);
    this.database.transaction(() => {
      this.database.connection
        .prepare(
          `UPDATE agent_sessions
           SET status = ?, last_error = ?, activities_json = ?, turn_state_json = ?, updated_at = ?,
               activity_at = ?
           WHERE id = ?`,
        )
        .run(input.status, error, activitiesJson, turnStateJson, now, nextActivityAt, input.sessionId);
      if (unreadEvent) {
        this.database.connection
          .prepare("UPDATE dispatches SET unread_at = ? WHERE id = ?")
          .run(now, session.dispatch_id);
      }
      if (input.sourceRestored) {
        this.database.connection
          .prepare("UPDATE agent_sessions SET source_archived_at = NULL, source_restore_pending = 0 WHERE id = ?")
          .run(input.sessionId);
      }
      if (sourceArchived === true) {
        this.database.connection
          .prepare(
            `UPDATE agent_sessions
             SET archived_at = COALESCE(archived_at, ?),
                 archive_source = CASE WHEN archive_source = 'missiongo' THEN archive_source ELSE 'source' END,
                 source_archived_at = COALESCE(source_archived_at, ?)
             WHERE id = ?`,
          )
          .run(now, now, input.sessionId);
      } else if (sourceArchived === false) {
        this.database.connection
          .prepare(
            `UPDATE agent_sessions SET archived_at = NULL, archive_source = NULL
             WHERE id = ? AND archive_source = 'source'`,
          )
          .run(input.sessionId);
      }
      if (input.model || input.effort || input.modelEndpoint) {
        this.database.connection
          .prepare(
            "UPDATE agent_sessions SET model = COALESCE(?, model), effort = COALESCE(?, effort), model_endpoint = COALESCE(?, model_endpoint) WHERE id = ?",
          )
          .run(
            input.model?.slice(0, 200) || null,
            input.effort?.slice(0, 200) || null,
            input.modelEndpoint?.slice(0, 200) || null,
            input.sessionId,
          );
      }
      if (input.settingsRevision !== undefined) {
        if (input.settingsError) {
          this.database.connection
            .prepare(
              `UPDATE agent_sessions SET settings_error = ?, settings_error_revision = MAX(settings_error_revision, ?)
               WHERE id = ? AND ? <= settings_revision`,
            )
            .run(input.settingsError.slice(0, 2_000), input.settingsRevision, input.sessionId, input.settingsRevision);
        } else {
          // The confirmed mode comes from the request the Mac just applied;
          // a later request may already be waiting, so read it by revision.
          this.database.connection
            .prepare(
              `UPDATE agent_sessions
               SET applied_settings_revision = MAX(applied_settings_revision, ?),
                   mode = CASE WHEN ? = settings_revision
                     THEN COALESCE(json_extract(desired_settings_json, '$.mode'), mode) ELSE mode END,
                   settings_error = CASE WHEN ? >= settings_error_revision THEN NULL ELSE settings_error END
               WHERE id = ? AND ? <= settings_revision`,
            )
            .run(input.settingsRevision, input.settingsRevision, input.settingsRevision, input.sessionId, input.settingsRevision);
        }
      }
      if (input.sourceArchiveError) {
        // Asked once. A thread Codex no longer has cannot be archived, and
        // asking every poll would not change that; the MissionGo archive stands.
        this.database.connection
          .prepare("UPDATE agent_sessions SET source_archive_error = ? WHERE id = ?")
          .run(input.sourceArchiveError.slice(0, 2_000), input.sessionId);
      }
      if (sessionUrl || input.clearSessionUrl) {
        this.database.connection.prepare(
          `UPDATE dispatches SET session_url = ?
           WHERE id = (SELECT dispatch_id FROM agent_sessions WHERE id = ?)`,
        ).run(sessionUrl || null, input.sessionId);
      }
      // A message keeps the position it was first stored with; a later mirror
      // that starts further back (a long session trimmed to its newest
      // messages, AND-222) would otherwise renumber everything it still
      // carries and interleave the transcript. Messages new to the session
      // continue after the newest position it already has.
      const maxStoredPosition = (storedMessages.reduce(
        (max, message) => Math.max(max, message.position), -1,
      ));
      const insertMessage = this.database.connection.prepare(
        `INSERT INTO agent_session_messages
          (id, session_id, source_id, turn_id, role, phase, text, questions_json, position, observed_at, occurred_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      const refreshMessage = this.database.connection.prepare(
        `UPDATE agent_session_messages
         SET turn_id = ?, role = ?, phase = ?, text = ?, questions_json = ?, observed_at = ?, occurred_at = ?
         WHERE session_id = ? AND source_id = ?`,
      );
      let nextPosition = maxStoredPosition + 1;
      messages.forEach((message) => {
        const occurredAt = message.sourceOccurredAt
          ?? storedBySource.get(message.sourceId)?.occurred_at
          ?? now;
        if (storedBySource.has(message.sourceId)) {
          refreshMessage.run(
            message.turnId, message.role, message.phase, message.text,
            message.questionsJson, now, occurredAt, input.sessionId, message.sourceId,
          );
          return;
        }
        insertMessage.run(
          randomUUID(), input.sessionId, message.sourceId, message.turnId,
          message.role, message.phase, message.text,
          message.questionsJson, nextPosition, now, occurredAt,
        );
        nextPosition += 1;
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
        const current = this.database.connection
          .prepare("SELECT status, error FROM agent_session_commands WHERE id = ? AND session_id = ?")
          .get(input.commandId, input.sessionId) as unknown as
            { status: AgentSessionCommandStatus; error: string | null } | undefined;
        if (!current) {
          throw conflict("agent_reply_changed", "The queued reply no longer matches this session.");
        }
        // The server may have given up on this delivery while the Mac was away
        // (AND-184). A late `delivering` for a command it already failed is
        // moot -- resurrecting it would collide with a new reply's pending slot
        // -- so it is ignored. A late settled report still overwrites the
        // timeout failure, so work the Mac really did finish is not recorded as
        // lost.
        const reaped = current.status === "failed" && current.error === COMMAND_DELIVERY_TIMEOUT_ERROR;
        if (input.commandStatus === "delivering") {
          if (!reaped && !["delivery_unknown", "delivered", "cancelled"].includes(current.status)) {
            const changed = this.database.connection
              .prepare(
                `UPDATE agent_session_commands
                 SET status = 'delivering', error = ?, delivered_at = NULL, delivering_at = ?
                 WHERE id = ? AND session_id = ? AND status = 'queued'`,
              )
              .run(
                input.commandError?.slice(0, 2_000) || null,
                now,
                input.commandId,
                input.sessionId,
              );
            if (changed.changes === 0) {
              throw conflict("agent_reply_changed", "The queued reply no longer matches this session.");
            }
          }
        } else if (current.status === "delivered" || current.status === "cancelled"
          || (reaped && input.commandStatus === "delivery_unknown")) {
          // A delayed report cannot reopen a person's resolution or turn an
          // older timeout into a pending command after a replacement was sent.
        } else {
          const changed = this.database.connection
            .prepare(
              `UPDATE agent_session_commands SET status = ?, error = ?, delivered_at = ?
               WHERE id = ? AND session_id = ?
                 AND (status IN ('queued', 'delivering', 'delivery_unknown') OR (status = 'failed' AND error = ?))`,
            )
            .run(
              input.commandStatus,
              input.commandStatus === "delivery_unknown"
                ? input.commandError?.slice(0, 2_000) || COMMAND_DELIVERY_UNKNOWN_ERROR
                : input.commandError?.slice(0, 2_000) || null,
              input.commandStatus === "delivered" ? now : null,
              input.commandId,
              input.sessionId,
              COMMAND_DELIVERY_TIMEOUT_ERROR,
            );
          if (changed.changes === 0) {
            throw conflict("agent_reply_changed", "The queued reply no longer matches this session.");
          }
          // A pending reply held back the automatic archive; retry now it settled.
          if (input.commandStatus !== "delivery_unknown") {
            autoArchiveFinishedDispatches(this.database, [session.dispatch_id], now);
          }
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
       ORDER BY position DESC, observed_at DESC, rowid DESC LIMIT 1`,
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

  /** Time out old claimed replies on read paths. Codex replies keep their slot
   * for human verification; other agents retain AND-184's failed timeout. */
  private failStuckDeliveringCommands(now = Date.now()): void {
    const cutoff = new Date(now - COMMAND_DELIVERING_TIMEOUT_MS).toISOString();
    const affected = this.database.connection
      .prepare(
        `SELECT DISTINCT s.dispatch_id AS dispatch_id
         FROM agent_session_commands c JOIN agent_sessions s ON s.id = c.session_id
         WHERE c.status = 'delivering' AND s.agent_kind != 'codex'
           AND COALESCE(c.delivering_at, c.created_at) <= ?`,
      )
      .all(cutoff) as unknown as Array<{ dispatch_id: string }>;
    this.database.connection.prepare(
      `UPDATE agent_session_commands SET status = 'delivery_unknown', error = ?
       WHERE status = 'delivering' AND COALESCE(delivering_at, created_at) <= ?
         AND session_id IN (SELECT id FROM agent_sessions WHERE agent_kind = 'codex')`,
    ).run(COMMAND_DELIVERY_UNKNOWN_ERROR, cutoff);
    const changed = this.database.connection.prepare(
      `UPDATE agent_session_commands SET status = 'failed', error = ?
       WHERE status = 'delivering' AND COALESCE(delivering_at, created_at) <= ?`,
    ).run(COMMAND_DELIVERY_TIMEOUT_ERROR, cutoff);
    if (changed.changes > 0) {
      // The reply settling is what lets an otherwise finished hand-off archive.
      autoArchiveFinishedDispatches(this.database, affected.map((row) => row.dispatch_id));
    }
  }

  private pendingCommand(sessionId: string): CommandRow | undefined {
    return this.database.connection
      .prepare(
        `SELECT id, kind, text, turn_id, status, error, created_at, delivered_at, delivering_at, cancelled_at
         FROM agent_session_commands
         WHERE session_id = ? AND status IN ('queued', 'delivering', 'delivery_unknown')
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
        `SELECT id, kind, text, turn_id, status, error, created_at, delivered_at, delivering_at, cancelled_at
         FROM agent_session_commands WHERE session_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1`,
      )
      .get(sessionId) as unknown as CommandRow | undefined;
  }

  private mapCommand(row: CommandRow): AgentSessionCommand {
    const attachments = this.attachments?.listForCommand(row.id) ?? [];
    return {
      id: row.id,
      kind: row.kind,
      text: row.text,
      ...(attachments.length ? { attachments } : {}),
      ...(row.turn_id ? { turnId: row.turn_id } : {}),
      status: row.status,
      ...(row.error ? { error: row.error } : {}),
      createdAt: row.created_at,
      ...(row.delivered_at ? { deliveredAt: row.delivered_at } : {}),
      ...(row.delivering_at ? { deliveringAt: row.delivering_at } : {}),
      ...(row.cancelled_at ? { cancelledAt: row.cancelled_at } : {}),
    };
  }
}
