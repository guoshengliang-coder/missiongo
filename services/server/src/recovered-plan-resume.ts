import { AgentSessionStore } from "./agent-session-store.js";
import { AgentApprovalStore } from "./agent-approval-store.js";
import { assertBuilderExecution, assertDispatchExecution } from "./builder-authority.js";
import { ImplementationPlans } from "./implementation-plans.js";
import { nativeMessageDigest, type NativePlanMessage } from "./storage/legacy-plan-recovery.js";
import type { MissionGoStore } from "./store.js";

function latestUser(store:MissionGoStore,sessionId:string) {
  return store.database.connection.prepare(`SELECT source_id,role,text,turn_id,occurred_at FROM agent_session_messages
    WHERE session_id=? AND role='user' ORDER BY occurred_at DESC,position DESC,rowid DESC LIMIT 1`)
    .get(sessionId) as NativePlanMessage|undefined;
}

/** An authenticated original claim only requests one continuation, never a new approval or claim. */
export function armRecoveredPlanResume(store:MissionGoStore,accountId:string,clientId:string,dispatchId:string): boolean {
  const db=store.database.connection,identity=`dispatch:${dispatchId}`;
  const recovered=db.prepare(`SELECT session_id,revision FROM implementation_plan_recoveries
    WHERE account_id=? AND identity_key=? AND client_id=?`).get(accountId,identity,clientId) as {session_id:string;revision:string}|undefined;
  if(!recovered || !new ImplementationPlans(store.database).canImplement(accountId,identity)) return false;
  const user=latestUser(store,recovered.session_id);
  if(!user) return false;
  db.prepare(`INSERT INTO implementation_plan_recovery_resumes
    (account_id,identity_key,revision,session_id,user_digest,requested_at,state) VALUES (?,?,?,?,?,?,'waiting')
    ON CONFLICT(account_id,identity_key) DO NOTHING`)
    .run(accountId,identity,recovered.revision,recovered.session_id,nativeMessageDigest(user),new Date().toISOString());
  return Boolean(db.prepare(`SELECT 1 FROM implementation_plan_recovery_resumes WHERE account_id=? AND identity_key=? AND state='waiting'`).get(accountId,identity));
}

/** Called only after an authenticated original node report. Wait for the idle phase
 * acknowledgement, then use the existing native queue exactly once. Never steer
 * the still-running planning turn, interrupt it or advance business state. */
export function resumeRecoveredPlan(store:MissionGoStore,accountId:string,nodeId:string,sessionId:string,
  authorize:(productId:string)=>void):void {
  const db=store.database.connection;
  store.database.transaction(()=>{
    const intent=db.prepare(`SELECT * FROM implementation_plan_recovery_resumes
      WHERE account_id=? AND session_id=? AND state='waiting'`).get(accountId,sessionId) as
      {identity_key:string;revision:string;user_digest:string}|undefined;
    if(!intent) return;
    const cancel=()=>db.prepare(`UPDATE implementation_plan_recovery_resumes SET state='cancelled'
      WHERE account_id=? AND identity_key=? AND state='waiting'`).run(accountId,intent.identity_key);
    const plans=new ImplementationPlans(store.database),proposal=plans.proposal(accountId,intent.identity_key);
    const session=db.prepare(`SELECT s.status,s.archived_at,s.last_error,s.turn_state_json,d.id AS dispatch_id,d.status AS dispatch_status,n.revoked_at
      FROM agent_sessions s JOIN dispatches d ON d.id=s.dispatch_id JOIN nodes n ON n.id=s.node_id
      WHERE s.id=? AND s.node_id=? AND d.account_id=? AND n.account_id=?`).get(sessionId,nodeId,accountId,accountId) as
      {status:string;archived_at:string|null;last_error:string|null;turn_state_json:string;dispatch_id:string;dispatch_status:string;revoked_at:string|null}|undefined;
    if(!session || session.archived_at || session.revoked_at || !['delivered','launched'].includes(session.dispatch_status)
      || !proposal?.approved || proposal.revision!==intent.revision || !proposal.valid) {cancel();return;}
    const user=latestUser(store,sessionId);
    if(!user || nativeMessageDigest(user)!==intent.user_digest) {cancel();return;}
    try {
      assertDispatchExecution(store.database,session.dispatch_id);
      for(const key of proposal.keys) {
        const item=store.getWorkItem(key);authorize(item.productId);assertBuilderExecution(store.database,item.id,accountId);
        if(item.status!=="ready") {cancel();return;}
      }
    } catch {cancel();return;}
    if(session.status!=="idle" || session.last_error || JSON.parse(session.turn_state_json).turnActive===true) return;
    const approval=new AgentApprovalStore(store.database).get(sessionId);
    if(approval && !['approved','resolved'].includes(approval.status)) return;
    try {for(const key of proposal.keys) plans.assertClaim(accountId,intent.identity_key,key);} catch {return;}
    const sessions=new AgentSessionStore(store.database);
    if(sessions.managedBinding(sessionId)) {cancel();return;}
    // Preserve a person's pending input and ambiguous deliveries. Do not replay.
    if(db.prepare(`SELECT 1 FROM agent_session_commands WHERE session_id=? AND status IN ('queued','delivering','delivery_unknown') LIMIT 1`).get(sessionId)) return;
    const command=sessions.enqueue(accountId,sessionId,
      `系统续办：原生方案批准已恢复，节点已确认实施模式。继续本次原派单中的 ${proposal.keys.join('、')}，沿用原会话与原领取参数，先核对实际条目状态和本轮执行凭据。保持用户已有的实施、push、merge、发布授权边界；不重新要求批准同一方案，不另建会话，不伪造交付或验收。此消息由系统排队，不是新的人工批准。`);
    db.prepare(`UPDATE implementation_plan_recovery_resumes SET state='queued',command_id=?,queued_at=?
      WHERE account_id=? AND identity_key=? AND state='waiting'`).run(command.id,new Date().toISOString(),accountId,intent.identity_key);
  });
}
