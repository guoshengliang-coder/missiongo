import type { AgentSessionSummary } from "./types";

export type AgentSessionReadState = Readonly<Record<string, string>>;

export function parseAgentSessionReadState(value: string | null): AgentSessionReadState {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(Object.entries(parsed).filter((entry): entry is [string, string] =>
      typeof entry[1] === "string"));
  } catch {
    return {};
  }
}

export function isAgentSessionUnread(session: Pick<AgentSessionSummary, "id" | "activityKey">, state: AgentSessionReadState): boolean {
  return state[session.id] !== session.activityKey;
}

export function markAgentSessionRead(
  session: Pick<AgentSessionSummary, "id" | "activityKey">,
  state: AgentSessionReadState,
): AgentSessionReadState {
  if (state[session.id] === session.activityKey) return state;
  return { ...state, [session.id]: session.activityKey };
}

export function agentSessionReadStorageKey(productId: string): string {
  return `missiongo.agent-console.read.v1:${productId}`;
}
