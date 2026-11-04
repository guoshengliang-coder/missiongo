import { itemExecutionBlockers } from "./item-execution-blockers.js";
import { deliveryRound } from "./delivery-round.js";
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
  const item = database.connection.prepare("SELECT builder_account_id FROM work_items WHERE id=?").get(itemId) as {builder_account_id:string|null}|undefined;
  if (requireOwner && accountId && item?.builder_account_id && accountId !== item.builder_account_id) {
    const executor = accountId && database.connection.prepare("SELECT 1 FROM item_executions WHERE item_id=? AND account_id=? AND authorization_revoked=0 AND status IN ('assigned','working','blocked')").get(itemId,accountId);
    if (!executor) throw conflict("builder_execution_revoked", "仅当前 Builder 或授权执行人可继续执行。");
  }
  if (!handover) return;
  if (handover.status !== "completed") throw conflict("builder_handover_pending", "Builder 交接尚未完成，禁止启动或继续执行。请查看交接进度。");
  if (requireOwner && handover.to_account_id !== null && accountId !== handover.to_account_id && !(accountId && database.connection.prepare("SELECT 1 FROM item_executions WHERE item_id=? AND account_id=? AND authorization_revoked=0 AND status IN ('assigned','working','blocked')").get(itemId,accountId))) throw conflict("builder_execution_revoked", "旧执行授权已失效，请由当前 Builder 接手。");
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

  if (!authorization) {
    throw conflict("builder_execution_missing","缺少执行凭据。请用 recover_execution_authorization 和原会话身份恢复本轮领取授权，不要重新领取。");
  }
  if (!database.connection.prepare(`SELECT 1 FROM builder_execution_authorizations
    WHERE id=? AND item_id=? AND account_id=? AND client_id=? AND revoked=0 AND round_key=?`).get(authorization,itemId,accountId,clientId,deliveryRound(database,itemId,true))) {
    throw conflict("builder_execution_revoked","执行凭据已失效或不属于本轮授权。请停止状态写入，由用户核对执行归属；不要重新领取或更换会话绕过。");
  }
}

/** Actual execution observations remain separate from the business card's status. Unknown source states fence new work. */
export function hasOngoingItemExecution(database:MissionGoDatabase,itemId:string,excludeDispatchId=""):boolean {
  return itemExecutionBlockers(database,itemId,excludeDispatchId).length > 0;
}
export function hasPriorProcessing(database:MissionGoDatabase,itemId:string):boolean {
 return Boolean(database.connection.prepare("SELECT 1 FROM work_item_events WHERE item_id=? AND history_source_key IS NULL AND to_status='in_progress' LIMIT 1").get(itemId));
}

export function requiresExecutionStopCheck(database:MissionGoDatabase,itemId:string):boolean {
  return hasPriorProcessing(database,itemId) || Boolean((database.connection.prepare("SELECT execution_disposition FROM work_items WHERE id=?")
    .get(itemId) as {execution_disposition:string|null}|undefined)?.execution_disposition);
}
