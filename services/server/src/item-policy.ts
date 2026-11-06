import { collaborationTransitionDenial, collaborationVerifier } from "./collaboration-policy.js";
import { requiresExecutionStopCheck, hasOngoingItemExecution } from "./builder-authority.js";
import { evaluateWorkItemTransition, type ActorKind, type TransitionReason, type WorkItemStatus } from "@missiongo/domain";
import { AccountStore } from "./accounts-store.js";
import type { MissionGoDatabase } from "./storage/database.js";
import { MissionGoError } from "./errors.js";

export interface PolicyItem {
  id: string; productId: string; status: WorkItemStatus; builderAccountId?: string;
  heldFrom?: WorkItemStatus; transferred?: boolean; executionDispatchId?:string;
  createdBy?: {kind:string;accountId?:string};
}
export function itemRoles(database: MissionGoDatabase, item: PolicyItem, accountId?: string) {
  const accounts = new AccountStore(database);
  const account = accountId ? accounts.findActive(accountId) : undefined;
  const view = !!account && accounts.allows(account,item.productId,"view");
  const manager = view && (account.role === "admin" || accounts.isProjectAdministrator(account,item.productId));
  const proposer = view && item.createdBy?.kind !== "sdk" && item.createdBy?.accountId === accountId;
  const builder = view && item.builderAccountId === accountId;
  const executor = view && !!database.connection.prepare(`SELECT 1 FROM item_executions WHERE item_id=? AND account_id=? AND authorization_revoked=0 AND status IN ('assigned','working','blocked')`).get(item.id,accountId!);
  const operate = view && accounts.allows(account!,item.productId,"operate");
  const roles = [manager && (account?.role === "admin" ? "system_admin" : "project_admin"),proposer && "proposer",builder && "builder",executor && "executor",operate && "operator"].filter((v):v is string=>!!v);
  return {view,manager,proposer,builder,executor,operate,roles};
}
export function transitionPolicy(database: MissionGoDatabase,item: PolicyItem,accountId: string|undefined,to: WorkItemStatus,reason: TransitionReason,actor: ActorKind = "human", context?:ReturnType<typeof itemRoles>, archived?:boolean) {
  const roles = context ?? itemRoles(database,item,accountId);
  if (item.status === "pending_verification" && to === "ready") reason="verification_failed";
  if (item.status === "pending_verification" && to === "done") reason="verification_passed";
  if (item.status === "done" && to === "ready") reason="reopened";
  if (item.status === "cancelled" && to === "inbox") reason="restored";
  const result = (allowed:boolean,code:string) => ({allowed,code:allowed ? "allowed" : code,roles:roles.roles,basis:reason === "manual_override" ? "manager_correction" : roles.roles.join("+")});
  const denied=collaborationTransitionDenial(database,item,to,actor,accountId);
  if(denied)return result(false,denied);
  if (item.transferred) return result(false,"item_transferred");
  const isArchived = archived ?? Boolean((database.connection.prepare("SELECT archived_at FROM products WHERE id=?").get(item.productId) as {archived_at:string|null}|undefined)?.archived_at);
  if (isArchived) return result(false,"project_archived");
  const verifier=collaborationVerifier(database,item.id);
  if(verifier && actor === "human" && accountId === verifier && item.status === "pending_verification" && ["done","ready"].includes(to)) {
    const source=database.connection.prepare("SELECT s.product_id FROM collaboration_requests r JOIN work_items s ON s.id=r.source_item_id WHERE r.target_item_id=? AND r.access_revoked_at IS NULL AND r.verifier_account_id=? LIMIT 1").get(item.id,accountId) as {product_id:string}|undefined;
    const accounts=new AccountStore(database),account=accounts.findActive(accountId);
    if(source && account && accounts.allows(account,source.product_id,"view")) return result(true,"allowed");
    return result(false,"item_not_accessible");
  }
  if (verifier && to === "cancelled" && (!roles.operate || !roles.manager && !roles.builder)) return result(false,"collaboration_receiver_required");
  if (to === "in_progress" && reason === "claim" && requiresExecutionStopCheck(database,item.id) && hasOngoingItemExecution(database,item.id,item.executionDispatchId)) return result(false,"execution_stop_unconfirmed");
  if (actor !== "human") {
    if (actor === "system") return result(
      to === "development_complete" && reason === "resolution_submitted" && ["inbox","ready","in_progress","development_complete"].includes(item.status)
      || to === "pending_verification" && reason === "release_verified" && item.status === "development_complete","system_evidence_required");
    if (!evaluateWorkItemTransition({from:item.status,to,actor,reason}).allowed) return result(false,"invalid_state_transition");
    return result(roles.operate && ["in_progress","development_complete","pending_verification"].includes(to) && (roles.builder || roles.executor || to === "in_progress" && !item.builderAccountId),"execution_not_permitted");
  }
  if (!roles.view) return result(false,"item_not_accessible");
  // Terminal decisions have one meaning even through a manual correction.
  if (item.status === "done" && to !== "ready") return result(false,"reopen_required");
  if (item.status === "cancelled" && to !== "inbox") return result(false,"restore_required");
  if (reason === "manual_override") return result(roles.manager,to === "done" ? "verification_not_permitted" : "manager_required");
  const edge = evaluateWorkItemTransition({from:item.status,to,actor,reason,note:"policy check"});
  if (!edge.allowed) return result(false,"invalid_state_transition");
  if (to === "done" || item.status === "done") return result(roles.manager || roles.proposer,"verification_not_permitted");
  if (to === "cancelled" || item.status === "cancelled" || item.status === "pending_verification") return result(roles.manager || roles.proposer || roles.builder,"decision_not_permitted");
  if (item.status === "on_hold") {
    if (to !== item.heldFrom) return result(false,"resume_origin_required");
    return result(roles.manager || roles.proposer && ["inbox","ready"].includes(to) || roles.builder && ["ready","in_progress"].includes(to),"resume_not_permitted");
  }
  if (to === "on_hold") return result(roles.manager || roles.proposer && ["inbox","ready"].includes(item.status) || roles.builder && item.status !== "inbox","hold_not_permitted");
  if (to === "in_progress") return result(roles.operate && (roles.builder || roles.executor || !item.builderAccountId),"builder_handover_required");
  if (to === "development_complete" || to === "pending_verification") return result(roles.manager || roles.operate && (roles.builder || roles.executor),"delivery_not_permitted");
  if (["in_progress","development_complete"].includes(item.status)) return result(roles.manager || roles.builder,"release_not_permitted");
  return result(roles.manager || roles.proposer,"proposer_or_manager_required");
}
/** A publication is product-scoped, independently of the developer's execution identity. */
export function assertReleaseBatchTransition(database: MissionGoDatabase, item: PolicyItem, accountId: string | undefined) {
  const accounts = new AccountStore(database), account = accountId ? accounts.findActive(accountId) : undefined;
  if (!account || !accounts.allows(account, item.productId, "operate") || !accounts.allows(account, item.productId, "ai")) {
    throw new MissionGoError("release_not_permitted", "Product operation and AI permissions are required for release handover.", 403);
  }
  // Reuse archive, transfer, collaboration and exact state-edge guards. This is
  // called only after the batch's immutable candidate and evidence checks.
  const decision = transitionPolicy(database, item, accountId, "pending_verification", "release_verified", "system");
  if (!decision.allowed) throw new MissionGoError(decision.code, "Release handover is no longer permitted.", 409);
  return { ...decision, basis: "product_release_batch" };
}

export function assertTransitionPolicy(database: MissionGoDatabase,item: PolicyItem,accountId: string|undefined,to:WorkItemStatus,reason:TransitionReason,actor:ActorKind = "human") {
  const decision = transitionPolicy(database,item,accountId,to,reason,actor);
  if (!decision.allowed) throw new MissionGoError(decision.code,"当前身份不允许此操作，请刷新条目查看可用动作。",["execution_stop_unconfirmed","project_archived","invalid_state_transition","resume_origin_required"].includes(decision.code) ? 409 : 403);
  return decision;
}
