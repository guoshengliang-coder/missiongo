import { createHash } from "node:crypto";

import type { AgentApproval } from "./agent-approval-store.js";
import type { AgentSessionAttention, AgentSessionSnapshot } from "./agent-session-store.js";
import { conflict } from "./errors.js";

export type PlanApprovalStatusCode = "ready" | "connection_unavailable" | "reply_unavailable" | "running"
  | "permission_required" | "reply_pending" | "not_approval" | "dismissed" | "awaiting_source";
export type PlanApprovalBlockReason = Extract<PlanApprovalStatusCode, "connection_unavailable" | "reply_pending" | "dismissed">;
export interface PlanApprovalOffer {
  readonly revision: string;
  readonly reason: string;
}
export interface PlanApprovalAssessment {
  readonly status: { readonly code: PlanApprovalStatusCode };
  readonly offer?: PlanApprovalOffer;
}

type Session = AgentSessionSnapshot & { readonly canReply: boolean; readonly approval?: AgentApproval; readonly attention: AgentSessionAttention };

/** The existing attention label supplies the shortcut. No second semantic verdict. */
export class PlanApprovalService {
  private readonly approvedRequests = new Map<string, string>();

  assess(session: Session, unavailableReason?: PlanApprovalBlockReason): PlanApprovalAssessment {
    const attention = session.attention;
    if (attention.dismissed) return { status: { code: "dismissed" } };
    if (attention.state !== "needed" || attention.kind !== "approval") return { status: { code: "not_approval" } };
    if (unavailableReason) return { status: { code: unavailableReason } };
    if (!session.canReply || session.managedExecution || session.archivedAt) return { status: { code: "reply_unavailable" } };
    if (session.lastError || (session.nativeConnection && session.nativeConnection.state !== "connected")) return { status: { code: "connection_unavailable" } };
    // A chat reply never answers a tool permission request.
    if (session.approval && !["approved", "resolved"].includes(session.approval.status)) return { status: { code: "permission_required" } };
    const command = session.command;
    if (command && ["queued", "delivering", "delivery_unknown"].includes(command.status)) return { status: { code: "reply_pending" } };
    if (session.status !== "idle" || session.turnState.turnActive === true) return { status: { code: "running" } };
    const requestRevision = createHash("sha256").update(JSON.stringify(session.messages)).digest("hex");
    if (this.approvedRequests.get(session.id) === requestRevision) return { status: { code: "awaiting_source" } };
    const latest = session.messages.at(-1);
    if (command?.status === "delivered" && (!latest?.occurredAt
      || Date.parse(command.createdAt) >= Date.parse(latest.occurredAt))) return { status: { code: "awaiting_source" } };
    const revision = createHash("sha256").update(JSON.stringify([session.id, attention, session.messages])).digest("hex");
    return { status: { code: "ready" }, offer: { revision, reason: attention.reason ?? "" } };
  }

  /** Reload and enqueue together in the caller's transaction; the queue prevents double submission. */
  approve<T>(session: Session, revision: string, enabled: boolean, enqueue: () => T): T {
    const assessment = this.assess(session);
    if (!enabled || assessment.status.code !== "ready" || assessment.offer?.revision !== revision) {
      throw conflict("agent_plan_approval_changed", "The approval request changed or is unavailable. Refresh and review the conversation before approving.");
    }
    const result = enqueue();
    this.approvedRequests.delete(session.id);
    this.approvedRequests.set(session.id, createHash("sha256").update(JSON.stringify(session.messages)).digest("hex"));
    if (this.approvedRequests.size > 200) this.approvedRequests.delete(this.approvedRequests.keys().next().value!);
    return result;
  }
}
