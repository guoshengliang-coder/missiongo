import { randomUUID } from "node:crypto";
import { isNodeOnline } from "@missiongo/domain";
import { AccountStore } from "./accounts-store.js";
import { latestBuilderHandover, type BuilderHandover } from "./builder-authority.js";
import { conflict, invalidInput } from "./errors.js";
import type { MissionGoStore } from "./store.js";

interface Execution {
  id: string; account_id: string; status: string; session_id: string | null;
  session_status: string | null; agent_kind: string; last_seen_at: string | null; revoked_at: string | null;
}

/** Human-authorized, item-scoped system stop. It does not grant cross-account session control to callers. */
export class BuilderHandovers {
  constructor(private readonly store: MissionGoStore) {}
  private get db() { return this.store.database.connection; }

  private target(itemId: string, accountId: string | null): void {
    if (accountId === null) return;
    const item = this.db.prepare("SELECT product_id FROM work_items WHERE id=?").get(itemId) as { product_id: string };
    const accounts = new AccountStore(this.store.database);
    const account = accounts.listAccounts().find(row => row.id === accountId);
    if (!account || account.disabledAt || !accounts.allows(account,item.product_id,"operate") || !accounts.allows(account,item.product_id,"ai")) {
      throw invalidInput("新 Builder 必须拥有此产品的操作权限和 AI 权限。");
    }
  }

  private executions(itemId: string): Execution[] {
    return this.db.prepare(`SELECT d.id,d.account_id,d.status,s.id AS session_id,s.status AS session_status,
      d.agent_kind,n.last_seen_at,n.revoked_at FROM dispatch_items di JOIN dispatches d ON d.id=di.dispatch_id
      JOIN nodes n ON n.id=d.node_id LEFT JOIN agent_sessions s ON s.dispatch_id=d.id
      WHERE di.item_id=? AND d.status IN ('queued','delivered','launched')
      AND NOT EXISTS (SELECT 1 FROM builder_revoked_dispatches r WHERE r.dispatch_id=d.id)
      AND (d.status IN ('queued','delivered') OR s.status IN ('active','stalled','unavailable')
        OR EXISTS (SELECT 1 FROM agent_session_commands c WHERE c.session_id=s.id AND c.status IN ('queued','delivering','delivery_unknown'))
        OR NOT EXISTS (SELECT 1 FROM work_item_events e WHERE e.item_id=di.item_id
          AND e.created_at>=d.created_at AND e.to_status IN ('development_complete','pending_verification','done','cancelled')))`)
      .all(itemId) as unknown as Execution[];
  }

  private external(itemId: string): Array<{ id: string }> {
    // Progress "completed" alone is not a physical stop proof for a connected native session.
    return this.db.prepare(`SELECT s.id FROM external_agent_sessions s JOIN external_agent_session_items i ON i.session_id=s.id
      WHERE i.item_id=? AND (json_extract(s.native_snapshot_json,'$.status') IN ('active','stalled','unavailable')
        OR EXISTS (SELECT 1 FROM external_native_commands c WHERE c.session_id=s.id AND c.status IN ('queued','delivering','delivery_unknown'))
        OR NOT EXISTS (SELECT 1 FROM work_item_events e WHERE e.item_id=i.item_id
          AND e.created_at>=s.created_at AND e.to_status IN ('development_complete','pending_verification','done','cancelled')))
      AND NOT EXISTS (SELECT 1 FROM builder_revoked_external_sessions r WHERE r.session_id=s.id)`)
      .all(itemId) as Array<{ id: string }>;
  }

  start(itemKey: string, accountId: string, targetId: string | null, expectedId: unknown, note: string) {
    return this.store.database.transaction(() => {
      const item = this.store.getWorkItem(itemKey);
      this.target(item.id,targetId);
      if ((item.builderAccountId ?? null) !== expectedId) throw conflict("builder_changed","Builder 已变更，请刷新后重新转交。");
      const previous = latestBuilderHandover(this.store.database,item.id);
      if (previous && previous.status !== "completed") throw conflict("builder_handover_pending","已有交接正在进行，请查看进度或重试。");
      if ((item.builderAccountId ?? null) === targetId) throw invalidInput("请选择不同的 Builder。");
      const executions = this.executions(item.id);
      const external = this.external(item.id);
      // Preflight the whole scope before cancelling even one queue or revoking one authorization.
      for (const execution of executions) {
        const scope = this.db.prepare("SELECT COUNT(*) AS count FROM dispatch_items WHERE dispatch_id=?").get(execution.id) as {count:number};
        if (scope.count !== 1) throw conflict("builder_handover_multi_item","此任务属于多条目派单或会话，不能单独自动转交。请先拆分执行范围或另行安排整组交接；本版本不提供拆分或整组交接入口。");
        // A native thread can have other dispatch/external records with additional items.
        if (execution.session_id && this.db.prepare(`SELECT 1 FROM agent_sessions current
          JOIN agent_sessions other ON other.node_id=current.node_id AND other.agent_kind=current.agent_kind AND other.agent_session_ref=current.agent_session_ref
          JOIN dispatch_items i ON i.dispatch_id=other.dispatch_id WHERE current.id=? AND i.item_id<>?
          UNION ALL SELECT 1 FROM agent_sessions current JOIN external_agent_sessions other
          ON other.native_node_id=current.node_id AND other.agent_kind=current.agent_kind AND other.session_ref=current.agent_session_ref
          JOIN external_agent_session_items i ON i.session_id=other.id WHERE current.id=? AND i.item_id<>? LIMIT 1`)
          .get(execution.session_id,item.id,execution.session_id,item.id)) {
          throw conflict("builder_handover_multi_item","同一原生会话关联了其他条目，不能单独停止。请先拆分执行范围或另行安排整组交接。");
        }
      }
      for (const session of external) {
        if (this.db.prepare("SELECT 1 FROM external_agent_session_items WHERE session_id=? AND item_id<>? LIMIT 1").get(session.id,item.id)) {
          throw conflict("builder_handover_multi_item","此任务属于多条目外部会话，不能单独自动转交。请先拆分执行范围或另行安排整组交接。");
        }
      }
      if (this.db.prepare(`SELECT 1 FROM managed_runs r JOIN managed_stages s ON s.run_id=r.id,json_each(r.scope_json,'$.itemKeys') i
        WHERE i.value=? AND s.status IN ('ready','running','waiting_for_human','unknown') AND json_array_length(r.scope_json,'$.itemKeys')>1 LIMIT 1`).get(item.key)) {
        throw conflict("builder_handover_multi_item","此任务属于多条目托管执行，不能单独停止。请先拆分执行范围或另行安排整组交接。");
      }
      const id = randomUUID(), now = new Date().toISOString();
      this.db.prepare(`INSERT INTO builder_handovers(id,item_id,from_account_id,to_account_id,initiated_by,note,status,created_at,updated_at)
        VALUES (?,?,?,?,?,?,'stopping',?,?)`).run(id,item.id,item.builderAccountId ?? null,targetId,accountId,note,now,now);
      this.db.prepare("UPDATE builder_execution_authorizations SET revoked=1 WHERE item_id=?").run(item.id);
      for (const execution of executions) {
        this.db.prepare("INSERT INTO builder_revoked_dispatches(dispatch_id,handover_id) VALUES (?,?)").run(execution.id,id);
        if (execution.status === "queued") this.db.prepare("UPDATE dispatches SET status='cancelled',completed_at=?,error=? WHERE id=? AND status='queued'")
          .run(now,"已由 Builder 交接取消",execution.id);
      }
      for (const session of external) this.db.prepare("INSERT INTO builder_revoked_external_sessions(session_id,handover_id) VALUES (?,?)").run(session.id,id);
      // Closed history needs no process stop, but its input authorization must never revive on a later A → B → A transfer.
      this.db.prepare(`INSERT INTO builder_revoked_dispatches(dispatch_id,handover_id,requires_stop)
        SELECT d.id,?,0 FROM dispatches d JOIN dispatch_items i ON i.dispatch_id=d.id WHERE i.item_id=?
        AND NOT EXISTS (SELECT 1 FROM builder_revoked_dispatches r WHERE r.dispatch_id=d.id)`).run(id,item.id);
      this.db.prepare(`INSERT INTO builder_revoked_external_sessions(session_id,handover_id,requires_stop)
        SELECT s.id,?,0 FROM external_agent_sessions s JOIN external_agent_session_items i ON i.session_id=s.id WHERE i.item_id=?
        AND NOT EXISTS (SELECT 1 FROM builder_revoked_external_sessions r WHERE r.session_id=s.id)`).run(id,item.id);
      this.store.recordDeliveryEvent(itemKey,accountId,"builder_handover_started",{handoverId:id,from:item.builderAccountId ?? null,to:targetId,note});
      this.stop(id);
      return this.store.getWorkItem(itemKey);
    });
  }

  retry(itemKey: string, handoverId: string) {
    return this.store.database.transaction(() => {
      const item = this.store.getWorkItem(itemKey), handover = latestBuilderHandover(this.store.database,item.id);
      if (!handover || handover.id !== handoverId || handover.status !== "blocked") throw conflict("builder_handover_changed","交接已变更，请刷新后重试。");
      this.target(item.id,handover.to_account_id);
      this.db.prepare("UPDATE builder_handovers SET status='stopping',reason='',updated_at=? WHERE id=?").run(new Date().toISOString(),handover.id);
      this.stop(handover.id);
      return this.store.getWorkItem(itemKey);
    });
  }

  private block(handover: BuilderHandover, reason: string) {
    const now = new Date().toISOString();
    this.db.prepare("UPDATE builder_handovers SET status='blocked',reason=?,updated_at=? WHERE id=? AND status='stopping'").run(reason,now,handover.id);
    const item = this.db.prepare("SELECT item_key FROM work_items WHERE id=?").get(handover.item_id) as {item_key:string};
    this.store.recordDeliveryEvent(item.item_key,handover.initiated_by,"builder_handover_blocked",{handoverId:handover.id,reason});
  }

  private stop(id: string) {
    const handover = this.db.prepare("SELECT * FROM builder_handovers WHERE id=?").get(id) as unknown as BuilderHandover;
    if (this.db.prepare("SELECT 1 FROM builder_revoked_external_sessions WHERE handover_id=? AND requires_stop=1").get(id)) {
      this.block(handover,"外部会话没有可核实的停止控制通道，无法确认已停止。执行授权已冻结，不能启动接手任务。"); return;
    }
    if (this.db.prepare(`SELECT 1 FROM ai_executions WHERE item_id=? AND status IN ('created','running','waiting_for_human')
      UNION ALL SELECT 1 FROM managed_runs r JOIN managed_stages s ON s.run_id=r.id,json_each(r.scope_json,'$.itemKeys') i
      JOIN work_items w ON w.item_key=i.value WHERE w.id=? AND s.status IN ('ready','running','waiting_for_human','unknown') LIMIT 1`)
      .get(handover.item_id,handover.item_id)) {
      this.block(handover,"存在尚未停止的托管执行，当前交接流程无法确认其停止。"); return;
    }
    const rows = this.db.prepare(`SELECT d.id,d.account_id,d.status,s.id AS session_id,s.status AS session_status,
      d.agent_kind,n.last_seen_at,n.revoked_at FROM builder_revoked_dispatches r JOIN dispatches d ON d.id=r.dispatch_id
      JOIN nodes n ON n.id=d.node_id LEFT JOIN agent_sessions s ON s.dispatch_id=d.id WHERE r.handover_id=? AND r.requires_stop=1`).all(id) as unknown as Execution[];
    for (const row of rows) {
      if (row.status === "cancelled" && !row.session_id) continue;
      if (!row.session_id) { this.block(handover,"旧派单已送达节点但尚无可控会话，无法确认停止。"); return; }
      if (row.revoked_at || !isNodeOnline(row.last_seen_at ?? undefined)) {
        this.block(handover,"旧执行节点离线或已撤销，无法确认停止。节点恢复后请手动重试。"); return;
      }
      const linked = this.db.prepare("SELECT stop_command_id FROM builder_revoked_dispatches WHERE dispatch_id=?").get(row.id) as {stop_command_id:string|null};
      const pending = this.db.prepare("SELECT id,status,kind FROM agent_session_commands WHERE session_id=? AND status IN ('queued','delivering','delivery_unknown') ORDER BY rowid DESC LIMIT 1")
        .get(row.session_id) as {id:string;status:string;kind:string}|undefined;
      if (pending && pending.kind === "message" && pending.status !== "queued") {
        this.block(handover,"旧继续执行指令正在送达或结果未知，暂时不能安全停止。请核实后重试。"); return;
      }
      if (linked.stop_command_id) {
        const command = this.db.prepare("SELECT status FROM agent_session_commands WHERE id=?").get(linked.stop_command_id) as {status:string};
        if (["queued","delivering"].includes(command.status)
          || command.status === "delivered" && ["idle","suspended"].includes(row.session_status ?? "")) continue;
      }
      const commandId = randomUUID(), now = new Date().toISOString();
      this.db.prepare("UPDATE agent_session_commands SET status='cancelled',cancelled_at=?,error=? WHERE session_id=? AND (status='queued' OR kind='interrupt' AND status='delivery_unknown')")
        .run(now,"已由 Builder 交接停止请求取代",row.session_id);
      const turn = this.db.prepare("SELECT turn_id FROM agent_session_messages WHERE session_id=? AND turn_id IS NOT NULL ORDER BY position DESC,rowid DESC LIMIT 1")
        .get(row.session_id) as {turn_id:string}|undefined;
      if (!turn && row.agent_kind !== "opencode" && ["active","stalled"].includes(row.session_status ?? "")) {
        this.block(handover,"旧执行尚未上报可停止的回合，无法安全发送停止请求。请稍后手动重试。"); return;
      }
      this.db.prepare(`INSERT INTO agent_session_commands(id,session_id,account_id,kind,text,turn_id,status,created_at)
        VALUES (?,?,?,'interrupt',?,?,'queued',?)`).run(commandId,row.session_id,row.account_id,"Builder 交接：停止旧执行",turn?.turn_id ?? null,now);
      this.db.prepare("UPDATE builder_revoked_dispatches SET stop_command_id=? WHERE dispatch_id=?").run(commandId,row.id);
    }
    this.reconcile(id);
  }

  /** Called after a node snapshot, and on delivery reads to surface offline/timeouts. Never retries a blocked handover. */
  reconcile(id: string) {
    this.store.database.transaction(() => {
      const handover = this.db.prepare("SELECT * FROM builder_handovers WHERE id=?").get(id) as unknown as BuilderHandover|undefined;
      if (!handover || handover.status !== "stopping") return;
      const rows = this.db.prepare(`SELECT d.status AS dispatch_status,s.status AS session_status,s.updated_at,s.turn_state_json,
        c.status AS command_status,c.delivered_at,n.last_seen_at,n.revoked_at FROM builder_revoked_dispatches r
        JOIN dispatches d ON d.id=r.dispatch_id JOIN nodes n ON n.id=d.node_id LEFT JOIN agent_sessions s ON s.dispatch_id=d.id
        LEFT JOIN agent_session_commands c ON c.id=r.stop_command_id WHERE r.handover_id=? AND r.requires_stop=1`).all(id) as unknown as Array<{
          dispatch_status:string;session_status:string|null;updated_at:string|null;turn_state_json:string|null;
          command_status:string|null;delivered_at:string|null;last_seen_at:string|null;revoked_at:string|null;
        }>;
      let waiting = false;
      for (const row of rows) {
        if (row.dispatch_status === "cancelled" && !row.session_status) continue;
        if (row.revoked_at || !isNodeOnline(row.last_seen_at ?? undefined)) { this.block(handover,"停止确认前节点离线或已撤销。节点恢复后请手动重试。"); return; }
        if (["failed","unavailable"].includes(row.session_status ?? "")) { this.block(handover,"旧会话停止失败或不可用，无法确认停止，请核实后手动重试。"); return; }
        if (["failed","cancelled","delivery_unknown"].includes(row.command_status ?? "")) { this.block(handover,"停止请求失败或结果未知，请查看旧会话并手动重试。"); return; }
        if (Date.now()-Date.parse(handover.updated_at)>120_000 && row.command_status !== "delivered") { this.block(handover,"等待停止确认超时，请核实节点和旧会话后手动重试。"); return; }
        // The exact stop must be acknowledged, followed by a healthy non-running source snapshot.
        // Unknown/failed is not a stopped process. No timestamp from the agent can forge the server receipt.
        const turn = row.turn_state_json ? JSON.parse(row.turn_state_json) as {turnActive?:boolean} : {};
        if (row.command_status !== "delivered" || !["idle","suspended"].includes(row.session_status ?? "")
          || turn.turnActive === true || !row.updated_at || !row.delivered_at || row.updated_at < row.delivered_at) waiting = true;
      }
      if (waiting) {
        if (Date.now()-Date.parse(handover.updated_at)>120_000) this.block(handover,"等待旧执行停止确认超时，请核实会话后手动重试。");
        return;
      }
      try { this.target(handover.item_id,handover.to_account_id); }
      catch { this.block(handover,"新 Builder 的产品操作或 AI 权限已失效，请恢复权限后重试。"); return; }
      const now = new Date().toISOString();
      this.db.prepare("UPDATE work_items SET builder_account_id=?,builder_assignment='manual',updated_at=? WHERE id=?")
        .run(handover.to_account_id,now,handover.item_id);
      this.db.prepare("UPDATE builder_handovers SET status='completed',reason='',updated_at=? WHERE id=?").run(now,id);
      const item = this.db.prepare("SELECT item_key FROM work_items WHERE id=?").get(handover.item_id) as {item_key:string};
      this.store.recordDeliveryEvent(item.item_key,handover.initiated_by,"builder_changed",{handoverId:id,from:handover.from_account_id,to:handover.to_account_id,note:handover.note,
        fromName:handover.from_account_id ? new AccountStore(this.store.database).displayNames([handover.from_account_id]).get(handover.from_account_id) ?? "已删除账号" : "待分配",
        toName:handover.to_account_id ? new AccountStore(this.store.database).displayNames([handover.to_account_id]).get(handover.to_account_id) ?? "已删除账号" : "待分配"});
    });
  }

  forSession(sessionId: string) {
    const rows = this.db.prepare(`SELECT r.handover_id FROM builder_revoked_dispatches r JOIN agent_sessions s ON s.dispatch_id=r.dispatch_id WHERE s.id=?`)
      .all(sessionId) as Array<{handover_id:string}>;
    for (const row of rows) this.reconcile(row.handover_id);
  }
}
