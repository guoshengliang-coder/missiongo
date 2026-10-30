import { conflict } from "./errors.js";
import type { MissionGoDatabase } from "./storage/database.js";

export interface BuilderHandover {
  id: string; item_id: string; from_account_id: string | null; to_account_id: string | null;
  initiated_by: string; note: string; status: "stopping" | "blocked" | "completed"; reason: string;
  resume_dispatch_id: string | null; claimed_at: string | null; created_at: string; updated_at: string;
}

export function latestBuilderHandover(database: MissionGoDatabase, itemId: string): BuilderHandover | undefined {
  return database.connection.prepare("SELECT * FROM builder_handovers WHERE item_id=? ORDER BY rowid DESC LIMIT 1")
    .get(itemId) as unknown as BuilderHandover | undefined;
}

/** Shared by dispatch, human transitions and MCP status writes. Comments remain historical evidence. */
export function assertBuilderExecution(database: MissionGoDatabase, itemId: string, accountId?: string, requireOwner = true): void {
  const handover = latestBuilderHandover(database, itemId);
  if (!handover) return;
  if (handover.status !== "completed") throw conflict("builder_handover_pending", "Builder 交接尚未完成，禁止启动或继续执行。请查看交接进度。");
  if (requireOwner && handover.to_account_id !== null && accountId !== handover.to_account_id) throw conflict("builder_execution_revoked", "旧执行授权已失效，请由当前 Builder 接手。");
}

export function dispatchExecutionRevoked(database: MissionGoDatabase, dispatchId: string): boolean {
  return Boolean(database.connection.prepare("SELECT 1 FROM builder_revoked_dispatches WHERE dispatch_id=?").get(dispatchId));
}

export function assertDispatchExecution(database: MissionGoDatabase, dispatchId: string): void {
  if (dispatchExecutionRevoked(database, dispatchId)) throw conflict("builder_execution_revoked", "此派单的执行授权已因 Builder 交接失效。");
}

export function assertExternalExecution(database: MissionGoDatabase, sessionId: string): void {
  if (database.connection.prepare("SELECT 1 FROM builder_revoked_external_sessions WHERE session_id=?").get(sessionId)) {
    throw conflict("builder_execution_revoked", "此会话的执行授权已因 Builder 交接失效。");
  }
}

/** An execution credential is scoped to a claim and OAuth client, and is permanently revoked on transfer. */
export function assertExecutionAuthorization(database: MissionGoDatabase, itemId: string, accountId: string, clientId: string,
  authorization?: string): void {
  assertBuilderExecution(database,itemId,accountId);
  if (!authorization && !latestBuilderHandover(database,itemId)) return; // Compatibility before the first handover.
  if (!authorization || !database.connection.prepare(`SELECT 1 FROM builder_execution_authorizations
    WHERE id=? AND item_id=? AND account_id=? AND client_id=? AND revoked=0`).get(authorization,itemId,accountId,clientId)) {
    throw conflict("builder_execution_revoked","执行凭据已失效或缺失。请使用新一轮领取返回的 executionAuthorization，不能沿用旧会话凭据。");
  }
}
