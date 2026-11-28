import type { Query, QueryKey } from "@tanstack/react-query";
import { ApiError } from "./api";

export function consoleReadKind(key: QueryKey) {
  if (key[0] === "agent-sessions") return "session_list";
  if (key[0] === "merge-deliveries" && typeof key[2] === "string" && key[2] !== "queue" && key[2] !== "preview") return "session_delivery";
  return undefined;
}

function failureKind(error: unknown) {
  if (error instanceof ApiError) {
    return error.status === 408 || error.status === 429 || error.status >= 500 ? "temporary_http" : "http";
  }
  if (error instanceof DOMException && error.name === "TimeoutError") return "timeout";
  if (error instanceof DOMException && error.name === "AbortError") return "cancelled";
  return error instanceof TypeError ? "network" : "unknown";
}

export function isConsoleReadRecoveryCandidate(query: Query) {
  return Boolean(query.isActive() && consoleReadKind(query.queryKey) &&
    (query.state.fetchStatus === "fetching" || isFailedConsoleRead(query)));
}

export function isFailedConsoleRead(query: Query) {
  if (!query.isActive() || query.state.status !== "error" || query.state.fetchStatus !== "idle") return false;
  const failure = failureKind(query.state.error);
  return failure === "timeout" || failure === "network" || failure === "temporary_http";
}

const diagnostics: Record<string, string | number>[] = [];

function record(values: Record<string, string | number>) {
  if (typeof document === "undefined") return;
  diagnostics.push({ at: Date.now(), visibility: document.visibilityState, ...values });
  if (diagnostics.length > 16) diagnostics.shift();
}

export function recordConsoleReadEvent(event: "hidden" | "visible" | "online" | "offline" | "stream_connected") {
  record({ event });
}

export function consoleReadDiagnostics() {
  return diagnostics.length ? JSON.stringify(diagnostics) : undefined;
}

export function clearConsoleReadDiagnostics() {
  diagnostics.length = 0;
}

export async function observeConsoleRead<T>(kind: "session_list" | "session_delivery", read: () => Promise<T>, signal?: AbortSignal) {
  const started = performance.now();
  let result: string = "success";
  try {
    return await read();
  } catch (error) {
    result = signal?.aborted ? "cancelled" : failureKind(error);
    throw error;
  } finally {
    record({ read: kind, durationMs: Math.round(performance.now() - started), result });
  }
}
