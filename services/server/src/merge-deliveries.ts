import { assertDispatchExecution, assertExternalExecution } from "./builder-authority.js";
import type { NonReleaseVerification } from "./non-release-evidence.js";
import { AccountStore } from "./accounts-store.js";
import { MissionGoError } from "./errors.js";
import { normalizeCompletion, sameCompletion } from "./completion.js";
import { reconciliationActionSchema, combinedValidationSchema, type ReconciliationAction, type ReconciliationState } from "./merge-reconciliation.js";
import { legacyIntegratorPrompt } from "./legacy-merge-authorization.js";
import { readRecoveryTransport } from "./merge-recovery-transport.js";
import type { MergeIntegration, MergeReconciliationPreview, MergeBatchPresentation, SessionDeliveryStage } from "@missiongo/contracts";
import { compactItemKeys } from "@missiongo/domain";
import { integrationActionSchema, integrationDigest, applyIntegrationAction, assertIntegrationMerge, freshIntegrationCheck, integrationDenied, type IntegrationAction } from "./merge-integration.js";
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
const instructionQuote = z.string().trim().min(1).max(500);
export const mergeEvidenceSchema = z.object({
  head: sha, base: sha, checkedAt: z.string().datetime(),
  checks: z.enum(["passed", "pending", "failed", "unknown"]),
  mergeable: z.enum(["clean", "conflicting", "unknown"]),
  source: z.string().trim().min(1).max(500),
});
export const deliverySchema = z.object({
  itemKeys: z.array(z.string().regex(/^[A-Z][A-Z0-9]*-[0-9]+$/)).max(20).default([]),
  productId: z.string().min(1).optional(),
  repository: z.string().regex(/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
  pullRequest: z.number().int().positive(), head: sha,
  targetBranch: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._/-]{0,150}$/),
  summary: z.string().trim().min(1).max(2000),
  validation: z.string().trim().min(1).max(4000),
  requiredArtifacts: z.array(z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,39}$/)).max(20).refine(a=>new Set(a).size===a.length,"Repeated artifact scope."),
  noReleaseReason: z.string().trim().min(1).max(4000).optional(),
  evidence: mergeEvidenceSchema,
}).refine(d => d.requiredArtifacts.length > 0 ? !d.noReleaseReason : Boolean(d.noReleaseReason), "Explicit release scope is required.").refine(d=>d.itemKeys.length>0 || Boolean(d.productId), "A project is required for standalone deliveries.");
export type DeliveryInput = z.infer<typeof deliverySchema>;
type Evidence = z.infer<typeof mergeEvidenceSchema>;
type Identity = { dispatchId?: string; sessionId?: string };
interface Delivery extends DeliveryInput {
  displayTitle?: string;
  releaseReceipts?: {key:string;digest:string;receiptDigest:string;deployedCommit:string;at:string;releases:{artifact:string;version:string;sourceCommit:string}[]}[];
  id: string; productId: string; accountId: string; clientId: string; identity: Identity;
  sessionId: string; revision: string; scope: string; activity: string;
  state: "proposed" | "confirmed" | "withdrawn" | "batched" | "merged";
  createdAt: string; confirmedAt?: string; confirmedBy?: "console" | "session-instruction"; instructionQuote?: string;
  batchId?: string;
  itemScopes?: Record<string,string>;
  reconfirmation?: boolean;
}
interface Batch {
  saveAsDefault?: boolean;
  displayBoundaries?: Record<string, { at: string; settings: string; humanStamp: string | null }>;
  reconciliation?: ReconciliationState;
  integration?: MergeIntegration;
  id: string; productId: string; accountId: string; requestKey: string;
  dispatchId: string; sessionId: string; config: FreeSessionConfig; publish: boolean;
  deliveries: string[]; selection: {id:string;revision:string}[]; state: "active" | "finished"; createdAt: string;
  results: Record<string, { status: "merged" | "blocked"; head: string; commit?: string; detail: string }>;
}
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const changed = () => conflict("merge_delivery_changed", "交付内容、代码或执行范围已变化，请重新核对并确认。");

/** Explicit delivery intent is independent of item state and chat inference. */
export class MergeDeliveries {
  constructor(private readonly store: MissionGoStore) {
    this.db.registerProjectionWriter("merge-display-v1", () => this.store.withProjectionReads(() => this.refreshDisplay()));
  }
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
  private saveBatch(b: Batch & {entries?:unknown;resultsDigest?:string}) {
    const {entries:_entries,resultsDigest:_resultsDigest,...stored}=b;
    this.db.connection.prepare("UPDATE merge_batches SET state=?,data_json=? WHERE id=?")
      .run(b.state, JSON.stringify(stored), b.id);
  }
  private displayReads: Map<string,unknown> | undefined;
  private displayRead<T>(key:string,read:()=>T):T {
    if(!this.displayReads)return read();
    if(!this.displayReads.has(key))this.displayReads.set(key,read());
    return this.displayReads.get(key) as T;
  }
  private scope(keys: string[]) {
    return this.displayRead("scope:"+JSON.stringify(keys),()=>{
    return digest(keys.map(key => {
      const id = this.store.workItemId(key);
      return [id, this.store.workItemContentVersion(key), this.store.workItemBuilderAccountId(key), deliveryRound(this.db, id)];
    }));
    });
  }
  private activity(sessionId: string) {
    return this.displayRead("activity:"+sessionId,()=>{
    // New human input invalidates the offer, regardless of how it is worded.
    return digest([
      this.db.connection.prepare("SELECT id FROM agent_session_commands WHERE session_id=? AND kind='message' ORDER BY rowid DESC LIMIT 1").get(sessionId),
      this.db.connection.prepare("SELECT id FROM external_native_commands WHERE session_id=? ORDER BY rowid DESC LIMIT 1").get(sessionId),
      this.db.connection.prepare("SELECT source_id,text FROM agent_session_messages WHERE session_id=? AND role='user' ORDER BY position DESC LIMIT 1").get(sessionId),
      this.db.connection.prepare("SELECT source_id,payload_json FROM external_native_messages WHERE session_id=? AND json_extract(payload_json,'$.role')='user' ORDER BY position DESC LIMIT 1").get(sessionId),
    ]);
    });
  }
  /** Account ownership and the persisted project binding replace item claim authority only for standalone work. */
  private projectSource(accountId:string,clientId:string,identity:Identity,productId:string) {
    this.store.assertProductWritable(productId);
    const project=this.db.connection.prepare(`SELECT s.id,s.agent_session_ref AS ref,s.settings_revision AS settings,d.id AS dispatchId,d.status,
      COALESCE(s.archived_at,d.archived_at) AS archived,n.revoked_at AS revoked,f.product_id AS productId
      FROM agent_sessions s JOIN dispatches d ON d.id=s.dispatch_id JOIN nodes n ON n.id=d.node_id
      JOIN free_session_starts f ON f.dispatch_id=d.id WHERE d.account_id=? AND ${identity.dispatchId ? "d.id=?" : "s.id=?"}`)
      .get(accountId,identity.dispatchId ?? identity.sessionId ?? "") as {id:string;ref:string;settings:number;dispatchId:string;status:string;archived:string|null;revoked:string|null;productId:string}|undefined;
    if(project) {
      assertDispatchExecution(this.db,project.dispatchId);
      if(project.productId!==productId || project.status!=="launched" || project.archived || project.revoked || project.ref.startsWith("pending:")) throw changed();
      return {sessionId:project.id,scope:digest([productId,project.id,project.ref,project.settings])};
    }
    const external=identity.sessionId ? this.db.connection.prepare(`SELECT id,product_id,ref_kind,session_ref,archived_at,native_generation,native_settings_json
      FROM external_agent_sessions WHERE id=? AND account_id=? AND client_id=?`).get(identity.sessionId,accountId,clientId) as
      {id:string;product_id:string|null;ref_kind:string;session_ref:string;archived_at:string|null;native_generation:number;native_settings_json:string|null}|undefined : undefined;
    if(!external || external.product_id!==productId || external.archived_at) throw changed();
    if(this.db.connection.prepare(`SELECT 1 FROM external_agent_sessions s JOIN nodes n ON n.id=s.native_node_id
      WHERE s.id=? AND n.revoked_at IS NOT NULL`).get(external.id)) throw changed();
    assertExternalExecution(this.db,external.id);
    return {sessionId:external.id,scope:digest([productId,external.id,external.ref_kind,external.session_ref,JSON.parse(external.native_settings_json ?? "{}").revision])};
  }
  private deliveryScope(d:Delivery) {
    return d.itemKeys.length ? this.scope(d.itemKeys) : this.projectSource(d.accountId,d.clientId,d.identity,d.productId).scope;
  }
  private sourceValid(d: Delivery) {
    for (const itemKey of d.itemKeys) {
      recoverExecutionAuthorization(this.store, d.accountId, d.clientId, {itemKey, ...d.identity});
      if (!["in_progress","development_complete","pending_verification"].includes(this.store.getWorkItem(itemKey).status)) throw changed();
    }
    if (this.deliveryScope(d) !== d.scope || this.activity(d.sessionId) !== d.activity) throw changed();
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
  /** Confirm binds the session's latest human input; a same-turn imperative order may confirm without a console click. */
  private confirm(d: Delivery, by: "console" | "session-instruction", quote?: string) {
    if (!["proposed", "confirmed"].includes(d.state)) throw changed();
    this.sourceValid(d);
    d.state = "confirmed"; d.confirmedAt ??= new Date().toISOString();
    d.confirmedBy ??= by; if (quote) d.instructionQuote ??= quote;
    this.save(d);
  }
  propose(accountId: string, clientId: string, identity: Identity, requestKey: string, input: DeliveryInput, confirmation?: {quote: string}) {
    input = deliverySchema.parse(input);
    const quote = confirmation ? instructionQuote.parse(confirmation.quote) : undefined;
    const keys = [...new Set(input.itemKeys)].sort();
    return this.db.transaction(() => {
      const previous = this.db.connection.prepare("SELECT id FROM merge_deliveries WHERE account_id=? AND client_id=? AND request_key=?")
        .get(accountId, clientId, requestKey) as {id:string}|undefined;
      if (previous) {
        const d = this.read<Delivery>("merge_deliveries", previous.id);
        if (digest({...input,itemKeys:keys}) !== d.revision || digest(identity) !== digest(d.identity)) throw changed();
        if (quote && d.state === "proposed") this.confirm(d, "session-instruction", quote);
        return this.view(d);
      }
      for (const itemKey of keys) recoverExecutionAuthorization(this.store, accountId, clientId, {itemKey,...identity});
      const productId = keys.length ? this.store.getWorkItem(keys[0]!).productId : input.productId!;
      if(input.productId && input.productId!==productId) throw changed();
      const project = keys.length ? undefined : this.projectSource(accountId,clientId,identity,productId);
      if (keys.some(key => this.store.getWorkItem(key).productId !== productId || !["in_progress","development_complete","pending_verification"].includes(this.store.getWorkItem(key).status))) throw changed();
      const sessionId = project?.sessionId ?? identity.sessionId ?? (this.db.connection.prepare("SELECT id FROM agent_sessions WHERE dispatch_id=?")
        .get(identity.dispatchId!) as {id:string}|undefined)?.id;
      if (!sessionId) throw changed();
      const history = this.listRaw(productId);
      const overlaps = (d:Delivery) => keys.length ? d.itemKeys.some(key=>keys.includes(key))
        : !d.itemKeys.length && d.repository===input.repository && d.pullRequest===input.pullRequest;
      const reconfirmation = history.some(d => d.accountId === accountId && d.sessionId === sessionId
        && d.state !== "merged" && overlaps(d));
      const existing = history.filter(d => d.accountId===accountId && d.clientId===clientId && d.sessionId===sessionId && overlaps(d) && !["withdrawn","merged"].includes(d.state));
      if (existing.some(d => d.state === "batched")) throw conflict("merge_batch_active", "这些改动已有合并批次，请核实原批次。");
      for (const d of existing) { d.state = "withdrawn"; this.save(d); }
      const d: Delivery = {...input,itemKeys:keys,id:randomUUID(),productId,accountId,clientId,identity,sessionId,
        displayTitle:keys.length ? keys.map(key=>this.store.getWorkItem(key).title).join(" / ") : input.summary,
        itemScopes:Object.fromEntries(keys.map(key=>[key,this.scope([key])])),reconfirmation,revision:digest({...input,itemKeys:keys}),scope:project?.scope ?? this.scope(keys),activity:this.activity(sessionId),state:"proposed",createdAt:new Date().toISOString()};
      this.db.connection.prepare("INSERT INTO merge_deliveries(id,product_id,account_id,client_id,request_key,state,data_json) VALUES (?,?,?,?,?,?,?)")
        .run(d.id,productId,accountId,clientId,requestKey,d.state,JSON.stringify(d));
      if (quote) this.confirm(d, "session-instruction", quote);
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
  recomputeList(productId: string, accountId: string) {
    return this.listRaw(productId).filter(d => d.accountId === accountId && !["withdrawn","merged"].includes(d.state)).map(d => this.view(d)).filter(d => d.state === "batched" || d.blocker !== "changed");
  }
  private displaySettings(sessionId: string): string {
    return this.displayRead("settings:"+sessionId,()=>{
    return digest([
      this.db.connection.prepare("SELECT dispatch_id,settings_revision FROM agent_sessions WHERE id=?").get(sessionId),
      this.db.connection.prepare("SELECT json_extract(native_settings_json,'$.revision') AS revision FROM external_agent_sessions WHERE id=?").get(sessionId),
      this.db.connection.prepare("SELECT id FROM agent_session_commands WHERE session_id=? AND kind='message' ORDER BY rowid DESC LIMIT 1").get(sessionId),
      this.db.connection.prepare("SELECT id FROM external_native_commands WHERE session_id=? ORDER BY rowid DESC LIMIT 1").get(sessionId),
    ]);
    });
  }
  private rememberDisplay(b: Batch, d: Delivery) {
    const boundaries = b.displayBoundaries ??= {};
    for (const id of [b.sessionId, d.sessionId]) boundaries[id] ??= { at: new Date().toISOString(), settings: this.displaySettings(id), humanStamp: this.latestHumanStamp(id) };
  }
  private displayUnchanged(b: Batch, sessionId: string): boolean {
    const boundary = b.displayBoundaries?.[sessionId];
    if (!boundary || boundary.settings !== this.displaySettings(sessionId)) return false;
    const stamp = this.latestHumanStamp(sessionId);
    return !stamp || Date.parse(stamp) <= Math.max(Date.parse(boundary.at), boundary.humanStamp ? Date.parse(boundary.humanStamp) : 0);
  }
  /** Old batches have no snapshot: use matching formal completion times only
   * when settings still have their initial revision. Unknown history stays unlabelled. */
  private legacyDisplayUnchanged(sessionId: string, deliveries: Delivery[]): boolean {
    const local = this.db.connection.prepare("SELECT settings_revision FROM agent_sessions WHERE id=?").get(sessionId) as {settings_revision:number}|undefined;
    const external = this.db.connection.prepare("SELECT json_extract(native_settings_json,'$.revision') AS revision FROM external_agent_sessions WHERE id=?").get(sessionId) as {revision:number|null}|undefined;
    if ((local?.settings_revision ?? 0)>1 || (external?.revision ?? 0)>0) return false;
    const completed: number[] = [];
    for (const d of deliveries) for (const key of d.itemKeys) {
      const evidence = this.store.getDevelopmentEvidence(key);
      if (!evidence.handover || !evidence.completion || !sameCompletion(evidence.completion,{kind:"github",url:`${d.repository}/pull/${d.pullRequest}`})) return false;
      completed.push(Date.parse(evidence.handover.createdAt));
    }
    const stamp=this.latestHumanStamp(sessionId);
    return completed.length>0 && (!stamp || Date.parse(stamp)<=Math.max(...completed));
  }
  private latestHumanStamp(sessionId: string): string | null {
    return this.displayRead("human:"+sessionId,()=>{
    const latest = this.db.connection.prepare(`SELECT MAX(stamp) AS stamp FROM (
      SELECT occurred_at AS stamp FROM agent_session_messages WHERE session_id=? AND role='user'
      UNION ALL SELECT created_at FROM agent_session_commands WHERE session_id=? AND kind='message'
      UNION ALL SELECT json_extract(payload_json,'$.occurredAt') FROM external_native_messages WHERE session_id=? AND json_extract(payload_json,'$.role')='user'
      UNION ALL SELECT created_at FROM external_native_commands WHERE session_id=?
    )`).get(sessionId,sessionId,sessionId,sessionId) as {stamp:string|null};
    return latest.stamp;
    });
  }

  /** Shared list/detail projection. Historical receipts never become mutable conversation state. */
  recomputeSessionProgress(productId: string, accountId: string, onlySession?: string, now = Date.now(), onPublishing?: (expires:number) => void): Record<string, SessionDeliveryStage> {
    let rows:Delivery[], batches:Batch[];
    if(onlySession) {
      const latest=this.db.connection.prepare("SELECT data_json FROM merge_deliveries WHERE product_id=? AND account_id=? AND json_extract(data_json,'$.sessionId')=? ORDER BY rowid DESC LIMIT 1").get(productId,accountId,onlySession) as {data_json:string}|undefined;
      const delivery=latest ? JSON.parse(latest.data_json) as Delivery : undefined;
      const batch=delivery ? (delivery.batchId ? this.db.connection.prepare("SELECT data_json FROM merge_batches WHERE id=?").get(delivery.batchId) : undefined)
        : this.db.connection.prepare("SELECT data_json FROM merge_batches WHERE product_id=? AND account_id=? AND json_extract(data_json,'$.sessionId')=? ORDER BY rowid DESC LIMIT 1").get(productId,accountId,onlySession);
      batches=batch ? [JSON.parse((batch as {data_json:string}).data_json) as Batch] : [];
      rows=batches.length ? (this.db.connection.prepare("SELECT data_json FROM merge_deliveries WHERE product_id=? AND account_id=? AND json_extract(data_json,'$.batchId')=? ORDER BY rowid DESC").all(productId,accountId,batches[0]!.id) as {data_json:string}[]).map(row=>JSON.parse(row.data_json) as Delivery) : delivery ? [delivery] : [];
    } else {
      batches=(this.db.connection.prepare("SELECT data_json FROM merge_batches WHERE product_id=? AND account_id=? ORDER BY rowid DESC").all(productId,accountId) as {data_json:string}[]).map(row=>JSON.parse(row.data_json) as Batch);
      rows=(this.db.connection.prepare("SELECT data_json FROM merge_deliveries WHERE product_id=? AND account_id=? ORDER BY rowid DESC").all(productId,accountId) as {data_json:string}[]).map(row=>JSON.parse(row.data_json) as Delivery);
    }
    const byBatch = new Map(batches.map(b=>[b.id,b]));
    const presentations = new Map<string, MergeBatchPresentation>();
    const presentationOf = (b: Batch) => { const cached = presentations.get(b.id); if (cached) return cached; const built = this.presentation(b); presentations.set(b.id, built); return built; };
    const result: Record<string, SessionDeliveryStage> = {};
    const stage = (b:Batch, deliveries:Delivery[], sessionId:string):SessionDeliveryStage|undefined => {
      if (!deliveries.length || deliveries.some(d=>{try{return this.deliveryScope(d)!==d.scope;}catch{return true;}})) return;
      const outcomes = deliveries.map(d=>b.results[d.id]);
      if (outcomes.some(r=>!r)) return b.state === "active" ? "merging" : undefined;
      if (outcomes.some(r=>r?.status === "blocked")) return outcomes.some(r=>r?.status === "merged") ? "partial" : "blocked";
      if (b.displayBoundaries?.[sessionId] ? !this.displayUnchanged(b,sessionId) : !this.legacyDisplayUnchanged(sessionId,deliveries)) return;
      const presentation = presentationOf(b);
      const needsPublication = deliveries.some(d=>d.requiredArtifacts.length>0);
      const publications = deliveries.map(d=>presentation.entries[d.id]?.publication);
      if (needsPublication && publications.every(value=>value === "published" || value === "not_required")) return "published";
      const partiallyPublished = publications.some(value=>value === "partial" || value === "published");
      const publication = b.integration?.publication;
      if (needsPublication && publication && publication.resultsDigest === digest(b.results)) {
        if (publication.state === "publishing" && b.state === "active" && Date.parse(publication.expiresAt)>now) {
          if(sessionId===onlySession)onPublishing?.(Date.parse(publication.expiresAt));
          return "publishing";
        }
        return partiallyPublished ? "publication_partial" : "publication_unknown";
      }
      return partiallyPublished ? "publication_partial" : "merged";
    };
    const seen = new Set<string>();
    for (const d of rows) {
      if (onlySession && d.sessionId!==onlySession) continue;
      if (seen.has(d.sessionId)) continue;
      seen.add(d.sessionId);
      if (d.state === "confirmed" && this.eligible(d)!=="changed") result[d.sessionId]="pending";
      else if (d.batchId) {
        const b = byBatch.get(d.batchId);
        const group = rows.filter(other=>other.batchId===d.batchId && other.sessionId===d.sessionId);
        if (!b || group.some(other=>b.results[other.id]?.status!=="merged" && this.activity(other.sessionId)!==other.activity)) continue;
        const value = stage(b,group,d.sessionId);
        if (value) result[d.sessionId] = value;
      }
    }
    for (const b of batches) {
      if (onlySession && b.sessionId!==onlySession) continue;
      if (seen.has(b.sessionId)) continue;
      seen.add(b.sessionId);
      const value = stage(b,rows.filter(d=>b.deliveries.includes(d.id)),b.sessionId);
      if (value) result[b.sessionId] = value;
    }
    return result;
  }
  /** A declined offer also handles this turn's generic attention; later input never inherits that choice. */
  recomputeAttentionSessionIds(productId: string, accountId: string) {
    return [...new Set(this.listRaw(productId).filter(d => d.accountId === accountId
      && d.state !== "merged" && d.activity === this.activity(d.sessionId))
      .filter(d => { try { this.sourceValid(d); return true; } catch { return false; } })
      .map(d => d.sessionId))];
  }
  /** Hot reads query only persisted display rows. Actions always use live sources. */
  list(productId: string, accountId: string, sessionId?: string) {
    const now=Date.now();
    return (this.db.connection.prepare(`SELECT data_json,fresh_from,fresh_until,fresh_blocker FROM merge_delivery_projection
      WHERE product_id=? AND account_id=? AND visible=1 ${sessionId ? "AND session_id=?" : ""} ORDER BY sequence DESC`).all(productId,accountId,...(sessionId ? [sessionId] : [])) as
      {data_json:string;fresh_from:number|null;fresh_until:number|null;fresh_blocker:string|null}[]).map(row=>{
      const value=JSON.parse(row.data_json) as ReturnType<MergeDeliveries["view"]>;
      if(row.fresh_until!==null && value.blocker!=="changed") value.blocker=now>=row.fresh_from! && now<=row.fresh_until ? row.fresh_blocker ?? undefined : "stale";
      return value;
    });
  }
  batches(productId: string, accountId: string, sessionId?: string): ReturnType<MergeDeliveries["recomputeBatches"]> {
    const rows=this.db.connection.prepare(`SELECT data_json,activity_json FROM merge_batch_projection WHERE product_id=? AND account_id=? ${sessionId ? "AND session_id=?" : ""} ORDER BY sequence DESC LIMIT 20`).all(productId,accountId,...(sessionId ? [sessionId] : [])) as {data_json:string;activity_json:string}[];
    type ActivityBoundary={sessionId:string;activity:string;sensitive:boolean};
    const boundaries=rows.map(row=>JSON.parse(row.activity_json) as Record<string,ActivityBoundary>);
    const sessionIds=[...new Set(boundaries.flatMap(entries=>Object.values(entries).map(entry=>entry.sessionId)))];
    const activity=new Map((sessionIds.length ? this.db.connection.prepare(`SELECT session_id,activity FROM merge_display_activity WHERE session_id IN (${sessionIds.map(()=>"?").join(",")})`).all(...sessionIds) as {session_id:string;activity:string}[] : []).map(row=>[row.session_id,row.activity]));
    return rows.map((row,index)=>{
      const value=JSON.parse(row.data_json) as ReturnType<MergeDeliveries["recomputeBatches"]>[number];
      const expected=boundaries[index]!;
      for(const [id,entry] of Object.entries(expected))if(value.presentation.entries[id]?.publication==="pending" && activity.get(entry.sessionId)!==entry.activity && entry.sensitive)value.presentation.entries[id]!.publication="unknown";
      return value;
    });
  }
  attentionSessionIds(productId: string, accountId: string, sessionId?: string): string[] {
    return (this.db.connection.prepare(`SELECT session_id FROM merge_delivery_projection WHERE product_id=? AND account_id=?
      AND attention=1 ${sessionId ? "AND session_id=?" : ""} GROUP BY session_id ORDER BY MAX(sequence) DESC`).all(productId,accountId,...(sessionId ? [sessionId] : [])) as {session_id:string}[]).map(row=>row.session_id);
  }
  sessionProgress(productId: string, accountId: string, sessionId?: string): Record<string, SessionDeliveryStage> {
    const rows=this.db.connection.prepare(`SELECT session_id,stage,expires_at,expired_stage FROM merge_session_projection WHERE product_id=? AND account_id=? ${sessionId ? "AND session_id=?" : ""}`)
      .all(productId,accountId,...(sessionId ? [sessionId] : [])) as {session_id:string;stage:SessionDeliveryStage;expires_at:number|null;expired_stage:SessionDeliveryStage|null}[];
    return Object.fromEntries(rows.map(row=>[row.session_id,row.expires_at!==null && Date.now()>=row.expires_at ? row.expired_stage! : row.stage]));
  }
  private refreshDisplay() {
    this.displayReads=new Map();
    try{this.writeDisplay();}finally{this.displayReads=undefined;}
  }
  private writeDisplay() {
    const changes=this.db.connection.prepare("SELECT kind,id FROM merge_display_dirty").all() as {kind:string;id:string}[];
    if(!changes.length)return;
    const deliveries=new Set<string>(), batches=new Set<string>(), activityOnly=new Set<string>();
    const activitySessions=changes.filter(change=>change.kind==="activity").map(change=>change.id);
    for(const sessionId of activitySessions) {
      const current=this.activity(sessionId);
      this.db.connection.prepare("INSERT OR REPLACE INTO merge_display_activity VALUES (?,?)").run(sessionId,current);
      for(const row of this.db.connection.prepare("SELECT id FROM merge_delivery_projection WHERE session_id=? AND (visible=1 OR attention=1) UNION SELECT id FROM merge_delivery_projection WHERE session_id=? AND expected_activity=? AND json_extract(data_json,'$.state')!='merged'").all(sessionId,sessionId,current) as {id:string}[])activityOnly.add(row.id);
    }
    for(const change of changes) {
      if(change.kind==="delivery")deliveries.add(change.id);
      if(change.kind==="batch")batches.add(change.id);
      for(const row of this.db.connection.prepare("SELECT delivery_id FROM merge_display_dependencies WHERE kind=? AND id=?").all(change.kind,change.id) as {delivery_id:string}[])deliveries.add(row.delivery_id);
      if(change.kind==="item") {
        // A target's status can unblock a delivery in a different project.
        for(const row of this.db.connection.prepare(`SELECT x.delivery_id FROM merge_display_dependencies x JOIN collaboration_requests r ON r.source_item_id=x.id
          WHERE x.kind='item' AND r.target_item_id=?`).all(change.id) as {delivery_id:string}[])deliveries.add(row.delivery_id);
      }
      if(change.kind==="session")for(const row of this.db.connection.prepare("SELECT id FROM merge_batches WHERE json_extract(data_json,'$.sessionId')=?").all(change.id) as {id:string}[])batches.add(row.id);
    }
    this.db.connection.prepare("DELETE FROM merge_display_dirty").run();
    for(const id of batches)for(const row of this.db.connection.prepare("SELECT value AS id FROM merge_batches,json_each(data_json,'$.deliveries') WHERE merge_batches.id=?").all(id) as {id:string}[])deliveries.add(row.id);
    const sessions=new Map<string,{productId:string;accountId:string;sessionId:string}>();
    const remember=(productId:string,accountId:string,sessionId:string)=>{
      sessions.set(JSON.stringify([productId,accountId,sessionId]),{productId,accountId,sessionId});
      this.db.connection.prepare("INSERT OR IGNORE INTO merge_display_activity_scopes VALUES (?,?,?)").run(sessionId,productId,accountId);
      this.db.connection.prepare("INSERT OR REPLACE INTO merge_display_activity VALUES (?,?)").run(sessionId,this.activity(sessionId));
    };
    for(const id of activityOnly)deliveries.add(id);
    for(const sessionId of activitySessions)for(const row of this.db.connection.prepare("SELECT product_id,account_id FROM merge_display_activity_scopes WHERE session_id=?").all(sessionId) as {product_id:string;account_id:string}[])remember(row.product_id,row.account_id,sessionId);
    for(const id of deliveries) {
      const activityChange=activityOnly.has(id) && !changes.some(change=>change.kind!=="activity");
      const previous=this.db.connection.prepare("SELECT product_id,account_id,session_id,batch_id FROM merge_delivery_projection WHERE id=?").get(id) as {product_id:string;account_id:string;session_id:string;batch_id:string|null}|undefined;
      if(previous){remember(previous.product_id,previous.account_id,previous.session_id);if(previous.batch_id&&!activityChange)batches.add(previous.batch_id);}
      const source=this.db.connection.prepare("SELECT rowid AS sequence,data_json FROM merge_deliveries WHERE id=?").get(id) as {sequence:number;data_json:string}|undefined;
      this.db.connection.prepare("DELETE FROM merge_display_dependencies WHERE delivery_id=?").run(id);
      if(!source){this.db.connection.prepare("DELETE FROM merge_delivery_projection WHERE id=?").run(id);continue;}
      const d=JSON.parse(source.data_json) as Delivery,view=this.view(d);
      const visible=!["withdrawn","merged"].includes(d.state) && (d.state==="batched" || view.blocker!=="changed");
      let attention=false;
      if(d.state!=="merged" && d.activity===this.activity(d.sessionId))try{this.sourceValid(d);attention=true;}catch{/* Invalid sources never suppress attention. */}
      let freshBlocker: string|undefined;
      if(view.blocker!=="changed" && d.state!=="batched") {
        freshBlocker=d.evidence.checks!=="passed" ? d.evidence.checks : d.evidence.mergeable!=="clean" ? d.evidence.mergeable
          : d.itemKeys.some(key=>collaborationBlockers(this.db,this.store.workItemId(key))>0) ? "dependency" : undefined;
      }
      const time=Date.parse(d.evidence.checkedAt);
      this.db.connection.prepare(`INSERT OR REPLACE INTO merge_delivery_projection VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        d.id,d.productId,d.accountId,d.sessionId,d.batchId??null,source.sequence,Number(visible),Number(attention),JSON.stringify(view),
        d.state==="batched"||d.evidence.head!==d.head?null:time-30_000,d.state==="batched"||d.evidence.head!==d.head?null:time+300_000,freshBlocker??null,d.activity);
      const link=(kind:string,key:string)=>this.db.connection.prepare("INSERT OR IGNORE INTO merge_display_dependencies VALUES (?,?,?)").run(id,kind,key);
      link("session",d.sessionId);link("account",d.accountId);link("product",d.productId);
      if(d.batchId){if(!activityChange)batches.add(d.batchId);link("batch",d.batchId);}
      for(const key of d.itemKeys)link("item",this.store.workItemId(key));
      if(d.identity.dispatchId)link("dispatch",d.identity.dispatchId);
      for(const sessionId of [d.sessionId]) {
        const local=this.db.connection.prepare("SELECT d.id,d.node_id FROM agent_sessions s JOIN dispatches d ON d.id=s.dispatch_id WHERE s.id=?").get(sessionId) as {id:string;node_id:string}|undefined;
        if(local){link("dispatch",local.id);link("node",local.node_id);}
        const external=this.db.connection.prepare("SELECT native_node_id FROM external_agent_sessions WHERE id=?").get(sessionId) as {native_node_id:string|null}|undefined;
        if(external?.native_node_id)link("node",external.native_node_id);
      }
      remember(d.productId,d.accountId,d.sessionId);
    }
    for(const id of batches) {
      const source=this.db.connection.prepare("SELECT rowid AS sequence,data_json FROM merge_batches WHERE id=?").get(id) as {sequence:number;data_json:string}|undefined;
      if(!source){this.db.connection.prepare("DELETE FROM merge_batch_projection WHERE id=?").run(id);continue;}
      const b=JSON.parse(source.data_json) as Batch;
      this.db.connection.prepare("INSERT OR REPLACE INTO merge_batch_projection VALUES (?,?,?,?,?,?,?)").run(b.id,b.productId,b.accountId,b.sessionId,source.sequence,JSON.stringify({...b,presentation:this.presentation(b,true)}),JSON.stringify(Object.fromEntries(b.deliveries.map(id=>{const d=this.read<Delivery>("merge_deliveries",id);return [id,{sessionId:d.sessionId,activity:d.activity,sensitive:d.itemKeys.some(key=>!this.publishedHandoff(d,key))}];}))));
      remember(b.productId,b.accountId,b.sessionId);
    }
    for(const {productId,accountId,sessionId} of sessions.values()) {
      let expires:number|null=null;
      const stage=this.recomputeSessionProgress(productId,accountId,sessionId,Date.now(),value=>{expires=value;})[sessionId];
      this.db.connection.prepare("DELETE FROM merge_session_projection WHERE product_id=? AND account_id=? AND session_id=?").run(productId,accountId,sessionId);
      if(!stage)continue;
      // Publishing is the only time-dependent stage. Compute its fallback once
      // on the write, retaining just the deadline comparison on reads.
      const expired=expires!==null ? this.recomputeSessionProgress(productId,accountId,sessionId,expires)[sessionId]??null : null;
      this.db.connection.prepare("INSERT INTO merge_session_projection VALUES (?,?,?,?,?,?)").run(productId,accountId,sessionId,stage,expires,expired);
    }
  }
  readForAccount(accountId: string, id: string) {
    const d=this.read<Delivery>("merge_deliveries",id);
    if(d.accountId!==accountId) throw notFound("Delivery");
    return this.view(d);
  }
  product(id: string) { return this.read<Delivery>("merge_deliveries",id).productId; }
  decide(accountId: string, id: string, revision: string, decision: "confirm" | "withdraw") {
    return this.db.transaction(() => {
      const d = this.read<Delivery>("merge_deliveries",id);
      if (d.accountId !== accountId || d.revision !== revision || d.state === "batched" || d.state === "merged") throw changed();
      if (decision === "confirm") this.confirm(d, "console");
      else d.state = "withdrawn";
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
  recomputeBatches(productId: string, accountId: string) {
    return (this.db.connection.prepare("SELECT data_json FROM merge_batches WHERE product_id=? AND account_id=? ORDER BY rowid DESC LIMIT 20")
      .all(productId,accountId) as {data_json:string}[]).map(row => {
        const batch=JSON.parse(row.data_json) as Batch;
        return {...batch,presentation:this.presentation(batch)};
      });
  }
  /** Stable delivery identities remain in the release ledger after a merge-only batch finishes. */
  releaseCandidates(productId:string,beforeSequence?:number,limit=100) {
    return (this.db.connection.prepare(`SELECT rowid AS sequence,data_json FROM merge_deliveries
      WHERE product_id=? AND state='merged' AND json_array_length(json_extract(data_json,'$.itemKeys'))=0
      AND (? IS NULL OR rowid*2+1<?) ORDER BY rowid DESC LIMIT ?`)
      .all(productId,beforeSequence ?? null,beforeSequence ?? null,limit) as {sequence:number;data_json:string}[]).map(row=>{
        const d=JSON.parse(row.data_json) as Delivery;
        return {sequence:row.sequence*2+1,delivery:d,candidate:{kind:"delivery" as const,deliveryId:d.id,expectedRevision:d.revision,
          title:d.summary,pullRequestUrl:`${d.repository}/pull/${d.pullRequest}`,completion:{kind:"github" as const,url:`${d.repository}/pull/${d.pullRequest}`},
          requiredArtifacts:d.requiredArtifacts}};
      });
  }
  recordRelease(accountId:string,clientId:string,input:{productId:string;idempotencyKey:string;deployedCommit:string;receiptDigest:string;
    deliveries:{deliveryId:string;expectedRevision:string;releases:{artifact:string;version:string;sourceCommit:string}[]}[]}) {
    this.store.assertProductWritable(input.productId);
    const accounts=new AccountStore(this.db),account=accounts.findActive(accountId);
    if(!account || !accounts.allows(account,input.productId,"operate") || !accounts.allows(account,input.productId,"ai")) throw changed();
    return this.db.transaction(()=>{
      const requestId=digest([accountId,clientId,input.productId,input.idempotencyKey]),signature=digest(input);
      const previousRequest=this.db.connection.prepare("SELECT digest FROM merge_delivery_release_requests WHERE id=?").get(requestId) as {digest:string}|undefined;
      if(previousRequest && previousRequest.digest!==signature) throw changed();
      // Reject cross-product or item-backed records before writing any receipt.
      for(const row of input.deliveries) {const d=this.read<Delivery>("merge_deliveries",row.deliveryId);
        if(d.productId!==input.productId || d.itemKeys.length) throw changed();}
      const results=input.deliveries.map(row=>this.db.transaction(()=>{
        const d=this.read<Delivery>("merge_deliveries",row.deliveryId),key=digest([accountId,clientId,input.idempotencyKey]);
        const previous=d.releaseReceipts?.find(r=>r.key===key);
        if(previous) {if(previous.digest!==signature)throw changed();return {deliveryId:d.id,outcome:"already_submitted"};}
        if(d.state!=="merged" || d.revision!==row.expectedRevision || !d.requiredArtifacts.length || !row.releases.length
          || new Set(row.releases.map(r=>r.artifact)).size!==row.releases.length || row.releases.some(r=>!d.requiredArtifacts.includes(r.artifact))) throw changed();
        if((d.releaseReceipts?.length ?? 0)>=1000) throw changed();
        (d.releaseReceipts ??= []).push({key,digest:signature,receiptDigest:input.receiptDigest,deployedCommit:input.deployedCommit,at:new Date().toISOString(),releases:row.releases});
        this.save(d);return {deliveryId:d.id,outcome:"submitted"};
      }));
      if(!previousRequest)this.db.connection.prepare("INSERT INTO merge_delivery_release_requests(id,digest,created_at) VALUES (?,?,?)").run(requestId,signature,new Date().toISOString());
      return results;
    });
  }
  /** Historical publication is read from formal receipts for this PR, not current
   * item status, free-form progress, or the fact that a batch was finished. */
  private presentation(b:Batch,ignoreActivity=false):MergeBatchPresentation {
    return this.displayRead("presentation:"+b.id+":"+ignoreActivity,()=>{
    return {entries:Object.fromEntries(b.deliveries.map(id=>{
      const d=this.read<Delivery>("merge_deliveries",id),url=`${d.repository}/pull/${d.pullRequest}`;
      const releases:MergeBatchPresentation["entries"][string]["releases"]=[];
      let publishedItems=0,knownItems=0;
      for(const key of d.itemKeys) {
        // Read receipt facts only: list polling must not load comment/transcript bodies.
        const timeline=(this.db.connection.prepare(`SELECT event_type AS eventType,to_status AS toStatus,payload_json AS payloadJson,created_at AS createdAt
          FROM work_item_events WHERE item_id=? AND history_source_key IS NULL
          AND (event_type='release_evidence_added' OR (event_type='status_changed' AND to_status='pending_verification')) ORDER BY rowid`)
          .all(this.store.workItemId(key)) as {eventType:string;toStatus:string;payloadJson:string;createdAt:string}[])
          .map(row=>({...row,payload:JSON.parse(row.payloadJson) as Record<string,unknown>}));
        // Each receipt covers its own item's complete scope, not the PR union.
        const receipt=[...timeline].reverse().find(e=>{
          if(e.eventType!=="release_evidence_added"&&!(e.eventType==="status_changed"&&e.toStatus==="pending_verification"))return false;
          const p=e.payload;
          try {if(!sameCompletion(normalizeCompletion(p),{kind:"github",url}))return false;}catch{return false;}
          return typeof p.receiptDigest==="string"&&/^[a-f0-9]{64}$/.test(p.receiptDigest)
            &&sha.safeParse(p.deployedCommit).success&&Array.isArray(p.releases)&&p.releases.length>0
            &&d.requiredArtifacts.every(artifact=>(p.releases as {artifact?:string}[]).some(r=>r.artifact===artifact))
            &&p.releases.every((r:unknown)=>z.object({artifact:z.string().min(1),version:z.string().min(1),sourceCommit:sha}).safeParse(r).success);
        });
        const record=this.store.getDeliveryRecords(key).find(row=>row.completion && sameCompletion(row.completion!,{kind:"github",url}));
        if(receipt && (!record || record.published)) {
          publishedItems++;knownItems++;
          for(const r of receipt.payload.releases as {artifact:string;version:string;sourceCommit:string}[])
            if(!releases.some(previous=>previous.artifact===r.artifact&&previous.sourceCommit===r.sourceCommit))releases.push({...r,checkedAt:receipt.createdAt});
        } else if(!this.itemBlocker(d,key,ignoreActivity))knownItems++;
      }
      if(!d.itemKeys.length) for(const receipt of d.releaseReceipts ?? []) for(const release of receipt.releases)
        if(!releases.some(r=>r.artifact===release.artifact && r.sourceCommit===release.sourceCommit)) releases.push({...release,checkedAt:receipt.at});
      const standalonePublished=!d.itemKeys.length && d.requiredArtifacts.every(a=>releases.some(r=>r.artifact===a));
      const publication=!d.requiredArtifacts.length&&d.noReleaseReason?"not_required":!d.itemKeys.length?(standalonePublished?"published":releases.length?"partial":"pending"):publishedItems===d.itemKeys.length?"published":publishedItems?"partial":knownItems===d.itemKeys.length?"pending":"unknown";
      return [id,{itemKeys:d.itemKeys,title:d.displayTitle??(d.itemKeys.length?d.itemKeys.map(key=>this.store.getWorkItem(key).title).join(" / "):d.summary),summary:d.summary,pullRequestUrl:url,
        requiredArtifacts:d.requiredArtifacts,noReleaseReason:d.noReleaseReason,publication,releases}];
    }))};
    });
  }
  start(accountId: string, requestKey: string, selection: {id:string;revision:string}[], config: FreeSessionConfig, publish: boolean, integrationProtocol?: 1, saveAsDefault = false) {
    return this.db.transaction(() => {
      const prev = this.db.connection.prepare("SELECT id FROM merge_batches WHERE account_id=? AND request_key=?").get(accountId,requestKey) as {id:string}|undefined;
      if (prev) {
        const b = this.read<Batch>("merge_batches",prev.id);
        if ((b.integration?.recoveredAuthorization?undefined:b.integration?.protocol)!==integrationProtocol) throw changed();
        if (Boolean(b.saveAsDefault)!==saveAsDefault) throw changed();
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
      const text = `执行用户已授权的合并批次 ${id}。派单启动后先调用 get_merge_batch，使用本会话原 dispatchId。仅处理批次冻结的 PR；每次执行前重新调用 get_merge_batch，entries 中 blocker 非空必须停止。推送并登记后，达到可合并状态即用 gh pr merge --auto --merge --match-head-commit 绑定实际合并的 head 挂自动合并，由 required checks 全绿自动完成合并，不要逐项等待 CI 通知或手动合并，直接并行推进下一项；合并后回读实际 merge commit 核实再 report；检查失败先 gh pr merge --disable-auto 再修复，禁止 --admin 或绕过保护；不要领取开发条目，不要重新创建批次。每项挂自动合并前重新核实目标仓库、主线、依赖、CI 及预期 head；他人推送的新提交必须停止，不得合并未经本会话核验的 head。清单中的旧检查证据仅供参考，由本合并会话统一读取实时结果；CI 排队或运行中时保留原批次，先查状态且状态未变时降低轮询频率，不将等待标记为失败或另建会话。${integrationProtocol===1 ? "你是集成者，以保障批次全部条目成功集成为目标：负责必要的冲突、兼容与回归修复，按下述协议登记后推送原 PR 分支，不扩大功能范围。" : "本批仅允许合并原确认版本，不授权修改代码。"}疑似 flaky 或超时的检查可有依据地重跑一次核实。修复后的最终 head 必须本地仓库检查通过且无冲突才允许挂 auto-merge，实际合并仍由 required checks 全绿保证；穷尽合理修复仍无法集成的项记 blocked，写明已尝试的修复与剩余障碍，不编造修复结果。使用 report_merge_batch 逐项记录实际结果；未知结果保留原批次。已核实合并且明确无需发布的条目，完整读取 get_item_context.developmentEvidence 并写结果评论后，用 submit_non_release_for_verification 携带原合并 dispatchId、精确 batch/delivery 和当前 integration revision 提交人工验证，不伪造发布凭据或领取源条目；需发布条目仍按正式发布交接。发布授权：${publish ? "批次全部条目合并成功后按项目既有全量候选覆盖门禁发布，批次选择不缩小发布范围；存在 blocked 项时不得自动发布，先逐项报告，等用户明确决定是否先发已合并部分。" : "仅合并，不发布。"} 完成所有操作且核实无后台执行后，才结束批次。遵守仓库权限和发布规则。`;
      const dispatches=new DispatchStore(this.db);
      const free=new FreeSessionStore(this.db,dispatches,new AgentSessionStore(this.db));
      const integrationInstructions=integrationProtocol===1 ? `本批已授权集成所必需的修复与验证，但不扩大需求或绕过原生权限。先读取全批 PR、条目与主线，梳理依赖、文件/接口/迁移重叠、分组、顺序及组合验证目标，通过 record_merge_integration 的 plan 动作持久化计划；这是执行说明，不重复索取方案批准。可并行只读调查，重叠代码修改和合并按计划协调。修复前用 prepare_repair 绑定当前远端 head 和主线；原 worktree 内先确认远端仍为该 head，仅追加本会话所做提交，不 force、不混入外部提交。推送前后核对远端 head，使用 scripts/merge-integration-evidence.mjs 验证提交链；repair 动作登记真实修复提交，原确认保持不变。修复或基线变化后重新核验，不复用旧提交检查。使用 check 动作保存最终 head、当前目标分支 base、本地检查与实时 CI 证据；get_merge_batch 的 executionHead 才是实际允许合并的 head，mergeReady 为 true 且实时 Git 核验通过后立即对 executionHead 执行 gh pr merge --auto --merge --match-head-commit 挂自动合并，不等待 CI 通知即转入下一依赖项；合并后回读实际 merge commit 核实并 report，检查失败先 gh pr merge --disable-auto 再修复。使用 progress 动作保存阶段和下一步，恢复时先读计划、修复预留、历史与结果，不重推、不重复合并。每次调用携带当前 expectedRevision 和稳定 idempotencyKey；响应未知原样重试。确认没有推送、远端仍为预留 head 且无后台执行时，可用 cancel_repair 结束未发生的修复；未知结果不能撤销预留。他人提交必须停下核对，不能登记为自己的修复。合并必须满足计划依赖，report_merge_batch 后继续独立项。批次结果全部明确后在实际目标分支验证已合并组合，final_validation 记录真实目标 head 和证据，再执行已授权发布与交接。发布开始/续期、失败或结束时用 publication_progress 动作，state 为 publishing/failed/ended，checkedAt 为实时 UTC，resultsDigest 原样取 get_merge_batch 返回值；沿用原 batchId/dispatchId、expectedRevision 与新幂等键。publishing 每五分钟内续期；没有可信心跳显示发布待核实，ended 不证明已发布，仍须完整正式凭据及交接。不得删除测试或降低断言来冒充修复。` : `本批来自旧版入口，未授权集成修复；只合并冻结 head，需改代码则停止并说明，不能套用新版修复授权。`;
      // The first message is instructions, so the conversation is named after
      // the work it integrates instead of an excerpt of that prompt (AND-449).
      const integrationTitle=`集成 · ${deliveries.every(d=>d.itemKeys.length) ? compactItemKeys([...new Set(deliveries.flatMap(d=>d.itemKeys))]) : deliveries.map(d=>`PR #${d.pullRequest}`).join(" / ")}`;
      const dispatch=free.prepare(accountId,id,{...config,saveAsDefault:false},`${text}\n\n${integrationInstructions}`,0,integrationTitle);
      const b: Batch={id,productId:config.productId,accountId,requestKey,dispatchId:dispatch.id,sessionId:dispatch.agentSessionId!,
        config,publish,saveAsDefault,selection,deliveries:deliveries.map(d=>d.id),state:"active",createdAt:new Date().toISOString(),results:{},
        ...(integrationProtocol===1?{integration:{protocol:1 as const,revision:0,plans:[],events:[],entries:Object.fromEntries(deliveries.map(d=>[d.id,{itemKeys:d.itemKeys,originalHead:d.head,head:d.head,progress:"queued" as const,detail:"",repairs:[]}]))}}:{})};
      this.db.connection.prepare("INSERT INTO merge_batches(id,product_id,account_id,request_key,state,data_json) VALUES (?,?,?,?,?,?)")
        .run(id,b.productId,accountId,requestKey,b.state,JSON.stringify(b));
      for(const d of deliveries){d.state="batched";d.batchId=id;this.save(d);}
      free.finish(accountId,dispatch.id,[]);
      if (saveAsDefault) dispatches.setDispatchDefaults(accountId, {
        nodeId: config.nodeId, agentKind: config.agentKind,
        agents: { ...dispatches.getDispatchDefaults(accountId, "integration").agents, [config.agentKind]: {
          mode: config.mode, ...(config.model ? {model:config.model} : {}), ...(config.effort ? {effort:config.effort} : {}),
        } },
      }, "integration");
      return b;
    });
  }
  batch(accountId: string, dispatchId: string, id: string) {
    const b=this.read<Batch>("merge_batches",id);
    this.permit(accountId,b,false);
    const live=this.db.connection.prepare("SELECT 1 FROM dispatches d JOIN nodes n ON n.id=d.node_id JOIN agent_sessions s ON s.dispatch_id=d.id WHERE d.id=? AND d.account_id=? AND s.id=? AND d.status='launched' AND n.revoked_at IS NULL")
      .get(dispatchId,accountId,b.sessionId);
    if(b.accountId!==accountId || !live) throw changed();
    // Restore only the exact persisted server-authored authorization, bound to this batch's original identity.
    // Reading exposes the recoverable protocol; the first authorized write persists it atomically.
    if(!b.integration && b.state==="active") {
      const original=this.db.connection.prepare("SELECT initial_text FROM free_session_starts WHERE dispatch_id=? AND account_id=? AND request_key=? AND product_id=? AND ready=1")
        .get(b.dispatchId,b.accountId,b.id,b.productId) as {initial_text:string}|undefined;
      if(original?.initial_text===legacyIntegratorPrompt(b.id,b.publish)) {
        b.integration={protocol:1,revision:0,plans:[],events:[],recoveredAuthorization:{dispatchId:b.dispatchId,promptDigest:digest(original.initial_text)},
          entries:Object.fromEntries(b.deliveries.map(id=>{const d=this.read<Delivery>("merge_deliveries",id);return [id,{itemKeys:d.itemKeys,originalHead:d.head,head:b.results[id]?.head??d.head,progress:"queued" as const,detail:"",repairs:[]}];}))};
      }
    }
    return {...b, dispatchId, resultsDigest:digest(b.results), entries:b.deliveries.map(id=>{
      const d=this.view(this.read<Delivery>("merge_deliveries",id));
      let mergeReady=!d.blocker&&!b.results[id]&&b.state==="active";
      if(b.integration){try{assertIntegrationMerge(b.integration,id,b.results);}catch{mergeReady=false;}}
      return {...d,executionHead:b.integration?.entries[id]?.head??d.head,expectedBase:b.integration?.entries[id]?.check?.base,mergeReady};
    })};
  }
  integrate(accountId:string,dispatchId:string,id:string,expectedRevision:number,key:string,raw:IntegrationAction) {
    const action=integrationActionSchema.parse(raw);
    return this.db.transaction(()=>{
      const b=this.batch(accountId,dispatchId,id),state=b.integration;this.permit(accountId,b,true);
      if(!state)integrationDenied("未找到可核实的原始集成修复授权，请保留原批次授权边界。");
      const recovery=action.kind==="progress"?readRecoveryTransport(action.detail):undefined;
      if(!recovery&&b.reconciliation?.transportReceipts?.[key])throw changed();
      if(recovery&&action.kind==="progress") {
        if(state.events.some(e=>e.id===key))throw changed();
        const receipt=b.reconciliation?.transportReceipts?.[key];
        if(receipt){if(receipt.digest!==integrationDigest(action))throw changed();return b;}
        if(Object.keys(b.reconciliation?.transportReceipts??{}).length>=1000)throw conflict("recovery_limit","兼容恢复记录已达上限，请核对历史记录。");
        const entry=state.entries[action.deliveryId];
        const prior=b.reconciliation?.requests.find(r=>r.id===(recovery.operation==="request"?key:recovery.requestId));
        if(action.phase!=="investigating"||!entry||!b.deliveries.includes(action.deliveryId))throw changed();
        if(recovery.operation==="request"&&"deliveryId" in recovery.action&&recovery.action.deliveryId!==action.deliveryId)throw changed();
        if(recovery.operation==="apply"&&prior&&"deliveryId" in prior.action&&prior.action.deliveryId!==action.deliveryId)throw changed();
        if(state.revision!==expectedRevision||entry.head!==action.expectedHead)throw changed();
        if(recovery.operation==="request")this.requestReconciliation(accountId,dispatchId,id,key,recovery.snapshot,recovery.action);
        else this.applyReconciliation(accountId,dispatchId,id,recovery.requestId);
        // Read the mutation's current state; saving the old view would undo it.
        const current=this.batch(accountId,dispatchId,id);
        const receipts=this.reconciliation(current).transportReceipts??={};
        receipts[key]={digest:integrationDigest(action)};
        this.saveBatch(current);
        return this.batch(accountId,dispatchId,id);
      }
      const previous=state.events.find(e=>e.id===key);
      if(previous){
        // Same key, different body: the caller reused a key across actions. Reporting this
        // as a content change sends integrators looking at the PR and the work item instead
        // of the key, which is the only thing that actually differs.
        if(previous.digest!==integrationDigest(action))
          throw conflict("merge_integration_idempotency_conflict","这个 idempotencyKey 已记录过内容不同的集成动作。原样重试请复用原参数；新动作请换新的 key（prepare_repair 返回的 repairId 填 action.repairId，不能当 key 用）。");
        return b;
      }
      if(b.state!=="active"||state.revision!==expectedRevision)throw changed();
      if (action.kind === "publication_progress") {
        const validation = b.reconciliation?.finalValidation;
        const partial = b.reconciliation?.publication;
        if (!b.publish || b.deliveries.some(id=>!b.results[id]) || !validation || validation.resultsDigest !== digest(b.results)
          || !b.deliveries.some(id=>this.read<Delivery>("merge_deliveries",id).requiredArtifacts.length)
          || (Object.values(b.results).some(r=>r.status==="blocked") && !(partial?.decision==="allow_partial_publication" && partial.resultsDigest===digest(b.results)))
          || b.deliveries.some(id=>b.results[id]?.status==="merged" && this.read<Delivery>("merge_deliveries",id).itemKeys.some(key=>this.itemBlocker(this.read<Delivery>("merge_deliveries",id),key)))
          || (partial?.decision==="defer_publication" && partial.resultsDigest===digest(b.results))) throw changed();
      }
      const affected="deliveryId" in action?[action.deliveryId]:b.deliveries.filter(id=>!b.results[id]);
      for(const id of affected){if(!b.deliveries.includes(id))throw changed();this.sourceValid(this.read<Delivery>("merge_deliveries",id));}
      applyIntegrationAction(state,action,key,b.results);
      // The legacy final_validation transport also fulfils the recovery close
      // gate; both records bind the same complete current results and target.
      if(action.kind==="final_validation")this.reconciliation(b).finalValidation={head:action.head,checkedAt:action.checkedAt,source:action.source,validation:action.validation,resultsDigest:digest(b.results)};
      this.saveBatch(b);return this.batch(accountId,dispatchId,id);
    });
  }
  report(accountId: string, dispatchId: string, id: string, deliveryId: string,
    result: {status:"merged"|"blocked";head:string;commit?:string;detail:string}) {
    return this.db.transaction(()=>{
      const b=this.batch(accountId,dispatchId,id);this.permit(accountId,b,true);
      if(!b.deliveries.includes(deliveryId)) throw changed();
      if(b.results[deliveryId]) {
        if(digest(b.results[deliveryId])!==digest(result)) throw changed();
        return b;
      }
      if(b.state!=="active") throw changed();
      const d=this.read<Delivery>("merge_deliveries",deliveryId);
      if(result.head!==(b.integration?.entries[deliveryId]?.head??d.head)) throw changed();
      if(b.integration?.entries[deliveryId]?.repair) throw changed();
      if(result.status==="merged") {
        sha.parse(result.commit);
        if(b.integration)assertIntegrationMerge(b.integration,deliveryId,b.results);
        if(this.activity(d.sessionId)!==d.activity)throw changed();
        d.state="merged"; this.save(d);
      }
      b.results[deliveryId]=result;
      if(result.status==="merged")this.rememberDisplay(b,d);
      if(result.status==="merged")this.handoff(b,d);
      if(b.integration){
        b.integration.revision++;delete b.integration.finalValidation;
        if(result.status==="merged")for(const [id,entry] of Object.entries(b.integration.entries))if(!b.results[id]){delete entry.check;if(entry.progress==="ready")entry.progress="queued";}
      }
      this.saveBatch(b); return b;
    });
  }
  /** The merge identity can submit only its own recorded, unchanged merged delivery. */
  submitNonRelease(accountId:string,dispatchId:string,input:{batchId:string;deliveryId:string;expectedRevision:number},raw:NonReleaseVerification) {
    return this.db.transaction(()=>{
      const b=this.batch(accountId,dispatchId,input.batchId);this.permit(accountId,b,true);
      if(b.dispatchId !== dispatchId || b.state !== "active" || !b.integration
        || b.integration.revision !== input.expectedRevision || !b.deliveries.includes(input.deliveryId))throw changed();
      const d=this.read<Delivery>("merge_deliveries",input.deliveryId),result=b.results[d.id];
      const entry=b.integration.entries[d.id];
      if(d.batchId !== b.id || d.state !== "merged" || !d.itemKeys.includes(raw.itemKey)
        || !result || result.status !== "merged" || !result.commit || result.head !== entry?.head
        || entry.repair || b.reconciliation?.handoffs[raw.itemKey]?.status !== "completed" || this.itemBlocker(d,raw.itemKey)
        || !sameCompletion(raw.completion,{kind:"github",url:`${d.repository}/pull/${d.pullRequest}`}))throw changed();
      const e=this.store.getDevelopmentEvidence(raw.itemKey,raw.developmentEventId);
      if(!e.handover || e.handover.id !== raw.developmentEventId)throw changed();
      return this.store.submitNonReleaseForVerification(raw,{batchId:b.id,deliveryId:d.id});
    });
  }
  private reconciliation(b: Batch) {
    return b.reconciliation ??= {requests:[],history:[],handoffs:{}};
  }
  private permit(accountId:string,b:Batch,write:boolean) {
    const accounts=new AccountStore(this.db),account=accounts.findActive(accountId);
    if(b.accountId!==accountId || !account || !accounts.allows(account,b.productId,"view")
      || write && (!accounts.allows(account,b.productId,"operate") || !accounts.allows(account,b.productId,"ai") || this.store.getProduct(b.productId).archivedAt)) throw changed();
  }
  batchProduct(id:string) {return this.read<Batch>("merge_batches",id).productId;}
  private publishedHandoff(d:Delivery,key:string) {
    const item=this.store.getWorkItem(key),e=this.store.getDevelopmentEvidence(key);
    const record=this.store.getDeliveryRecords(key).find(row=>row.completion && sameCompletion(row.completion!,{kind:"github",url:`${d.repository}/pull/${d.pullRequest}`}));
    if(record)return record.published;
    // A delivery lists the PR's artifact union. Each independently completed
    // item keeps its own authoritative scope; do not require sibling artifacts.
    const required=this.store.getDevelopmentReleaseScope(key)??d.requiredArtifacts;
    if(!["pending_verification","done"].includes(item.status)||!e.handover||!e.roundKey||!required.length)return false;
    const timeline=this.store.getTimeline(key).filter(event=>!event.historySourceKey);
    const release=[...timeline].reverse().find(event=>event.eventType==="release_evidence_added"||event.eventType==="status_changed"&&event.toStatus==="pending_verification");
    const p=release?.payload,artifacts=p?.releases as {artifact:string;sourceCommit:string;version:string}[]|undefined;
    let matches=false;try{matches=sameCompletion(normalizeCompletion(p),{kind:"github",url:`${d.repository}/pull/${d.pullRequest}`});}catch{/* Missing proof is not publication. */}
    return Boolean(matches&&timeline.findIndex(event=>event.id===release?.id)>=timeline.findIndex(event=>event.id===e.handover!.id)
      &&(p?.developmentEventId===undefined||p.developmentEventId===e.handover.id)&&p?.roundKey===e.roundKey
      &&typeof p?.receiptDigest==="string"&&/^[a-f0-9]{64}$/.test(p.receiptDigest)
      &&typeof p?.deployedCommit==="string"&&sha.safeParse(p.deployedCommit).success
      &&Array.isArray(artifacts)&&required.every(a=>artifacts.some(r=>r.artifact===a&&sha.safeParse(r.sourceCommit).success&&r.version)));
  }
  private itemBlocker(d:Delivery,key:string,ignoreActivity=false):string|undefined {
    try {
      const item=this.store.getWorkItem(key);
      if(d.itemScopes ? d.itemScopes[key]!==this.scope([key]) : d.scope!==this.scope(d.itemKeys)) return "条目内容、Builder 或处理轮次已变化；旧交付不能覆盖。";
      if(this.store.getTimeline(key).some(e=>!e.historySourceKey&&e.eventType==="status_changed"&&e.createdAt>=d.createdAt
        && ["development_complete","pending_verification","done"].includes(e.fromStatus??"")&&["ready","in_progress"].includes(e.toStatus??"")))return "人工已将交付退回处理，旧交付不能恢复其状态。";
      if(!["in_progress","development_complete","pending_verification","done"].includes(item.status)) return "条目已退回、取消或暂缓；保留人工状态。";
      if(collaborationBlockers(this.db,item.id)>0) return "协作依赖未结束。";
      // A publisher's completed handover is independent of later conversation
      // activity. Scope/round/rework/dependency guards above still apply.
      if(this.publishedHandoff(d,key))return undefined;
      if(!ignoreActivity && this.activity(d.sessionId)!==d.activity) return "开发会话收到新的人工输入，请重新核对交付范围。";
      recoverExecutionAuthorization(this.store,d.accountId,d.clientId,{itemKey:key,...d.identity});
    } catch {return "原开发授权、项目或条目范围已失效，请由当前 Builder 核对。";}
    return undefined;
  }
  private snapshot(b:Batch) {
    return digest([b.state,b.results,b.integration?.recoveredAuthorization&&b.integration.revision===0&&!b.integration.plans.length?undefined:b.integration,b.reconciliation?.publication,b.deliveries.map(id=>{
      const d=this.read<Delivery>("merge_deliveries",id);
      return [d.revision,this.activity(d.sessionId),d.itemKeys.map(key=>{
        const i=this.store.getWorkItem(key);return [key,i.revision,i.status,this.scope([key]),this.itemBlocker(d,key)];
      })];
    })]);
  }
  preview(accountId:string,id:string):MergeReconciliationPreview {
    const b=this.read<Batch>("merge_batches",id);this.permit(accountId,b,false);
    return {batchId:id,state:b.state,publish:b.publish,snapshot:this.snapshot(b),sessionId:b.sessionId,
      reconciliation:b.reconciliation,entries:b.deliveries.map(deliveryId=>{
        const d=this.read<Delivery>("merge_deliveries",deliveryId);
        return {deliveryId,itemKeys:d.itemKeys,originalHead:d.head,executionHead:b.integration?.entries[deliveryId]?.head??d.head,
          repository:d.repository,pullRequest:d.pullRequest,targetBranch:d.targetBranch,result:b.results[deliveryId],
          requiredArtifacts:d.requiredArtifacts,noReleaseReason:d.noReleaseReason,
          repair:b.integration?.entries[deliveryId]?.repair,
          items:d.itemKeys.map(itemKey=>{const item=this.store.getWorkItem(itemKey);
            const record=this.store.getDeliveryRecords(itemKey).find(row=>row.completion && sameCompletion(row.completion!,{kind:"github",url:`${d.repository}/pull/${d.pullRequest}`}));
            const e=this.store.getDevelopmentEvidence(itemKey,record?.id),scope=this.store.getDevelopmentReleaseDecision(itemKey,record?.id);
            const blocker=this.itemBlocker(d,itemKey);
            return {itemKey,status:item.status,revision:item.revision,blocker,developmentEventId:e.handover?.id,roundKey:e.roundKey??undefined,requiredArtifacts:scope.requiredArtifacts,
              missingPublicationEvidence:item.status==="pending_verification"&&!this.publishedHandoff(d,itemKey),
              missingEvidence:["development_complete","pending_verification"].includes(item.status)&&(!e.completion||scope.requiredArtifacts===null),
              handoff:b.reconciliation?.handoffs[itemKey],
              next:blocker??(!b.results[deliveryId]?"核实 Git 结果":b.results[deliveryId]!.status==="blocked"?"障碍解除后申请恢复":item.status==="development_complete"?"补齐交付证据并核实必需产物发布":"保留现有状态并核对交接证据")};})};
      })};
  }
  requestReconciliation(accountId:string,dispatchId:string,id:string,key:string,snapshot:string,raw:ReconciliationAction) {
    const action=reconciliationActionSchema.parse(raw);
    return this.db.transaction(()=>{
      const b=this.batch(accountId,dispatchId,id);this.permit(accountId,b,true);
      const r=this.reconciliation(b),prior=r.requests.find(p=>p.id===key),hash=digest({snapshot,action});
      if(prior){if(prior.digest!==hash)throw changed();return this.preview(accountId,id);}
      if(this.snapshot(b)!==snapshot)throw changed();
      if(r.requests.length>=200)throw conflict("recovery_limit","恢复请求过多，请核对历史记录。");
      if("deliveryId" in action&&!b.deliveries.includes(action.deliveryId))throw changed();
      if(action.kind==="accept_merge") {
        const d=this.read<Delivery>("merge_deliveries",action.deliveryId);
        if(action.evidence.source!==`${d.repository}/pull/${d.pullRequest}` || !freshIntegrationCheck(action.evidence.checkedAt))throw changed();
        const existing=b.results[d.id];
        if(existing?.status==="merged"&&(existing.head!==action.evidence.head||existing.commit!==action.evidence.commit))throw conflict("merge_fact_conflict","已记录的成功合并事实不允许替换。");
      }
      if((action.kind==="defer_publication"||action.kind==="allow_partial_publication")&&!b.publish)throw changed();
      r.requests.push({id:key,digest:hash,snapshot,action,at:new Date().toISOString()});this.saveBatch(b);
      return this.preview(accountId,id);
    });
  }
  /** Human Web or bound native decision; never an Agent-provided approval fact. */
  decideReconciliation(accountId:string,id:string,requestId:string,snapshot:string,decision:"approved"|"rejected",noExecutionRemaining:boolean) {
    return this.db.transaction(()=>{
      const b=this.read<Batch>("merge_batches",id);this.permit(accountId,b,true);
      const r=this.reconciliation(b),request=r.requests.find(p=>p.id===requestId);
      if(!request||request.snapshot!==snapshot)throw changed();
      if(request.decision){if(request.decision!==decision)throw changed();return this.preview(accountId,id);}
      if(this.snapshot(b)!==snapshot||!noExecutionRemaining)throw changed();
      if(b.state==="finished"&&decision==="approved") {
        if(this.db.connection.prepare("SELECT 1 FROM merge_batches WHERE product_id=? AND state='active' AND id!=?").get(b.productId,id))throw conflict("merge_batch_active","同项目已有其他活动批次，不能恢复旧批次。");
        const session=new AgentSessionStore(this.db).getForAccount(accountId,b.sessionId);
        if(session.turnState?.turnActive||session.status==="active"||session.status==="stalled"||this.db.connection.prepare("SELECT 1 FROM agent_session_commands WHERE session_id=? AND status IN ('queued','delivering','delivery_unknown')").get(b.sessionId))throw conflict("merge_execution_active","原会话仍有活动或待执行命令，先核实结束再恢复。");
      }
      request.decision=decision;request.decidedAt=new Date().toISOString();request.decidedBy=accountId;
      r.history.push({at:request.decidedAt,action:decision,requestId,detail:decision==="approved"?"人工确认此快照中的恢复操作，未授权重做 Git 合并。":"人工拒绝此恢复操作。"});
      this.saveBatch(b);return this.preview(accountId,id);
    });
  }
  private handoff(b:Batch,d:Delivery,requestId?:string) {
    const r=this.reconciliation(b);
    if(!d.itemKeys.length) this.store.recordProductReleaseArtifacts(d.productId,d.requiredArtifacts);
    for(const itemKey of d.itemKeys) {
      const at=new Date().toISOString();
      try {
        this.db.transaction(()=>{
          const blocker=this.itemBlocker(d,itemKey);if(blocker)throw conflict("handoff_blocked",blocker);
          const item=this.store.getWorkItem(itemKey);
          const completion={kind:"github" as const,url:`${d.repository}/pull/${d.pullRequest}`};
          if(item.status==="in_progress")this.store.submitDevelopmentComplete({itemKey,completion,requiredArtifacts:d.requiredArtifacts,
            ...(d.noReleaseReason?{noReleaseReason:d.noReleaseReason}:{}),summary:b.results[d.id]!.detail,idempotencyKey:`merge-batch:${b.id}:${d.id}:${itemKey}`,attribution:{accountId:b.accountId}});
          else if((item.status==="development_complete" || item.status==="pending_verification") && !this.publishedHandoff(d,itemKey)) {
            const e=this.store.getDevelopmentEvidence(itemKey),scope=this.store.getDevelopmentReleaseDecision(itemKey);
            if(e.handover?.actorKind==="agent" && e.completion && !sameCompletion(e.completion,completion))this.store.submitDevelopmentComplete({itemKey,completion,requiredArtifacts:d.requiredArtifacts,
              ...(d.noReleaseReason?{noReleaseReason:d.noReleaseReason}:{}),summary:b.results[d.id]!.detail,idempotencyKey:`merge-batch:${b.id}:${d.id}:${itemKey}`,attribution:{accountId:b.accountId}});
            else if(requestId)this.store.supplementDevelopmentEvidence({itemKey,accountId:b.accountId,batchId:b.id,requestId,completion,requiredArtifacts:d.requiredArtifacts,preserveVerification:item.status==="pending_verification",...(d.noReleaseReason?{noReleaseReason:d.noReleaseReason}:{})});
            else if(!e.completion||!sameCompletion(e.completion,completion)||scope.requiredArtifacts===null||digest([...scope.requiredArtifacts].sort())!==digest([...d.requiredArtifacts].sort()))throw conflict("handoff_evidence_missing","人工推进后的交付依据缺失或冲突，请在对账预览中申请补证据。");
          }
        });
        r.handoffs[itemKey]={status:"completed",detail:"开发交接已核对；保留待验证或已完成的人工状态。",at};
      } catch(error) {
        if(!(error instanceof MissionGoError))throw error;
        r.handoffs[itemKey]={status:"blocked",detail:error.message,at};
      }
    }
  }
  applyReconciliation(accountId:string,dispatchId:string,id:string,requestId:string) {
    return this.db.transaction(()=>{
      const b=this.batch(accountId,dispatchId,id);this.permit(accountId,b,true);
      const r=this.reconciliation(b),request=r.requests.find(p=>p.id===requestId);
      if(!request||request.decision!=="approved")throw conflict("recovery_approval_required","需要人工确认这次对账快照及恢复操作。");
      if(request.appliedAt)return this.preview(accountId,id);
      if(this.snapshot(b)!==request.snapshot)throw changed();
      if(b.state==="finished") {
        if(this.db.connection.prepare("SELECT 1 FROM merge_batches WHERE product_id=? AND state='active' AND id!=?").get(b.productId,id))throw conflict("merge_batch_active","同项目存在活动批次。");
        b.state="active";
      }
      const action=request.action,at=new Date().toISOString();
      if(action.kind==="accept_merge"||action.kind==="retry_handover"||action.kind==="retry_blocked") {
        const d=this.read<Delivery>("merge_deliveries",action.deliveryId),previous=b.results[d.id];
        if(action.kind!=="accept_merge"&&b.integration?.entries[d.id]?.repair)throw conflict("repair_unresolved","修复预留尚未核实，请先按原预留恢复；不能删除或冒认他人修复。");
        if(action.kind==="accept_merge") {
          if(!freshIntegrationCheck(action.evidence.checkedAt))throw conflict("merge_evidence_stale","Git 证据已过期，请刷新预览后确认。");
          b.results[d.id]={status:"merged",head:action.evidence.head,commit:action.evidence.commit,detail:action.evidence.validation};
          // External acceptance is not a repair: originalHead and repair history stay intact.
          if(b.integration){
            const entry=b.integration.entries[d.id]!;
            if(entry.repair)r.history.push({at,action:"external_merge_settled_reservation",deliveryId:d.id,requestId,previous:entry.repair,detail:"保留原修复预留；以人工批准的外部合并事实结清，未登记为本会话修复。"});
            delete entry.repair;delete entry.check;
            b.integration.entries[d.id]!.head=action.evidence.head;b.integration.revision++;delete b.integration.finalValidation;
            for(const [otherId,other] of Object.entries(b.integration.entries))if(!b.results[otherId]){delete other.check;if(other.progress==="ready")other.progress="queued";}}
          d.state="merged";this.save(d);delete r.finalValidation;delete r.publication;
          this.rememberDisplay(b,d);
          this.handoff(b,d,requestId);
        } else if(action.kind==="retry_blocked") {
          if(previous?.status!=="blocked")throw changed();this.sourceValid(d);
          delete b.results[d.id];d.state="batched";this.save(d);delete r.finalValidation;delete r.publication;
          if(b.integration){b.integration.revision++;delete b.integration.finalValidation;delete b.integration.entries[d.id]!.check;}
        } else {if(previous?.status!=="merged")throw changed();this.handoff(b,d,requestId);}
        r.history.push({at,action:action.kind,deliveryId:d.id,requestId,previous,detail:action.kind==="accept_merge"?action.evidence.validation:action.kind==="retry_blocked"?action.reason:"按人工确认补充证据并重试逐条交接。"});
      } else {
        r.publication={decision:action.kind,reason:action.reason,requestId,resultsDigest:digest(b.results)};
        r.history.push({at,action:action.kind,requestId,detail:action.reason});
      }
      request.appliedAt=at;this.saveBatch(b);return this.preview(accountId,id);
    });
  }
  recordCombinedValidation(accountId:string,dispatchId:string,id:string,raw:z.infer<typeof combinedValidationSchema>) {
    const input=combinedValidationSchema.parse(raw);
    return this.db.transaction(()=>{
      const b=this.batch(accountId,dispatchId,id);this.permit(accountId,b,true);
      if(b.state!=="active"||b.deliveries.some(id=>!b.results[id])||!freshIntegrationCheck(input.checkedAt))throw changed();
      this.reconciliation(b).finalValidation={...input,resultsDigest:digest(b.results)};this.saveBatch(b);return this.preview(accountId,id);
    });
  }
  private assertPublication(b:Batch) {
    const decision=b.reconciliation?.publication;
    if(decision?.resultsDigest===digest(b.results)&&decision.decision==="defer_publication")return;
    if(Object.values(b.results).some(r=>r.status==="blocked")&&!(decision?.resultsDigest===digest(b.results)&&decision.decision==="allow_partial_publication"))throw conflict("partial_publication_decision_required","部分交付受阻，请人工决定本次暂不发布或授权部分发布。");
    for(const id of b.deliveries) {
      if(b.results[id]?.status!=="merged")continue;
      const d=this.read<Delivery>("merge_deliveries",id);
      if(!d.itemKeys.length && d.requiredArtifacts.length && !d.requiredArtifacts.every(a=>d.releaseReceipts?.some(r=>r.releases.some(release=>release.artifact===a))))
        throw conflict("merge_publication_incomplete",`PR #${d.pullRequest} 缺少完整产物发布凭据；保留批次。`);
      for(const key of d.itemKeys) {
        if(!d.requiredArtifacts.length)continue;
        if(this.itemBlocker(d,key)||!this.publishedHandoff(d,key))throw conflict("merge_publication_incomplete",`${key} 缺少匹配本轮交付的发布凭据或完整产物交接；保留批次。`);
      }
    }
  }
  finish(accountId:string,dispatchId:string,id:string) {
    return this.db.transaction(()=>{
      const b=this.batch(accountId,dispatchId,id);this.permit(accountId,b,true);
      if(b.state==="finished") return b;
      if(b.deliveries.some(id=>!b.results[id])) throw conflict("merge_results_unknown","仍有结果未核实，不能释放批次。");
      if(b.integration && Object.values(b.results).some(r=>r.status==="merged") && b.integration.finalValidation?.selectionDigest!==integrationDigest(b.results) && b.reconciliation?.finalValidation?.resultsDigest!==digest(b.results))
        integrationDenied("请先完成实际目标分支上的整批组合验证。");
      if(b.reconciliation?.requests.some(r=>r.decision==="approved"&&!r.appliedAt))throw conflict("recovery_pending","已批准恢复操作尚未执行。");
      if(b.integration && Object.values(b.integration.entries).some(e=>e.repair))throw conflict("repair_unresolved","仍有未核实的修复预留。");
      if(b.reconciliation?.history.some(e=>e.action==="accept_merge"||e.action==="retry_blocked") && Object.values(b.results).some(r=>r.status==="merged")
        && b.reconciliation.finalValidation?.resultsDigest!==digest(b.results))throw conflict("merge_validation_required","恢复后须重新验证实际目标分支上的合并组合。");
      for(const deliveryId of b.deliveries)if(b.results[deliveryId]?.status==="merged") {
        const d=this.read<Delivery>("merge_deliveries",deliveryId);
        if(d.itemKeys.some(key=>b.reconciliation?.handoffs[key]?.status==="blocked"||Boolean(this.itemBlocker(d,key))))throw conflict("merge_handoffs_incomplete","部分开发交接仍受阻，请查看逐条对账结果。");
      }
      if(b.integration?.publication?.state==="publishing" && Date.parse(b.integration.publication.expiresAt)>Date.now()) throw conflict("merge_publication_running","请先核实发布已停止并结束阶段上报，不能释放仍在发布的批次。");
      if(b.publish)this.assertPublication(b);
      b.state="finished";this.saveBatch(b);
      for(const id of b.deliveries) {const d=this.read<Delivery>("merge_deliveries",id);if(d.state==="batched"){d.state="withdrawn";this.save(d);}}
      return b;
    });
  }
}
