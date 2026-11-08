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
    const plans=new ImplementationPlans(this.store.database);
    const records=rows.slice(0,20).map(row=>{
      const proposal=JSON.parse(row.proposal_json) as Proposal;
      const keys=(JSON.parse(row.scope_json) as {key:string}[]).map(item=>item.key);
      for(const key of new Set([...keys,...proposal.keys])) authorize(key);
      const current=plans.proposal(accountId,row.identity_key);
      const approval=db.prepare("SELECT approved_at,source FROM implementation_plan_approvals WHERE account_id=? AND identity_key=? AND revision=?")
        .get(accountId,row.identity_key,row.revision) as {approved_at:string;source:string}|undefined;
      // List polling reads metadata, never every version's Markdown body.
      const metadata=proposal.documentId && !options.recordId ? db.prepare(
        "SELECT json_remove(document_json,'$.markdown','$.plan','$.summary') AS metadata FROM plan_documents WHERE id=?")
        .get(proposal.documentId) as {metadata:string}|undefined : undefined;
      const document=proposal.documentId ? (options.recordId ? new PlanDocuments(this.store).get(proposal.documentId,authorize)
        : metadata ? JSON.parse(metadata.metadata) as PlanDocument : undefined) : undefined;
      for(const key of document?.keys??[]) authorize(key);
      const isCurrent=row.kind==="proposal" && current?.revision===row.revision;
      // An historical approval is a fact, never current execution authority.
      const effective=Boolean(isCurrent && current?.approved && current.valid);
      return {id:row.sequence,revision:row.revision,keys,kind:row.kind,current:isCurrent,effective,
        scopeValid:row.scope_json===plans.scope(keys),legacy:Boolean(row.legacy),
        ...(proposal.submittedAt?{submittedAt:proposal.submittedAt}:{}),
        ...(approval?{approval:{approvedAt:approval.approved_at,source:approval.source}}:{}),
        ...(document?{documentId:document.id,version:document.version,rounds:document.rounds,sha256:document.sha256,
          ...(document.parentDocumentId?{parentDocumentId:document.parentDocumentId,parentApproved:new PlanDocuments(this.store).approved(document)}:{})}:{}),
        ...(options.recordId ? {plan:proposal.plan,validation:proposal.validation,...(document?{markdown:document.markdown}:{})}:{}),
      };
    });
    // Unknown old unapproved requests cannot be reconstructed. Never claim complete pre-migration history.
    return {records,historyIncomplete:identities.some(identity=>Boolean(db.prepare("SELECT 1 FROM implementation_plan_versions WHERE account_id=? AND identity_key=? AND legacy=1 LIMIT 1").get(accountId,identity))),...(rows.length>20?{nextBefore:records.at(-1)!.id}:{})};
  }
}
