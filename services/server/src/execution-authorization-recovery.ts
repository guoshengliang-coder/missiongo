import { assertBuilderExecution, assertDispatchExecution, assertExecutionAuthorization, assertExternalExecution } from "./builder-authority.js";
import { deliveryRound } from "./delivery-round.js";
import { conflict, MissionGoError } from "./errors.js";
import type { ExternalAgentSessionIdentity } from "@missiongo/contracts";
import type { MissionGoStore } from "./store.js";

interface RecoveryInput {
  itemKey: string;
  dispatchId?: string;
  sessionId?: string;
  session?: Pick<ExternalAgentSessionIdentity, "agentKind" | "refKind" | "sessionRef">;
}

interface Conversation {
  dispatchId?: string;
  sessionId?: string;
}

const recoveryReasons = {
  claim_not_found: "未找到本会话的原领取回执，可能尚未领取或关联缺失。请由用户在原会话核对领取记录；不要用重新领取代替恢复。",
  records_missing: "本会话的领取回执与授权记录无法完整关联。请由用户核对原领取记录；不要猜测其他会话或重新领取绕过。",
  identity_ambiguous: "原会话身份关联不唯一。请在原客户端核对原派单编号或原 sessionId，再使用该精确身份恢复；不要猜测身份。",
  round_changed: "原领取已不适用于当前处理轮次。请由当前 Builder 核对返工或交接记录，重新核实本轮工作；旧回执不能推进状态。",
  revoked: "本会话的原执行授权已撤销。请由当前 Builder 核对执行归属；恢复不能重新授权，也不能通过更换会话绕过。",
} as const;
export class ExecutionRecoveryError extends MissionGoError {
  constructor(readonly reason: keyof typeof recoveryReasons) {
    super("execution_authorization_not_recoverable", recoveryReasons[reason], 409);
  }
}
function unavailable(reason?: keyof typeof recoveryReasons): never {
  if (reason) throw new ExecutionRecoveryError(reason);
  throw conflict("execution_authorization_not_recoverable",
    "无法核验本会话的有效领取记录。请保留原状态，由用户核对执行归属；不要重新领取或猜测其他会话身份。");
}

/** Recover an existing claim, never create a session, credential, or processing round. */
export function recoverExecutionAuthorization(store: MissionGoStore, accountId: string, clientId: string, input: RecoveryInput) {
  const db = store.database.connection;
  const item = store.getWorkItem(input.itemKey);
  store.assertWorkItemWritable(item.key);
  assertBuilderExecution(store.database, item.id, accountId);
  const round = deliveryRound(store.database, item.id, true);
  if (!clientId) unavailable();

  let conversation: Conversation;
  if (input.dispatchId) {
    conversation = { dispatchId: input.dispatchId };
  } else if (input.sessionId) {
    conversation = { sessionId: input.sessionId };
  } else if (input.session) {
    const identity = input.session;
    const matches: Conversation[] = db.prepare(`SELECT s.id AS sessionId FROM external_agent_sessions s
      JOIN external_agent_session_items i ON i.session_id=s.id
      WHERE s.account_id=? AND s.client_id=? AND s.agent_kind=? AND s.ref_kind=? AND s.session_ref=? AND i.item_id=? AND i.link_kind='handling'`)
      .all(accountId, clientId, identity.agentKind, identity.refKind, identity.sessionRef, item.id) as Conversation[];
    if (identity.refKind === "native") {
      matches.push(...db.prepare(`SELECT d.id AS dispatchId FROM agent_sessions s
        JOIN dispatches d ON d.id=s.dispatch_id JOIN dispatch_items i ON i.dispatch_id=d.id
        WHERE d.account_id=? AND s.agent_kind=? AND s.agent_session_ref=? AND i.item_id=?`)
        .all(accountId, identity.agentKind, identity.sessionRef, item.id) as Conversation[]);
    }
    if (!matches.length) unavailable();
    if (matches.length !== 1) {
      // A native ref can be mirrored by several dispatches. Account ownership
      // alone does not prove this OAuth client's association with those claims.
      const ownsEveryClaim = matches.every(match => db.prepare(`SELECT 1 FROM builder_execution_authorizations a
        JOIN mcp_agent_claim_receipts r ON r.account_id=a.account_id AND r.client_id=a.client_id
          AND json_extract(r.result_json,'$.executionAuthorization')=a.id
          AND json_extract(r.result_json,'$.item.id')=a.item_id
        WHERE a.item_id=? AND a.account_id=? AND a.client_id=? AND ${match.dispatchId
          ? "a.dispatch_id=?" : "a.dispatch_id IS NULL AND json_extract(r.result_json,'$.sessionId')=?"} LIMIT 1`)
        .get(item.id,accountId,clientId,match.dispatchId ?? match.sessionId!));
      if (!ownsEveryClaim) unavailable();
      unavailable("identity_ambiguous");
    }
    conversation = matches[0]!;
  } else {
    unavailable();
  }

  if (conversation.dispatchId) {
    assertDispatchExecution(store.database, conversation.dispatchId);
    if (!db.prepare(`SELECT 1 FROM dispatches d JOIN dispatch_items i ON i.dispatch_id=d.id
      JOIN nodes n ON n.id=d.node_id WHERE d.id=? AND d.account_id=? AND i.item_id=?
      AND d.status IN ('delivered','launched') AND n.revoked_at IS NULL`)
      .get(conversation.dispatchId, accountId, item.id)) unavailable();
  } else {
    assertExternalExecution(store.database, conversation.sessionId!);
    if (!db.prepare(`SELECT 1 FROM external_agent_sessions s JOIN external_agent_session_items i ON i.session_id=s.id
      WHERE s.id=? AND s.account_id=? AND s.client_id=? AND i.item_id=? AND i.link_kind='handling'`)
      .get(conversation.sessionId!, accountId, clientId, item.id)) unavailable();
  }

  // Older claims already persisted both the credential and their session ID in
  // this receipt. Its exact association is required: a later session registration
  // on the same item is not proof that the new conversation made the claim.
  const claims = db.prepare(`SELECT DISTINCT a.id,a.round_key,a.revoked FROM builder_execution_authorizations a
    JOIN mcp_agent_claim_receipts r ON r.account_id=a.account_id AND r.client_id=a.client_id
      AND json_extract(r.result_json,'$.executionAuthorization')=a.id
      AND json_extract(r.result_json,'$.item.id')=a.item_id
    WHERE a.item_id=? AND a.account_id=? AND a.client_id=?
      AND ${conversation.dispatchId ? "a.dispatch_id=?" : "a.dispatch_id IS NULL AND json_extract(r.result_json,'$.sessionId')=?"}
    `).all(item.id, accountId, clientId, conversation.dispatchId ?? conversation.sessionId!) as { id: string; round_key: string; revoked: number }[];
  const credentials = claims.filter(claim => claim.round_key === round && !claim.revoked);
  if (credentials.length > 1) unavailable("identity_ambiguous");
  if (!credentials.length) {
    if (claims.length) unavailable(!round || claims.every(claim => claim.round_key !== round) ? "round_changed" : "revoked");
    // Diagnose only this caller's exact conversation, never another client's receipts.
    const receipt = db.prepare(`SELECT 1 FROM mcp_agent_claim_receipts WHERE account_id=? AND client_id=?
      AND json_extract(result_json,'$.item.id')=? AND ${conversation.dispatchId
        ? "json_extract(result_json,'$.claimIdentity')=?"
        : "json_extract(result_json,'$.sessionId')=?"} LIMIT 1`)
      .get(accountId, clientId, item.id, conversation.dispatchId ? `dispatch:${conversation.dispatchId}` : conversation.sessionId!);
    if (!receipt && conversation.dispatchId) unavailable();
    unavailable(receipt ? "records_missing" : "claim_not_found");
  }
  const executionAuthorization = credentials[0]!.id;
  assertExecutionAuthorization(store.database, item.id, accountId, clientId, executionAuthorization);
  return { itemKey: item.key, executionAuthorization, ...conversation, statusChanged: false };
}
