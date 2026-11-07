import type { AgentSessionListItem } from "./agent-session-store.js";

/** Projection only: keep raw classification/revision and the user's dismissal intact. */
export function withDeliveryAttention<T extends Pick<AgentSessionListItem,
  "attention" | "needsAttention" | "status" | "waitingForPermission" | "planApprovalPending" | "waitingForReply">>(session: T, currentDelivery: boolean): T {
  const handled = currentDelivery && session.attention.deliveryOnly === true
    && session.attention.kind === "instruction" && Boolean(session.attention.revision)
    && !session.waitingForPermission && !session.planApprovalPending
    && !["failed", "stalled", "unavailable"].includes(session.status);
  return handled ? { ...session, needsAttention: false, waitingForReply: false,
    attention: { ...session.attention, handledByDelivery: true } } : session;
}
