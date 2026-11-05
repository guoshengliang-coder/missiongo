import { ImplementationPlans, planDigest } from "./implementation-plans.js";
import type { MissionGoDatabase } from "./storage/database.js";
import { createHash } from "node:crypto";

import type { AgentApproval } from "./agent-approval-store.js";
import type { AgentSessionAttention, AgentSessionSnapshot } from "./agent-session-store.js";
import { conflict } from "./errors.js";

export type PlanApprovalStatusCode = "ready" | "connection_unavailable" | "reply_unavailable" | "running"
  | "permission_required" | "reply_pending" | "not_approval" | "dismissed" | "awaiting_source" | "approved";
export type PlanApprovalBlockReason = Extract<PlanApprovalStatusCode, "connection_unavailable" | "reply_pending" | "dismissed">;
export interface PlanApprovalOffer {
  readonly revision: string;
  readonly reason: string;
  readonly plan?: string;
  readonly validation?: string;
  readonly itemKeys?: readonly string[];
}
export interface PlanApprovalAssessment {
  readonly status: { readonly code: PlanApprovalStatusCode };
  readonly offer?: PlanApprovalOffer;
}

type Session = AgentSessionSnapshot & { readonly canReply: boolean; readonly approval?: AgentApproval; readonly attention: AgentSessionAttention; readonly canApprovePlan?: boolean };

/** The existing attention label supplies the shortcut. No second semantic verdict. */
export class PlanApprovalService {
  private readonly approvedRequests = new Map<string, string>();
  private readonly plans: ImplementationPlans | undefined;
  constructor(private readonly database?: MissionGoDatabase) {
    this.plans = database ? new ImplementationPlans(database) : undefined;
  }

  private identity(session: Session): string {
    if(session.dispatchId) return `dispatch:${session.dispatchId}`;
    const external=this.database?.connection.prepare("SELECT client_id,agent_kind,ref_kind,session_ref FROM external_agent_sessions WHERE id=?")
      .get(session.id) as {client_id:string;agent_kind:string;ref_kind:string;session_ref:string}|undefined;
    return external ? `native:${external.client_id}:${external.agent_kind}:${external.ref_kind}:${external.session_ref}` : `session:${session.id}`;
  }
  private owner(session: Session): string | undefined {
    return (this.database?.connection.prepare(`SELECT d.account_id FROM agent_sessions s JOIN dispatches d ON d.id=s.dispatch_id WHERE s.id=?
      UNION ALL SELECT account_id FROM external_agent_sessions WHERE id=? LIMIT 1`).get(session.id,session.id) as {account_id:string}|undefined)?.account_id;
  }
  private planHash(session: Session): string {
    const last = [...session.messages].reverse().find(message => message.role !== "user");
    return planDigest(last?.text ?? "");
  }

  registered(session: Session) {
    const owner = this.owner(session);
    const proposal = owner ? this.plans?.proposal(owner,this.identity(session)) : undefined;
    const visible = [...session.messages].reverse().find(message=>message.role!=="user")?.text;
    if (proposal?.origin === "attention" && session.attention.state === "needed" && session.attention.kind === "approval"
      && visible && visible !== proposal.plan) return undefined;
    return proposal;
  }

  /** Readable proposal survives approval, disconnection and scope changes. */
  content(session: Session) {
    const proposal = this.registered(session);
    return proposal ? { revision: proposal.revision, itemKeys: proposal.keys,
      plan: proposal.plan, validation: proposal.validation,
      submittedAt: proposal.submittedAt, approvedAt: proposal.approvedAt,
      approved: proposal.approved, valid: proposal.valid } : undefined;
  }

  /** A registered plan is a domain decision, independent of its optional reply channel. */
  private independent(session: Session): boolean {
    return Boolean(this.registered(session));
  }

  private awaitingNativePlan(session: Session): boolean {
    const last=[...session.messages].reverse().find(message=>message.role!=="user");
    return session.source!=="external" && session.agentKind==="claude_code" && session.turnState.waitingForInput===true
      && last?.role==="plan" && /^(permission|request)-/.test(last.sourceId)
      && last.phase!=="plan_approved" && last.phase!=="plan_declined";
  }

  approvalState(session: Session) {
    const proposal = this.registered(session);
    if (!proposal?.approved) return undefined;
    const owner = this.owner(session)!;
    const row = this.database!.connection.prepare(`SELECT command_id FROM implementation_plan_approvals
      WHERE account_id=? AND identity_key=? AND revision=?`).get(owner,this.identity(session),proposal.revision) as {command_id:string|null}|undefined;
    const cancelled=row?.command_id && this.database!.connection.prepare(`SELECT 1 FROM agent_session_commands WHERE id=? AND status IN ('cancelled','failed')
      UNION ALL SELECT 1 FROM external_native_commands WHERE id=? AND status IN ('cancelled','failed') LIMIT 1`).get(row.command_id,row.command_id);
    const pending=this.database!.connection.prepare(`SELECT 1 FROM implementation_plan_continuations
      WHERE account_id=? AND identity_key=? AND revision=? AND state='waiting'`).get(owner,this.identity(session),proposal.revision);
    return { approved: true as const, revision: proposal.revision, continuationQueued: Boolean(row?.command_id) && !cancelled,
      ...(pending ? {continuationPending:true as const} : {}) };
  }

  assess(session: Session, unavailableReason?: PlanApprovalBlockReason): PlanApprovalAssessment {
    const attention = session.attention;
    const owner = this.owner(session);
    const prepared = this.registered(session);
    if(prepared?.approved) return {status:{code:this.independent(session) ? "approved" : "awaiting_source"}};
    const visiblePlan=[...session.messages].reverse().find(message=>message.role!=="user")?.text;
    if(!prepared && !visiblePlan?.trim()) return {status:{code:"not_approval"}};
    if(prepared && !prepared.valid) return {status:{code:"not_approval"}};
    if(session.canApprovePlan===false) return {status:{code:"reply_unavailable"}};
    if (!prepared && attention.dismissed) return { status: { code: "dismissed" } };
    if (!prepared && (attention.state !== "needed" || attention.kind !== "approval")) return { status: { code: "not_approval" } };
    if (this.independent(session)) {
      if (session.archivedAt || session.managedExecution) return {status:{code:"reply_unavailable"}};
      return {status:{code:"ready"},offer:{revision:prepared!.revision,reason:"请审阅当前方案与验证目标。",plan:prepared!.plan,validation:prepared!.validation,itemKeys:prepared!.keys}};
    }
    if (unavailableReason) return { status: { code: unavailableReason } };
    if (!session.canReply || session.managedExecution || session.archivedAt) return { status: { code: "reply_unavailable" } };
    if (session.lastError || (session.nativeConnection && session.nativeConnection.state !== "connected")) return { status: { code: "connection_unavailable" } };
    // A chat reply never answers a tool permission request.
    if (session.approval && !["approved", "resolved"].includes(session.approval.status)) return { status: { code: "permission_required" } };
    const command = session.command;
    if (command && ["queued", "delivering", "delivery_unknown"].includes(command.status)) return { status: { code: "reply_pending" } };
    if ((session.status !== "idle" || session.turnState.turnActive === true) && !this.awaitingNativePlan(session)) return { status: { code: "running" } };
    if (owner && this.plans?.approved(owner,this.identity(session),this.planHash(session))) return { status: { code: "awaiting_source" } };
    const requestRevision = createHash("sha256").update(JSON.stringify(session.messages)).digest("hex");
    if (!this.plans && this.approvedRequests.get(session.id) === requestRevision) return { status: { code: "awaiting_source" } };
    const latest = session.messages.at(-1);
    if (command?.status === "delivered" && (!latest?.occurredAt
      || Date.parse(command.createdAt) >= Date.parse(latest.occurredAt))) return { status: { code: "awaiting_source" } };
    const revision = prepared?.revision ?? createHash("sha256").update(JSON.stringify([session.id, attention, session.messages, this.plans && session.dispatchId ? this.plans.scope(this.plans.dispatchKeys(session.dispatchId)) : null])).digest("hex");
    return { status: { code: "ready" }, offer: { revision, reason: attention.reason ?? "",...(prepared ? {plan:prepared.plan,validation:prepared.validation,itemKeys:prepared.keys} : {plan:visiblePlan!,...(session.dispatchId && this.plans ? {itemKeys:this.plans.dispatchKeys(session.dispatchId)} : {})}) } };
  }

  /** Reload and enqueue together in the caller's transaction; the queue prevents double submission. */
  approve<T>(session: Session, revision: string, enabled: boolean, enqueue: () => T, deliveryAvailable=true): T | {approved:true;revision:string;continuationQueued:boolean;continuationPending?:true} {
    const saved = this.approvalState(session);
    if (saved?.revision === revision) return saved;
    const assessment = this.assess(session);
    if (!enabled || assessment.status.code !== "ready" || assessment.offer?.revision !== revision) {
      throw conflict("agent_plan_approval_changed", "The approval request changed or is unavailable. Refresh and review the conversation before approving.");
    }
    // An explicit proposal can be approved offline. Only queue when the original channel is ready.
    const canContinue = deliveryAvailable && session.canReply && (session.status === "idle" && session.turnState.turnActive !== true || this.awaitingNativePlan(session))
      && !session.lastError && (!session.nativeConnection || session.nativeConnection.state === "connected")
      && (!session.command || !["queued","delivering","delivery_unknown"].includes(session.command.status))
      && (!session.approval || ["approved","resolved"].includes(session.approval.status));
    const result = this.independent(session) && !canContinue
      ? {approved:true as const,revision,continuationQueued:false as const} : enqueue();
    const owner = this.owner(session);
    if (owner && this.plans) {
      const prepared=this.registered(session);
      const keys = prepared?.keys ?? (session.dispatchId ? this.plans.dispatchKeys(session.dispatchId)
        : (this.database!.connection.prepare(`SELECT w.item_key AS key FROM external_agent_session_items e JOIN work_items w ON w.id=e.item_id WHERE e.session_id=?`).all(session.id) as {key:string}[]).map(row => row.key));
      const plan = prepared?.plan ?? [...session.messages].reverse().find(message=>message.role!=="user")?.text ?? "";
      this.plans.request(owner,this.identity(session),revision,{keys,plan,validation:prepared?.validation ?? "",...(!prepared ? {origin:"attention" as const} : prepared.origin ? {origin:prepared.origin} : {})});
      this.plans.record({accountId:owner,identity:this.identity(session),revision,planHash:revision,keys,source:"web",validation:prepared?.validation ?? "",plan,
        ...(result && typeof result === "object" && "id" in result ? {commandId:String(result.id)} : {})});
      // Running sources continue themselves. Persist a single offline/blocked idle handoff.
      if (result && typeof result === "object" && "continuationQueued" in result && !result.continuationQueued
        && (session.status !== "active" && session.turnState.turnActive !== true || this.awaitingNativePlan(session))) {
        this.database!.connection.prepare(`INSERT OR IGNORE INTO implementation_plan_continuations
          (account_id,identity_key,revision,session_id,source_digest,requested_at,state) VALUES (?,?,?,?,?,?,'waiting')`)
          .run(owner,this.identity(session),revision,session.id,this.sourceDigest(session),new Date().toISOString());
      }
    }
    this.approvedRequests.delete(session.id);
    this.approvedRequests.set(session.id, createHash("sha256").update(JSON.stringify(session.messages)).digest("hex"));
    if (this.approvedRequests.size > 200) this.approvedRequests.delete(this.approvedRequests.keys().next().value!);
    return result && typeof result==="object" && "approved" in result ? this.approvalState(session) ?? result : result;
  }

  private sourceDigest(session: Session): string {
    const user = [...session.messages].reverse().find(message=>message.role==="user");
    const agent = [...session.messages].reverse().find(message=>message.role!=="user");
    return planDigest([user?.turnId ?? null,user?.text ?? null,agent?.role ?? null,agent?.text ?? null,agent?.phase ?? null]);
  }

  /** Called after original-node reports. Existing queues remain the delivery authority. */
  resume<T extends {id:string}>(session: Session, enabled: boolean, enqueue:()=>T): void {
    if (!this.database) return;
    this.database.transaction(()=>{
      const owner=this.owner(session), identity=this.identity(session);
      if (!owner) return;
      const pending=this.database!.connection.prepare(`SELECT revision,source_digest,requested_at FROM implementation_plan_continuations
        WHERE account_id=? AND identity_key=? AND state='waiting'`).get(owner,identity) as
        {revision:string;source_digest:string;requested_at:string}|undefined;
      if (!pending) return;
      const settle=(state:string,commandId:string|null=null)=>this.database!.connection.prepare(`UPDATE implementation_plan_continuations
        SET state=?,command_id=? WHERE account_id=? AND identity_key=? AND revision=? AND state='waiting'`)
        .run(state,commandId,owner,identity,pending.revision);
      const proposal=this.registered(session);
      const subsequentInput=this.database!.connection.prepare(`SELECT 1 FROM agent_session_commands WHERE session_id=? AND created_at>=?
        UNION ALL SELECT 1 FROM external_native_commands WHERE session_id=? AND created_at>=? LIMIT 1`)
        .get(session.id,pending.requested_at,session.id,pending.requested_at);
      if (!enabled || session.archivedAt || session.managedExecution || !proposal?.approved || proposal.revision!==pending.revision
        || (session.status==="active" || session.turnState.turnActive===true) && !this.awaitingNativePlan(session) || subsequentInput || this.sourceDigest(session)!==pending.source_digest) {
        settle("cancelled");return;
      }
      if (!session.canReply || session.status!=="idle" && !this.awaitingNativePlan(session) || session.lastError
        || session.nativeConnection && session.nativeConnection.state!=="connected"
        || session.approval && !["approved","resolved"].includes(session.approval.status)
        || session.command && ["queued","delivering","delivery_unknown"].includes(session.command.status)) return;
      const command=enqueue();
      this.plans!.attachCommand(owner,identity,pending.revision,command.id);
      settle("queued",command.id);
    });
  }

}
