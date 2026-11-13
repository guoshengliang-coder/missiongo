import type { QueryClient } from "@tanstack/react-query";
import { api, ApiError } from "./api";
import { canonicalAgentSessionId } from "./agent-session-view";
import type { AgentSessionSummary } from "./types";

export function isSessionAccessError(error: unknown): error is ApiError {
  return error instanceof ApiError && [401, 403, 404].includes(error.status);
}

/** Drop content while retaining the denied query's error and retry controls.
 * Removing an observed query would recreate it and restart the denied read. */
export function clearDeniedSession(client: QueryClient, sessionId: string) {
  client.getQueryCache().find({ queryKey: ["agent-session", sessionId], exact: true })
    ?.setState({ data: undefined });
  client.removeQueries({ predicate: query =>
    ["agent-history-result", "artifact-request", "artifact-state", "artifact-bundle",
      "plan-overview", "plan-records", "plan-record", "plan-record-parent"]
      .includes(String(query.queryKey[0])) && query.queryKey[1] === sessionId });
}

export type SessionRecoveryResult = { kind: "ready" | "sync_pending" }
  | { kind: "unavailable"; error: ApiError };

/** A bounded, read-only recovery. List membership alone is never an access check. */
export async function recoverAgentSession(client: QueryClient, sessionId: string, signal: AbortSignal): Promise<SessionRecoveryResult> {
  const check = () => { if (signal.aborted) throw new DOMException("Recovery cancelled", "AbortError"); };
  const refresh = async () => {
    const page = await client.fetchQuery({
      queryKey: ["agent-sessions"],
      queryFn: ({ signal }) => api.listAgentSessions(undefined, signal),
      staleTime: 0, retry: false,
    });
    check();
    const canonical = canonicalAgentSessionId(sessionId, page.sessions);
    return page.sessions.some((row: AgentSessionSummary) => row.id === canonical);
  };
  try {
    if (await refresh()) return { kind: "ready" };
    // Do not seed the transcript cache: detail access does not provide all the
    // summary fields needed to render controls or invent a missing list row.
    await api.getAgentSession(sessionId, signal);
    check();
    return { kind: await refresh() ? "ready" : "sync_pending" };
  } catch (error) {
    check();
    if (!isSessionAccessError(error)) throw error;
    clearDeniedSession(client, sessionId);
    return { kind: "unavailable", error };
  }
}
