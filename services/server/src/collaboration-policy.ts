import type { ActorKind, WorkItemStatus } from "@missiongo/domain";
import type { MissionGoDatabase } from "./storage/database.js";
import { AccountStore } from "./accounts-store.js";
import { conflict } from "./errors.js";

export function collaborationBlockers(
  database: MissionGoDatabase,
  itemId: string,
): number {
  return (
    database.connection
      .prepare(
        `SELECT count(*) AS n FROM collaboration_requests r JOIN work_items t ON t.id=r.target_item_id
    WHERE r.source_item_id=? AND r.withdrawn_at IS NULL AND t.status NOT IN ('done','cancelled')`,
      )
      .get(itemId) as { n: number }
  ).n;
}
export function collaborationVerifier(
  database: MissionGoDatabase,
  itemId: string,
): string | undefined {
  return (
    database.connection
      .prepare(
        `SELECT verifier_account_id FROM collaboration_requests WHERE target_item_id=? ORDER BY created_at LIMIT 1`,
      )
      .get(itemId) as { verifier_account_id: string } | undefined
  )?.verifier_account_id;
}
/** Runs even for system handovers and legacy/no-account callers. No UI bypass. */
export function collaborationTransitionDenial(
  database: MissionGoDatabase,
  item: { id: string; status: WorkItemStatus },
  to: WorkItemStatus,
  actor: ActorKind,
  accountId?: string,
): string | undefined {
  if (
    ["development_complete", "pending_verification", "done"].includes(to) &&
    collaborationBlockers(database, item.id)
  )
    return "collaboration_blocked";
  const verifier = collaborationVerifier(database, item.id);
  if (verifier && to === "pending_verification") {
    const missing = database.connection
      .prepare(
        `SELECT 1 FROM collaboration_requests r WHERE r.target_item_id=? AND r.withdrawn_at IS NULL AND NOT EXISTS (
      SELECT 1 FROM collaboration_events e WHERE e.request_id=r.id AND e.kind='delivery' AND e.rowid>COALESCE((SELECT MAX(last.rowid) FROM collaboration_events last WHERE last.request_id=r.id AND last.kind='target_status' AND json_extract(last.payload_json,'$.to') IN ('ready','inbox')),0)) LIMIT 1`,
      )
      .get(item.id);
    if (missing) return "collaboration_delivery_required";
  }
  if (
    verifier &&
    (to === "done" ||
      (item.status === "pending_verification" && to === "ready"))
  ) {
    if (
      actor !== "human" ||
      accountId !== verifier ||
      !new AccountStore(database).findActive(verifier)
    )
      return "collaboration_verifier_required";
    if (to === "done" && item.status !== "pending_verification")
      return "collaboration_verification_required";
  }
  return undefined;
}
export function assertCollaborationAcyclic(
  database: MissionGoDatabase,
  sourceId: string,
  targetId: string,
  excludeId = "",
) {
  const found = database.connection
    .prepare(
      `WITH RECURSIVE reach(id) AS (
    SELECT ? UNION SELECT r.target_item_id FROM collaboration_requests r JOIN reach ON r.source_item_id=reach.id
    WHERE r.withdrawn_at IS NULL AND r.id!=?
  ) SELECT 1 FROM reach WHERE id=? LIMIT 1`,
    )
    .get(targetId, excludeId, sourceId);
  if (found)
    throw conflict(
      "collaboration_cycle",
      "依赖不能形成循环，请先撤回或调整相关依赖。",
    );
}
export function assertNoCollaborationTransfer(
  database: MissionGoDatabase,
  itemId: string,
) {
  if (
    database.connection
      .prepare(
        "SELECT 1 FROM collaboration_requests WHERE source_item_id=? OR target_item_id=? LIMIT 1",
      )
      .get(itemId, itemId)
  ) {
    throw conflict(
      "collaboration_transfer_blocked",
      "含协作历史的条目暂不能迁移，请保留原条目并建立后续条目。",
    );
  }
}
