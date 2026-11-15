/** Content-free, bounded observability. These intervals overlap; never add them. */
export const PERFORMANCE_STAGES = ["send_started", "logical_accepted", "list_read", "detail_read", "http_attempt", "prepare", "upload", "submit", "start", "node_received", "native_delivery", "agent_first_output", "reply_visible", "background_wait", "cache_visible", "fresh_visible", "detail_cache_visible", "detail_fresh_visible", "missing", "list_visit", "list_visit_end", "list_view", "list_request", "list_server", "list_cache_visible", "list_fresh_visible", "list_entry_fresh_visible"] as const;
export const PERFORMANCE_RESULTS = ["success", "rejected", "network_failure", "timeout", "unconfirmed", "cancelled", "unsupported", "uncorrelated", "process_restart", "expired", "hidden", "no_cache", "inflight_at_entry", "no_refresh", "unknown"] as const;
export type PerformanceStage = typeof PERFORMANCE_STAGES[number];
export type PerformanceResult = typeof PERFORMANCE_RESULTS[number];
export interface ConsolePerformanceEvent {
  id: string; stage: PerformanceStage; result: PerformanceResult; durationMs?: number; list?: ListObservation;
}
export const PERFORMANCE_BUCKETS = [1, 4, 16, 64, 256, 1000, 4000, 16000, 60000, 240000, 900000, 3600000, 86400000] as const;
export function validPerformanceEvent(input: unknown): input is ConsolePerformanceEvent {
  if (!input || typeof input !== "object" || Array.isArray(input)) return false;
  const e = input as Record<string, unknown>;
  return Object.keys(e).every(k => ["id", "stage", "result", "durationMs", "list"].includes(k))
    && typeof e.id === "string" && /^[a-zA-Z0-9:._-]{1,160}$/.test(e.id)
    && PERFORMANCE_STAGES.includes(e.stage as PerformanceStage) && PERFORMANCE_RESULTS.includes(e.result as PerformanceResult)
    && (e.list === undefined ? (!String(e.stage).startsWith("list_") || e.stage==="list_read") : (validListObservation(e.list) && String(e.stage).startsWith("list_") && e.stage!=="list_read"))
    && (e.durationMs === undefined || (typeof e.durationMs === "number" && Number.isFinite(e.durationMs) && e.durationMs >= 0 && e.durationMs <= 86400000));
}
/** A new response must have an exact turn binding; message order/text/time are not evidence. */
export function firstPerformanceReply(messages: readonly { role: string; turnId?: string; historical?: boolean }[], turnId?: string): boolean {
  return Boolean(turnId && messages.some(m => !m.historical && m.turnId === turnId && (m.role === "agent" || m.role === "plan")));
}

/** Only finite categories and bounded numeric measurements. Never UA, content or device identity. */
export const LIST_DEVICES = ["phone", "pc", "unknown"] as const;
export const LIST_SCENARIOS = ["first_entry", "cache_return", "background_resume", "unknown"] as const;
export interface ListObservation {
  protocol: 1;
  device: typeof LIST_DEVICES[number];
  scenario: typeof LIST_SCENARIOS[number];
  dataset: "account_feed" | "project_view";
  visitId?: string;
  rows?: number;
  renderedRows?: number;
  responseBytes?: number;
  transferBytes?: number;
  requests?: number;
  refreshes?: number;
}
export const LIST_MEASURE_LIMITS = {rows:1000000, renderedRows:1000000, responseBytes:67108864, transferBytes:67108864, requests:1000000, refreshes:1000000} as const;
export const LIST_COUNT_BUCKETS = [0,1,2,4,8,16,64,256,1024,1000000] as const;
export const LIST_BYTE_BUCKETS = [0,1024,4096,16384,65536,262144,1048576,4194304,16777216,67108864] as const;
export function validListObservation(input: unknown): input is ListObservation {
  if(!input || typeof input!=="object" || Array.isArray(input)) return false;
  const o=input as Record<string,unknown>;
  return Object.keys(o).every(k=>["protocol","device","scenario","dataset","visitId",...Object.keys(LIST_MEASURE_LIMITS)].includes(k))
    && o.protocol===1 && LIST_DEVICES.includes(o.device as ListObservation["device"])
    && LIST_SCENARIOS.includes(o.scenario as ListObservation["scenario"])
    && ["account_feed","project_view"].includes(String(o.dataset))
    && (o.visitId===undefined || (typeof o.visitId==="string" && /^[a-zA-Z0-9_-]{1,80}$/.test(o.visitId)))
    && Object.entries(LIST_MEASURE_LIMITS).every(([key,max])=>o[key]===undefined || (Number.isSafeInteger(o[key]) && Number(o[key])>=0 && Number(o[key])<=max));
}
export function listLoadBucket(rows?: number): string {
  return rows===undefined ? "unknown" : rows===0 ? "0" : rows<=50 ? "1-50" : rows<=200 ? "51-200" : rows<=1000 ? "201-1000" : "1001+";
}
