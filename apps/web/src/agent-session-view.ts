import type { AgentKind } from "@missiongo/domain";

import type {
  AgentSessionCommand,
  AgentSessionMessage,
  AgentSessionQuestion,
  AgentSessionReplyBlockedReason,
  AgentSessionStatus,
  AgentSessionSummary,
} from "./types";

export const DEFAULT_AGENT_SESSION_FILTER = "attention" as const;
export const DEFAULT_AGENT_KIND_FILTER = "all" as const;
export const MESSAGE_BOTTOM_THRESHOLD_PX = 48;
export const AGENT_SESSIONS_CONSOLE_REFETCH_MS = 5_000;
export const AGENT_SESSIONS_BACKGROUND_REFETCH_MS = 60_000;
export const AGENT_SESSION_DETAIL_REFETCH_MS = 2_000;
export const AGENT_SESSION_MAX_BACKOFF_MS = 5 * 60_000;

function backedOffInterval(base: number, failureCount: number): number {
  return Math.min(base * (2 ** Math.min(Math.max(failureCount, 0), 8)), AGENT_SESSION_MAX_BACKOFF_MS);
}

export function agentSessionsRefetchInterval(
  consoleOpen: boolean,
  documentVisible = true,
  failureCount = 0,
): number | false {
  if (!documentVisible) return false;
  const base = consoleOpen ? AGENT_SESSIONS_CONSOLE_REFETCH_MS : AGENT_SESSIONS_BACKGROUND_REFETCH_MS;
  return backedOffInterval(base, failureCount);
}

export function agentSessionDetailRefetchInterval(documentVisible: boolean, failureCount = 0): number | false {
  if (!documentVisible) return false;
  return backedOffInterval(AGENT_SESSION_DETAIL_REFETCH_MS, failureCount);
}

export function formatAgentMessageTime(value: string, locale: string, now = new Date()): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const time = new Intl.DateTimeFormat(locale, {
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const startOfDate = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const dayDifference = Math.round((startOfToday.getTime() - startOfDate.getTime()) / 86_400_000);
  if (dayDifference === 0) return time;
  if (dayDifference === 1) {
    const yesterday = new Intl.RelativeTimeFormat(locale, { numeric: "auto" }).format(-1, "day");
    return `${yesterday} ${time}`;
  }
  const calendarDate = new Intl.DateTimeFormat(locale, {
    month: "numeric",
    day: "numeric",
  }).format(date);
  return `${calendarDate} ${time}`;
}

export type AgentSessionFilter = "attention" | "active" | "all" | "failed" | "archived";
export type AgentKindFilter = "all" | AgentKind;

export function isAbnormalAgentSession(session: Pick<AgentSessionSummary, "status" | "command">): boolean {
  return session.status === "failed" || session.command?.status === "failed";
}

export function replyBlockedLabelKey(reason: AgentSessionReplyBlockedReason | undefined):
  | "agentSessionWorkFinishedReadOnly"
  | "agentSessionArchivedReadOnly"
  | "agentSessionSourceArchivedReadOnly"
  | "agentNodeRevokedReadOnly"
  | "agentSessionOperateReadOnly"
  | "agentSessionReadOnly"
  | "agentSessionUnavailableReadOnly" {
  if (reason === "work_finished") return "agentSessionWorkFinishedReadOnly";
  if (reason === "archived") return "agentSessionArchivedReadOnly";
  if (reason === "source_archived") return "agentSessionSourceArchivedReadOnly";
  if (reason === "node_revoked") return "agentNodeRevokedReadOnly";
  if (reason === "operate_permission") return "agentSessionOperateReadOnly";
  if (reason === "ai_permission") return "agentSessionReadOnly";
  return "agentSessionUnavailableReadOnly";
}

type FilterableAgentSession = Pick<
  AgentSessionSummary,
  | "id"
  | "agentKind"
  | "archivedAt"
  | "status"
  | "command"
  | "needsAttention"
  | "nodeName"
  | "sessionName"
  | "latestMessage"
  | "items"
>;

type AttentionCountableSession = Pick<
  AgentSessionSummary,
  "id" | "archivedAt" | "needsAttention" | "items"
>;

export interface AgentAttentionCounts {
  readonly total: number;
  readonly byProduct: ReadonlyMap<string, number>;
}

export function archivableVisibleSessionIds(
  sessions: readonly Pick<AgentSessionSummary, "id" | "canArchive" | "archivedAt" | "archivedSource">[],
): readonly string[] {
  return sessions
    .filter((session) => session.canArchive && !session.archivedAt && session.archivedSource !== "source")
    .map((session) => session.id);
}

/**
 * One conversation can cover items from several products. Count it once in the
 * global badge, and once for each distinct product it reaches. Repeated items
 * from the same product must not inflate that product's badge.
 */
export function agentAttentionCounts(
  sessions: readonly AttentionCountableSession[],
): AgentAttentionCounts {
  const globalSessionIds = new Set<string>();
  const productSessionIds = new Map<string, Set<string>>();
  for (const session of sessions) {
    if (session.archivedAt || !session.needsAttention) continue;
    globalSessionIds.add(session.id);
    for (const productId of new Set(session.items.map((item) => item.productId))) {
      const sessionIds = productSessionIds.get(productId) ?? new Set<string>();
      sessionIds.add(session.id);
      productSessionIds.set(productId, sessionIds);
    }
  }
  return {
    total: globalSessionIds.size,
    byProduct: new Map([...productSessionIds].map(([productId, sessionIds]) => [productId, sessionIds.size])),
  };
}

export function agentSessionMatches(
  session: FilterableAgentSession,
  filter: AgentSessionFilter,
  agentFilter: AgentKindFilter,
  search: string,
): boolean {
  if (filter === "archived") {
    if (!session.archivedAt) return false;
  } else if (session.archivedAt) return false;
  if (agentFilter !== "all" && session.agentKind !== agentFilter) return false;
  if (filter === "attention" && !session.needsAttention) return false;
  if (filter === "active" && session.status !== "active") return false;
  if (filter === "failed" && !isAbnormalAgentSession(session)) return false;
  if (filter === "all" && isAbnormalAgentSession(session)) return false;
  const query = search.trim().toLocaleLowerCase();
  if (!query) return true;
  return [
    session.nodeName,
    session.sessionName ?? "",
    session.latestMessage?.text ?? "",
    ...session.items.flatMap((item) => [item.key, item.title]),
  ].some((value) => value.toLocaleLowerCase().includes(query));
}

/** Unread is a badge, never an ordering input. Activity is the only clock. */
export function byLatestActivity<T extends Pick<AgentSessionSummary, "id" | "activityAt" | "updatedAt" | "createdAt">>(
  sessions: readonly T[],
): readonly T[] {
  return [...sessions].sort((left, right) => {
    const leftTime = Date.parse(left.activityAt ?? left.updatedAt ?? left.createdAt);
    const rightTime = Date.parse(right.activityAt ?? right.updatedAt ?? right.createdAt);
    const compared = (Number.isNaN(rightTime) ? 0 : rightTime) - (Number.isNaN(leftTime) ? 0 : leftTime);
    return compared || left.id.localeCompare(right.id);
  });
}

/**
 * Only a conversation the person opened is marked read, and only while the tab
 * is in front. Merely being first in the list is not reading it.
 */
export function shouldMarkRead(
  session: Pick<AgentSessionSummary, "unread" | "unreadAt"> | undefined,
  openedByPerson: boolean,
  documentVisible: boolean,
): session is Pick<AgentSessionSummary, "unread"> & { readonly unreadAt: string } {
  return Boolean(session?.unread && session.unreadAt && openedByPerson && documentVisible);
}

export interface ScrollMetrics {
  readonly scrollHeight: number;
  readonly scrollTop: number;
  readonly clientHeight: number;
}

export interface OutgoingReply {
  readonly text: string;
  readonly occurredAt: string;
  readonly status: "sending" | "queued" | "delivering" | "failed";
  readonly error?: string;
  readonly commandId?: string;
}

/**
 * The POST starts before MissionGo has a command id. Once it does, the mirrored
 * command carries the same bubble through queueing and delivery. Delivered
 * replies disappear here because the same node snapshot contains the real user
 * message; cancelled replies return to the editor instead of lingering.
 */
export function outgoingReply(
  command: AgentSessionCommand | undefined,
  request?: { readonly text: string; readonly occurredAt: string; readonly status: "sending" | "failed"; readonly error?: string },
): OutgoingReply | null {
  if (request) return request;
  if (!command || command.kind !== "message") return null;
  if (command.status !== "queued" && command.status !== "delivering" && command.status !== "failed") return null;
  return {
    text: command.text,
    occurredAt: command.createdAt,
    status: command.status,
    ...(command.error ? { error: command.error } : {}),
    commandId: command.id,
  };
}

/**
 * A one-pane conversation is mounted and populated while its list is visible.
 * Opening that already-selected conversation therefore needs the same reset as
 * selecting a different session, even though its id and messages did not
 * change in that render.
 */
export function shouldResetMessageView(
  sessionChanged: boolean,
  conversationWasOpen: boolean,
  conversationOpen: boolean,
): boolean {
  return sessionChanged || (!conversationWasOpen && conversationOpen);
}

/**
 * Keep the conversation a person is reading even when a live status update
 * moves it out of the current list filter. The selection is cleared only when
 * the session itself is gone, or by an explicit navigation/filter action.
 * Before the first response, absence from the empty array proves nothing and
 * must not erase state restored after an Android Activity recreation.
 */
export function resolvedAgentSessionId(
  requestedId: string | null,
  availableIds: readonly string[],
  loaded: boolean,
): string | null {
  if (requestedId && (!loaded || availableIds.includes(requestedId))) return requestedId;
  return null;
}

/** Small rounding differences must not make a conversation stop following. */
export function isNearMessageBottom(
  metrics: ScrollMetrics,
  threshold = MESSAGE_BOTTOM_THRESHOLD_PX,
): boolean {
  return metrics.scrollHeight - metrics.scrollTop - metrics.clientHeight <= threshold;
}

/**
 * A reply the person just sent is their own action, so the newest content must
 * come into view even if they had scrolled up through history. Messages that
 * merely arrive keep respecting the follow-latest position: scrolling up is a
 * request to read something else, not an invitation to be pulled back down.
 */
export function shouldScrollMessagesAfterChange(outgoingChanged: boolean, followLatest: boolean): boolean {
  return outgoingChanged || followLatest;
}

/**
 * A streamed answer keeps its id while its text grows. Treat that as one unseen
 * message, while a later snapshot of the same text changes nothing.
 */
export function changedMessageIds(
  previous: readonly Pick<AgentSessionMessage, "id" | "text">[],
  next: readonly Pick<AgentSessionMessage, "id" | "text">[],
): readonly string[] {
  const previousText = new Map(previous.map((message) => [message.id, message.text]));
  return next
    .filter((message) => previousText.get(message.id) !== message.text)
    .map((message) => message.id);
}

/** The label a reply line is written under. OpenCode form fields answer by
 * key; Claude and Codex questions answer by header or title. */
export function questionAnswerLabel(
  question: Pick<AgentSessionQuestion, "header" | "title" | "key">,
): string {
  return question.key ?? question.header ?? question.title;
}

/** The separator between several chosen values of one multi-select field. */
export const QUESTION_VALUE_SEPARATOR = "、";

/** Build the plain-text answer format understood by the host prompts. A single
 * key-less question is answered with the option alone; a keyed field always
 * carries its label so the answer routes back to the right form field. */
export function questionAnswerText(
  current: string,
  question: Pick<AgentSessionQuestion, "header" | "title" | "key">,
  option: string,
  questionCount: number,
): string {
  if (questionCount <= 1 && !question.key) return option;
  const prefix = `${questionAnswerLabel(question)}: `;
  const lines = current.split("\n").filter(Boolean);
  const next = lines.filter((line) => !line.startsWith(prefix));
  next.push(`${prefix}${option}`);
  return next.join("\n");
}

/** The single value already written for one question, without splitting it; a
 * free-text field may itself contain the multi-select separator. */
export function questionAnswerValue(
  current: string,
  question: Pick<AgentSessionQuestion, "header" | "title" | "key">,
): string {
  const prefix = `${questionAnswerLabel(question)}: `;
  const line = current.split("\n").find((entry) => entry.startsWith(prefix));
  return line ? line.slice(prefix.length) : "";
}

/** The values already written for one question, so a multi-select field can
 * toggle against what the reply currently says. */
export function questionAnswerValues(
  current: string,
  question: Pick<AgentSessionQuestion, "header" | "title" | "key">,
): string[] {
  return questionAnswerValue(current, question)
    .split(QUESTION_VALUE_SEPARATOR)
    .map((value) => value.trim())
    .filter(Boolean);
}

/** Toggle one option of a multi-select field, keeping the other answers. */
export function toggleQuestionOption(
  current: string,
  question: Pick<AgentSessionQuestion, "header" | "title" | "key">,
  option: string,
  questionCount: number,
): string {
  const selected = questionAnswerValues(current, question);
  const next = selected.includes(option)
    ? selected.filter((value) => value !== option)
    : [...selected, option];
  if (next.length === 0) {
    const prefix = `${questionAnswerLabel(question)}: `;
    return current.split("\n").filter((line) => line && !line.startsWith(prefix)).join("\n");
  }
  return questionAnswerText(current, question, next.join(QUESTION_VALUE_SEPARATOR), questionCount);
}

export function messageLabelKey(
  role: AgentSessionMessage["role"],
  agentKind: AgentKind = "codex",
): "agentSessionPlan" | "agentSessionCodex" | "agentClaudeCode" | "agentOpenCode" | null {
  if (role === "user") return null;
  if (role === "plan") return "agentSessionPlan";
  return agentKind === "claude_code" ? "agentClaudeCode" : agentKind === "opencode" ? "agentOpenCode" : "agentSessionCodex";
}

export function activityLabelKey(status: AgentSessionStatus, replyQueued = false):
  | "agentSessionActivityActive"
  | "agentSessionActivityIdle"
  | "agentSessionActivityUnavailable"
  | "agentSessionActivityUnavailableQueued"
  | "agentSessionActivityFailed"
  | "agentSessionActivitySuspended"
  | "agentSessionActivityStalled" {
  if (status === "active") return "agentSessionActivityActive";
  if (status === "idle") return "agentSessionActivityIdle";
  if (status === "suspended") return "agentSessionActivitySuspended";
  if (status === "stalled") return "agentSessionActivityStalled";
  if (status === "failed") return "agentSessionActivityFailed";
  return replyQueued ? "agentSessionActivityUnavailableQueued" : "agentSessionActivityUnavailable";
}
