import type { CompletionReference } from "@missiongo/contracts";
import { normalizeCompletion } from "./completion.js";
import { deliveryRound } from "./delivery-round.js";
import { notFound } from "./errors.js";
import type { MissionGoStore } from "./store.js";

type HistoricalEvidence = {
  merged?: {commit:string;occurredAt:string};
  releases?: Array<{artifact:string;version:string;sourceCommit:string;containsMergeCommit:string;verifiedAt:string;receiptDigest:string}>;
};
interface Row {
  completion_json: string | null;
  id: string; item_id: string; account_id: string; round_key: string; pull_request_url: string;
  required_json: string | null; no_release_reason: string | null; evidence_json: string; evidence_source_json: string;
  retry_count: number; last_report_at: string | null;
  revision: number; checked_revision: number; check_status: string; reason: string;
  checked_at: string | null; requested_at: string | null; lease_token: string | null; lease_node_id: string | null;
  lease_repo_path: string | null; lease_until: string | null; created_at: string; updated_at: string;
}

/** Read-only compatibility for retired checks. Never schedules or transitions work. */
export class StatusCheckHistory {
  constructor(readonly store: MissionGoStore) {}
  private get db() { return this.store.database.connection; }
  private row(id: string): Row {
    const row = this.db.prepare("SELECT * FROM status_handovers WHERE id=?").get(id) as unknown as Row | undefined;
    if (!row) throw notFound("Handover"); return row;
  }
  private round(itemId: string) { return deliveryRound(this.store.database,itemId); }
  private completion(row: Row): CompletionReference {
    return normalizeCompletion(row.completion_json ? {completion:JSON.parse(row.completion_json) as CompletionReference} : {pullRequestUrl:row.pull_request_url});
  }
  snapshot(id: string) {
    const row = this.row(id);
    const item = this.db.prepare("SELECT item_key,product_id,status FROM work_items WHERE id=?").get(row.item_id) as {item_key: string; product_id: string; status: string};
    const evidence = JSON.parse(row.evidence_json) as HistoricalEvidence;
    return { id, revision:row.revision, itemRevision:this.store.getWorkItem(item.item_key).revision, itemKey: item.item_key, productId: item.product_id, itemStatus: item.status, pullRequestUrl: row.pull_request_url, completion: this.completion(row),
      requiredArtifacts: row.required_json ? JSON.parse(row.required_json) as string[] : null, noReleaseReason: row.no_release_reason,
      status: "retired", historicalStatus: this.round(row.item_id) !== row.round_key ? "stale" : row.check_status,
      reason: "状态检查已取消，以下为历史记录。", historicalReason: row.reason, checkedAt: row.checked_at, lastResultAt: row.last_report_at, requestedAt: null, historicalRequestedAt: row.requested_at,
      evidence, evidenceSource: (JSON.parse(row.evidence_source_json) as {kind?:string}).kind ?? "authorized_executor", evidenceReporter: JSON.parse(row.evidence_source_json), evidenceUpdatedAt: row.updated_at, roundKey: row.round_key };
  }
  list(productId: string, itemKey?: string, limit = 100, offset = 0) {
    const rows = this.db.prepare(`SELECT h.id FROM status_handovers h JOIN work_items w ON w.id=h.item_id
      WHERE w.product_id=? ${itemKey ? "AND w.item_key=?" : ""} ORDER BY h.created_at DESC,h.id LIMIT ? OFFSET ?`)
      .all(productId, ...(itemKey ? [itemKey] : []), limit + 1, offset) as Array<{id: string}>;
    return { items: rows.slice(0,limit).map(r => this.snapshot(r.id)), ...(rows.length > limit ? { nextOffset: offset + limit } : {}) };
  }
}
