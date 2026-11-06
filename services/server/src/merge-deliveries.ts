import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import type { MissionGoStore } from "./store.js";
import { conflict, notFound } from "./errors.js";
import { recoverExecutionAuthorization } from "./execution-authorization-recovery.js";
import { deliveryRound } from "./delivery-round.js";
import { FreeSessionStore, type FreeSessionConfig } from "./free-session-store.js";
import { DispatchStore } from "./dispatch-store.js";
import { AgentSessionStore } from "./agent-session-store.js";
import { collaborationBlockers } from "./collaboration-policy.js";

const sha = z.string().regex(/^[a-f0-9]{40}$/);
export const mergeEvidenceSchema = z.object({
  head: sha, base: sha, checkedAt: z.string().datetime(),
  checks: z.enum(["passed", "pending", "failed", "unknown"]),
  mergeable: z.enum(["clean", "conflicting", "unknown"]),
  source: z.string().trim().min(1).max(500),
});
export const deliverySchema = z.object({
  itemKeys: z.array(z.string().regex(/^[A-Z][A-Z0-9]*-[0-9]+$/)).min(1).max(20),
  repository: z.string().regex(/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
  pullRequest: z.number().int().positive(), head: sha,
  targetBranch: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._/-]{0,150}$/),
  summary: z.string().trim().min(1).max(2000),
  validation: z.string().trim().min(1).max(4000),
  requiredArtifacts: z.array(z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/)).max(20),
  noReleaseReason: z.string().trim().min(1).max(4000).optional(),
  evidence: mergeEvidenceSchema,
}).refine(d => d.requiredArtifacts.length > 0 ? !d.noReleaseReason : Boolean(d.noReleaseReason), "Explicit release scope is required.");
export type DeliveryInput = z.infer<typeof deliverySchema>;
type Evidence = z.infer<typeof mergeEvidenceSchema>;
type Identity = { dispatchId?: string; sessionId?: string };
interface Delivery extends DeliveryInput {
  id: string; productId: string; accountId: string; clientId: string; identity: Identity;
  sessionId: string; revision: string; scope: string; activity: string;
  state: "proposed" | "confirmed" | "withdrawn" | "batched" | "merged";
  createdAt: string; confirmedAt?: string; batchId?: string;
}
interface Batch {
  id: string; productId: string; accountId: string; requestKey: string;
  dispatchId: string; sessionId: string; config: FreeSessionConfig; publish: boolean;
  deliveries: string[]; selection: {id:string;revision:string}[]; state: "active" | "finished"; createdAt: string;
  results: Record<string, { status: "merged" | "blocked"; head: string; commit?: string; detail: string }>;
}
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const changed = () => conflict("merge_delivery_changed", "交付内容、代码或执行范围已变化，请重新核对并确认。");

/** Explicit delivery intent is independent of item state and chat inference. */
export class MergeDeliveries {
  constructor(private readonly store: MissionGoStore) {}
  private get db() { return this.store.database; }
  private read<T>(table: "merge_deliveries" | "merge_batches", id: string): T {
    const row = this.db.connection.prepare(`SELECT data_json FROM ${table} WHERE id=?`).get(id) as {data_json:string}|undefined;
    if (!row) throw notFound("Merge record");
    return JSON.parse(row.data_json) as T;
  }
  private save(d: Delivery) {
    this.db.connection.prepare("UPDATE merge_deliveries SET state=?,data_json=? WHERE id=?")
      .run(d.state, JSON.stringify(d), d.id);
  }
  private saveBatch(b: Batch & {entries?:unknown}) {
    const {entries:_entries,...stored}=b;
    this.db.connection.prepare("UPDATE merge_batches SET state=?,data_json=? WHERE id=?")
      .run(b.state, JSON.stringify(stored), b.id);
  }
  private scope(keys: string[]) {
    return digest(keys.map(key => {
      const i = this.store.getWorkItem(key);
      return [i.id, i.contentVersion, i.builderAccountId, deliveryRound(this.db, i.id)];
    }));
  }
  private activity(sessionId: string) {
    // New human input invalidates the offer, regardless of how it is worded.
    return digest([
      this.db.connection.prepare("SELECT id FROM agent_session_commands WHERE session_id=? AND kind='message' ORDER BY rowid DESC LIMIT 1").get(sessionId),
      this.db.connection.prepare("SELECT id FROM external_native_commands WHERE session_id=? ORDER BY rowid DESC LIMIT 1").get(sessionId),
      this.db.connection.prepare("SELECT source_id,text FROM agent_session_messages WHERE session_id=? AND role='user' ORDER BY position DESC LIMIT 1").get(sessionId),
      this.db.connection.prepare("SELECT source_id,payload_json FROM external_native_messages WHERE session_id=? AND json_extract(payload_json,'$.role')='user' ORDER BY position DESC LIMIT 1").get(sessionId),
    ]);
  }
  private sourceValid(d: Delivery) {
    for (const itemKey of d.itemKeys) {
      recoverExecutionAuthorization(this.store, d.accountId, d.clientId, {itemKey, ...d.identity});
      if (this.store.getWorkItem(itemKey).status !== "in_progress") throw changed();
    }
    if (this.scope(d.itemKeys) !== d.scope || this.activity(d.sessionId) !== d.activity) throw changed();
  }
  private fresh(e: Evidence, head: string) {
    const age = Date.now() - Date.parse(e.checkedAt);
    return e.head === head && age >= -30_000 && age <= 5 * 60_000;
  }
  private eligible(d: Delivery): string | undefined {
    try { this.sourceValid(d); } catch { return "changed"; }
    if (d.state === "batched") return d.itemKeys.some(key => collaborationBlockers(this.db, this.store.getWorkItem(key).id)>0) ? "dependency" : undefined;
    if (!this.fresh(d.evidence, d.head)) return "stale";
    if (d.evidence.checks !== "passed") return d.evidence.checks;
    if (d.evidence.mergeable !== "clean") return d.evidence.mergeable;
    if (d.itemKeys.some(key => collaborationBlockers(this.db, this.store.getWorkItem(key).id)>0)) return "dependency";
    return undefined;
  }
  propose(accountId: string, clientId: string, identity: Identity, requestKey: string, input: DeliveryInput) {
    input = deliverySchema.parse(input);
    const keys = [...new Set(input.itemKeys)].sort();
    return this.db.transaction(() => {
      const previous = this.db.connection.prepare("SELECT id FROM merge_deliveries WHERE account_id=? AND client_id=? AND request_key=?")
        .get(accountId, clientId, requestKey) as {id:string}|undefined;
      if (previous) {
        const d = this.read<Delivery>("merge_deliveries", previous.id);
        if (digest({...input,itemKeys:keys}) !== d.revision || digest(identity) !== digest(d.identity)) throw changed();
        return this.view(d);
      }
      for (const itemKey of keys) recoverExecutionAuthorization(this.store, accountId, clientId, {itemKey,...identity});
      const productId = this.store.getWorkItem(keys[0]!).productId;
      if (keys.some(key => this.store.getWorkItem(key).productId !== productId || this.store.getWorkItem(key).status !== "in_progress")) throw changed();
      const sessionId = identity.sessionId ?? (this.db.connection.prepare("SELECT id FROM agent_sessions WHERE dispatch_id=?")
        .get(identity.dispatchId!) as {id:string}|undefined)?.id;
      if (!sessionId) throw changed();
      const existing = this.listRaw(productId).filter(d => d.itemKeys.some(k => keys.includes(k)) && !["withdrawn","merged"].includes(d.state));
      if (existing.some(d => d.state === "batched")) throw conflict("merge_batch_active", "这些改动已有合并批次，请核实原批次。");
      for (const d of existing) { d.state = "withdrawn"; this.save(d); }
      const d: Delivery = {...input,itemKeys:keys,id:randomUUID(),productId,accountId,clientId,identity,sessionId,
        revision:digest({...input,itemKeys:keys}),scope:this.scope(keys),activity:this.activity(sessionId),state:"proposed",createdAt:new Date().toISOString()};
      this.db.connection.prepare("INSERT INTO merge_deliveries(id,product_id,account_id,client_id,request_key,state,data_json) VALUES (?,?,?,?,?,?,?)")
        .run(d.id,productId,accountId,clientId,requestKey,d.state,JSON.stringify(d));
      return this.view(d);
    });
  }
  private listRaw(productId: string): Delivery[] {
    return (this.db.connection.prepare("SELECT data_json FROM merge_deliveries WHERE product_id=? ORDER BY rowid DESC").all(productId) as {data_json:string}[])
      .map(row => JSON.parse(row.data_json) as Delivery);
  }
  private view(d: Delivery) {
    const {clientId:_client,identity:_identity,activity:_activity,scope:_scope,...visible} = d;
    return {...visible, blocker: ["proposed","confirmed","batched"].includes(d.state) ? this.eligible(d) : undefined,
      pullRequestUrl:`${d.repository}/pull/${d.pullRequest}`};
  }
  list(productId: string, accountId: string) {
    return this.listRaw(productId).filter(d => d.accountId === accountId && !["withdrawn","merged"].includes(d.state)).map(d => this.view(d));
  }
  product(id: string) { return this.read<Delivery>("merge_deliveries",id).productId; }
  decide(accountId: string, id: string, revision: string, decision: "confirm" | "withdraw") {
    return this.db.transaction(() => {
      const d = this.read<Delivery>("merge_deliveries",id);
      if (d.accountId !== accountId || d.revision !== revision || d.state === "batched" || d.state === "merged") throw changed();
      if (decision === "confirm") {
        if (!["proposed","confirmed"].includes(d.state)) throw changed();
        this.sourceValid(d);
        d.state = "confirmed"; d.confirmedAt ??= new Date().toISOString();
      } else d.state = "withdrawn";
      this.save(d); return this.view(d);
    });
  }
  refresh(accountId: string, clientId: string, identity: Identity, id: string, evidence: Evidence) {
    const d = this.read<Delivery>("merge_deliveries",id);
    if (d.accountId !== accountId || d.clientId !== clientId || digest(identity) !== digest(d.identity) || !["proposed","confirmed"].includes(d.state)) throw changed();
    this.sourceValid(d);
    d.evidence = mergeEvidenceSchema.parse(evidence);
    if (evidence.head !== d.head) d.state = "withdrawn";
    this.save(d); return this.view(d);
  }
  batches(productId: string, accountId: string) {
    return (this.db.connection.prepare("SELECT data_json FROM merge_batches WHERE product_id=? AND account_id=? ORDER BY rowid DESC LIMIT 20")
      .all(productId,accountId) as {data_json:string}[]).map(row => JSON.parse(row.data_json) as Batch);
  }
  start(accountId: string, requestKey: string, selection: {id:string;revision:string}[], config: FreeSessionConfig, publish: boolean) {
    return this.db.transaction(() => {
      const prev = this.db.connection.prepare("SELECT id FROM merge_batches WHERE account_id=? AND request_key=?").get(accountId,requestKey) as {id:string}|undefined;
      if (prev) {
        const b = this.read<Batch>("merge_batches",prev.id);
        if (digest(b.config)!==digest(config) || b.publish!==publish || digest(b.selection)!==digest(selection)) throw changed();
        return b;
      }
      if (!selection.length || selection.length>20 || new Set(selection.map(s=>s.id)).size!==selection.length) throw changed();
      if (this.db.connection.prepare("SELECT 1 FROM merge_batches WHERE product_id=? AND state='active'").get(config.productId))
        throw conflict("merge_batch_active","当前项目已有合并批次，请进入原会话核实或继续。");
      const deliveries = selection.map(s => {
        const d=this.read<Delivery>("merge_deliveries",s.id);
        if(d.accountId!==accountId || d.productId!==config.productId || d.revision!==s.revision || d.state!=="confirmed" || this.eligible(d)==="changed") throw changed();
        return d;
      });
      if(new Set(deliveries.map(d=>d.repository)).size!==1 || new Set(deliveries.map(d=>d.targetBranch)).size!==1) throw changed();
      const id=randomUUID();
      const text = `执行用户已授权的合并批次 ${id}。派单启动后先调用 get_merge_batch，使用本会话原 dispatchId。仅合并批次冻结的 PR 与 head；每次执行前重新调用 get_merge_batch，entries 中 blocker 非空必须停止。用 gh pr merge --match-head-commit 绑定获准 head，禁止 --admin 或绕过保护；不要领取开发条目，不要重新创建批次。每项合并前重新核实目标仓库、主线、依赖、CI 及预期 head，提交变化必须停止，不允许合并新 head。清单中的旧检查证据仅供参考，由本合并会话统一读取实时结果；CI 排队或运行中时保留原批次等待，先查状态且状态未变时降低轮询频率，不将等待标记为失败或另建会话；实际检查失败、冲突或未结束依赖必须阻止实际合并。机械性冲突可调查，语义冲突交回原开发会话；新增代码需重新交付确认。使用 report_merge_batch 逐项记录实际结果；未知结果保留原批次。发布授权：${publish ? "合并完成后按项目既有全量候选覆盖门禁发布；批次选择不缩小发布范围。" : "仅合并，不发布。"} 完成所有操作且核实无后台执行后，才结束批次。遵守仓库权限和发布规则。`;
      const dispatches=new DispatchStore(this.db);
      const free=new FreeSessionStore(this.db,dispatches,new AgentSessionStore(this.db));
      const dispatch=free.prepare(accountId,id,config,text);
      const b: Batch={id,productId:config.productId,accountId,requestKey,dispatchId:dispatch.id,sessionId:dispatch.agentSessionId!,
        config,publish,selection,deliveries:deliveries.map(d=>d.id),state:"active",createdAt:new Date().toISOString(),results:{}};
      this.db.connection.prepare("INSERT INTO merge_batches(id,product_id,account_id,request_key,state,data_json) VALUES (?,?,?,?,?,?)")
        .run(id,b.productId,accountId,requestKey,b.state,JSON.stringify(b));
      for(const d of deliveries){d.state="batched";d.batchId=id;this.save(d);}
      free.finish(accountId,dispatch.id,[]);
      return b;
    });
  }
  batch(accountId: string, dispatchId: string, id: string) {
    const b=this.read<Batch>("merge_batches",id);
    const live=this.db.connection.prepare("SELECT 1 FROM dispatches d JOIN nodes n ON n.id=d.node_id JOIN agent_sessions s ON s.dispatch_id=d.id WHERE d.id=? AND d.account_id=? AND s.id=? AND d.status='launched' AND n.revoked_at IS NULL")
      .get(dispatchId,accountId,b.sessionId);
    if(b.accountId!==accountId || !live) throw changed();
    return {...b, dispatchId, entries:b.deliveries.map(id=>this.view(this.read<Delivery>("merge_deliveries",id)))};
  }
  report(accountId: string, dispatchId: string, id: string, deliveryId: string,
    result: {status:"merged"|"blocked";head:string;commit?:string;detail:string}) {
    return this.db.transaction(()=>{
      const b=this.batch(accountId,dispatchId,id);
      if(!b.deliveries.includes(deliveryId)) throw changed();
      if(b.results[deliveryId]) {
        if(digest(b.results[deliveryId])!==digest(result)) throw changed();
        return b;
      }
      if(b.state!=="active") throw changed();
      const d=this.read<Delivery>("merge_deliveries",deliveryId);
      if(result.head!==d.head) throw changed();
      if(result.status==="merged") {
        sha.parse(result.commit);
        if (this.eligible(d)) throw changed();
        for(const itemKey of d.itemKeys) this.store.submitDevelopmentComplete({itemKey,
          completion:{kind:"github",url:`${d.repository}/pull/${d.pullRequest}`},requiredArtifacts:d.requiredArtifacts,
          ...(d.noReleaseReason?{noReleaseReason:d.noReleaseReason}:{}),summary:result.detail,idempotencyKey:`merge-batch:${id}:${itemKey}`,attribution:{accountId}});
        d.state="merged"; this.save(d);
      }
      b.results[deliveryId]=result; this.saveBatch(b); return b;
    });
  }
  finish(accountId:string,dispatchId:string,id:string) {
    return this.db.transaction(()=>{
      const b=this.batch(accountId,dispatchId,id);
      if(b.state==="finished") return b;
      if(b.deliveries.some(id=>!b.results[id])) throw conflict("merge_results_unknown","仍有结果未核实，不能释放批次。");
      b.state="finished";this.saveBatch(b);
      for(const id of b.deliveries) {const d=this.read<Delivery>("merge_deliveries",id);if(d.state==="batched"){d.state="withdrawn";this.save(d);}}
      return b;
    });
  }
}
