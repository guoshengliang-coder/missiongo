import type { AgentSessionStatus, AgentSessionTurnState } from "./agent-session-store.js";

export const SESSION_PROGRESS_WARNING_MS = 10 * 60_000;
export const SESSION_OBSERVATION_TIMEOUT_MS = 2 * 60_000;

/** A read-time projection. A warning never stops a runtime or frees its execution slot. */
export function sessionHealth(status: AgentSessionStatus, turn: AgentSessionTurnState, now = Date.now()): {
  status: AgentSessionStatus; reason?: string;
} {
  if (status !== "active" && status !== "stalled") return { status };
  // Old nodes did not report observations; their unchanged snapshots are not a lost heartbeat.
  const observed = Date.parse(turn.observedAt ?? "");
  if (!Number.isFinite(observed)) return { status };
  if (now - observed >= SESSION_OBSERVATION_TIMEOUT_MS) {
    return { status: "unavailable", reason: "原生会话已超过 2 分钟未同步，当前运行状态无法确认；不会自动中断或重发消息。" };
  }
  if (turn.waitingForInput || turn.turnActive === false) return { status };
  const progress = Date.parse(turn.lastProgressAt ?? "");
  if (Number.isFinite(progress) && now - progress >= SESSION_PROGRESS_WARNING_MS) {
    return { status: "stalled", reason: "连续 10 分钟没有可确认的执行进展，可能正在等待工具或模型；请核对当前活动后决定中断或继续，MissionGo 未自动中断。" };
  }
  return { status };
}

/** Observation clocks must not reorder conversations or create unread activity. */
export function executionTurnState(turn: AgentSessionTurnState): Omit<AgentSessionTurnState, "observedAt" | "lastProgressAt"> {
  const { observedAt: _observed, lastProgressAt: _progress, ...execution } = turn;
  return execution;
}
