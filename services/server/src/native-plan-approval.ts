import type { AgentSessionMessageInput } from "./agent-session-store.js";
import { ImplementationPlans, planDigest } from "./implementation-plans.js";
import type { MissionGoDatabase } from "./storage/database.js";

/** Called only after an authenticated original-node snapshot, never MCP prose reports.
 * Native Codex emits the complete accepted plan as the next user turn. Freeze its
 * item scope while it is pending; a historical transcript alone cannot invent scope. */
export function synchronizeNativePlan(database: MissionGoDatabase, accountId: string, sessionId: string): void {
  const db = database.connection;
  const dispatch = db.prepare(`SELECT s.dispatch_id FROM agent_sessions s JOIN dispatches d ON d.id=s.dispatch_id
    WHERE s.id=? AND d.account_id=? AND s.agent_kind IN ('codex','claude_code') AND s.archived_at IS NULL`).get(sessionId,accountId) as {dispatch_id:string}|undefined;
  const external = !dispatch ? db.prepare(`SELECT client_id,agent_kind,ref_kind,session_ref FROM external_agent_sessions
    WHERE id=? AND account_id=? AND agent_kind IN ('codex','claude_code') AND native_node_id IS NOT NULL AND archived_at IS NULL`)
    .get(sessionId,accountId) as {client_id:string;agent_kind:string;ref_kind:string;session_ref:string}|undefined : undefined;
  if (!dispatch && !external) return;
  const plans = new ImplementationPlans(database);
  const identity = dispatch ? `dispatch:${dispatch.dispatch_id}` : `native:${external!.client_id}:${external!.agent_kind}:${external!.ref_kind}:${external!.session_ref}`;
  type NativeMessage = AgentSessionMessageInput & {position:number};
  const latest = dispatch
    ? db.prepare(`SELECT source_id AS sourceId,turn_id AS turnId,role,phase,text,occurred_at AS occurredAt,position
        FROM agent_session_messages WHERE session_id=? AND role='plan' ORDER BY position DESC,rowid DESC LIMIT 1`).get(sessionId) as NativeMessage|undefined
    : db.prepare(`SELECT payload_json,position FROM external_native_messages WHERE session_id=? AND json_extract(payload_json,'$.role')='plan'
        ORDER BY position DESC,rowid DESC LIMIT 1`).get(sessionId) as {payload_json:string;position:number}|undefined;
  if (!latest) return;
  const plan:NativeMessage = "payload_json" in latest ? {...JSON.parse(latest.payload_json),position:latest.position} : latest;
  if (plan.text.length < 20) return;
  const next = dispatch
    ? db.prepare(`SELECT source_id AS sourceId,turn_id AS turnId,role,text,occurred_at AS occurredAt,position FROM agent_session_messages
        WHERE session_id=? AND role='user' AND position>? ORDER BY position,rowid LIMIT 1`).get(sessionId,plan.position) as NativeMessage|undefined
    : db.prepare(`SELECT payload_json FROM external_native_messages WHERE session_id=? AND json_extract(payload_json,'$.role')='user'
        AND position>? ORDER BY position,rowid LIMIT 1`).get(sessionId,plan.position) as {payload_json:string}|undefined;
  const user:AgentSessionMessageInput|undefined = next && ("payload_json" in next ? JSON.parse(next.payload_json) : next);
  const accepted = plan.phase === "plan_approved" || (plan.turnId && plan.occurredAt && user?.turnId && user.turnId!==plan.turnId && user.occurredAt && user.occurredAt>plan.occurredAt
    && user.text===`PLEASE IMPLEMENT THIS PLAN:\n${plan.text}`);
  database.transaction(()=>{
    let proposal = plans.proposal(accountId,identity);
    // An explicit MCP proposal owns its scope; a different native text cannot approve it.
    if (proposal && proposal.plan!==plan.text && proposal.origin!=="native") return;
    if (!proposal || proposal.plan!==plan.text) {
      // Do not retrospectively bind an already accepted historical plan to today's scope.
      if (user || plan.phase === "plan_approved" || plan.phase === "plan_declined") return;
      const keys = dispatch ? plans.dispatchKeys(dispatch.dispatch_id)
        : (db.prepare(`SELECT w.item_key AS key FROM external_agent_session_items e JOIN work_items w ON w.id=e.item_id WHERE e.session_id=?`)
          .all(sessionId) as {key:string}[]).map(row=>row.key);
      if (!keys.length) return;
      const revision = planDigest([identity,plans.scope(keys),plan.text,""]);
      plans.request(accountId,identity,revision,{keys,plan:plan.text,validation:"",origin:"native"});
      proposal = plans.proposal(accountId,identity);
    }
    if (!proposal?.valid) return;
    if (!accepted && !user && plan.phase !== "plan_declined") {
      db.prepare(`UPDATE implementation_plan_requests SET proposal_json=json_set(proposal_json,'$.nativeSourceId',?)
        WHERE account_id=? AND identity_key=? AND revision=? AND json_extract(proposal_json,'$.nativeSourceId') IS NOT ?`)
        .run(plan.sourceId,accountId,identity,proposal.revision,plan.sourceId);
      return;
    }
    if (!accepted) return;
    // Bind source decisions to a plan observed while pending, or a Codex user
    // acceptance newer than the explicit request. Never reuse pre-request history.
    if (proposal.nativeSourceId !== plan.sourceId && !(proposal.requestedAt && user?.occurredAt
      && user.occurredAt >= proposal.requestedAt && user.text === `PLEASE IMPLEMENT THIS PLAN:\n${plan.text}`)) return;
    // A separately supplied validation section must also have been shown in the native plan.
    if (proposal.validation && !plan.text.includes(proposal.validation)) return;
    plans.record({accountId,identity,revision:proposal.revision,planHash:proposal.revision,keys:proposal.keys,
      source:"native",plan:proposal.plan,validation:proposal.validation});
    plans.nativeContinued(accountId,identity,proposal.revision);
  });
}
