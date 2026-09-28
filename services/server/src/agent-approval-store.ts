import { randomUUID } from "node:crypto";

import { conflict, invalidInput, notFound } from "./errors.js";
import type { MissionGoDatabase } from "./storage/database.js";

export interface AgentApproval {
  id: string;
  kind: "manual" | "auto";
  status: string;
  turnId: string;
  action: string;
  reason?: string;
  startedAtMs: number;
  decision?: "accept" | "decline";
  retryId?: string;
  retryStatus?: "queued" | "delivering" | "delivered" | "restored" | "failed";
  retryError?: string;
}

interface ApprovalRow {
  session_id: string;
  approval_id: string;
  kind: "manual" | "auto";
  status: string;
  turn_id: string;
  action: string;
  reason: string | null;
  started_at_ms: number;
  decision: "accept" | "decline" | null;
  retry_id: string | null;
  retry_review_id: string | null;
  retry_status: "queued" | "delivering" | "delivered" | "restored" | "failed" | null;
  retry_error: string | null;
}

const manualStatuses = new Set(["pending", "approved", "denied", "unavailable"]);
const autoStatuses = new Set(["inProgress", "approved", "denied", "timedOut", "aborted"]);

function publicApproval(row: ApprovalRow): AgentApproval {
  return {
    id: row.approval_id, kind: row.kind, status: row.status,
    turnId: row.turn_id, action: row.action, startedAtMs: row.started_at_ms,
    ...(row.reason ? { reason: row.reason } : {}),
    ...(row.decision ? { decision: row.decision } : {}),
    ...(row.retry_review_id === row.approval_id && row.retry_id ? { retryId: row.retry_id } : {}),
    ...(row.retry_review_id === row.approval_id && row.retry_status ? { retryStatus: row.retry_status } : {}),
    ...(row.retry_review_id === row.approval_id && row.retry_error ? { retryError: row.retry_error } : {}),
  };
}

export class AgentApprovalStore {
  constructor(private readonly database: MissionGoDatabase) {}

  get(sessionId: string): AgentApproval | undefined {
    const row = this.row(sessionId);
    return row ? publicApproval(row) : undefined;
  }

  private row(sessionId: string): ApprovalRow | undefined {
    return this.database.connection.prepare("SELECT * FROM agent_session_approvals WHERE session_id = ?")
      .get(sessionId) as unknown as ApprovalRow | undefined;
  }

  /** Only the node that owns this Codex session can report its source approval. */
  record(nodeId: string, sessionId: string, approval: AgentApproval): void {
    const owner = this.database.connection.prepare(
      "SELECT id FROM agent_sessions WHERE id = ? AND node_id = ? AND agent_kind = 'codex'",
    ).get(sessionId, nodeId);
    if (!owner) throw notFound("Codex session");
    if (!approval.id || approval.id.length > 250 || !approval.turnId || approval.turnId.length > 150
      || !approval.action || approval.action.length > 4_000
      || (approval.reason?.length ?? 0) > 2_000
      || !Number.isSafeInteger(approval.startedAtMs) || approval.startedAtMs < 0
      || (approval.kind !== "manual" && approval.kind !== "auto")
      || !(approval.kind === "manual" ? manualStatuses : autoStatuses).has(approval.status)) {
      throw invalidInput("Invalid Codex approval snapshot.");
    }
    const now = new Date().toISOString();
    this.database.transaction(() => {
      const previous = this.row(sessionId);
      if (previous && previous.approval_id === approval.id) {
        if ((previous.kind === "manual" && previous.status !== "pending" && approval.status === "pending")
          || (previous.kind === "auto" && previous.status !== "inProgress" && approval.status === "inProgress")) {
          return;
        }
        // A stale node snapshot must not reset a decision or retry queued by a
        // person after that snapshot was taken.
        this.database.connection.prepare(
          `UPDATE agent_session_approvals SET status = ?, action = ?, reason = ?, updated_at = ?
           WHERE session_id = ? AND approval_id = ?`,
        ).run(approval.status, approval.action, approval.reason ?? null, now, sessionId, approval.id);
      } else {
        this.database.connection.prepare(
          `INSERT INTO agent_session_approvals
           (session_id, approval_id, kind, status, turn_id, action, reason, started_at_ms, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(session_id) DO UPDATE SET
           approval_id=excluded.approval_id,kind=excluded.kind,status=excluded.status,
           turn_id=excluded.turn_id,action=excluded.action,reason=excluded.reason,
           started_at_ms=excluded.started_at_ms,decision=NULL,updated_at=excluded.updated_at`,
        ).run(sessionId, approval.id, approval.kind, approval.status, approval.turnId,
          approval.action, approval.reason ?? null, approval.startedAtMs, now);
      }
    });
  }

  decide(sessionId: string, approvalId: string, choice: "accept" | "decline"): AgentApproval {
    return this.database.transaction(() => {
      const row = this.row(sessionId);
      if (!row || row.approval_id !== approvalId || row.kind !== "manual" || row.status !== "pending") {
        throw conflict("approval_stale", "This Codex approval is no longer pending.");
      }
      if (row.decision && row.decision !== choice) throw conflict("approval_decided", "This approval already has a different decision.");
      if (!row.decision) this.database.connection.prepare(
        "UPDATE agent_session_approvals SET decision = ?, updated_at = ? WHERE session_id = ?",
      ).run(choice, new Date().toISOString(), sessionId);
      return this.get(sessionId)!;
    });
  }

  requestRetry(sessionId: string, approvalId: string): AgentApproval {
    return this.database.transaction(() => {
      const row = this.row(sessionId);
      if (!row || row.approval_id !== approvalId || row.kind !== "auto" || row.status !== "denied") {
        throw conflict("approval_retry_unavailable", "Only a current automatic-review denial can be retried.");
      }
      if (row.retry_review_id === approvalId && row.retry_id) return publicApproval(row);
      if (row.retry_id && row.retry_status !== "restored" && row.retry_status !== "failed") {
        throw conflict("approval_retry_in_progress", "The previous manual retry has not finished.");
      }
      this.database.connection.prepare(
        "UPDATE agent_session_approvals SET retry_id = ?, retry_review_id = ?, retry_status = 'queued', retry_error = NULL, updated_at = ? WHERE session_id = ?",
      ).run(randomUUID(), approvalId, new Date().toISOString(), sessionId);
      return this.get(sessionId)!;
    });
  }

  /** Sent to the owning node on its next session poll. */
  pendingForNode(sessionId: string): { approvalDecision?: { id: string; choice: "accept" | "decline" };
    approvalRetry?: { id: string; reviewId: string; status: string } } {
    const row = this.row(sessionId);
    if (!row) return {};
    return {
      ...(row.kind === "manual" && row.status === "pending" && row.decision
        ? { approvalDecision: { id: row.approval_id, choice: row.decision } } : {}),
      ...(row.retry_id && row.retry_review_id
        && ["queued", "delivering", "delivered"].includes(row.retry_status ?? "")
        ? { approvalRetry: { id: row.retry_id, reviewId: row.retry_review_id, status: row.retry_status! } } : {}),
    };
  }

  recordRetry(nodeId: string, sessionId: string, retryId: string,
              status: "delivering" | "delivered" | "restored" | "failed", error?: string): void {
    const owned = this.database.connection.prepare(
      `SELECT a.retry_id, a.retry_status FROM agent_session_approvals a JOIN agent_sessions s ON s.id = a.session_id
       WHERE a.session_id = ? AND s.node_id = ?`,
    ).get(sessionId, nodeId) as { retry_id: string; retry_status: string } | undefined;
    if (!owned || owned.retry_id !== retryId) throw conflict("approval_retry_stale", "Retry no longer belongs to this node session.");
    if (["restored", "failed"].includes(owned.retry_status)) return;
    if (owned.retry_status === "delivered" && status === "delivering") return;
    this.database.connection.prepare(
      "UPDATE agent_session_approvals SET retry_status = ?, retry_error = ?, updated_at = ? WHERE session_id = ?",
    ).run(status, error?.slice(0, 2_000) ?? null, new Date().toISOString(), sessionId);
  }
}
