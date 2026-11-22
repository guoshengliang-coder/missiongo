import { createHash } from "node:crypto";
import type { MergeContinuation, MergeReconciliationPreview } from "@missiongo/contracts";
import type { MissionGoDatabase } from "./storage/database.js";
import type { AgentSessionCommand } from "./agent-session-store.js";
import { SessionSendRequests } from "./session-send-requests.js";
import { MissionGoError } from "./errors.js";

// A bounded key accepted by SessionSendRequests; opaque batch/request values never enter its syntax.
export function mergeContinuationKey(batchId: string, requestId: string): string {
  return createHash("sha256").update(JSON.stringify(["merge-continuation", batchId, requestId])).digest("hex");
}
const message = "本次集成决定已批准，请核实执行状态并沿用现有授权继续处理。回复先讲结论、变化与影响；仅列必要待决项，详细依据及完整验证放 Markdown，保留关键风险与授权边界。";
export interface MergeContinuationTransport {
  commandById(sessionId: string, commandId: string): AgentSessionCommand | undefined;
  enqueue(accountId: string, sessionId: string, text: string, requestKey: string): AgentSessionCommand;
}
export class MergeContinuations {
  constructor(private readonly db: MissionGoDatabase, private readonly sessions: MergeContinuationTransport) {}

  private recordKey(accountId: string, sessionId: string, key: string): string {
    return `merge-continuation:${JSON.stringify([accountId, sessionId, key])}`;
  }
  read(accountId: string, preview: MergeReconciliationPreview, requestId: string): MergeContinuation {
    const key = mergeContinuationKey(preview.batchId, requestId);
    const reference = new SessionSendRequests(this.db).get(accountId, preview.sessionId, "command", key);
    if (reference) {
      const command = this.sessions.commandById(preview.sessionId, reference.id);
      return command ? { state: command.status, commandId: command.id,
        ...(command.status === "failed" ? { reason: "send_failed" as const } : {}) }
        : { state: "failed", reason: "unavailable", commandId: reference.id };
    }
    const row = this.db.connection.prepare("SELECT result_json FROM idempotency_keys WHERE key=? AND operation='merge_continuation'")
      .get(this.recordKey(accountId, preview.sessionId, key)) as { result_json: string } | undefined;
    return row ? JSON.parse(row.result_json) : { state: "not_sent" };
  }
  decorate(accountId: string, preview: MergeReconciliationPreview): MergeReconciliationPreview {
    return { ...preview, continuations: Object.fromEntries((preview.reconciliation?.requests ?? [])
      .filter(row => row.decision === "approved" && !row.appliedAt)
      .map(row => {
        const result = this.read(accountId, preview, row.id);
        return [row.id, row.snapshot === preview.snapshot || result.commandId ? result
          : { state: "failed", reason: "scope_changed" }];
      })) };
  }
  send(accountId: string, preview: MergeReconciliationPreview, requestId: string,
    onError: (error: unknown) => void): MergeContinuation {
    const row = preview.reconciliation?.requests.find(row => row.id === requestId);
    if (!row || row.decision !== "approved" || row.appliedAt)
      return { state: "failed", reason: "scope_changed" };
    // Resolve an earlier accepted send before enqueue's pending/archived guards. Never resend it.
    const prior = this.read(accountId, preview, requestId);
    if (prior.commandId) return prior;
    if (row.snapshot !== preview.snapshot) return { state: "failed", reason: "scope_changed" };
    const key = mergeContinuationKey(preview.batchId, requestId);
    try {
      const command = this.sessions.enqueue(accountId, preview.sessionId, message, key);
      return { state: command.status, commandId: command.id };
    } catch (error) {
      onError(error);
      const reasons: Record<string, NonNullable<MergeContinuation["reason"]>> = {
        agent_reply_pending: "pending", agent_session_archived: "archived", builder_execution_revoked: "revoked",
        agent_session_work_finished: "finished", managed_session_control: "managed", not_found: "unavailable", external_native_not_ready: "not_ready",
      };
      const result: MergeContinuation = { state: "failed", reason: error instanceof MissionGoError
        ? reasons[error.code] ?? "send_failed" : "send_failed" };
      this.db.connection.prepare(`INSERT INTO idempotency_keys(key,operation,result_json,created_at) VALUES (?,'merge_continuation',?,?)
        ON CONFLICT(key) DO UPDATE SET result_json=excluded.result_json,created_at=excluded.created_at`)
        .run(this.recordKey(accountId, preview.sessionId, key), JSON.stringify(result), new Date().toISOString());
      return result;
    }
  }
}
