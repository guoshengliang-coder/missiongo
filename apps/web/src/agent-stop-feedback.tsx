import { useI18n } from "./i18n.js";
import type { AgentSessionCommand } from "./types.js";

/** Shared by the console and the embedded item conversation. */
export function AgentStopFeedback({ stop, latestCommand, backgroundRunning = false, turnActive = false }: {
  stop?: AgentSessionCommand | undefined;
  latestCommand?: AgentSessionCommand | undefined;
  backgroundRunning?: boolean;
  turnActive?: boolean;
}) {
  const { t } = useI18n();
  if (!stop || stop.kind !== "interrupt") return null;
  if (latestCommand?.kind === "message" && latestCommand.createdAt > stop.createdAt) return null;
  if (stop.status === "delivered" && turnActive) return null;
  const label = stop.status === "queued" ? "agentSessionStopQueued"
    : stop.status === "delivering" ? "agentSessionStopDelivering"
      : stop.status === "delivered" ? !stop.stopConfirmed ? "agentSessionStopUnconfirmedDelivery" : backgroundRunning ? "agentSessionStopBackground" : "agentSessionStopDelivered"
        : stop.status === "cancelled" ? "agentSessionStopCancelled" : "agentSessionStopFailed";
  return <div className={`agent-session-command agent-session-command-${stop.status}`} role="status">
    <span>{t(label)}{stop.error ? `: ${stop.error}` : ""}</span>
  </div>;
}
