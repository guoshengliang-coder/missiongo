import { createHash, randomUUID } from "node:crypto";
import { conflict, invalidInput, notFound } from "./errors.js";
import { ImplementationPlans } from "./implementation-plans.js";
import type { MissionGoStore } from "./store.js";

export interface PlanDocument {
  id: string; accountId: string; identity: string; keys: string[]; scope: string;
  rounds: { key: string; eventId: string | null; number: number }[];
  version: number; summary: string; markdown: string; sha256: string; plan: string;
  createdAt: string; parentDocumentId?: string;
}

/** Immutable bytes shared by native clients, Web review and comment attachments. */
export class PlanDocuments {
  constructor(private readonly store: MissionGoStore) {}

  get(id: string, authorize: (key: string) => unknown): PlanDocument {
    const row = this.store.database.connection.prepare("SELECT document_json FROM plan_documents WHERE id=?")
      .get(id) as {document_json:string} | undefined;
    if (!row) throw notFound("Plan document");
    const document = JSON.parse(row.document_json) as PlanDocument;
    for (const key of document.keys) authorize(key);
    return document;
  }

  prepare(input: { accountId:string; identity:string; keys:string[]; summary:string; markdown:string; origin:string; requestKey:string; parentDocumentId?:string }): PlanDocument {
    const keys = [...new Set(input.keys)].sort();
    if (!input.markdown.startsWith(input.summary + "\n")) throw invalidInput("The Markdown must start with the exact summary followed by a newline.");
    if (Buffer.byteLength(input.markdown, "utf8") > 512_000) throw invalidInput("Plan document exceeds 512000 UTF-8 bytes.");
    const db = this.store.database.connection;
    const scope = new ImplementationPlans(this.store.database).scope(keys);
    // Use the actual latest processing/rework event, including an unclaimed return.
    const rounds = keys.map(key => {
      const events = db.prepare(`SELECT e.id FROM work_item_events e JOIN work_items w ON w.id=e.item_id
        WHERE w.item_key=? AND e.history_source_key IS NULL AND e.event_type='status_changed'
        AND json_extract(e.payload_json,'$.reason')='verification_failed'
        ORDER BY e.timeline_seq`).all(key) as {id:string}[];
      return {key,eventId:events.at(-1)?.id ?? null,number:events.length+1};
    });
    const parent = input.parentDocumentId ? this.get(input.parentDocumentId,()=>undefined) : undefined;
    if(parent) {
      this.assertCurrent(parent,input.accountId,input.identity,keys,true);
      if(parent.parentDocumentId || !this.approved(parent)) throw conflict("plan_document_parent_unapproved","Rework notes require the current approved plan, not another note.");
    }
    const fingerprint = JSON.stringify([keys,scope,rounds,input.summary,input.markdown,input.parentDocumentId]);
    return this.store.database.transaction(() => {
      const prior = db.prepare("SELECT document_json,fingerprint FROM plan_documents WHERE account_id=? AND identity_key=? AND request_key=?")
        .get(input.accountId,input.identity,input.requestKey) as {document_json:string;fingerprint:string}|undefined;
      if (prior) {
        if (prior.fingerprint!==fingerprint) throw conflict("plan_document_changed", "This request key belongs to different content or scope. Use a new key for a new version.");
        return JSON.parse(prior.document_json) as PlanDocument;
      }
      const scopeKey = JSON.stringify([keys,rounds]);
      const version = (db.prepare("SELECT COALESCE(MAX(version),0)+1 AS n FROM plan_documents WHERE account_id=? AND identity_key=? AND scope_key=?")
        .get(input.accountId,input.identity,scopeKey) as {n:number}).n;
      const id = randomUUID();
      const label = rounds.map(r=>`${r.key} 第 ${r.number} 轮`).join("、");
      const plan = `${input.summary}\n\n[查看完整诊断与方案 · ${label} · v${version}](${input.origin}/?planDocument=${id})\n\n${parent ? `本轮补修记录引用[原获批方案](${input.origin}/?planDocument=${parent.id})，不新增或扩大授权；实质方案变化须另行审阅。` : "本次批准覆盖上述摘要及链接所指的固定版本完整方案；不授予 push、merge 或发布权限。"}`;
      const document: PlanDocument = {id, accountId:input.accountId,identity:input.identity,keys,scope,rounds,version,
        summary:input.summary,markdown:input.markdown,sha256:createHash("sha256").update(input.markdown,"utf8").digest("hex"),plan,createdAt:new Date().toISOString(),...(parent ? {parentDocumentId:parent.id} : {})};
      db.prepare("INSERT INTO plan_documents(id,account_id,identity_key,request_key,scope_key,version,fingerprint,document_json) VALUES (?,?,?,?,?,?,?,?)")
        .run(id,input.accountId,input.identity,input.requestKey,scopeKey,version,fingerprint,JSON.stringify(document));
      return document;
    });
  }

  assertCurrent(document: PlanDocument, accountId: string, identity: string, keys: readonly string[], allowPriorRound = false) {
    const roundsMatch = document.rounds.every(round => {
      const row=this.store.database.connection.prepare(`SELECT e.id FROM work_item_events e JOIN work_items w ON w.id=e.item_id
        WHERE w.item_key=? AND e.history_source_key IS NULL AND e.event_type='status_changed'
        AND json_extract(e.payload_json,'$.reason')='verification_failed' ORDER BY e.timeline_seq DESC LIMIT 1`).get(round.key) as {id:string}|undefined;
      return (row?.id ?? null)===round.eventId;
    });
    if ((!allowPriorRound && !roundsMatch) || document.accountId!==accountId || document.identity!==identity || JSON.stringify([...keys].sort())!==JSON.stringify(document.keys)
      || document.scope!==new ImplementationPlans(this.store.database).scope(keys)) {
      throw conflict("plan_document_scope_changed", "Document identity or scope changed. Prepare and review the current document.");
    }
  }

  approved(document: PlanDocument): boolean {
    const plans = new ImplementationPlans(this.store.database);
    if(document.parentDocumentId) {
      const parent=this.get(document.parentDocumentId,()=>undefined);
      return !parent.parentDocumentId && document.scope===plans.scope(document.keys) && this.approved(parent);
    }
    const proposal = plans.proposal(document.accountId,document.identity);
    return proposal?.documentId===document.id && proposal.approved && proposal.valid;
  }
}
