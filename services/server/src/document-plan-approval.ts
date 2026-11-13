import { createHash } from "node:crypto";
import { AccountStore } from "./accounts-store.js";
import { AgentArtifacts } from "./agent-artifacts.js";
import { AgentHistory } from "./agent-history.js";
import { assertBuilderExecution, assertDispatchExecution, assertExternalExecution } from "./builder-authority.js";
import { ImplementationPlans } from "./implementation-plans.js";
import { PlanDocuments } from "./plan-documents.js";
import type { AgentSessionMessageInput } from "./agent-session-store.js";
import type { MissionGoDatabase } from "./storage/database.js";

export type DocumentApprovalCode = "ready_to_restore" | "restored" | "already_approved" | "evidence_missing"
  | "history_incomplete" | "scope_changed" | "source_conflict" | "identity_unavailable" | "no_document";
export interface DocumentApprovalState { code: DocumentApprovalCode; documentId?: string; revision?: string }
type Message = AgentSessionMessageInput;
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const waitingNotes = new Set([
  "等待批准。", "当前尚未批准。", "方案已保存，等待批准。", "Awaiting approval.",
  "方案已保存并完整回读，当前尚未批准、未修改产品代码。依 “选择不等于批准”，等待本批方案的一次明确实施批准。",
]);

/** Exact frozen content, with only navigation/status outside it. Never fuzzy matching. */
export function documentDecision(plan: string, requestedAt: string, messages: readonly Message[]) {
  const displays = messages.filter(m => m.role !== "user" && m.phase === "final_answer"
    && (m.text === plan || m.text.startsWith(plan + "\n")) && m.occurredAt
    && Date.parse(m.occurredAt) >= Date.parse(requestedAt));
  if (displays.length !== 1) return undefined;
  const display = displays[0]!;
  if(display.questions?.length) return undefined;
  const suffix=display.text.slice(plan.length).trim();
  // Strip navigation links only; arbitrary additional requirements/exceptions
  // must not be interpreted as approval of the unchanged frozen document.
  const notes=suffix.replace(/\[[^\]]*\]\(<?[^\s)>]+>?\)/g,"").trim();
  if(notes && !waitingNotes.has(notes)) return undefined;
  // Multiple documents/proposals in one answer are ambiguous, even if one is a prefix.
  const links = [...display.text.matchAll(/[?&]planDocument=([a-f0-9-]{36})/g)].map(m=>m[1]);
  if (new Set(links).size !== 1) return undefined;
  const index = messages.indexOf(display);
  if(messages.slice(0,index).some(m=>m.role==="user" && m.occurredAt
    && Date.parse(m.occurredAt)>=Date.parse(requestedAt))) return undefined;
  const acceptance = messages.slice(index + 1).find(m => m.role === "user");
  if (!acceptance || acceptance.text !== "批准" || !acceptance.sourceId || !display.sourceId
    || !acceptance.occurredAt || !display.occurredAt
    || !Number.isFinite(Date.parse(acceptance.occurredAt))
    || Date.parse(acceptance.occurredAt) <= Date.parse(display.occurredAt)
    || acceptance.sourceId === display.sourceId
    || display.turnId && acceptance.turnId && display.turnId === acceptance.turnId) return undefined;
  // Provider-specific progress/revisions between the displayed plan and decision cannot be skipped.
  if (messages.slice(index + 1, messages.indexOf(acceptance)).some(m => m.role === "plan"
    || m.role === "agent" && m.phase === "final_answer")) return undefined;
  return { display, acceptance };
}

/** Pure inspection and explicit domain writes share one verifier. No caller supplied approval fact. */
export class DocumentPlanApprovals {
  constructor(private readonly database: MissionGoDatabase) {}
  private get db() { return this.database.connection; }

  private binding(accountId: string, sessionId: string) {
    const dispatch = this.db.prepare(`SELECT s.node_id,s.agent_session_ref AS session_ref,s.dispatch_id,s.agent_kind
      FROM agent_sessions s JOIN dispatches d ON d.id=s.dispatch_id JOIN nodes n ON n.id=s.node_id
      WHERE s.id=? AND d.account_id=? AND n.account_id=? AND n.revoked_at IS NULL
      AND s.archived_at IS NULL AND s.archive_source IS NULL AND d.status IN ('delivered','launched')
      AND s.agent_kind IN ('codex','claude_code','opencode')
      AND NOT EXISTS(SELECT 1 FROM managed_execution_intents WHERE id=d.id)`)
      .get(sessionId,accountId,accountId) as {node_id:string;session_ref:string;dispatch_id:string;agent_kind:string}|undefined;
    if (dispatch) return {...dispatch,external:false,identity:`dispatch:${dispatch.dispatch_id}`};
    const external = this.db.prepare(`SELECT s.native_node_id AS node_id,s.session_ref,s.client_id,s.agent_kind,s.ref_kind
      FROM external_agent_sessions s JOIN nodes n ON n.id=s.native_node_id
      WHERE s.id=? AND s.account_id=? AND n.account_id=? AND n.revoked_at IS NULL
      AND s.archived_at IS NULL AND s.ref_kind='native' AND s.agent_kind IN ('codex','claude_code','opencode')`)
      .get(sessionId,accountId,accountId) as {node_id:string;session_ref:string;client_id:string;agent_kind:string;ref_kind:string}|undefined;
    return external ? {...external,external:true,dispatch_id:undefined,
      identity:`native:${external.client_id}:${external.agent_kind}:${external.ref_kind}:${external.session_ref}`} : undefined;
  }

  private evaluate(accountId: string, sessionId: string) {
    const binding=this.binding(accountId,sessionId);
    const fail=(code:DocumentApprovalCode,documentId?:string,revision?:string)=>({state:{code,...(documentId?{documentId}:{}),...(revision?{revision}:{})}});
    if (!binding) return fail("identity_unavailable");
    const plans=new ImplementationPlans(this.database);
    const proposal=plans.proposal(accountId,binding.identity);
    if (!proposal?.documentId) return fail("no_document");
    const {documentId,revision}=proposal;
    const denied=(code:DocumentApprovalCode)=>fail(code,documentId,revision);
    try {
      if(binding.external) assertExternalExecution(this.database,sessionId);
      else assertDispatchExecution(this.database,binding.dispatch_id!);
      const accounts=new AccountStore(this.database),account=accounts.getAccount(accountId);
      for(const key of proposal.keys) {
        const item=this.db.prepare("SELECT id,product_id,status FROM work_items WHERE item_key=?").get(key) as {id:string;product_id:string;status:string}|undefined;
        if(!item || !["ready","in_progress","development_complete","pending_verification"].includes(item.status)
          || !["view","operate","ai"].every(p=>accounts.allows(account,item.product_id,p as "view"|"operate"|"ai"))) return denied("identity_unavailable");
        assertBuilderExecution(this.database,item.id,accountId);
      }
    } catch { return denied("identity_unavailable"); }
    if(!proposal.valid) return denied("scope_changed");
    if(proposal.approved) return denied("already_approved");
    const document=new PlanDocuments({database:this.database} as ConstructorParameters<typeof PlanDocuments>[0]).get(documentId,()=>undefined);
    if(document.accountId!==accountId || document.identity!==binding.identity || document.plan!==proposal.plan
      || document.parentDocumentId || !proposal.requestedAt) return denied("scope_changed");
    const history=new AgentHistory(this.database,new AgentArtifacts(this.database,""));
    const available=history.available(accountId,sessionId);
    if(!["complete","ready"].includes(available.status) || history.incomplete(accountId,sessionId)) return denied("history_incomplete");
    // Metadata first: refuse unbounded histories before loading bodies.
    const table=binding.external?"external_native_messages":"agent_session_messages";
    const count=this.db.prepare(`SELECT COUNT(*) AS n,COALESCE(SUM(length(${binding.external?"payload_json":"text"})),0) AS bytes FROM ${table} WHERE session_id=?`)
      .get(sessionId) as {n:number;bytes:number};
    if(count.n>10000 || count.bytes>32*1024*1024) return denied("history_incomplete");
    const current:Message[]=binding.external
      ? (this.db.prepare("SELECT payload_json FROM external_native_messages WHERE session_id=? ORDER BY position,rowid").all(sessionId) as {payload_json:string}[]).map(r=>JSON.parse(r.payload_json))
      : this.db.prepare(`SELECT source_id AS sourceId,turn_id AS turnId,role,phase,text,occurred_at AS occurredAt
          FROM agent_session_messages WHERE session_id=? ORDER BY position,observed_at,rowid`).all(sessionId) as unknown as Message[];
    const pages=this.db.prepare(`SELECT COUNT(*) AS n,COALESCE(SUM(length(result_json)),0) AS bytes FROM agent_history_pages
      WHERE account_id=? AND session_id=? AND node_id=? AND session_ref=? AND status='ready'`)
      .get(accountId,sessionId,binding.node_id,binding.session_ref) as {n:number;bytes:number};
    if(pages.n>512 || pages.bytes>32*1024*1024) return denied("history_incomplete");
    const cached=history.cachedMessages(accountId,sessionId);
    if(cached.length+current.length>10000 || Buffer.byteLength(JSON.stringify(cached))>32*1024*1024) return denied("history_incomplete");
    const bySource=new Map<string,Message>();
    for(const message of [...cached,...current]) {
      if(message.phase==="execution") continue;
      if(!message.sourceId || !message.occurredAt || !Number.isFinite(Date.parse(message.occurredAt))) return denied("history_incomplete");
      const previous=bySource.get(message.sourceId);
      if(previous && hash([previous.role,previous.text,previous.phase??null,Date.parse(previous.occurredAt!),previous.turnId??null])
        !==hash([message.role,message.text,message.phase??null,Date.parse(message.occurredAt!),message.turnId??null])) return denied("source_conflict");
      bySource.set(message.sourceId,message);
    }
    const messages=cached.length ? [...bySource.values()].sort((a,b)=>Date.parse(a.occurredAt!)-Date.parse(b.occurredAt!)) : [...bySource.values()];
    if(cached.length && messages.some((m,i)=>i>0 && Date.parse(m.occurredAt!)===Date.parse(messages[i-1]!.occurredAt!)
      && m.sourceId!==messages[i-1]!.sourceId)) return denied("source_conflict");
    const pair=documentDecision(document.plan,proposal.requestedAt,messages);
    if(!pair) return denied("evidence_missing");
    if(binding.agent_kind==="codex" && (!pair.display.turnId || !pair.acceptance.turnId)) return denied("evidence_missing");
    // Main-table occurred_at may be a receipt-time fallback. Only source clocks
    // or the original timestamp carried by authenticated history are evidence.
    for(const message of [pair.display,pair.acceptance]) {
      if(cached.some(m=>m.sourceId===message.sourceId && m.occurredAt && Date.parse(m.occurredAt)===Date.parse(message.occurredAt!))) continue;
      const stamp=this.db.prepare("SELECT occurred_at FROM session_message_times WHERE session_key=? AND source_id=? AND provenance='source_message'")
        .get(binding.external?`external:${sessionId}`:binding.identity,`native:${message.sourceId}`) as {occurred_at:string}|undefined;
      if(!stamp || Date.parse(stamp.occurred_at)!==Date.parse(message.occurredAt!)) return denied("history_incomplete");
    }
    return {state:{code:"ready_to_restore" as const,documentId,revision},binding,proposal,document,pair};
  }

  inspect(accountId:string,sessionId:string):DocumentApprovalState { return this.evaluate(accountId,sessionId).state; }

  recover(accountId:string,sessionId:string,documentId:string,revision:string,requestKey:string):DocumentApprovalState {
    return this.database.transaction(()=>{
      const result=this.evaluate(accountId,sessionId);
      if(!result.state.documentId) return result.state;
      if(result.state.documentId!==documentId || result.state.revision!==revision) return {code:"scope_changed",documentId,revision};
      if(!("pair" in result) || !result.pair) return result.state;
      const {binding,proposal,document,pair}=result;
      const prior=this.db.prepare("SELECT document_id,revision FROM document_plan_decisions WHERE account_id=? AND identity_key=? AND request_key=?")
        .get(accountId,binding.identity,requestKey) as {document_id:string;revision:string}|undefined;
      if(prior && (prior.document_id!==documentId || prior.revision!==revision)) return {code:"source_conflict",documentId,revision};
      const plans=new ImplementationPlans(this.database);
      plans.record({accountId,identity:binding.identity,revision,planHash:revision,keys:proposal.keys,plan:proposal.plan,validation:proposal.validation,source:"native"});
      this.db.prepare(`INSERT INTO document_plan_decisions(account_id,identity_key,revision,document_id,document_sha256,
        session_id,node_id,session_ref,display_source_id,acceptance_source_id,evidence_digest,accepted_at,recorded_at,request_key)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(accountId,binding.identity,revision,documentId,document.sha256,sessionId,
          binding.node_id,binding.session_ref,pair.display.sourceId,pair.acceptance.sourceId,hash(pair),pair.acceptance.occurredAt!,new Date().toISOString(),requestKey);
      plans.nativeContinued(accountId,binding.identity,revision);
      return {code:"restored",documentId,revision};
    });
  }

  synchronize(accountId:string,sessionId:string):void {
    const state=this.inspect(accountId,sessionId);
    if(state.code==="ready_to_restore") this.recover(accountId,sessionId,state.documentId!,state.revision!,`original-node-sync:${state.revision}`);
  }
}
