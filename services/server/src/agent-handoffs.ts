import { randomUUID } from "node:crypto";
import { assertBuilderExecution, assertDispatchExecution, assertExternalExecution } from "./builder-authority.js";
import { deliveryRound } from "./delivery-round.js";
import { conflict } from "./errors.js";
import { ImplementationPlans, planDigest } from "./implementation-plans.js";
import { itemExecutionBlockers, itemExecutionCheckpoint, executionBlocksTakeover, takeOverItemExecutions } from "./item-execution-blockers.js";
import type { MissionGoStore } from "./store.js";
import type { MissionGoDatabase } from "./storage/database.js";

interface HandoffRow {
  id:string; item_id:string; account_id:string; target_identity:string; target_session_id:string|null;
  target_dispatch_id:string|null; scope_json:string; round_key:string|null; checkpoint:string;
  note:string; request_digest:string; result_json:string; consumed_at:string|null; superseded_at:string|null;
}
export interface AgentHandoffTarget { sessionId:string; identity:string; dispatchId?:string; agentKind:string; name:string }

/** Human handoff authority is separate from approval and from the business status. */
export class AgentHandoffs {
  constructor(private readonly store:MissionGoStore) {}
  private get db() { return this.store.database.connection; }

  pending(accountId:string,key:string) {
    const row=this.db.prepare(`SELECT id,target_dispatch_id AS dispatchId,target_session_id AS sessionId,created_at AS createdAt
      FROM agent_handoffs WHERE item_id=? AND account_id=? AND consumed_at IS NULL AND superseded_at IS NULL`)
      .get(this.store.getWorkItem(key).id,accountId) as {id:string;dispatchId:string|null;sessionId:string|null;createdAt:string}|undefined;
    return row ? {id:row.id,createdAt:row.createdAt,...(row.dispatchId?{dispatchId:row.dispatchId}:{}),...(row.sessionId?{sessionId:row.sessionId}:{})} : undefined;
  }

  targets(accountId:string,key:string):AgentHandoffTarget[] {
    const item=this.store.getWorkItem(key),plans=new ImplementationPlans(this.store.database);
    const rows=this.db.prepare(`SELECT s.id AS sessionId,'native:'||s.client_id||':'||s.agent_kind||':'||s.ref_kind||':'||s.session_ref AS identity,
      NULL AS dispatchId,s.agent_kind AS agentKind,COALESCE(s.name,s.agent_kind) AS name
      FROM external_agent_sessions s JOIN external_agent_session_items i ON i.session_id=s.id
      WHERE s.account_id=? AND i.item_id=? AND i.link_kind='approval' AND s.archived_at IS NULL
      AND NOT EXISTS(SELECT 1 FROM external_agent_session_items x JOIN work_items w ON w.id=x.item_id WHERE x.session_id=s.id AND w.product_id!=?)
      AND NOT EXISTS(SELECT 1 FROM builder_revoked_external_sessions r WHERE r.session_id=s.id)
      UNION ALL SELECT s.id,'dispatch:'||d.id,d.id,s.agent_kind,COALESCE(d.session_name,s.agent_kind)
      FROM free_session_starts f JOIN dispatches d ON d.id=f.dispatch_id JOIN agent_sessions s ON s.dispatch_id=d.id JOIN nodes n ON n.id=d.node_id
      WHERE d.account_id=? AND f.product_id=? AND d.status='launched' AND d.archived_at IS NULL AND s.archived_at IS NULL
      AND n.revoked_at IS NULL AND s.agent_session_ref NOT LIKE 'pending:%'
      AND NOT EXISTS(SELECT 1 FROM dispatch_items i WHERE i.dispatch_id=d.id AND i.item_id=?)
      AND NOT EXISTS(SELECT 1 FROM builder_revoked_dispatches r WHERE r.dispatch_id=d.id)`)
      .all(accountId,item.id,item.productId,accountId,item.productId,item.id) as unknown as Array<AgentHandoffTarget & {dispatchId:string|null}>;
    return rows.filter(row=>{const p=plans.proposal(accountId,row.identity);return p?.valid && p.keys.includes(key);})
      .map(row=>({sessionId:row.sessionId,identity:row.identity,agentKind:row.agentKind,name:row.name,...(row.dispatchId?{dispatchId:row.dispatchId}:{})}));
  }

  replay(accountId:string,key:string,idempotencyKey:string,digest:string):Record<string,unknown>|undefined {
    const row=this.db.prepare("SELECT request_digest,result_json FROM agent_handoffs WHERE created_by=? AND item_id=? AND idempotency_key=?")
      .get(accountId,this.store.getWorkItem(key).id,idempotencyKey) as {request_digest:string;result_json:string}|undefined;
    if(!row) return undefined;
    if(row.request_digest!==digest) throw conflict("agent_handoff_key_reused","交接请求键已用于其他内容，请刷新后重试。");
    return JSON.parse(row.result_json);
  }

  create(input:{key:string;accountId:string;createdBy:string;identity:string;sessionId?:string;dispatchId?:string;
    note:string;idempotencyKey:string;digest:string;result:Record<string,unknown>}):Record<string,unknown> {
    const item=this.store.getWorkItem(input.key);
    this.assertClear(input.key,input.dispatchId,input.sessionId);
    const now=new Date().toISOString(),id=randomUUID(),result={...input.result,handoffId:id,statusChanged:false};
    this.db.prepare("UPDATE agent_handoffs SET superseded_at=? WHERE item_id=? AND consumed_at IS NULL AND superseded_at IS NULL").run(now,item.id);
    this.db.prepare(`INSERT INTO agent_handoffs(id,item_id,account_id,created_by,target_identity,target_session_id,target_dispatch_id,
      scope_json,round_key,checkpoint,note,idempotency_key,request_digest,result_json,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(id,item.id,input.accountId,input.createdBy,input.identity,input.sessionId??null,input.dispatchId??null,
        new ImplementationPlans(this.store.database).scope([item.key]),deliveryRound(this.store.database,item.id,true),
        itemExecutionCheckpoint(this.store.database,item.id,input.dispatchId,input.sessionId),input.note,input.idempotencyKey,input.digest,JSON.stringify(result),now);
    this.store.recordDeliveryEvent(item.key,input.createdBy,"agent_handoff_requested",{handoffId:id,targetSessionId:input.sessionId,targetDispatchId:input.dispatchId,note:input.note});
    return result;
  }

  assertClear(key:string,dispatchId?:string,sessionId?:string):void {
    const item=this.store.getWorkItem(key);
    if(item.status!=="in_progress") throw conflict("agent_handoff_changed","条目已不处于处理中，请刷新后重新核对。");
    if(itemExecutionBlockers(this.store.database,item.id,dispatchId,sessionId).some(executionBlocksTakeover)) {
      throw conflict("execution_stop_unconfirmed","原执行仍有实际活动或待执行命令，请先在原会话处理。");
    }
  }

  /** Called inside the normal claim transaction, after the persisted plan/mode gate. */
  consume(key:string,accountId:string,identity:string):string {
    const item=this.store.getWorkItem(key);
    const row=this.db.prepare(`SELECT * FROM agent_handoffs WHERE item_id=? AND account_id=? AND target_identity=?
      AND consumed_at IS NULL AND superseded_at IS NULL`).get(item.id,accountId,identity) as unknown as HandoffRow|undefined;
    if(!row) throw conflict("agent_handoff_required","处理中条目需要人工明确交给本会话接手，不能仅凭关联记录重新领取。");
    assertBuilderExecution(this.store.database,item.id,accountId);
    if(row.target_dispatch_id) {
      assertDispatchExecution(this.store.database,row.target_dispatch_id);
      if(!this.db.prepare(`SELECT 1 FROM dispatches d JOIN nodes n ON n.id=d.node_id LEFT JOIN agent_sessions s ON s.dispatch_id=d.id
        WHERE d.id=? AND d.account_id=? AND d.status IN ('delivered','launched') AND d.archived_at IS NULL AND s.archived_at IS NULL AND n.revoked_at IS NULL`)
        .get(row.target_dispatch_id,accountId)) throw conflict("agent_handoff_changed","目标派单已不可用，请重新核对接手目标。");
    } else {
      assertExternalExecution(this.store.database,row.target_session_id!);
      if(!this.db.prepare("SELECT 1 FROM external_agent_sessions WHERE id=? AND account_id=? AND archived_at IS NULL").get(row.target_session_id!,accountId)) {
        throw conflict("agent_handoff_changed","目标会话已不可用，请重新核对接手目标。");
      }
    }
    this.assertClear(key,row.target_dispatch_id??undefined,row.target_dispatch_id?undefined:row.target_session_id??undefined);
    if(row.scope_json!==new ImplementationPlans(this.store.database).scope([key]) || row.round_key!==deliveryRound(this.store.database,item.id,true)
      || row.checkpoint!==itemExecutionCheckpoint(this.store.database,item.id,row.target_dispatch_id??undefined,row.target_dispatch_id?undefined:row.target_session_id??undefined)) {
      throw conflict("agent_handoff_changed","交接后的条目或旧执行已有变化，请重新核实并明确交接。");
    }
    const now=new Date().toISOString();
    takeOverItemExecutions(this.store.database,item.id,accountId,row.target_dispatch_id??"",row.target_dispatch_id?"":row.target_session_id??"");
    this.db.prepare("UPDATE agent_handoffs SET consumed_at=? WHERE id=?").run(now,row.id);

    return row.id;
  }
}

export const handoffRequestDigest=(value:unknown)=>planDigest(value);

/** Rechecked at node delivery and immediately before launch as well as at Agent claim. */
export function handoffDispatchIsCurrent(database:MissionGoDatabase,dispatchId:string):boolean {
  const rows=database.connection.prepare(`SELECT h.*,w.item_key,w.status FROM agent_handoffs h JOIN work_items w ON w.id=h.item_id
    WHERE h.target_dispatch_id=?`).all(dispatchId) as unknown as Array<HandoffRow & {item_key:string;status:string}>;
  if(!rows.length) return true;
  return rows.every(row=>{
    if(row.consumed_at || row.superseded_at || row.status!=="in_progress") return false;
    try {assertBuilderExecution(database,row.item_id,row.account_id);} catch {return false;}
    return row.scope_json===new ImplementationPlans(database).scope([row.item_key]) && row.round_key===deliveryRound(database,row.item_id,true)
      && row.checkpoint===itemExecutionCheckpoint(database,row.item_id,dispatchId)
      && !itemExecutionBlockers(database,row.item_id,dispatchId).some(executionBlocksTakeover);
  });
}
