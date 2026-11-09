import type { AgentSessionListItem } from "./agent-session-store.js";
import type { MissionGoStore } from "./store.js";
import { ImplementationPlans } from "./implementation-plans.js";
import { PlanDocuments, type PlanDocument } from "./plan-documents.js";
import { notFound } from "./errors.js";

interface VersionRow {
  sequence:number; revision:string; identity_key:string; proposal_json:string; scope_json:string; kind:"proposal"|"rework"; legacy:number;
}
interface Proposal { keys:string[]; plan:string; validation:string; documentId?:string; submittedAt?:string }

/** Explicit conversation scope only. No text classification, synthetic message or approval writes. */
export class PlanRecords {
  constructor(private readonly store:MissionGoStore) {}

  identities(accountId:string,members:readonly AgentSessionListItem[]):string[] {
    const db=this.store.database.connection;
    const identities=new Set<string>();
    for(const member of members) {
      if(member.source!=="external" && member.dispatchId) identities.add(`dispatch:${member.dispatchId}`);
      if(member.source!=="external") continue;
      const native=db.prepare("SELECT agent_kind,ref_kind,session_ref FROM external_agent_sessions WHERE account_id=? AND id=?")
        .get(accountId,member.id) as {agent_kind:string;ref_kind:string;session_ref:string}|undefined;
      if(!native) continue;
      const suffix=`:${native.agent_kind}:${native.ref_kind}:${native.session_ref}`;
      const rows=db.prepare("SELECT DISTINCT identity_key FROM implementation_plan_versions WHERE account_id=? AND substr(identity_key,1,7)='native:' AND substr(identity_key,-length(?))=?")
        .all(accountId,suffix,suffix) as {identity_key:string}[];
      for(const row of rows) if(row.identity_key.startsWith("native:")&&row.identity_key.endsWith(suffix)) identities.add(row.identity_key);
    }
    return [...identities];
  }

  has(accountId:string,identities:readonly string[],authorize:(key:string)=>unknown):boolean {
    for(const identity of identities) {
      const rows=this.store.database.connection.prepare(
        "SELECT scope_json FROM implementation_plan_versions WHERE account_id=? AND identity_key=? ORDER BY sequence DESC")
        .iterate(accountId,identity);
      for(const row of rows) {
        try { for(const item of JSON.parse(row.scope_json as string) as {key:string}[]) authorize(item.key); return true; }
        catch { /* Historical inaccessible scope must not leak existence. */ }
      }
    }
    return false;
  }

  read(accountId:string,identities:readonly string[],authorize:(key:string)=>unknown,options:{before?:number|undefined;recordId?:number|undefined}={}) {
    const db=this.store.database.connection;
    if(!identities.length) { if(options.recordId) throw notFound("Plan record"); return {records:[],historyIncomplete:false}; }
    const slots=identities.map(()=>"?").join(",");
    const selection=options.recordId ? "*" : "sequence,revision,identity_key,scope_json,kind,legacy,json_remove(proposal_json,'$.plan','$.validation') AS proposal_json";
    const rows=db.prepare(`SELECT ${selection} FROM implementation_plan_versions WHERE account_id=? AND identity_key IN (${slots})
      AND sequence < ? ${options.recordId ? "AND sequence=?" : ""} ORDER BY sequence DESC LIMIT 21`)
      .all(accountId,...identities,options.before??Number.MAX_SAFE_INTEGER,...(options.recordId?[options.recordId]:[])) as unknown as VersionRow[];
    if(options.recordId&&!rows.length) throw notFound("Plan record");
    const records=rows.slice(0,20).map(row=>this.record(accountId,row,authorize,Boolean(options.recordId)));
    // Unknown old unapproved requests cannot be reconstructed. Never claim complete pre-migration history.
    return {records,historyIncomplete:identities.some(identity=>Boolean(db.prepare("SELECT 1 FROM implementation_plan_versions WHERE account_id=? AND identity_key=? AND legacy=1 LIMIT 1").get(accountId,identity))),...(rows.length>20?{nextBefore:records.at(-1)!.id}:{})};
  }

  /** Current records are independent of the historical cursor. Only these summaries are read. */
  overview(accountId:string,identities:readonly string[],authorize:(key:string)=>unknown) {
    const db=this.store.database.connection;
    const records=[] as ReturnType<PlanRecords["record"]>[];
    const slots=identities.map(()=>"?").join(",");
    if(!identities.length) return {records,historyIncomplete:false,hasHistory:false};
    const rows=db.prepare(`SELECT v.sequence,v.revision,v.identity_key,v.scope_json,v.kind,v.legacy,
      json_remove(v.proposal_json,'$.plan','$.validation') AS proposal_json
      FROM implementation_plan_versions v JOIN implementation_plan_requests r
      ON r.account_id=v.account_id AND r.identity_key=v.identity_key AND r.revision=v.revision
      WHERE v.account_id=? AND v.identity_key IN (${slots}) AND v.kind='proposal' ORDER BY v.sequence DESC`)
      .all(accountId,...identities) as unknown as VersionRow[];
    for(const row of rows) {
      const record=this.record(accountId,row,authorize,false,true);
      records.push(record);
      if(!record.effective || !record.documentId) continue;
      const note=db.prepare(`SELECT v.sequence,v.revision,v.identity_key,v.scope_json,v.kind,v.legacy,
        json_remove(v.proposal_json,'$.plan','$.validation') AS proposal_json
        FROM implementation_plan_versions v JOIN plan_documents d ON d.id=json_extract(v.proposal_json,'$.documentId')
        WHERE v.account_id=? AND v.identity_key=? AND v.kind='rework'
        AND json_extract(d.document_json,'$.parentDocumentId')=? ORDER BY v.sequence DESC LIMIT 1`)
        .get(accountId,row.identity_key,record.documentId) as VersionRow|undefined;
      if(note) records.push(this.record(accountId,note,authorize,false,true));
    }
    const visible=new Set(records.map(record=>record.id));
    let hasHistory=false;
    // Metadata only; do not infer a total or leak inaccessible historical scopes.
    const history=db.prepare(`SELECT sequence,revision,identity_key,scope_json,kind,legacy,json_remove(proposal_json,'$.plan','$.validation') AS proposal_json FROM implementation_plan_versions
      WHERE account_id=? AND identity_key IN (${slots}) ORDER BY sequence DESC`).iterate(accountId,...identities);
    for(const row of history) {
      if(visible.has(row.sequence as number)) continue;
      try { this.record(accountId,row as unknown as VersionRow,authorize,false); hasHistory=true;break; }
      catch { /* Same scope filtering as has(). Reading never grants access. */ }
    }
    const historyIncomplete=identities.some(identity=>Boolean(db.prepare("SELECT 1 FROM implementation_plan_versions WHERE account_id=? AND identity_key=? AND legacy=1 LIMIT 1").get(accountId,identity)));
    return {records,historyIncomplete,hasHistory};
  }

  private record(accountId:string,row:VersionRow,authorize:(key:string)=>unknown,full:boolean,includeSummary=false) {
    const db=this.store.database.connection;
    const plans=new ImplementationPlans(this.store.database);
    const proposal=JSON.parse(row.proposal_json) as Proposal;
    const keys=(JSON.parse(row.scope_json) as {key:string}[]).map(item=>item.key);
    for(const key of new Set([...keys,...proposal.keys])) authorize(key);
    const current=plans.proposal(accountId,row.identity_key);
    const approval=db.prepare("SELECT approved_at,source FROM implementation_plan_approvals WHERE account_id=? AND identity_key=? AND revision=?")
      .get(accountId,row.identity_key,row.revision) as {approved_at:string;source:string}|undefined;
    // List polling reads metadata, never every version's Markdown body.
    const metadata=proposal.documentId && !full ? db.prepare(
      `SELECT json_remove(document_json,'$.markdown','$.plan'${includeSummary ? "" : ",'$.summary'"}) AS metadata FROM plan_documents WHERE id=?`)
      .get(proposal.documentId) as {metadata:string}|undefined : undefined;
    const document=proposal.documentId ? (full ? new PlanDocuments(this.store).get(proposal.documentId,authorize)
      : metadata ? JSON.parse(metadata.metadata) as PlanDocument : undefined) : undefined;
    for(const key of document?.keys??[]) authorize(key);
    const isCurrent=row.kind==="proposal" && current?.revision===row.revision;
    // An historical approval is a fact, never current execution authority.
    const effective=Boolean(isCurrent && current?.approved && current.valid);
    return {id:row.sequence,revision:row.revision,keys,kind:row.kind,current:isCurrent,effective,
      pending:Boolean(isCurrent && !approval && current?.valid),currentValid:Boolean(isCurrent && current?.valid),
      scopeValid:row.scope_json===plans.scope(keys),legacy:Boolean(row.legacy),
      ...(proposal.submittedAt?{submittedAt:proposal.submittedAt}:{}),
      ...(approval?{approval:{approvedAt:approval.approved_at,source:approval.source}}:{}),
      ...(document?{documentId:document.id,version:document.version,rounds:document.rounds,sha256:document.sha256,
        ...(document.parentDocumentId?{parentDocumentId:document.parentDocumentId,parentApproved:new PlanDocuments(this.store).approved(document)}:{})}:{}),
      ...(includeSummary && document ? {summary:document.summary} : {}),
      ...(full ? {plan:proposal.plan,validation:proposal.validation,...(document?{markdown:document.markdown}:{})}:{}),
    };
  }
}
