import type { AgentSessionMessage, AgentSessionStatus } from "./types";

export const DEFAULT_AGENT_SESSION_FILTER = "all" as const;
export const MESSAGE_BOTTOM_THRESHOLD_PX = 48;

export interface ScrollMetrics {
  readonly scrollHeight: number;
  readonly scrollTop: number;
  readonly clientHeight: number;
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

export function messageLabelKey(
  role: AgentSessionMessage["role"],
): "agentSessionPlan" | "agentSessionCodex" | null {
  if (role === "user") return null;
  return role === "plan" ? "agentSessionPlan" : "agentSessionCodex";
}

export function activityLabelKey(status: AgentSessionStatus, replyQueued = false):
  | "agentSessionActivityActive"
  | "agentSessionActivityIdle"
  | "agentSessionActivityUnavailable"
  | "agentSessionActivityUnavailableQueued"
  | "agentSessionActivityFailed" {
  if (status === "active") return "agentSessionActivityActive";
  if (status === "idle") return "agentSessionActivityIdle";
  if (status === "failed") return "agentSessionActivityFailed";
  return replyQueued ? "agentSessionActivityUnavailableQueued" : "agentSessionActivityUnavailable";
}
