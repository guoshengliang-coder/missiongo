import { commandSourceMessage, commandSourceMessages } from "./command-source-message.js";
import { SessionSendRequests } from "./session-send-requests.js";
import { observeMessageTimes, recordMessageTime } from "./session-message-clock.js";
import { acknowledgeSessionUnread, observeSessionUnread } from "./session-unread.js";
import { isConversationMessage } from "@missiongo/domain";
import { ImplementationPlans } from "./implementation-plans.js";
import { handoffDispatchIsCurrent } from "./agent-handoffs.js";
import { assertDispatchExecution, dispatchExecutionRevoked } from "./builder-authority.js";
import { createHash, randomUUID } from "node:crypto";

import { hasStoppableAgentTurn, hasPendingPermissionQuestion, normalizeAgentMode, sessionErrorFields, storedSessionError, type CodexSessionFailure, isAcceptedSessionUrl, nodeConnectionState, type AgentKind, type NodeConnectionState } from "@missiongo/domain";

import { sessionHealth, executionTurnState, mergeSessionHealth } from "./agent-session-health.js";

import type { AgentAttentionClassification, AgentAttentionKind as ClassifiedAttentionKind } from "./ai-title.js";
import type { AgentSessionAttachment, AgentSessionAttachments } from "./agent-session-attachments.js";
import { parseAgentModels, requireAvailableMode, requireOfferedModel, type AgentRunSettings } from "./agent-settings.js";
import { autoArchiveFinishedDispatches, autoArchiveFinishedConversations } from "./auto-archive.js";
import { deliveredDispatchTimedOut } from "./dispatch-store.js";
import { conflict, invalidInput, notFound } from "./errors.js";
import type { MissionGoDatabase } from "./storage/database.js";
import type { ExternalNativeConnection } from "./external-native-session-store.js";

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
  readonly deliveryOnly?: boolean;
  readonly handledByDelivery?: boolean;
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
    /** What the person picked, once the reply this question waited on was
     * delivered; absent while it is still open. */
    readonly answered?: string;
    /** The ask is gone without an answer — OpenCode auto-approved or dismissed
     * the request at the source. Settled history like `answered`, written by
     * the server when a poll stops carrying the card (AND-239). */
    readonly withdrawn?: boolean;
  }[];
}

export interface AgentSessionActivity {
  readonly id: string;
  readonly title: string;
  readonly detail?: string;
  readonly startedAt?: string;
}

export interface AgentSessionTurnState {
  /** Server-owned start boundary; a delivery receipt is not source progress. */
  readonly healthStartedAt?: string;
  /** Derived by the server from the current snapshot, never a node-supplied grant. */
  readonly waitingForPermission?: boolean;
  readonly observedAt?: string;
  readonly lastProgressAt?: string;
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
  /** Persisted source association; delivery alone is not execution evidence. */
  readonly sourceMessageId?: string;
  readonly kind: "message" | "interrupt";
  readonly text: string;
  readonly planApprovalRevision?: string | undefined;
  readonly attachments?: readonly AgentSessionAttachment[];
  readonly turnId?: string;
  readonly stopConfirmed?: boolean;
  readonly status: AgentSessionCommandStatus;
  readonly error?: string;
  readonly createdAt: string;
  readonly deliveredAt?: string;
  readonly deliveringAt?: string;
  readonly cancelledAt?: string;
}

export interface ManagedSessionBinding {
  id: string; runId: string; stageId: string; generation: number; role: string; stopRequested: boolean; state: string; ownershipHeld: boolean;
}
export interface AgentSessionSnapshot {
  readonly progressReports?: ReadonlyArray<{ id: string; text: string; occurredAt: string }>;
  readonly sessionPurpose?: "integration";
  readonly productId?: string;
  readonly initialText?: string;
  readonly startReady?: boolean;
  readonly nativeConnection?: ExternalNativeConnection;
  readonly managedExecution?: ManagedSessionBinding;
  readonly source?: "dispatch" | "external";
  readonly approvalOnly?: boolean;
  readonly progressStatus?: "working" | "waiting_for_input" | "blocked" | "completed" | "failed";
  readonly lastReportedAt?: string;
  readonly refKind?: "native" | "tracking";
  readonly id: string;
  readonly dispatchId?: string;
  readonly agentKind: AgentKind | "other";
  readonly status: AgentSessionStatus;
  readonly lastError?: string;
  readonly failure?: CodexSessionFailure;
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
  readonly stopCommand?: AgentSessionCommand;
  /** False once every linked item is done. */
  readonly replyable: boolean;
}

export interface AgentSessionListItem {
  readonly favorite?: boolean;
  readonly sessionPurpose?: "integration";
  readonly waitingForPermission?: boolean;
  readonly productId?: string;
  readonly initialText?: string;
  readonly startReady?: boolean;
  /** Original record IDs represented by this one real conversation. */
  readonly relatedSessionIds?: readonly string[];
  readonly nativeConnection?: ExternalNativeConnection;
  readonly managedExecution?: ManagedSessionBinding;
  readonly source?: "dispatch" | "external";
  readonly approvalOnly?: boolean;
  readonly progressStatus?: "working" | "waiting_for_input" | "blocked" | "completed" | "failed";
  readonly lastReportedAt?: string;
  readonly refKind?: "native" | "tracking";
  readonly id: string;
  readonly agentSessionId?: string;
  readonly dispatchId?: string;
  /** Which dispatch on these items this is; absent for sessions MissionGo did not dispatch. */
  readonly round?: number;
  readonly agentKind: AgentKind | "other";
  readonly status: AgentSessionStatus;
  readonly turnState?: AgentSessionTurnState;
  readonly lastError?: string;
  readonly failure?: CodexSessionFailure;
  readonly updatedAt: string;
  readonly activityAt: string;
  readonly archivedAt?: string;
  readonly archivedSource?: "missiongo" | "source";
  readonly nodeId?: string;
  readonly nodeName: string;
  readonly nodeConnectionState?: NodeConnectionState;
  readonly nodeLastSeenAt?: string;
  readonly nodeRevoked: boolean;
  readonly mode: string;
  readonly dispatchStatus: string;
  readonly dispatchResultRejected?: boolean;
  readonly sessionName?: string;
  readonly sessionUrl?: string;
  readonly createdAt: string;
  readonly items: readonly {
    readonly key: string;
    readonly title: string;
    readonly productId: string;
  }[];
  readonly latestMessage?: Pick<AgentSessionMessageInput, "role" | "text"> & Partial<Pick<AgentSessionMessageInput, "sourceId" | "phase">>;
  readonly command?: AgentSessionCommand;
  readonly stopCommand?: AgentSessionCommand;
  readonly attention: AgentSessionAttention;
  readonly needsAttention: boolean;
  readonly planApprovalPending?: boolean;
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

/**
 * AND-260: what the number on an icon counts. A conversation that is still
 * running keeps producing messages that arrive unread, and counting those is
 * why the badge never went quiet -- an unread conversation that is still
 * `active` is noise until it stops. Every other unread conversation counts:
 * idle, stalled, suspended, unavailable and failed ones are all waiting on a
 * person.
 */
export function agentSessionCountsAsUnread(
  session: { readonly unread: boolean; readonly status: string },
): boolean {
  return session.unread && session.status !== "active";
}

export interface AgentSessionSettings {
  /** External sessions advertise individual controls; absent means a legacy dispatch. */
  readonly supportedFields?: readonly ("mode" | "model" | "effort")[];
  readonly unavailableReason?: "connect" | "upgrade" | "source";
  readonly applyOn?: "next_reply" | "idle";

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
  /** Latest model choice, including a running-session change; absent means the Mac's own configuration. */
  readonly requiresImplementationMode?: boolean;
  readonly requestedMode?: string;
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
  readonly managedExecution?: ManagedSessionBinding;
  readonly id: string;
  readonly dispatchId: string;
  readonly agentKind: "codex" | "claude_code" | "opencode";
  readonly sessionRef: string;
  readonly status: AgentSessionStatus;
  readonly lifecycle: "keep" | "close";
  readonly occupiesExecutionSlot: boolean;
  readonly command?: AgentSessionCommand;
  readonly approvalReviewMode?: string;
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
  approval_review_mode?: string;
  desired_settings_json?: string | null;
  settings_revision?: number;
  applied_settings_revision?: number;
  settings_error_revision?: number;
}

interface SessionSettingsColumns {
  implementation_mode?: string | null;
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

type NodeModelsCache = Map<string, Map<AgentKind, ReturnType<typeof parseAgentModels>>>;

function nodeAgentModels(agentsJson: string, agentKind: AgentKind, cache?: NodeModelsCache) {
  const cached = cache?.get(agentsJson);
  if (cached?.has(agentKind)) return cached.get(agentKind);
  const agents = JSON.parse(agentsJson) as Array<{ kind: string; models?: unknown }>;
  const agent = agents.find((entry) => entry.kind === agentKind);
  const models = agent ? parseAgentModels(agent.models) : undefined;
  if (cache) {
    const byKind = cached ?? new Map();
    byKind.set(agentKind, models);
    cache.set(agentsJson, byKind);
  }
  return models;
}

function sessionSettings(row: SessionSettingsColumns, open: boolean, modelsCache?: NodeModelsCache): AgentSessionSettings {
  const desired = row.desired_settings_json ? JSON.parse(row.desired_settings_json) as AgentRunSettings : undefined;
  const requestedModel = desired?.model ?? row.dispatch_model;
  const revision = row.settings_revision ?? 0;
  const settled = Math.max(row.applied_settings_revision ?? 0, row.settings_error_revision ?? 0);
  return {
    mode: row.session_mode ?? row.dispatch_mode,
    requestedMode: row.implementation_mode ?? row.dispatch_mode,
    ...(row.agent_kind!=="codex" && row.session_mode==="plan" ? {requiresImplementationMode:true} : {}),
    ...(row.session_model ? { model: row.session_model } : {}),
    ...(row.session_model_endpoint ? { modelEndpoint: row.session_model_endpoint } : {}),
    ...(row.session_effort ? { effort: row.session_effort } : {}),
    // Running changes retain earlier requested fields, so a later effort or
    // mode change must not make the picker jump back to the dispatch's model.
    ...(requestedModel ? { requestedModel } : {}),
    ...(row.dispatch_effort ? { requestedEffort: row.dispatch_effort } : {}),
    ...(desired && revision > settled ? { pending: { ...desired, revision } } : {}),
    ...(row.settings_error && (row.settings_error_revision ?? 0) >= (row.applied_settings_revision ?? 0)
      ? { error: row.settings_error }
      : {}),
    adjustable: open && nodeAgentModels(row.node_agents_json, row.agent_kind, modelsCache) !== undefined,
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
  dispatch_diagnostic_json: string | null;
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

interface CommandMetadata {
  readonly attachments: ReadonlyMap<string, readonly AgentSessionAttachment[]>;
  readonly sources: ReadonlyMap<string, string>;
  readonly revisions: ReadonlyMap<string, string>;
}

interface CommandRow {
  stop_confirmed?: number;
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
  delivery_only: number | null;
  state: AgentAttentionState;
  kind: AgentAttentionKind | null;
  reason: string | null;
  model: string | null;
  dismissed_message_hash: string | null;
  dismissed_at: string | null;
  dismissed_by_account_id: string | null;
}

const MAX_MESSAGE_LENGTH = 4_000_000;
const MAX_COMMAND_LENGTH = 20_000;
const MAX_MESSAGES_PER_SNAPSHOT = 2_000;
const MAX_ACTIVITIES_PER_SNAPSHOT = 100;
const SOURCE_ARCHIVE_POLL_MS = 30_000;

function requiredText(value: string, field: string, maximum: number, preserve = false): string {
  const text = value.trim();
  if (!text) throw invalidInput(`${field} is required.`);
  if ((preserve ? value : text).length > maximum) throw invalidInput(`${field} must be ${maximum} characters or fewer.`);
  return preserve ? value : text;
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
    // A question marked `answered` is settled history, not an open ask: an
    // answered card as the newest message must not read as waiting for a
    // person (AND-227). A `withdrawn` one is settled the same way (AND-239).
    return Array.isArray(parsed) && parsed.some(
      (question) => !((question as { answered?: string }).answered)
        && (question as { withdrawn?: boolean }).withdrawn !== true,
    );
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
      reason: "会话疑似卡住，请核对当前活动后决定中断或继续；MissionGo 未自动中断。",
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
/** A stop must settle promptly; ordinary replies keep their separate policy. */
export const STOP_COMMAND_TIMEOUT_MS = 2 * 60 * 1_000;
/**
 * How long a reply may wait behind a running turn before it is worth pointing
 * out. Waiting behind a long turn is legitimate, so this never fails the
 * command, it only surfaces it (AND-184).
 */
export const COMMAND_QUEUED_ALERT_MS = 180 * 60 * 1_000;
/** Stamped on a delivery the server stopped waiting for; also its alert marker. */
export const COMMAND_DELIVERY_TIMEOUT_ERROR =
  "Mac 认领回复后 30 分钟没有报告投递结果，MissionGo 已自动标记失败。请重新发送或检查该 Mac。";
/** What the console, the Mac menu and the timeline call each agent. */
const AGENT_DISPLAY_NAMES: Readonly<Record<string, string>> = {
  codex: "Codex",
  claude_code: "Claude Code",
  opencode: "OpenCode",
  hermes: "Hermes",
};
export function agentDisplayName(agentKind: string): string {
  return AGENT_DISPLAY_NAMES[agentKind] ?? "AI";
}
/**
 * Written on a reply whose delivery the Mac could not confirm, when the Mac's
 * own report carried no text. The Mac usually supplies its own, already
 * agent-aware copy, so this is the fallback; it names the session's own agent
 * instead of Codex, which is what an OpenCode session used to read (AND-253).
 */
export function commandDeliveryUnknownError(agentKind: string): string {
  const agent = agentDisplayName(agentKind);
  return `无法确认 ${agent} 是否收到这条回复。请先在 ${agent} 会话中核实，再选择已收到或未收到；MissionGo 不会自动重发。`;
}

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
  agentKind: string,
  now = Date.now(),
): string | undefined {
  if (command.status === "delivering") {
    const since = Date.parse(command.delivering_at ?? command.created_at);
    return Number.isFinite(since) && now - since >= COMMAND_DELIVERING_TIMEOUT_MS
      ? COMMAND_DELIVERY_TIMEOUT_ERROR
      : undefined;
  }
  if (command.status === "delivery_unknown") {
    return command.error || commandDeliveryUnknownError(agentKind);
  }
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

export class AgentSessionStore {
  constructor(private readonly database: MissionGoDatabase, private readonly attachments?: AgentSessionAttachments) {}

  private freeSession(dispatchId: string) {
    return this.database.connection.prepare(`SELECT f.*,d.status AS dispatch_status,d.error FROM free_session_starts f JOIN dispatches d ON d.id=f.dispatch_id WHERE f.dispatch_id=?`)
      .get(dispatchId) as { product_id:string;initial_text:string;ready:number;dispatch_status:string;error:string|null }|undefined;
  }
  private pendingNative(dispatchId: string): boolean {
    return Boolean(this.database.connection.prepare("SELECT 1 FROM agent_sessions WHERE dispatch_id=? AND agent_session_ref=?").get(dispatchId,`pending:${dispatchId}`));
  }

  managedBinding(sessionId: string): ManagedSessionBinding | undefined {
    const row = this.database.connection.prepare("SELECT i.snapshot_json FROM managed_execution_intents i JOIN agent_sessions s ON s.dispatch_id=i.id WHERE s.id=?")
      .get(sessionId) as { snapshot_json: string } | undefined;
    if (!row) return undefined;
    const i = JSON.parse(row.snapshot_json);
    return { id: i.id, runId: i.binding.runId, stageId: i.stageId, generation: i.generation, role: i.binding.role, stopRequested: i.stopRequested, state: i.state, ownershipHeld: i.ownershipHeld };
  }
  private requireManualSession(sessionId: string): void {
    if (this.managedBinding(sessionId)) throw conflict("managed_session_control", "Use the scoped coordinator control for a managed session.");
  }
  createForDispatch(input: { dispatchId: string; nodeId: string; sessionRef: string; initialTurnId?: string }): string {
    assertDispatchExecution(this.database,input.dispatchId);
    const dispatch = this.database.connection
      .prepare("SELECT d.agent_kind,d.mode,n.agents_json FROM dispatches d JOIN nodes n ON n.id=d.node_id WHERE d.id = ? AND d.node_id = ?")
      .get(input.dispatchId, input.nodeId) as unknown as { agent_kind: string; mode: string; agents_json:string } | undefined;
    if (!dispatch) throw notFound("Dispatch");
    if (dispatch.agent_kind !== "codex" && dispatch.agent_kind !== "claude_code" && dispatch.agent_kind !== "opencode") {
      throw invalidInput("This agent does not support mirrored sessions.");
    }
    const initialMode = normalizeAgentMode(dispatch.agent_kind, dispatch.mode);
    // Native permissions apply from the first turn, independently of approval.
    const initialSettings = JSON.stringify({mode: initialMode, planning: false});
    const sessionRef = requiredText(input.sessionRef, "sessionRef", 200);
    const existing = this.database.connection
      .prepare("SELECT id FROM agent_sessions WHERE dispatch_id = ?")
      .get(input.dispatchId) as unknown as { id: string } | undefined;
    if (existing) {
      this.database.connection.prepare(`UPDATE agent_sessions SET agent_session_ref=?,status='active',mode=COALESCE(mode,?),implementation_mode=COALESCE(implementation_mode,?),
        desired_settings_json=COALESCE(desired_settings_json,?),settings_revision=MAX(settings_revision,?) WHERE id=? AND agent_session_ref=?`)
        .run(sessionRef,initialMode,initialMode,initialSettings,1,existing.id,`pending:${input.dispatchId}`);
      this.bindStartupStop(existing.id, input.initialTurnId);
      return existing.id;
    }
    const id = randomUUID();
    const now = new Date().toISOString();
    this.database.connection
      .prepare(
        `INSERT INTO agent_sessions
          (id, dispatch_id, node_id, agent_kind, agent_session_ref, status, mode, implementation_mode, desired_settings_json, settings_revision, created_at, updated_at, activity_at)
         VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, input.dispatchId, input.nodeId, dispatch.agent_kind, sessionRef, initialMode, initialMode, initialSettings, 1, now, now, now);
    this.bindStartupStop(id, input.initialTurnId);
    return id;
  }

  /** Stable batch identity survives completion, archival and startup retries. */
  private integrationSessionIds(accountId: string): Set<string> {
    const rows = this.database.connection.prepare(
      "SELECT json_extract(data_json, '$.sessionId') AS session_id FROM merge_batches WHERE account_id = ?",
    ).all(accountId) as unknown as Array<{ session_id: string }>;
    return new Set(rows.map(row => row.session_id));
  }

  getForAccount(accountId: string, sessionId: string, includeMessages = true): AgentSessionSnapshot {
    this.failStuckDeliveringCommands();
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
    const free = this.freeSession(row.dispatch_id);
    const messages = includeMessages ? this.database.connection
      .prepare(
        `SELECT id, source_id, turn_id, role, phase, text, questions_json, occurred_at
         FROM agent_session_messages WHERE session_id = ? AND (phase IS NULL OR phase <> 'execution') ORDER BY position, observed_at, rowid`,
      )
      .all(sessionId) as unknown as Array<{
        id: string; source_id: string; turn_id: string | null; role: AgentMessageRole;
        phase: string | null; text: string; questions_json: string | null; occurred_at: string;
      }> : [];
    const command = this.latestCommand(sessionId);
    const stopCommand = this.latestStop(sessionId);
    const turnState = JSON.parse(row.turn_state_json) as AgentSessionTurnState;
    const health = sessionHealth(offlineDegradedStatus(row.status, row.node_last_seen_at, Boolean(row.node_revoked_at)).status, row.archived_at ? {} : turnState);
    return {
      id: row.id,
      ...(this.integrationSessionIds(accountId).has(row.id) ? { sessionPurpose: "integration" as const } : {}),
      ...(free ? { productId: free.product_id, initialText: free.initial_text, startReady: free.ready === 1 } : {}),
      dispatchId: row.dispatch_id,
      ...(this.managedBinding(row.id) ? { managedExecution: this.managedBinding(row.id)! } : {}),
      agentKind: row.agent_kind,
      // Same read-time rule as the list (AND-221): a Mac nobody has heard
      // from in half an hour is not running this session.
      status: free && row.agent_session_ref.startsWith("pending:") ? (free.dispatch_status === "failed" ? "failed" : "idle") : health.status,
      ...sessionErrorFields(health.reason ?? row.last_error ?? free?.error),
      updatedAt: row.updated_at,
      ...(row.archived_at ? { archivedAt: row.archived_at } : {}),
      ...(row.archive_source ? { archivedSource: row.archive_source } : {}),
      activities: JSON.parse(row.activities_json) as AgentSessionActivity[],
      turnState,
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
      ...(stopCommand ? { stopCommand: this.mapCommand(stopCommand) } : {}),
      replyable: (!free || free.dispatch_status === "launched") && !dispatchExecutionRevoked(this.database,row.dispatch_id) && !this.managedBinding(sessionId) && !this.itemsCompleted(sessionId),
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
  listForAccount(accountId: string, limit = 100, selectedIds?: readonly string[]): readonly AgentSessionListItem[] {
    if (selectedIds?.length === 0) return [];
    // Read paths are where the server's own timeout check runs (AND-184): no
    // resident timer, and the check happens exactly when somebody can see the
    // freed slot.
    this.failStuckDeliveringCommands();
    const db = this.database.connection;
    const rows = db
      .prepare(
        `SELECT s.id AS session_id, d.id AS dispatch_id, d.agent_kind,
                s.status AS session_status, s.last_error AS session_last_error,
                s.updated_at AS session_updated_at, COALESCE(mc.message_at, s.created_at, d.created_at) AS session_activity_at,
                s.archived_at AS session_archived_at, s.archive_source AS session_archive_source,
                s.activities_json AS session_activities_json,
                s.turn_state_json AS session_turn_state_json,
                d.node_id, COALESCE(n.nickname, n.name) AS node_name, n.last_seen_at AS node_last_seen_at,
                n.revoked_at AS node_revoked_at, d.mode, d.status AS dispatch_status,
                d.session_name, d.session_url, d.error AS dispatch_error,
                d.diagnostic_snapshot_json AS dispatch_diagnostic_json,
                d.created_at, d.delivered_at, d.completed_at, d.archived_at AS dispatch_archived_at,
                d.unread_at, d.read_at,
                d.mode AS dispatch_mode, d.model AS dispatch_model, d.effort AS dispatch_effort,
                s.implementation_mode, s.mode AS session_mode, s.model AS session_model,
                s.model_endpoint AS session_model_endpoint, s.effort AS session_effort,
                s.desired_settings_json, s.settings_revision, s.applied_settings_revision,
                s.settings_error, s.settings_error_revision, NULL AS node_agents_json
         FROM dispatches d
         LEFT JOIN agent_sessions s ON s.dispatch_id = d.id
         LEFT JOIN session_message_clocks mc ON mc.session_key = 'dispatch:' || d.id
         JOIN nodes n ON n.id = d.node_id
         WHERE d.account_id = ?
           ${selectedIds ? `AND d.id IN (SELECT value FROM json_each(?))` : ''}
           AND (s.id IS NOT NULL OR NOT EXISTS (SELECT 1 FROM free_session_starts f WHERE f.dispatch_id=d.id))
         ORDER BY COALESCE(mc.message_at, s.created_at, d.created_at) DESC, d.id DESC
         LIMIT ?`,
      )
      .all(accountId, ...(selectedIds ? [JSON.stringify(selectedIds)] : []), limit) as unknown as SessionListSettingsRow[];
    // AND-383: every per-row lookup below used to run as its own statement
    // (items, latest message and command, attention, free starts, pending
    // natives, rounds, managed bindings, revocations, item completion) --
    // roughly ten queries per session, several thousand per scan once an
    // account passed a few hundred dispatches, which pinned the single-
    // threaded event loop for hundreds of milliseconds on every console read.
    // One batched statement per lookup now feeds the exact same row mapping.
    // Capabilities belong to nodes, not dispatches. Avoid copying the same large
    // JSON column for every historical session, and keep parsing request-local.
    const nodeIds = [...new Set(rows.map(row => row.node_id))];
    const nodeCapabilities = new Map(nodeIds.length ? (db.prepare(
      "SELECT id,agents_json FROM nodes WHERE id IN (SELECT value FROM json_each(?))",
    ).all(JSON.stringify(nodeIds)) as Array<{id:string;agents_json:string}>).map(row => [row.id,row.agents_json]) : []);
    for (const row of rows) row.node_agents_json = nodeCapabilities.get(row.node_id) ?? "[]";
    const modelsCache: NodeModelsCache = new Map();
    const integrationIds = this.integrationSessionIds(accountId);
    const dispatchIds = [...new Set(rows.map((row) => row.dispatch_id))];
    const sessionIds = rows.flatMap((row) => (row.session_id ? [row.session_id as string] : []));
    const holes = (values: readonly string[]) => `(${values.map(() => "?").join(",")})`;
    const itemRowsByDispatch = new Map<string, Array<{ item_key: string; title: string; product_id: string; status: string }>>();
    if (dispatchIds.length) {
      const batch = db.prepare(`SELECT di.dispatch_id, w.item_key, w.title, w.product_id, w.status
        FROM dispatch_items di JOIN work_items w ON w.id = di.item_id
        WHERE di.dispatch_id IN ${holes(dispatchIds)} ORDER BY di.dispatch_id, di.position`)
        .all(...dispatchIds) as unknown as Array<{ dispatch_id: string; item_key: string; title: string; product_id: string; status: string }>;
      for (const item of batch) {
        const list = itemRowsByDispatch.get(item.dispatch_id) ?? [];
        itemRowsByDispatch.set(item.dispatch_id, list);
        list.push(item);
      }
    }
    const messageBySession = new Map<string, { id: string; source_id: string; role: AgentMessageRole; phase: string | null;
      text: string; questions_json: string | null }>();
    if (sessionIds.length) {
      // One statement, with an index seek for each selected session. Avoid both
      // the old full-table window sort and one JS/SQLite round trip per row.
      const messages = db.prepare(`SELECT session_id,id,source_id,role,phase,text,questions_json FROM agent_session_messages
        WHERE rowid IN (SELECT (SELECT m.rowid FROM agent_session_messages m WHERE m.session_id=s.id
          AND (m.phase IS NULL OR m.phase<>'execution') ORDER BY m.position DESC,m.observed_at DESC,m.rowid DESC LIMIT 1)
          FROM agent_sessions s WHERE s.id IN (SELECT value FROM json_each(?)))`)
        .all(JSON.stringify(sessionIds)) as unknown as Array<{session_id:string;id:string;source_id:string;role:AgentMessageRole;phase:string|null;text:string;questions_json:string|null}>;
      for (const message of messages) messageBySession.set(message.session_id,message);
    }
    const commandBySession = new Map<string, CommandRow>();
    if (sessionIds.length) {
      const batch = db.prepare(`SELECT session_id, id, kind, text, turn_id, stop_confirmed, status, error, created_at, delivered_at, delivering_at, cancelled_at FROM (
        SELECT session_id, id, kind, text, turn_id, stop_confirmed, status, error, created_at, delivered_at, delivering_at, cancelled_at,
          ROW_NUMBER() OVER (PARTITION BY session_id ORDER BY CASE WHEN status IN ('queued','delivering','delivery_unknown') THEN CASE WHEN kind='interrupt' THEN 0 ELSE 1 END ELSE 2 END, created_at DESC, rowid DESC) AS rn
        FROM agent_session_commands WHERE session_id IN ${holes(sessionIds)}) WHERE rn = 1`)
        .all(...sessionIds) as unknown as Array<{ session_id: string } & CommandRow>;
      for (const command of batch) commandBySession.set(command.session_id, command);
    }
    const stopBySession = new Map<string, CommandRow>();
    if (sessionIds.length) {
      const stops = db.prepare(`SELECT * FROM (SELECT *, ROW_NUMBER() OVER (PARTITION BY session_id ORDER BY created_at DESC,rowid DESC) AS rn
        FROM agent_session_commands WHERE kind='interrupt' AND session_id IN ${holes(sessionIds)}) WHERE rn=1`)
        .all(...sessionIds) as unknown as Array<{ session_id: string } & CommandRow>;
      for (const stop of stops) stopBySession.set(stop.session_id, stop);
    }
    const attentionBySession = new Map<string, AttentionRow>();
    if (sessionIds.length) {
      const batch = db.prepare(`SELECT session_id, message_hash, state, kind, reason, model, delivery_only,
          dismissed_message_hash, dismissed_at, dismissed_by_account_id
        FROM agent_session_attention WHERE session_id IN ${holes(sessionIds)}`)
        .all(...sessionIds) as unknown as Array<{ session_id: string } & AttentionRow>;
      for (const attention of batch) attentionBySession.set(attention.session_id, attention);
    }
    const freeByDispatch = new Map<string, { product_id: string; initial_text: string; session_title: string | null; ready: number; dispatch_status: string; error: string | null }>();
    if (dispatchIds.length) {
      const batch = db.prepare(`SELECT f.dispatch_id, f.product_id, f.initial_text, f.session_title, f.ready, d.status AS dispatch_status, d.error
        FROM free_session_starts f JOIN dispatches d ON d.id = f.dispatch_id WHERE f.dispatch_id IN ${holes(dispatchIds)}`)
        .all(...dispatchIds) as unknown as Array<{ dispatch_id: string; product_id: string; initial_text: string; session_title: string | null; ready: number; dispatch_status: string; error: string | null }>;
      for (const free of batch) freeByDispatch.set(free.dispatch_id, free);
    }
    const pendingNatives = new Set<string>(dispatchIds.length
      ? (db.prepare(`SELECT d.id AS dispatch_id FROM dispatches d
          JOIN agent_sessions s ON s.dispatch_id = d.id AND s.agent_session_ref = 'pending:' || d.id
          WHERE d.id IN ${holes(dispatchIds)}`)
        .all(...dispatchIds) as unknown as Array<{ dispatch_id: string }>).map((row) => row.dispatch_id)
      : []);
    const roundByDispatch = new Map<string, number>();
    if (dispatchIds.length) {
      // Count each distinct timestamp bucket once. A self-join expanded N
      // dispatches on the same item to N² rows before discarding equal/newer times.
      const batch = db.prepare(`WITH item_times AS (
        SELECT di.item_id,d.created_at,SUM(CASE WHEN d.status IN ('delivered','launched') THEN 1 ELSE 0 END) AS n
        FROM dispatch_items di JOIN dispatches d ON d.id=di.dispatch_id
        WHERE di.item_id IN (SELECT item_id FROM dispatch_items WHERE dispatch_id IN (SELECT value FROM json_each(?)))
        GROUP BY di.item_id,d.created_at
      ), counts AS (
        SELECT item_id,created_at,COALESCE(SUM(n) OVER(PARTITION BY item_id ORDER BY created_at
          ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING),0) AS earlier FROM item_times
      ) SELECT di.dispatch_id,counts.earlier FROM dispatch_items di JOIN dispatches d ON d.id=di.dispatch_id
        JOIN counts ON counts.item_id=di.item_id AND counts.created_at=d.created_at
        WHERE di.dispatch_id IN (SELECT value FROM json_each(?))`)
        .all(JSON.stringify(dispatchIds),JSON.stringify(dispatchIds)) as unknown as Array<{ dispatch_id: string; earlier: number }>;
      for (const round of batch) roundByDispatch.set(round.dispatch_id, Math.max(roundByDispatch.get(round.dispatch_id) ?? 0, round.earlier));
    }
    const bindingBySession = new Map<string, ManagedSessionBinding>();
    if (sessionIds.length) {
      const batch = db.prepare(`SELECT s.id AS session_id, i.snapshot_json
        FROM managed_execution_intents i JOIN agent_sessions s ON s.dispatch_id = i.id
        WHERE s.id IN ${holes(sessionIds)}`)
        .all(...sessionIds) as unknown as Array<{ session_id: string; snapshot_json: string }>;
      for (const binding of batch) {
        const intent = JSON.parse(binding.snapshot_json);
        bindingBySession.set(binding.session_id, { id: intent.id, runId: intent.binding.runId, stageId: intent.stageId,
          generation: intent.generation, role: intent.binding.role, stopRequested: intent.stopRequested,
          state: intent.state, ownershipHeld: intent.ownershipHeld });
      }
    }
    const revokedDispatches = new Set<string>(dispatchIds.length
      ? (db.prepare(`SELECT dispatch_id FROM builder_revoked_dispatches WHERE dispatch_id IN ${holes(dispatchIds)}`)
        .all(...dispatchIds) as unknown as Array<{ dispatch_id: string }>).map((row) => row.dispatch_id)
      : []);
    const commands = [...new Map([...commandBySession.values(), ...stopBySession.values()].map(row => [row.id,row])).values()];
    const commandIds = commands.map(row => row.id);
    const metadata: CommandMetadata = {
      attachments: this.attachments?.listForCommands(commandIds) ?? new Map(),
      sources: commandSourceMessages(db, commandIds),
      revisions: new ImplementationPlans(this.database).commandRevisions(commandIds),
    };
    const mappedCommands = new Map(commands.map(row => [row.id,this.mapCommand(row,metadata)]));
    return rows.map((row) => {
      const free = freeByDispatch.get(row.dispatch_id);
      const itemRows = itemRowsByDispatch.get(row.dispatch_id) ?? [];
      const message = row.session_id ? messageBySession.get(row.session_id) : undefined;
      const command = row.session_id ? commandBySession.get(row.session_id) : undefined;
      const stopCommand = row.session_id ? stopBySession.get(row.session_id) : undefined;
      const pendingNativeFree = Boolean(free) && pendingNatives.has(row.dispatch_id);
      const binding = row.session_id ? bindingBySession.get(row.session_id) : undefined;
      const itemsCompleted = !free && row.session_id
        ? itemRows.length > 0 && itemRows.every((item) => item.status === "done")
        : false;
      const awaitingNative = !row.session_id || pendingNativeFree;
      const resultRejected = awaitingNative && row.dispatch_status === "delivered"
        && Boolean(row.dispatch_diagnostic_json && JSON.parse(row.dispatch_diagnostic_json).resultRejection);
      const deliveryTimedOut = awaitingNative && row.dispatch_status === "delivered"
        && deliveredDispatchTimedOut(row.delivered_at);
      const inferredStatus: AgentSessionStatus = free && !free.ready && row.dispatch_status === "queued" ? "idle" : row.dispatch_status === "failed" || deliveryTimedOut || resultRejected
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
        (free && pendingNativeFree ? inferredStatus : row.session_status ?? inferredStatus), row.node_last_seen_at, Boolean(row.node_revoked_at),
      );
      const turnState = row.session_turn_state_json ? JSON.parse(row.session_turn_state_json) as AgentSessionTurnState : {};
      const health = sessionHealth(offlineDegraded.status, row.session_archived_at || row.dispatch_archived_at ? {} : turnState);
      const status = health.status;
      const updatedAt = row.session_updated_at ?? row.dispatch_archived_at
        ?? row.completed_at ?? row.delivered_at ?? row.created_at;
      const activityAt = row.session_activity_at ?? row.created_at;
      const archivedAt = row.session_archived_at ?? row.dispatch_archived_at;
      const archivedSource = row.session_archive_source ?? (row.dispatch_archived_at ? "missiongo" : null);
      const lastError = health.reason ?? row.session_last_error ?? row.dispatch_error
        ?? (deliveryTimedOut ? "Mac 领取派单后超过 10 分钟仍未报告启动结果。请确认来源会话不存在，再手动重新派单。" : null);
      const connectionState = row.node_revoked_at
        ? "offline"
        : nodeConnectionState(row.node_last_seen_at ?? undefined);
      const messageHash = attentionMessageHash(status, message);
      const contentHash = attentionContentHash(message);
      const cachedAttention = row.session_id
        ? attentionBySession.get(row.session_id) as AttentionRow | undefined
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
                      ...(cachedAttention.delivery_only === 1 ? { deliveryOnly: true } : {}),
                      revision: contentHash,
                    }
                  : { ...initialAttention(status, message), revision: contentHash };
      // A reply the Mac claimed but never settled, or one queued far longer than
      // a turn, is a fault the transcript cannot express (AND-184). Override the
      // message-derived attention so the console shows it; deliberately without a
      // revision, so nobody can dismiss a condition that is still true.
      const stuckReason = command ? stuckCommandReason(command, row.agent_kind) : undefined;
      // So is a session reading "running" on a Mac nobody has heard from in
      // half an hour (AND-221) — same discipline, still true until the Mac
      // reports again, so it cannot be dismissed either.
      const offlineReason = offlineDegraded.degraded
        ? row.node_revoked_at
          ? "该会话所属节点已被撤销，状态不再更新；如需继续请重新派单。"
          : "节点已离线超过 30 分钟，会话状态无法确认；节点恢复后会自动更正。"
        : undefined;
      const alertAttention: AgentSessionAttention = health.reason
        ? { state: "needed", kind: "uncertain", reason: health.reason }
        : stuckReason
        ? { state: "needed", kind: "action", reason: stuckReason }
        : offlineReason
          ? { state: "needed", kind: "uncertain", reason: offlineReason }
          : attention;
      const needsAttention = alertAttention.state === "needed";
      return {
        id: row.session_id ?? `dispatch:${row.dispatch_id}`,
        ...(row.session_id && integrationIds.has(row.session_id) ? { sessionPurpose: "integration" as const } : {}),
        ...(row.session_id ? { agentSessionId: row.session_id } : {}),
        dispatchId: row.dispatch_id,
        round: (roundByDispatch.get(row.dispatch_id) ?? 0) + 1,
        ...(binding ? { managedExecution: binding } : {}),
        agentKind: row.agent_kind,
        status,
        ...sessionErrorFields(lastError),
        updatedAt,
        activityAt,
        ...(archivedAt ? { archivedAt } : {}),
        ...(archivedSource ? { archivedSource } : {}),
        nodeId: row.node_id,
        ...(free ? { productId: free.product_id, initialText: free.initial_text, startReady: free.ready === 1 } : {}),
        nodeName: row.node_name,
        nodeConnectionState: connectionState,
        ...(row.node_last_seen_at ? { nodeLastSeenAt: row.node_last_seen_at } : {}),
        nodeRevoked: Boolean(row.node_revoked_at),
        mode: row.mode,
        dispatchStatus: row.dispatch_status,
        ...(resultRejected ? { dispatchResultRejected: true } : {}),
        ...(free ? { sessionName: free.session_title ?? (free.initial_text.slice(0, 80) || "新会话") } : row.session_name ? { sessionName: row.session_name } : {}),
        ...(row.session_url ? { sessionUrl: row.session_url } : {}),
        createdAt: row.created_at,
        items: itemRows.map((item) => ({ key: item.item_key, title: item.title, productId: item.product_id })),
        ...(message ? { latestMessage: { role: message.role, text: message.text, sourceId: message.source_id, ...(message.phase ? {phase:message.phase} : {}) } } : {}),
        ...(command ? { command: mappedCommands.get(command.id)! } : {}),
        ...(stopCommand ? { stopCommand: mappedCommands.get(stopCommand.id)! } : {}),
        attention: alertAttention,
        needsAttention,
        activities: row.session_activities_json
          ? JSON.parse(row.session_activities_json) as AgentSessionActivity[]
          : [],
        ...(row.session_turn_state_json
          ? { turnState: JSON.parse(row.session_turn_state_json) as AgentSessionTurnState }
          : {}),
        waitingForPermission: turnState.waitingForPermission ?? Boolean(message && hasPendingPermissionQuestion(row.agent_kind, [{ sourceId: message.source_id, questions: JSON.parse(message.questions_json ?? "[]") }])),
        waitingForReply: needsAttention,
        retryable: (["failed", "cancelled"].includes(row.dispatch_status) || deliveryTimedOut)
          && (free ? free.ready === 1 && ["failed", "cancelled"].includes(row.dispatch_status) && pendingNativeFree : itemRows.length > 0 && itemRows.every((item) => item.status === "ready")),
        stoppable: (["queued", "delivered"].includes(row.dispatch_status)
          && (!free || free.ready === 1))
          || Boolean(row.dispatch_status === "launched" && row.session_id && !binding && !itemsCompleted
            && hasStoppableAgentTurn({ status, turnState,
              command: command ? mappedCommands.get(command.id)! : undefined,
              stopCommand: stopCommand ? mappedCommands.get(stopCommand.id)! : undefined })),
        replyable: row.session_id && (!free || free.dispatch_status === "launched") ? !revokedDispatches.has(row.dispatch_id) && !binding && !itemsCompleted : false,
        settings: sessionSettings(
          row,
          Boolean(row.session_id) && (!free || free.dispatch_status === "launched") && !archivedAt && !(row.session_id && (itemsCompleted || binding)),
          modelsCache,
        ),
        unread: Boolean(row.unread_at && (!row.read_at || row.unread_at > row.read_at)),
        ...(row.unread_at ? { unreadAt: row.unread_at } : {}),
      };
    });
  }

  setArchived(accountId: string, sessionId: string, archived: boolean): AgentSessionSnapshot {
    this.failStuckDeliveringCommands();
    this.requireManualSession(sessionId);
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
    if (archived) {
      this.database.connection.prepare(`UPDATE dispatches SET status='cancelled',completed_at=?
        WHERE id=(SELECT dispatch_id FROM agent_sessions WHERE id=?) AND status='queued'
          AND EXISTS (SELECT 1 FROM free_session_starts f WHERE f.dispatch_id=dispatches.id AND f.ready=0)`)
        .run(new Date().toISOString(), sessionId);
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
         SET archived_at = ?, archive_source = ?, updated_at = ?, activity_at = ?, activity_repair_pending = 0,
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
    if(archived) for(const table of ["implementation_plan_recovery_resumes","implementation_plan_continuations"])
      this.database.connection.prepare(`UPDATE ${table} SET state='cancelled'
        WHERE account_id=? AND session_id=? AND state='waiting'`).run(accountId,sessionId);
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
    acknowledgeSessionUnread(this.database, `dispatch:${dispatchId}`, through);
  }

  /**
   * Ask the Mac to change a running conversation's mode, model or effort
   * (AND-130). Fields left out keep their earlier request; the revision lets the
   * Mac apply each request once and report which one it is on.
   */
  requestSettings(accountId: string, sessionId: string, change: AgentRunSettings): AgentSessionSettings {
    const binding = this.database.connection.prepare("SELECT dispatch_id FROM agent_sessions s JOIN dispatches d ON d.id=s.dispatch_id WHERE s.id=? AND d.account_id=?")
      .get(sessionId,accountId) as {dispatch_id:string}|undefined;
    if (binding) assertDispatchExecution(this.database,binding.dispatch_id);
    this.requireManualSession(sessionId);
    const row = this.database.connection
      .prepare(
        `SELECT s.agent_kind, d.mode AS dispatch_mode, d.model AS dispatch_model, d.effort AS dispatch_effort,
                s.implementation_mode, s.mode AS session_mode, s.model AS session_model,
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
    const requestedMode=change.mode ?? row.implementation_mode ?? row.dispatch_mode;
    const agent=(JSON.parse(row.node_agents_json ?? "[]") as {kind:string;modes?:import("@missiongo/domain").AgentModeCapability[]}[]).find(entry=>entry.kind===row.agent_kind);
    requireAvailableMode(row.agent_kind,requestedMode,agent?.modes,next.model ?? row.session_model ?? row.dispatch_model ?? undefined);
    if(change.mode) this.database.connection.prepare("UPDATE agent_sessions SET implementation_mode=? WHERE id=?").run(change.mode,sessionId);
    const {planApproved: _previousApproval, ...choices} = next;
    const effective: AgentRunSettings = {...choices, mode: requestedMode, planning: false};
    this.database.connection
      .prepare(
        "UPDATE agent_sessions SET desired_settings_json = ?, settings_revision = settings_revision + 1 WHERE id = ?",
      )
      .run(JSON.stringify(effective), sessionId);
    return sessionSettings({
      ...row,
      desired_settings_json: JSON.stringify(effective),
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
       WHERE session_id = ? AND (phase IS NULL OR phase <> 'execution') ORDER BY position DESC, observed_at DESC, rowid DESC LIMIT 1`,
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

  enqueue(accountId: string, sessionId: string, textValue: string, attachmentIds: readonly string[] = [], managedControl = false, requestKey?: string): AgentSessionCommand {
    const binding = this.database.connection.prepare("SELECT dispatch_id FROM agent_sessions s JOIN dispatches d ON d.id=s.dispatch_id WHERE s.id=? AND d.account_id=?")
      .get(sessionId,accountId) as {dispatch_id:string}|undefined;
    if (binding) assertDispatchExecution(this.database,binding.dispatch_id);
    if (!managedControl) this.requireManualSession(sessionId);
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
    return new SessionSendRequests(this.database).run<AgentSessionCommand>(accountId, sessionId, "command", requestKey,
      [text, attachmentIds], id => this.commandById(sessionId, id), () => {
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
          recordMessageTime(this.database.connection, `dispatch:${binding!.dispatch_id}`, `command:${id}`, now);
          this.database.connection
            .prepare("UPDATE agent_sessions SET updated_at = ?, activity_at = ?, activity_repair_pending = 0 WHERE id = ?")
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
    });
  }

  commandById(sessionId: string, commandId: string): AgentSessionCommand | undefined {
    const row = this.database.connection.prepare("SELECT * FROM agent_session_commands WHERE session_id=? AND id=?")
      .get(sessionId, commandId) as unknown as CommandRow | undefined;
    return row ? this.mapCommand(row) : undefined;
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

  /** A durable intent exists even while launch has not registered a native ID. */
  requestDispatchStop(accountId: string, dispatchId: string): AgentSessionCommand {
    const dispatch = this.database.connection.prepare("SELECT node_id FROM dispatches WHERE id=? AND account_id=? AND status IN ('delivered','launched')")
      .get(dispatchId, accountId) as { node_id: string } | undefined;
    if (!dispatch) throw conflict("dispatch_not_stoppable", "This dispatch cannot be stopped.");
    return this.database.transaction(() => {
      const existing = this.database.connection.prepare("SELECT id FROM agent_sessions WHERE dispatch_id=?").get(dispatchId) as { id: string } | undefined;
      const sessionId = existing?.id ?? this.createForDispatch({ dispatchId, nodeId: dispatch.node_id, sessionRef: `pending:${dispatchId}` });
      return this.enqueueInterrupt(accountId, sessionId);
    });
  }

  /** Node-only launch fence. A later stop is carried to the first native turn. */
  permitDispatchStart(nodeId: string, dispatchId: string): boolean {
    return this.database.transaction(() => {
      const dispatch = this.database.connection.prepare("SELECT status FROM dispatches WHERE id=? AND node_id=?").get(dispatchId, nodeId) as { status: string } | undefined;
      if (!dispatch) throw notFound("Dispatch");
      if (dispatch.status === "cancelled") return false;
      if (dispatch.status !== "delivered") throw conflict("dispatch_result_not_expected", "Dispatch is not awaiting launch.");
      assertDispatchExecution(this.database, dispatchId);
      if(!handoffDispatchIsCurrent(this.database,dispatchId)) return false;
      const stop = this.database.connection.prepare(`SELECT c.id,s.id AS session_id FROM agent_session_commands c
        JOIN agent_sessions s ON s.id=c.session_id WHERE s.dispatch_id=? AND c.kind='interrupt'
        AND c.status IN ('queued','delivering','delivery_unknown')`).get(dispatchId) as { id: string; session_id: string } | undefined;
      if (!stop) return true;
      const now = new Date().toISOString();
      this.database.connection.prepare("UPDATE dispatches SET status='cancelled',completed_at=?,error=? WHERE id=?")
        .run(now, "已在启动前停止", dispatchId);
      this.database.connection.prepare("UPDATE agent_sessions SET status='idle',updated_at=? WHERE id=?").run(now, stop.session_id);
      this.database.connection.prepare("UPDATE agent_session_commands SET status='delivered',stop_confirmed=1,delivered_at=? WHERE id=?").run(now, stop.id);
      return false;
    });
  }

  private bindStartupStop(sessionId: string, turnId?: string): void {
    if (!turnId || turnId === "startup") return;
    this.database.connection.prepare("UPDATE agent_session_commands SET turn_id=? WHERE session_id=? AND kind='interrupt' AND turn_id='startup' AND status='queued'")
      .run(turnId, sessionId);
  }

  enqueueInterrupt(accountId: string, sessionId: string): AgentSessionCommand {
    this.failStuckDeliveringCommands();
    this.requireManualSession(sessionId);
    const session = this.database.connection.prepare(`SELECT s.id,s.status,s.archived_at,s.agent_kind,s.agent_session_ref
      FROM agent_sessions s JOIN dispatches d ON d.id=s.dispatch_id WHERE s.id=? AND d.account_id=?`)
      .get(sessionId, accountId) as { id: string; status: AgentSessionStatus; archived_at: string | null; agent_kind: AgentKind; agent_session_ref: string } | undefined;
    if (!session) throw notFound("Agent session");
    if (session.archived_at) throw conflict("agent_session_archived", "Restore this session before stopping it.");
    const stop = this.database.connection.prepare(`SELECT * FROM agent_session_commands WHERE session_id=? AND kind='interrupt'
      AND status IN ('queued','delivering','delivery_unknown') ORDER BY created_at DESC,rowid DESC LIMIT 1`).get(sessionId) as unknown as CommandRow | undefined;
    if (stop) return this.mapCommand(stop);
    const pending = this.database.connection.prepare(`SELECT * FROM agent_session_commands WHERE session_id=? AND kind='message'
      AND status IN ('queued','delivering','delivery_unknown') LIMIT 1`).get(sessionId) as unknown as CommandRow | undefined;
    const latest = this.database.connection.prepare(`SELECT turn_id,source_id FROM agent_session_messages
      WHERE session_id=? AND (role='user' OR turn_id IS NOT NULL) ORDER BY position DESC,observed_at DESC,rowid DESC LIMIT 1`)
      .get(sessionId) as { turn_id: string | null; source_id: string } | undefined;
    // Session-scoped protocols bind to the native user-input identity too.
    const turnId = latest ? (session.agent_kind === "opencode" ? latest.source_id : latest.turn_id) ?? "startup" : "startup";
    const id = randomUUID();
    const now = new Date().toISOString();
    this.database.transaction(() => {
      for(const table of ["implementation_plan_recovery_resumes","implementation_plan_continuations"])
        this.database.connection.prepare(`UPDATE ${table} SET state='cancelled'
          WHERE account_id=? AND session_id=? AND state='waiting'`).run(accountId,sessionId);
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
        .prepare("UPDATE agent_sessions SET updated_at = ?, activity_at = ?, activity_repair_pending = 0 WHERE id = ?")
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
      this.database.connection.prepare(`UPDATE implementation_plan_recovery_resumes SET state='cancelled'
        WHERE account_id=? AND session_id=? AND command_id=?`).run(accountId,sessionId,commandId);
      this.database.connection
        .prepare("UPDATE agent_sessions SET updated_at = ?, activity_at = ?, activity_repair_pending = 0 WHERE id = ?")
        .run(now, now, sessionId);
      this.database.connection
        .prepare(
          `UPDATE agent_session_attention
           SET state = 'needed', kind = 'uncertain', reason = ?, model = NULL, updated_at = ?
           WHERE session_id = ?`,
        )
        .run("回复已取消，请重新确认是否仍需处理。", now, sessionId);
      autoArchiveFinishedConversations(this.database, accountId, now, [sessionId]);
    });
    return this.mapCommand({ ...command, status: "cancelled", cancelled_at: now });
  }

  /** Release an uncertain reply only after the account holder checks the agent. */
  resolveDeliveryUnknown(
    accountId: string, sessionId: string, commandId: string, outcome: "received" | "not_received",
  ): AgentSessionCommand {
    const command = this.database.connection.prepare(
      `SELECT c.id, c.kind, c.text, c.turn_id, c.status, c.error, c.created_at,
              c.delivered_at, c.delivering_at, c.cancelled_at, s.dispatch_id, s.agent_kind
       FROM agent_session_commands c
       JOIN agent_sessions s ON s.id = c.session_id
       JOIN dispatches d ON d.id = s.dispatch_id
       WHERE c.id = ? AND c.session_id = ? AND d.account_id = ?`,
    ).get(commandId, sessionId, accountId) as unknown as
      (CommandRow & { dispatch_id: string; agent_kind: string }) | undefined;
    if (!command) throw notFound("Agent session command");
    if (command.kind !== "message" || command.status !== "delivery_unknown") {
      throw conflict("agent_reply_not_unconfirmed", "Only a reply awaiting delivery confirmation can be resolved.");
    }
    const now = new Date().toISOString();
    const status = outcome === "received" ? "delivered" : "cancelled";
    const agent = agentDisplayName(command.agent_kind);
    const error = outcome === "received"
      ? `用户在 ${agent} 核实已收到这条回复。`
      : `用户在 ${agent} 核实未收到；可手动重新发送。`;
    this.database.transaction(() => {
      const changed = this.database.connection.prepare(
        `UPDATE agent_session_commands
         SET status = ?, error = ?, delivered_at = ?, cancelled_at = ?
         WHERE id = ? AND session_id = ? AND status = 'delivery_unknown'`,
      ).run(status, error, outcome === "received" ? now : null, outcome === "not_received" ? now : null,
        commandId, sessionId);
      if (changed.changes !== 1) throw conflict("agent_reply_changed", "The reply changed before it was confirmed.");
      this.database.connection.prepare(
        "UPDATE agent_sessions SET updated_at = ?, activity_at = ?, activity_repair_pending = 0 WHERE id = ?",
      ).run(now, now, sessionId);
      autoArchiveFinishedDispatches(this.database, [command.dispatch_id], now);
    });
    return this.mapCommand({ ...command, status, error,
      delivered_at: outcome === "received" ? now : null,
      cancelled_at: outcome === "not_received" ? now : null });
  }

  listForNode(nodeId: string, interruptsOnly = false): readonly NodeAgentSession[] {
    this.failStuckDeliveringCommands();
    const sourceArchiveBefore = new Date(Date.now() - SOURCE_ARCHIVE_POLL_MS).toISOString();
    const selection = `SELECT id, dispatch_id, agent_kind, agent_session_ref, status, last_error, updated_at,
                archived_at, archive_source, archive_reason, source_archived_at, source_archive_error, source_restore_pending,
                desired_settings_json, settings_revision, applied_settings_revision, settings_error_revision,
                COALESCE(s.mode, (SELECT d.mode FROM dispatches d WHERE d.id=s.dispatch_id)) AS approval_review_mode
         FROM agent_sessions s
         WHERE node_id = ?
         AND s.agent_session_ref NOT LIKE 'pending:%'
         AND EXISTS (SELECT 1 FROM managed_execution_intents i WHERE i.id=s.dispatch_id) = ?
         AND (EXISTS (SELECT 1 FROM managed_execution_intents i WHERE i.id=s.dispatch_id AND (i.ownership_held=1 OR (json_extract(i.snapshot_json,'$.stopRequested')=1 AND json_extract(i.snapshot_json,'$.cleanup') IS NULL)))
           OR archived_at IS NULL OR (archive_source = 'source' AND updated_at <= ?)
           -- Finished work archived by MissionGo still needs the Mac once: a
           -- Codex thread to archive at the source, a Claude process to close.
           OR (archive_source = 'missiongo' AND agent_kind = 'codex'
             AND source_archived_at IS NULL AND source_archive_error IS NULL)
           OR (archive_source = 'missiongo' AND agent_kind = 'claude_code'
             AND source_archived_at IS NULL AND source_archive_error IS NULL)
           OR (archive_reason = 'auto' AND agent_kind = 'claude_code' AND status NOT IN ('suspended', 'failed')))
         AND (
           EXISTS (SELECT 1 FROM managed_execution_intents i WHERE i.id=s.dispatch_id AND (i.ownership_held=1 OR (json_extract(i.snapshot_json,'$.stopRequested')=1 AND json_extract(i.snapshot_json,'$.cleanup') IS NULL)))
           OR status IN ('active', 'stalled', 'unavailable') OR EXISTS (
             SELECT 1 FROM agent_session_commands c
             WHERE c.session_id = s.id AND c.status IN ('queued', 'delivering', 'delivery_unknown')
           ) OR EXISTS (
             SELECT 1 FROM agent_session_approvals a WHERE a.session_id = s.id
             AND (a.decision IS NOT NULL AND a.status = 'pending'
               OR a.retry_status IN ('queued', 'delivering', 'delivered'))
           ) OR s.settings_revision > MAX(s.applied_settings_revision, s.settings_error_revision)
           OR s.source_restore_pending = 1
           -- A source archive still owed goes out now, not after the idle cool-down.
           OR (archived_at IS NOT NULL AND archive_source = 'missiongo' AND agent_kind = 'codex'
             AND source_archived_at IS NULL AND source_archive_error IS NULL)
           OR (archived_at IS NOT NULL AND archive_source = 'missiongo' AND agent_kind = 'claude_code'
             AND source_archived_at IS NULL AND source_archive_error IS NULL)
           OR s.updated_at <= ?
         )
         ${interruptsOnly ? `AND s.agent_kind='codex' AND EXISTS (
           SELECT 1 FROM agent_session_commands c WHERE c.session_id=s.id AND c.kind='interrupt'
           AND c.status IN ('queued','delivering'))` : ""}
         AND s.id > ?`;
    const args = (managed: number, after: string) => [nodeId, managed, sourceArchiveBefore, sourceArchiveBefore, after];
    const managedPage = this.database.connection.prepare(selection + " ORDER BY s.id LIMIT 100");
    // Persist stable-ID progress across requests and restarts. BEGIN IMMEDIATE
    // serializes selection/advancement across connections. Stop/status updates
    // do not reset progress or move a held session ahead of unseen sessions.
    const managedRows = interruptsOnly ? [] : this.database.transaction(() => {
      const cursor = this.database.connection.prepare(
        "SELECT after_session_id FROM managed_session_poll_cursors WHERE node_id=?",
      ).get(nodeId) as { after_session_id: string } | undefined;
      let page = managedPage.all(...args(1, cursor?.after_session_id ?? "")) as unknown as SessionRow[];
      // Wrap only after exhausting the remainder; never duplicate within a page.
      if (!page.length && cursor) page = managedPage.all(...args(1, "")) as unknown as SessionRow[];
      if (page.length) this.database.connection.prepare(
        `INSERT INTO managed_session_poll_cursors(node_id,after_session_id) VALUES (?,?)
         ON CONFLICT(node_id) DO UPDATE SET after_session_id=excluded.after_session_id`,
      ).run(nodeId, page[page.length - 1]!.id);
      return page;
    });
    // Ordinary delivery keeps its independent bounded page and existing order.
    const ordinaryRows = this.database.connection.prepare(selection +
      " ORDER BY archive_source = 'source', updated_at DESC LIMIT 100")
      .all(...args(0, "")) as unknown as SessionRow[];
    const rows = [...managedRows, ...ordinaryRows];
    return rows.map((row) => {
      const managed = this.managedBinding(row.id);
      const revoked = dispatchExecutionRevoked(this.database,row.dispatch_id);
      const pending = this.pendingCommand(row.id);
      const command = pending?.kind === "interrupt" ? pending : (managed && (managed.stopRequested || !["running", "waiting"].includes(managed.state))) ? undefined : pending;
      const autoArchived = row.archive_reason === "auto";
      return {
        id: row.id,
        dispatchId: row.dispatch_id,
        ...(this.managedBinding(row.id) ? { managedExecution: this.managedBinding(row.id)! } : {}),
        agentKind: row.agent_kind,
        ...(row.agent_kind === "codex" && row.approval_review_mode
          ? { approvalReviewMode: row.approval_review_mode } : {}),
        sessionRef: row.agent_session_ref,
        status: row.status,
        lifecycle: row.agent_kind === "claude_code" && !row.source_restore_pending
          && (Boolean(row.archived_at) || autoArchived || this.itemsCompleted(row.id)) ? "close" : "keep",
        // Node uses this field for ordinary claim-next capacity. Managed
        // ownership remains in managedExecution, including unknown/stop states.
        occupiesExecutionSlot: !managed && !row.archived_at && (row.status === "active" || row.status === "stalled"),
        ...(command && (!revoked || command.kind === "interrupt") && command.status !== "delivery_unknown" ? { command: this.mapCommand(command) } : {}),
        ...(row.archive_source === "missiongo" && row.archived_at && row.agent_kind === "codex"
          && !row.source_archived_at && !row.source_archive_error
          ? { archiveInSource: true as const }
          : {}),
        ...(!revoked && row.source_restore_pending ? { restoreInSource: true as const } : {}),
        ...(!revoked && row.desired_settings_json && (row.settings_revision ?? 0) > 0
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
        `SELECT COUNT(*) AS count FROM agent_sessions s
         WHERE node_id = ? AND status IN ('active', 'stalled') AND archived_at IS NULL
         AND NOT EXISTS (SELECT 1 FROM managed_execution_intents i WHERE i.id=s.dispatch_id)`,
      )
      .get(nodeId) as unknown as { count: number };
    return row.count;
  }

  recordSnapshot(input: {
    controlReservation?: boolean;
    nodeId: string;
    sessionId: string;
    status: AgentSessionStatus;
    messages: readonly AgentSessionMessageInput[];
    activities?: readonly AgentSessionActivity[];
    turnState?: AgentSessionTurnState;
    error?: string;
    failure?: CodexSessionFailure;
    commandId?: string;
    commandStatus?: "delivering" | "delivery_unknown" | "delivered" | "failed";
    commandError?: string;
    stopConfirmed?: boolean;
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
    // A node may resume an old poll without any intervening console read.
    // Expire the request before accepting its reservation or late result.
    this.failStuckDeliveringCommands();
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
    const incomingTurnState: AgentSessionTurnState = {
      ...(input.turnState?.observedAt ? { observedAt: normalizedSourceTimestamp(input.turnState.observedAt, now, "observedAt")! } : {}),
      ...(input.turnState?.lastProgressAt ? { lastProgressAt: normalizedSourceTimestamp(input.turnState.lastProgressAt, now, "lastProgressAt")! } : {}),
      ...(input.turnState?.turnActive !== undefined ? { turnActive: input.turnState.turnActive } : {}),
      ...(input.turnState?.waitingForInput !== undefined ? { waitingForInput: input.turnState.waitingForInput } : {}),
      ...(input.turnState?.turnStartedAt ? { turnStartedAt: normalizedSourceTimestamp(input.turnState.turnStartedAt, now, "turnStartedAt")! } : {}),
      ...(input.turnState?.lastOutputAt ? { lastOutputAt: normalizedSourceTimestamp(input.turnState.lastOutputAt, now, "lastOutputAt")! } : {}),
      ...(input.turnState?.thinkingStartedAt ? { thinkingStartedAt: normalizedSourceTimestamp(input.turnState.thinkingStartedAt, now, "thinkingStartedAt")! } : {}),
      ...(input.turnState?.thinkingTokens !== undefined ? { thinkingTokens: input.turnState.thinkingTokens } : {}),
      ...(input.turnState?.thinkingDurationSeconds !== undefined ? { thinkingDurationSeconds: input.turnState.thinkingDurationSeconds } : {}),
    };
    const messages = input.messages.filter(isConversationMessage).map((message, position) => ({
      sourceId: requiredText(message.sourceId, "sourceId", 200),
      turnId: message.turnId?.slice(0, 200) || null,
      role: message.role,
      phase: message.phase?.slice(0, 50) || null,
      text: requiredText(message.text, "message text", MAX_MESSAGE_LENGTH, true),
      questionsJson: message.questions ? JSON.stringify(message.questions) : null,
      sourceOccurredAt: normalizedSourceTimestamp(message.occurredAt, now, "message occurredAt"),
      position,
    }));
    const session = this.database.connection
      .prepare(
        `SELECT id, dispatch_id, agent_kind, status, last_error, archived_at, archive_source, activities_json, turn_state_json, activity_at,
                source_restore_pending, activity_repair_pending, created_at
         FROM agent_sessions WHERE id = ? AND node_id = ?`,
      )
      .get(input.sessionId, input.nodeId) as unknown as {
        id: string;
        dispatch_id: string;
        agent_kind: "codex" | "claude_code" | "opencode";
        source_restore_pending: number;
        status: AgentSessionStatus;
        last_error: string | null;
        archived_at: string | null;
        archive_source: "missiongo" | "source" | null;
        activities_json: string;
        turn_state_json: string;
        activity_at: string;
        activity_repair_pending: number;
        created_at: string;
      } | undefined;
    if (!session) throw notFound("Agent session");
    // A turn state an agent did not report means "not reported this time",
    // not "cleared": a degraded snapshot (a Claude unavailable fallback, or
    // any report from an agent without turn instrumentation) must not blank
    // what an earlier healthy report established (AND-223). Fields the input
    // does carry overwrite; fields it omits survive.
    const storedTurnState = session.turn_state_json
      ? JSON.parse(session.turn_state_json) as AgentSessionTurnState
      : {};
    // Permissions need not be the last message: OpenCode can append ordinary
    // forms after them. Derive once during ingestion, not by scanning history
    // on every list poll. A failed empty snapshot retains the last known state.
    const permissionState = ["claude_code", "opencode"].includes(session.agent_kind) && (!input.controlReservation || input.messages.length) && (!input.error || input.messages.length)
      ? { waitingForPermission: hasPendingPermissionQuestion(session.agent_kind, input.messages) } : {};
    // A failed source read may synthesize turnActive=false. Keep the last
    // trustworthy execution state so recovery of the same turn is not progress
    // (AND-438). The unavailable status still reports the connection failure.
    const command = input.commandId && input.commandStatus
      ? this.database.connection.prepare("SELECT status, kind FROM agent_session_commands WHERE id = ? AND session_id = ?")
        .get(input.commandId, input.sessionId) as { status: string; kind: string } | undefined
      : undefined;
    const health = mergeSessionHealth(session.status, storedTurnState, input.status,
      { ...incomingTurnState, ...permissionState }, command ? {
        kind: command.kind, status: input.commandStatus!, previousStatus: command.status,
        acceptedAt: now,
      } : undefined);
    input.status = health.status;
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
    const turnStateJson = JSON.stringify(health.turnState);
    const sourceActivityAt = normalizedSourceTimestamp(input.activityAt, now, "activityAt");
    const error = health.ignoredExecution ? session.last_error
      : storedSessionError(input.error, input.status === "failed" ? input.failure : undefined);
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
    // AND-265: unavailable is a mirror/connection state, not conversation
    // progress. Keep the last task snapshot through an empty error fallback,
    // so receiving it again on recovery also cannot make an old session new.
    const healthy = input.status !== "unavailable";
    const nextActivitiesJson = health.ignoredExecution || (!healthy && activities.length === 0) ? session.activities_json : activitiesJson;
    const activityChanged = (healthy && session.status !== "unavailable" && session.status !== input.status)
      || messagesChanged
      || (healthy && (session.activities_json !== nextActivitiesJson
        || JSON.stringify(executionTurnState(storedTurnState)) !== JSON.stringify(executionTurnState(JSON.parse(turnStateJson) as AgentSessionTurnState))
        || (sourceActivityAt !== undefined && Date.parse(sourceActivityAt) > Date.parse(session.activity_at))
        || archiveChanged
        || (command !== undefined && command.status !== input.commandStatus)));
    let nextActivityAt = activityChanged
      ? new Date(Math.max(Date.parse(session.activity_at) || 0, Date.parse(sourceActivityAt ?? now))).toISOString()
      : session.activity_at;
    let repairPending = session.activity_repair_pending;
    if (repairPending && healthy) {
      // The migration only flags known integration-error reports. Legacy
      // occurred_at can be a poll-time fallback, so never use it as evidence.
      // Recover lazily from the node's actual source clock (or a source-dated
      // report that includes the latest stored message), protecting later user
      // operations with their durable timestamps.
      const latestStored = storedMessages.reduce<typeof storedMessages[number] | undefined>(
        (latest, message) => !latest || message.position > latest.position ? message : latest, undefined,
      );
      const latestSourceMessage = latestStored
        ? messages.find((message) => message.sourceId === latestStored.source_id)?.sourceOccurredAt
        : undefined;
      const sourceClock = sourceActivityAt ?? (input.status !== "active" && activities.length === 0 ? latestSourceMessage : undefined);
      if (sourceClock) {
        const userClock = this.database.connection.prepare(`
          SELECT MAX(stamp) AS stamp FROM (
            SELECT created_at AS stamp FROM agent_session_commands WHERE session_id = ?
            UNION ALL SELECT cancelled_at FROM agent_session_commands WHERE session_id = ?
            UNION ALL SELECT delivered_at FROM agent_session_commands WHERE session_id = ?
          )
        `).get(input.sessionId, input.sessionId, input.sessionId) as { stamp: string | null };
        const progressState = JSON.parse(turnStateJson) as AgentSessionTurnState;
        const taskTimes = (JSON.parse(nextActivitiesJson) as AgentSessionActivity[]).map((activity) => activity.startedAt);
        const stamps = [sourceClock, session.created_at, session.archived_at, userClock.stamp,
          progressState.turnStartedAt, progressState.lastOutputAt, progressState.thinkingStartedAt, ...taskTimes,
          ...messages.map((message) => message.sourceOccurredAt)];
        nextActivityAt = new Date(Math.max(...stamps
          .filter((stamp): stamp is string => Boolean(stamp) && Number.isFinite(Date.parse(stamp!)))
          .map((stamp) => Date.parse(stamp)))).toISOString();
        repairPending = 0;
      } else if (activityChanged) {
        // Fresh progress supersedes the polluted clock; no historical time is
        // invented for a source that does not provide one.
        nextActivityAt = now;
        repairPending = 0;
      }
    }
    this.database.transaction(() => {
      observeMessageTimes(this.database.connection, `dispatch:${session.dispatch_id}`, input.messages, now);
      const previousUnread = this.database.connection.prepare("SELECT unread_at FROM dispatches WHERE id=?")
        .get(session.dispatch_id) as { unread_at: string | null };
      const unreadAt = new Date(Math.max(Date.parse(now), previousUnread.unread_at ? Date.parse(previousUnread.unread_at) + 1 : 0)).toISOString();
      const unreadEvent = observeSessionUnread(this.database, {
        key: `dispatch:${session.dispatch_id}`, previousStatus: session.status, status: input.status, now: unreadAt,
        messages: messages.map(message => ({ ...message, occurredAt: message.sourceOccurredAt,
          questions: message.questionsJson ? JSON.parse(message.questionsJson) : undefined })),
        stored: storedMessages.map(message => ({ sourceId: message.source_id, role: message.role,
          phase: message.phase, occurredAt: message.occurred_at,
          questions: message.questions_json ? JSON.parse(message.questions_json) : undefined })),
      });
      const first = messages.find(message => message.role === "user");
      this.bindStartupStop(input.sessionId, session.agent_kind === "opencode" ? first?.sourceId : first?.turnId ?? undefined);
      this.database.connection
        .prepare(
          `UPDATE agent_sessions
           SET status = ?, last_error = ?, activities_json = ?, turn_state_json = ?, updated_at = ?,
               activity_at = ?, activity_repair_pending = ?
           WHERE id = ?`,
        )
        .run(input.status, error, nextActivitiesJson, turnStateJson, now, nextActivityAt, repairPending, input.sessionId);
      if (unreadEvent) {
        this.database.connection.prepare("UPDATE dispatches SET unread_at = ? WHERE id = ?")
          .run(unreadAt, session.dispatch_id);
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
      // AND-239: an OpenCode poll appends a synthetic `permission-`/`form-`
      // card for each request still pending and never resends one that
      // stopped being — auto-approved at the source, or dismissed. Messages
      // are kept forever, so such a card would wait for a person forever. A
      // healthy poll carries every card still pending, so an open stored card
      // it does not carry is no longer pending: settle it as withdrawn, the
      // way a delivered answer settles one as answered (AND-227). A degraded
      // report — the unavailable fallback carries no messages at all — says
      // nothing about what is pending and settles nothing.
      if (session.agent_kind === "opencode" && input.status !== "unavailable" && messages.length > 0) {
        const reportedSources = new Set(messages.map((message) => message.sourceId));
        const settleWithdrawn = this.database.connection.prepare(
          "UPDATE agent_session_messages SET questions_json = ? WHERE session_id = ? AND source_id = ?",
        );
        for (const stored of storedMessages) {
          const synthetic = stored.source_id.startsWith("permission-") || stored.source_id.startsWith("form-");
          if (!synthetic || reportedSources.has(stored.source_id) || !hasQuestions(stored.questions_json)) continue;
          const questions = JSON.parse(stored.questions_json!) as Array<Record<string, unknown>>;
          settleWithdrawn.run(
            JSON.stringify(questions.map((question) => ({ ...question, withdrawn: true }))),
            input.sessionId,
            stored.source_id,
          );
        }
      }
      if (!health.ignoredExecution) {
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
             delivery_only = NULL,
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
      }
      if (input.commandId && input.commandStatus) {
        const current = this.database.connection
          .prepare("SELECT status, error, kind FROM agent_session_commands WHERE id = ? AND session_id = ?")
          .get(input.commandId, input.sessionId) as unknown as
            { status: AgentSessionCommandStatus; error: string | null; kind: string } | undefined;
        if (!current) {
          throw conflict("agent_reply_changed", "The queued reply no longer matches this session.");
        }
        // The server may have given up on this delivery while the Mac was away
        // (AND-184). A late `delivering` for a command it already failed is
        // moot -- resurrecting it would collide with a new reply's pending slot
        // -- so it is ignored. A late settled report still overwrites the
        // timeout failure, so work the Mac really did finish is not recorded as
        // lost.
        if (current.kind === "interrupt" && input.commandStatus === "delivery_unknown") {
          input.commandStatus = "failed";
          input.commandError = input.commandError || "停止尚未确认：请核实来源后重试。";
        }
        const reaped = current.status === "failed" && current.error === COMMAND_DELIVERY_TIMEOUT_ERROR;
        if (input.commandStatus === "delivering") {
          if (current.kind !== "interrupt") {
            assertDispatchExecution(this.database,session.dispatch_id);
            const stop = this.pendingCommand(input.sessionId);
            if (stop?.kind === "interrupt") throw conflict("agent_stop_pending", "Stop is pending; input was not reserved.");
          }
          const managed = this.managedBinding(input.sessionId);
          if (managed && (managed.stopRequested || managed.state === "unknown" || managed.state === "terminal")) {
            throw conflict("execution_stopped", "Managed input permission is no longer active.");
          }
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
                ? input.commandError?.slice(0, 2_000) || commandDeliveryUnknownError(session.agent_kind)
                : input.commandError?.slice(0, 2_000) || null,
              input.commandStatus === "delivered" ? now : null,
              input.commandId,
              input.sessionId,
              COMMAND_DELIVERY_TIMEOUT_ERROR,
            );
          if (changed.changes === 0) {
            throw conflict("agent_reply_changed", "The queued reply no longer matches this session.");
          }
          if (current.kind === "interrupt" && input.commandStatus === "delivered" && input.stopConfirmed === true) {
            if (input.turnState?.turnActive !== false) throw invalidInput("A confirmed stop needs an ended foreground turn.");
            this.database.connection.prepare("UPDATE agent_session_commands SET stop_confirmed=1 WHERE id=?").run(input.commandId);
            this.database.connection.prepare(`UPDATE agent_session_commands SET status='failed', error=?
              WHERE session_id=? AND kind='message' AND status IN ('queued','delivering','delivery_unknown')
                AND created_at <= (SELECT created_at FROM agent_session_commands WHERE id=?)`)
              .run("当前回合已停止；此回复的执行结果未确认，不会自动重发。", input.sessionId, input.commandId);
          }
          // A pending reply held back the automatic archive; retry now it settled.
          if (input.commandStatus !== "delivery_unknown") {
            autoArchiveFinishedDispatches(this.database, [session.dispatch_id], now);
          }
        }
      }
    });
  }

  /** One bounded upgrade of the current legacy verdict, not a historical reclassification. */
  requestDeliveryAttribution(sessionId: string): boolean {
    const result = this.database.connection.prepare(`UPDATE agent_session_attention
      SET state='pending', delivery_only=0 WHERE session_id=? AND state='needed'
      AND kind='instruction' AND delivery_only IS NULL AND dismissed_message_hash IS NULL`).run(sessionId);
    if (!result.changes) return false;
    if (this.pendingAttention(sessionId)) return true;
    this.database.connection.prepare("UPDATE agent_session_attention SET state='needed' WHERE session_id=?").run(sessionId);
    return false;
  }

  pendingAttention(sessionId: string): { readonly messageHash: string; readonly text: string; readonly truncated?: boolean } | undefined {
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
       FROM agent_session_messages WHERE session_id = ? AND (phase IS NULL OR phase <> 'execution')
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
    return { messageHash: session.message_hash, text: boundedAttentionText(message.text), ...(message.text.length > 20_000 ? { truncated: true } : {}) };
  }

  completeAttention(
    sessionId: string,
    messageHash: string,
    classification: AgentAttentionClassification,
  ): boolean {
    const changed = this.database.connection.prepare(
      `UPDATE agent_session_attention
       SET state = ?, kind = ?, reason = ?, model = ?, updated_at = ?, delivery_only = ?
       WHERE session_id = ? AND message_hash = ? AND state = 'pending'`,
    ).run(
      classification.needsAttention ? "needed" : "not_needed",
      classification.kind === "none" ? null : classification.kind,
      classification.reason,
      classification.model,
      new Date().toISOString(),
      Number(classification.deliveryOnly === true && classification.kind === "instruction"),
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
   * for human verification; other agents retain AND-184's failed timeout.
   * AND-383: consoles poll this path every few seconds, and the timeout used
   * to run its UPDATE statements unconditionally -- a write transaction on
   * every read even with nothing stuck. The cheap existence probe now gates
   * them, so the write only happens when there is work to do; the check
   * itself still runs on every read, keeping AND-184's "check exactly when
   * somebody can see the freed slot" contract. */
  private failStuckDeliveringCommands(now = Date.now()): void {
    const stopCutoff = new Date(now - STOP_COMMAND_TIMEOUT_MS).toISOString();
    // Startup stops also fence a launch. Keep that fence until its native turn
    // is bound; expiring it could silently permit the cancelled work to start.
    const stopPending = this.database.connection.prepare(`SELECT 1 FROM agent_session_commands
      WHERE kind='interrupt' AND ((status='queued' AND turn_id<>'startup' AND created_at<=?)
        OR (status='delivering' AND COALESCE(delivering_at,created_at)<=?)) LIMIT 1`).get(stopCutoff, stopCutoff);
    if (stopPending) {
      this.database.connection.prepare(`UPDATE agent_session_commands SET status='failed',error=?
        WHERE kind='interrupt' AND status='queued' AND turn_id<>'startup' AND created_at<=?`)
        .run("停止尚未确认：节点在 2 分钟内未接收请求。请检查节点连接，在来源客户端核实后重试。", stopCutoff);
      this.database.connection.prepare(`UPDATE agent_session_commands SET status='failed',error=?
        WHERE kind='interrupt' AND status='delivering' AND COALESCE(delivering_at,created_at)<=?`)
        .run("停止尚未确认：节点在 2 分钟内未回报结果。请在来源客户端核实后重试。", stopCutoff);
    }
    const cutoff = new Date(now - COMMAND_DELIVERING_TIMEOUT_MS).toISOString();
    const stuck = this.database.connection
      .prepare(
        `SELECT 1 FROM agent_session_commands
         WHERE status = 'delivering' AND COALESCE(delivering_at, created_at) <= ? LIMIT 1`,
      )
      .get(cutoff);
    if (!stuck) return;
    const affected = this.database.connection
      .prepare(
        `SELECT DISTINCT s.dispatch_id AS dispatch_id
         FROM agent_session_commands c JOIN agent_sessions s ON s.id = c.session_id
         WHERE c.status = 'delivering' AND s.agent_kind != 'codex'
           AND COALESCE(c.delivering_at, c.created_at) <= ?`,
      )
      .all(cutoff) as unknown as Array<{ dispatch_id: string }>;
    this.database.connection.prepare(`UPDATE agent_session_commands SET status='failed',error=?
      WHERE kind='interrupt' AND status='delivering' AND COALESCE(delivering_at,created_at)<=?`)
      .run("停止尚未确认：节点没有回报结果，请核实来源后重试。", cutoff);
    this.database.connection.prepare(
      `UPDATE agent_session_commands SET status = 'delivery_unknown', error = ?
       WHERE status = 'delivering' AND COALESCE(delivering_at, created_at) <= ?
         AND session_id IN (SELECT id FROM agent_sessions WHERE agent_kind = 'codex')`,
    ).run(commandDeliveryUnknownError("codex"), cutoff);
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
        `SELECT id, kind, text, turn_id, stop_confirmed, status, error, created_at, delivered_at, delivering_at, cancelled_at
         FROM agent_session_commands
         WHERE session_id = ? AND status IN ('queued', 'delivering', 'delivery_unknown')
         ORDER BY kind = 'interrupt' DESC, created_at DESC, rowid DESC LIMIT 1`,
      )
      .get(sessionId) as unknown as CommandRow | undefined;
  }

  private itemsCompleted(sessionId: string): boolean {
    if (this.database.connection.prepare(`SELECT 1 FROM agent_sessions s JOIN free_session_starts f
      ON f.dispatch_id=s.dispatch_id WHERE s.id=?`).get(sessionId)) return false;
    const rows = this.database.connection.prepare(
      `SELECT w.status FROM agent_sessions s
       JOIN dispatch_items di ON di.dispatch_id = s.dispatch_id
       JOIN work_items w ON w.id = di.item_id
       WHERE s.id = ?`,
    ).all(sessionId) as unknown as Array<{ status: string }>;
    return rows.length > 0 && rows.every((row) => row.status === "done");
  }

  private latestStop(sessionId: string): CommandRow | undefined {
    return this.database.connection.prepare(`SELECT * FROM agent_session_commands WHERE session_id=? AND kind='interrupt'
      ORDER BY created_at DESC,rowid DESC LIMIT 1`).get(sessionId) as unknown as CommandRow | undefined;
  }

  private latestCommand(sessionId: string): CommandRow | undefined {
    return this.database.connection
      .prepare(
        `SELECT id, kind, text, turn_id, stop_confirmed, status, error, created_at, delivered_at, delivering_at, cancelled_at
         FROM agent_session_commands WHERE session_id = ? ORDER BY CASE WHEN status IN ('queued','delivering','delivery_unknown') THEN CASE WHEN kind='interrupt' THEN 0 ELSE 1 END ELSE 2 END, created_at DESC, rowid DESC LIMIT 1`,
      )
      .get(sessionId) as unknown as CommandRow | undefined;
  }

  private mapCommand(row: CommandRow, metadata?: CommandMetadata): AgentSessionCommand {
    const attachments = metadata ? metadata.attachments.get(row.id) ?? [] : this.attachments?.listForCommand(row.id) ?? [];
    const sourceMessageId = metadata ? metadata.sources.get(row.id) : (row.kind === "message" ? commandSourceMessage(this.database.connection, row.id).sourceMessageId : undefined);
    const revision = metadata ? metadata.revisions.get(row.id) : new ImplementationPlans(this.database).commandRevision(row.id);
    return {
      id: row.id,
      kind: row.kind,
      ...(row.kind === "message" && sourceMessageId ? {sourceMessageId} : {}),
      text: row.text,
      ...(revision ? { planApprovalRevision: revision } : {}),
      ...(attachments.length ? { attachments } : {}),
      ...(row.turn_id ? { turnId: row.turn_id } : {}),
      ...(row.kind === "interrupt" && row.stop_confirmed === 1 ? { stopConfirmed: true } : {}),
      status: row.status,
      ...(row.error ? { error: row.error } : {}),
      createdAt: row.created_at,
      ...(row.delivered_at ? { deliveredAt: row.delivered_at } : {}),
      ...(row.delivering_at ? { deliveringAt: row.delivering_at } : {}),
      ...(row.cancelled_at ? { cancelledAt: row.cancelled_at } : {}),
    };
  }
}
