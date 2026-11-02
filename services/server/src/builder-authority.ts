import { NODE_ONLINE_WINDOW_MS } from "@missiongo/domain";
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

  if (!authorization || !database.connection.prepare(`SELECT 1 FROM builder_execution_authorizations
    WHERE id=? AND item_id=? AND account_id=? AND client_id=? AND revoked=0 AND round_key=?`).get(authorization,itemId,accountId,clientId,deliveryRound(database,itemId,true))) {
    throw conflict("builder_execution_revoked","执行凭据已失效或缺失。请使用新一轮领取返回的 executionAuthorization，不能沿用旧会话凭据。");
  }
}

/** Actual execution observations remain separate from the business card's status. Unknown source states fence new work. */
export function hasOngoingItemExecution(database:MissionGoDatabase,itemId:string,excludeDispatchId=""):boolean {
  const oldestObservation = new Date(Date.now()-NODE_ONLINE_WINDOW_MS).toISOString();
  return Boolean(database.connection.prepare(`SELECT 1 FROM item_executions WHERE item_id=? AND status IN ('assigned','working','blocked')
    UNION ALL SELECT 1 FROM external_agent_sessions s JOIN external_agent_session_items i ON i.session_id=s.id LEFT JOIN nodes n ON n.id=s.native_node_id
      WHERE i.item_id=? AND ((COALESCE(json_extract(s.native_snapshot_json,'$.status'),'tracking') NOT IN ('idle','suspended')
        AND (s.native_node_id IS NOT NULL OR s.native_snapshot_json IS NOT NULL OR s.progress_status NOT IN ('completed','failed')))
        OR s.native_node_id IS NOT NULL AND (n.revoked_at IS NOT NULL OR n.last_seen_at IS NULL OR n.last_seen_at<? OR s.native_synced_at IS NULL OR s.native_synced_at<?)
        OR COALESCE(json_extract(s.native_snapshot_json,'$.turnState.turnActive'),0)=1
        OR EXISTS(SELECT 1 FROM external_native_commands c WHERE c.session_id=s.id AND c.status IN ('queued','delivering','delivery_unknown')))
    UNION ALL SELECT 1 FROM dispatches d JOIN dispatch_items i ON i.dispatch_id=d.id LEFT JOIN agent_sessions s ON s.dispatch_id=d.id JOIN nodes n ON n.id=d.node_id
      WHERE i.item_id=? AND d.id!=? AND d.status IN ('queued','delivered','launched') AND (s.id IS NULL OR s.status NOT IN ('idle','suspended') OR n.revoked_at IS NOT NULL OR n.last_seen_at IS NULL OR n.last_seen_at<?
        OR COALESCE(json_extract(s.turn_state_json,'$.turnActive'),0)=1
        OR EXISTS(SELECT 1 FROM agent_session_commands c WHERE c.session_id=s.id AND c.status IN ('queued','delivering','delivery_unknown')))
    UNION ALL SELECT 1 FROM ai_executions WHERE item_id=? AND status IN ('created','running','waiting_for_human')
    UNION ALL SELECT 1 FROM managed_runs r JOIN managed_stages s ON s.run_id=r.id,json_each(r.scope_json,'$.itemKeys') i
      JOIN work_items w ON w.item_key=i.value WHERE w.id=? AND s.status IN ('ready','running','waiting_for_human','unknown') LIMIT 1`)
    .get(itemId,itemId,oldestObservation,oldestObservation,itemId,excludeDispatchId,oldestObservation,itemId,itemId));
}
export function hasPriorProcessing(database:MissionGoDatabase,itemId:string):boolean {
 return Boolean(database.connection.prepare("SELECT 1 FROM work_item_events WHERE item_id=? AND history_source_key IS NULL AND to_status='in_progress' LIMIT 1").get(itemId));
}
