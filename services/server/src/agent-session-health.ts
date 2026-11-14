import type { AgentSessionStatus, AgentSessionTurnState } from "./agent-session-store.js";

export const SESSION_PROGRESS_WARNING_MS = 10 * 60_000;
export const SESSION_OBSERVATION_TIMEOUT_MS = 2 * 60_000;

interface HealthReceipt {
  kind: string;
  status: string;
  previousStatus: string;
  acceptedAt: string;
}

/** Source observations and control acknowledgements have different clocks.
 * The server-owned boundary floors health ages, never lastProgressAt itself. */
export function mergeSessionHealth(
  previousStatus: AgentSessionStatus,
  previous: AgentSessionTurnState,
  status: AgentSessionStatus,
  incoming: AgentSessionTurnState,
  receipt?: HealthReceipt,
): { status: AgentSessionStatus; turnState: AgentSessionTurnState; ignoredExecution?: boolean } {
  // Internal metadata must never be supplied or cleared by a node.
  const { healthStartedAt: _boundary, ...source } = incoming;
  const observed = Date.parse(source.observedAt ?? "");
  const boundary = Date.parse(previous.healthStartedAt ?? "");
  const settled = receipt?.kind === "message" && ["delivered", "cancelled"].includes(receipt.previousStatus);
  // Cached control results cannot restore execution after a newer stop/idle.
  // Older observations crossing a newly accepted start belong to the old turn.
  if ((settled && status === "active")
    || (Number.isFinite(boundary) && Number.isFinite(observed) && observed < boundary)) {
    return { status: previousStatus, turnState: previous, ignoredExecution: true };
  }
  if (status === "unavailable") return { status, turnState: previous };
  const turnState = { ...previous, ...source };
  const firstDelivery = receipt?.kind === "message" && receipt.status === "delivered"
    && ["queued", "delivering", "delivery_unknown"].includes(receipt.previousStatus);
  const wasInactive = ["idle", "suspended"].includes(previousStatus) || previous.turnActive === false;
  if (firstDelivery && wasInactive && !["unavailable", "failed"].includes(previousStatus)
    && status === "active" && source.turnActive === true
    && Number.isFinite(Date.parse(previous.observedAt ?? ""))) {
    // Only the first accepted delivery creates this boundary. Replayed
    // receipts are settled above and cannot renew it. Reservation/attachment
    // preparation time is not time spent executing the new turn.
    turnState.healthStartedAt = receipt.acceptedAt;
    turnState.waitingForInput = false;
    turnState.waitingForPermission = false;
    delete turnState.turnStartedAt;
    delete turnState.lastOutputAt;
    delete turnState.thinkingStartedAt;
    delete turnState.thinkingTokens;
    delete turnState.thinkingDurationSeconds;
  } else if ((!receipt || settled) && (source.turnActive === false || ["idle", "suspended", "failed"].includes(status))) {
    delete turnState.healthStartedAt;
  }
  return { status, turnState };
}

/** Shared with the live-event scheduler so a bounded startup window expires
 * even when no new snapshot or browser poll arrives. */
export function sessionHealthDeadlines(turn: AgentSessionTurnState): [number, number] {
  const boundary = Date.parse(turn.healthStartedAt ?? "");
  const observed = Date.parse(turn.observedAt ?? "");
  const progress = Date.parse(turn.lastProgressAt ?? "");
  const floor = (value: number) => Number.isFinite(boundary) ? Math.max(Number.isFinite(value) ? value : boundary, boundary) : value;
  return [floor(observed) + SESSION_OBSERVATION_TIMEOUT_MS, floor(progress) + SESSION_PROGRESS_WARNING_MS];
}

/** A read-time projection. A warning never stops a runtime or frees its execution slot. */
export function sessionHealth(status: AgentSessionStatus, turn: AgentSessionTurnState, now = Date.now()): {
  status: AgentSessionStatus; reason?: string;
} {
  if (status !== "active" && status !== "stalled") return { status };
  // Old nodes did not report observations; their unchanged snapshots are not a lost heartbeat.
  const [observationDeadline, progressDeadline] = sessionHealthDeadlines(turn);
  if (!Number.isFinite(observationDeadline)) return { status };
  if (now >= observationDeadline) {
    return { status: "unavailable", reason: "原生会话已超过 2 分钟未同步，当前运行状态无法确认；不会自动中断或重发消息。" };
  }
  if (turn.waitingForInput || turn.turnActive === false) return { status };
  if (Number.isFinite(progressDeadline) && now >= progressDeadline) {
    return { status: "stalled", reason: "连续 10 分钟没有可确认的执行进展，可能正在等待工具或模型；请核对当前活动后决定中断或继续，MissionGo 未自动中断。" };
  }
  return { status };
}

/** Observation clocks must not reorder conversations or create unread activity. */
export function executionTurnState(turn: AgentSessionTurnState): Omit<AgentSessionTurnState, "observedAt" | "lastProgressAt" | "waitingForPermission" | "healthStartedAt"> {
  const { observedAt: _observed, lastProgressAt: _progress, waitingForPermission: _permission, healthStartedAt: _boundary, ...execution } = turn;
  return execution;
}
