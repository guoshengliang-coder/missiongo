import type { AgentKind } from "@missiongo/domain";

import { isAgentSessionUnread, type AgentSessionReadState } from "./agent-session-unread";
import type {
  AgentSessionCommand,
  AgentSessionMessage,
  AgentSessionQuestion,
  AgentSessionStatus,
  AgentSessionSummary,
} from "./types";

export const DEFAULT_AGENT_SESSION_FILTER = "all" as const;
export const DEFAULT_AGENT_KIND_FILTER = "all" as const;
export const MESSAGE_BOTTOM_THRESHOLD_PX = 48;

export type AgentSessionFilter = "unread" | "attention" | "active" | "all" | "failed" | "archived";
export type AgentKindFilter = "all" | AgentKind;

type FilterableAgentSession = Pick<
  AgentSessionSummary,
  | "id"
  | "activityKey"
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

export function agentSessionMatches(
  session: FilterableAgentSession,
  filter: AgentSessionFilter,
  agentFilter: AgentKindFilter,
  search: string,
  readState: AgentSessionReadState,
  retainedReadSessionId: string | null = null,
): boolean {
  if (filter === "archived") {
    if (!session.archivedAt) return false;
  } else if (session.archivedAt) return false;
  if (agentFilter !== "all" && session.agentKind !== agentFilter) return false;
  if (filter === "unread"
    && session.id !== retainedReadSessionId
    && !isAgentSessionUnread(session, readState)) return false;
  if (filter === "attention" && !session.needsAttention) return false;
  if (filter === "active" && session.status !== "active") return false;
  if (filter === "failed" && session.status !== "failed" && session.command?.status !== "failed") return false;
  const query = search.trim().toLocaleLowerCase();
  if (!query) return true;
  return [
    session.nodeName,
    session.sessionName ?? "",
    session.latestMessage?.text ?? "",
    ...session.items.flatMap((item) => [item.key, item.title]),
  ].some((value) => value.toLocaleLowerCase().includes(query));
}

export function retainedReadSessionAfterSelection(
  filter: AgentSessionFilter,
  session: Pick<AgentSessionSummary, "id" | "activityKey">,
  readState: AgentSessionReadState,
  current: string | null,
): string | null {
  if (filter !== "unread") return null;
  return session.id === current || isAgentSessionUnread(session, readState) ? session.id : null;
}

export interface ScrollMetrics {
  readonly scrollHeight: number;
  readonly scrollTop: number;
  readonly clientHeight: number;
}

export interface OutgoingReply {
  readonly text: string;
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
  request?: { readonly text: string; readonly status: "sending" | "failed"; readonly error?: string },
): OutgoingReply | null {
  if (request) return request;
  if (!command || command.kind !== "message") return null;
  if (command.status !== "queued" && command.status !== "delivering" && command.status !== "failed") return null;
  return {
    text: command.text,
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
 * Keep a URL-restored conversation until the session list has actually loaded.
 * Before that response, absence from the empty array proves nothing and must
 * not erase the state that survived an Android Activity recreation.
 */
export function resolvedAgentSessionId(
  requestedId: string | null,
  visibleIds: readonly string[],
  loaded: boolean,
): string | null {
  if (requestedId && (!loaded || visibleIds.includes(requestedId))) return requestedId;
  return visibleIds[0] ?? null;
}

/** Small rounding differences must not make a conversation stop following. */
export function isNearMessageBottom(
  metrics: ScrollMetrics,
  threshold = MESSAGE_BOTTOM_THRESHOLD_PX,
): boolean {
  return metrics.scrollHeight - metrics.scrollTop - metrics.clientHeight <= threshold;
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

/** Build the plain-text answer format understood by Claude's host prompt. */
export function questionAnswerText(
  current: string,
  question: Pick<AgentSessionQuestion, "header" | "title">,
  option: string,
  questionCount: number,
): string {
  if (questionCount <= 1) return option;
  const label = question.header ?? question.title;
  const prefix = `${label}: `;
  const lines = current.split("\n").filter(Boolean);
  const next = lines.filter((line) => !line.startsWith(prefix));
  next.push(`${prefix}${option}`);
  return next.join("\n");
}

export function messageLabelKey(
  role: AgentSessionMessage["role"],
  agentKind: AgentKind = "codex",
): "agentSessionPlan" | "agentSessionCodex" | "agentClaudeCode" | null {
  if (role === "user") return null;
  if (role === "plan") return "agentSessionPlan";
  return agentKind === "claude_code" ? "agentClaudeCode" : "agentSessionCodex";
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
