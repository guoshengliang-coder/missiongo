import { assertBuilderExecution, assertDispatchExecution } from "./builder-authority.js";
import { conflict } from "./errors.js";
import { ImplementationPlans, planDigest } from "./implementation-plans.js";
import { nativeMessageDigest, nativePlanPair } from "./storage/legacy-plan-recovery.js";
import type { MissionGoStore } from "./store.js";

/** Normal claim's narrowly scoped upgrade adapter. No caller-supplied approval or transcript.
 * Only migration-frozen, authenticated node history can restore a native decision. */
export function recoverLegacyPlanApproval(store: MissionGoStore, input: {
  accountId:string; clientId:string; dispatchId:string; itemKey:string;
  authorize: (key:string) => void;
}): void {
  const {accountId,clientId,dispatchId,itemKey}=input;
  const db=store.database.connection, plans=new ImplementationPlans(store.database), identity=`dispatch:${dispatchId}`;
  const candidate=db.prepare(`SELECT * FROM implementation_plan_recovery_candidates WHERE account_id=? AND identity_key=?`)
    .get(accountId,identity) as {request_revision:string;scope_json:string;session_id:string;node_id:string;
      plan_source_id:string;plan_digest:string;acceptance_source_id:string;acceptance_digest:string}|undefined;
  if (!candidate || plans.canImplement(accountId,identity)) return;
  store.database.transaction(() => {
    const unavailable=():never=>{throw conflict("native_plan_recovery_unavailable","历史原生方案证据或授权已变化，不能恢复批准；保留原记录，不重复要求批准或猜测其他会话。");};
    if(!clientId) unavailable();
    assertDispatchExecution(store.database,dispatchId);
    const session=db.prepare(`SELECT s.id FROM agent_sessions s JOIN dispatches d ON d.id=s.dispatch_id
      JOIN nodes n ON n.id=s.node_id WHERE s.id=? AND s.node_id=? AND d.id=? AND d.account_id=?
      AND n.account_id=? AND n.revoked_at IS NULL AND s.archived_at IS NULL
      AND s.agent_kind='codex' AND d.status IN ('delivered','launched')`)
      .get(candidate.session_id,candidate.node_id,dispatchId,accountId,accountId);
    if(!session) unavailable();
    const proposal=plans.proposal(accountId,identity);
    if(!proposal?.valid || proposal.revision!==candidate.request_revision
      || plans.scope(proposal.keys)!==candidate.scope_json || !proposal.keys.includes(itemKey)
      || JSON.stringify([...proposal.keys].sort())!==JSON.stringify(plans.dispatchKeys(dispatchId))) unavailable();
    for(const key of proposal!.keys) {
      input.authorize(key);
      const item=store.getWorkItem(key);
      store.assertWorkItemWritable(key);assertBuilderExecution(store.database,item.id,accountId);
      if(item.status!=="ready" || db.prepare(`SELECT 1 FROM work_item_events WHERE item_id=? AND to_status='in_progress' LIMIT 1`).get(item.id)) unavailable();
    }
    const pair=nativePlanPair(db,candidate.session_id);
    if(!pair || pair.plan.source_id!==candidate.plan_source_id || pair.acceptance.source_id!==candidate.acceptance_source_id
      || nativeMessageDigest(pair.plan)!==candidate.plan_digest || nativeMessageDigest(pair.acceptance)!==candidate.acceptance_digest) unavailable();
    // Restore the exact plan the user actually accepted, not an agent's paraphrase of it.
    const plan=pair!.plan.text, validation="", keys=proposal!.keys;
    const revision=planDigest([identity,candidate.scope_json,plan,validation]);
    plans.request(accountId,identity,revision,{keys,plan,validation});
    plans.record({accountId,identity,revision,planHash:revision,keys,plan,validation,source:"native"});
    db.prepare(`INSERT INTO implementation_plan_recoveries VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(accountId,identity,clientId,candidate.request_revision,revision,candidate.session_id,
        candidate.plan_source_id,candidate.acceptance_source_id,candidate.plan_digest,candidate.acceptance_digest,
        pair!.acceptance.occurred_at!,new Date().toISOString());
  });
}
