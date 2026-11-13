/** Content-free, bounded observability. These intervals overlap; never add them. */
export const PERFORMANCE_STAGES = ["send_started", "logical_accepted", "list_read", "detail_read", "http_attempt", "prepare", "upload", "submit", "start", "node_received", "native_delivery", "agent_first_output", "reply_visible", "background_wait", "cache_visible", "fresh_visible", "detail_cache_visible", "detail_fresh_visible", "missing"] as const;
export const PERFORMANCE_RESULTS = ["success", "rejected", "network_failure", "timeout", "unconfirmed", "cancelled", "unsupported", "uncorrelated", "process_restart", "expired", "hidden", "no_cache"] as const;
export type PerformanceStage = typeof PERFORMANCE_STAGES[number];
export type PerformanceResult = typeof PERFORMANCE_RESULTS[number];
export interface ConsolePerformanceEvent {
  id: string; stage: PerformanceStage; result: PerformanceResult; durationMs?: number;
}
export const PERFORMANCE_BUCKETS = [1, 4, 16, 64, 256, 1000, 4000, 16000, 60000, 240000, 900000, 3600000, 86400000] as const;
export function validPerformanceEvent(input: unknown): input is ConsolePerformanceEvent {
  if (!input || typeof input !== "object" || Array.isArray(input)) return false;
  const e = input as Record<string, unknown>;
  return Object.keys(e).every(k => ["id", "stage", "result", "durationMs"].includes(k))
    && typeof e.id === "string" && /^[a-zA-Z0-9:._-]{1,160}$/.test(e.id)
    && PERFORMANCE_STAGES.includes(e.stage as PerformanceStage) && PERFORMANCE_RESULTS.includes(e.result as PerformanceResult)
    && (e.durationMs === undefined || (typeof e.durationMs === "number" && Number.isFinite(e.durationMs) && e.durationMs >= 0 && e.durationMs <= 86400000));
}
/** A new response must have an exact turn binding; message order/text/time are not evidence. */
export function firstPerformanceReply(messages: readonly { role: string; turnId?: string; historical?: boolean }[], turnId?: string): boolean {
  return Boolean(turnId && messages.some(m => !m.historical && m.turnId === turnId && (m.role === "agent" || m.role === "plan")));
}
