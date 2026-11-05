import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

export const LEGACY_PLAN_RECOVERY_SCHEMA = `
CREATE TABLE implementation_plan_recovery_candidates (
  account_id TEXT NOT NULL, identity_key TEXT NOT NULL, request_revision TEXT NOT NULL,
  scope_json TEXT NOT NULL, session_id TEXT NOT NULL, node_id TEXT NOT NULL,
  plan_source_id TEXT NOT NULL, plan_digest TEXT NOT NULL,
  acceptance_source_id TEXT NOT NULL, acceptance_digest TEXT NOT NULL,
  captured_at TEXT NOT NULL, PRIMARY KEY(account_id,identity_key)
) STRICT;
CREATE TABLE implementation_plan_recoveries (
  account_id TEXT NOT NULL, identity_key TEXT NOT NULL, client_id TEXT NOT NULL,
  previous_revision TEXT NOT NULL, revision TEXT NOT NULL,
  session_id TEXT NOT NULL, plan_source_id TEXT NOT NULL, acceptance_source_id TEXT NOT NULL,
  plan_digest TEXT NOT NULL, acceptance_digest TEXT NOT NULL,
  native_accepted_at TEXT NOT NULL, recovered_at TEXT NOT NULL,
  PRIMARY KEY(account_id,identity_key)
) STRICT;
`;

export interface NativePlanMessage {
  source_id: string; role: string; text: string; turn_id: string | null; occurred_at: string | null;
}

export const nativeMessageDigest = (message: NativePlanMessage): string => createHash("sha256")
  .update(JSON.stringify([message.source_id, message.role, message.text, message.turn_id, message.occurred_at])).digest("hex");

/** Only a complete native Codex implementation instruction paired with its exact plan.
 * Not a prose classifier: ordinary chat, comments and progress reports cannot match. */
export function nativePlanPair(db: DatabaseSync, sessionId: string) {
  const plan = db.prepare(`SELECT source_id,role,text,turn_id,occurred_at FROM agent_session_messages
    WHERE session_id=? AND role='plan' ORDER BY occurred_at DESC,position DESC,rowid DESC LIMIT 1`)
    .get(sessionId) as NativePlanMessage | undefined;
  if (!plan?.turn_id || !plan.occurred_at || plan.text.length < 20) return;
  // It must be the immediate next native user input, not an old quote found later.
  const acceptance = db.prepare(`SELECT source_id,role,text,turn_id,occurred_at FROM agent_session_messages
    WHERE session_id=? AND role='user' AND occurred_at>? ORDER BY occurred_at,position,rowid LIMIT 1`)
    .get(sessionId, plan.occurred_at) as NativePlanMessage | undefined;
  if (!acceptance?.turn_id || acceptance.turn_id === plan.turn_id || !acceptance.occurred_at
    || acceptance.text !== `PLEASE IMPLEMENT THIS PLAN:\n${plan.text}`) return;
  return { plan, acceptance };
}

/** Upgrade captures evidence, never an approval, execution credential or business transition.
 * New requests and transcripts arriving after this one-time migration are ineligible. */
export function captureLegacyPlanRecoveries(db: DatabaseSync, now: string): void {
  const requests = db.prepare(`SELECT r.*,s.id AS session_id,s.node_id FROM implementation_plan_requests r
    JOIN dispatches d ON r.identity_key='dispatch:'||d.id AND d.account_id=r.account_id
    JOIN agent_sessions s ON s.dispatch_id=d.id AND s.agent_kind='codex'
    WHERE r.proposal_json IS NOT NULL AND r.scope_json IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM implementation_plan_approvals a
        WHERE a.account_id=r.account_id AND a.identity_key=r.identity_key AND a.revision=r.revision)`)
    .all() as {account_id:string;identity_key:string;revision:string;scope_json:string;session_id:string;node_id:string}[];
  const insert = db.prepare(`INSERT INTO implementation_plan_recovery_candidates
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`);
  for (const request of requests) {
    const pair = nativePlanPair(db, request.session_id);
    if (!pair || pair.acceptance.occurred_at! > now) continue;
    insert.run(request.account_id, request.identity_key, request.revision, request.scope_json,
      request.session_id, request.node_id, pair.plan.source_id, nativeMessageDigest(pair.plan),
      pair.acceptance.source_id, nativeMessageDigest(pair.acceptance), now);
  }
}
