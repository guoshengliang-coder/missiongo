import { randomUUID } from "node:crypto";
import type { InsightBatch, InsightBatchProgress, InsightBatchItem, InsightBatchMilestone } from "@missiongo/domain";
import type { MissionGoStore } from "./store.js";
import { invalidInput, notFound } from "./errors.js";
import { loadInsightData } from "./project-insights.js";

interface Member { itemId: string; itemKey: string }
interface BatchRow { id: string; name: string; members_json: string; created_at: string }
const metadata = (row: BatchRow): InsightBatch => ({ id: row.id, name: row.name, createdAt: row.created_at,
  itemCount: (JSON.parse(row.members_json) as Member[]).length });

export function listInsightBatches(store: MissionGoStore, accountId: string): InsightBatch[] {
  const rows = store.database.connection.prepare("SELECT id,name,members_json,created_at FROM insight_batches WHERE account_id=? ORDER BY created_at DESC,id DESC").all(accountId) as unknown as BatchRow[];
  return rows.map(metadata);
}
export function createInsightBatch(store: MissionGoStore, accountId: string, name: string, members: Member[]): InsightBatch {
  const unique = [...new Map(members.map(member => [member.itemId, member])).values()];
  if (!name.trim() || name.trim().length > 100 || !unique.length || unique.length > 500) throw invalidInput("Choose a batch name and 1–500 items.");
  const row: BatchRow = { id: randomUUID(), name: name.trim(), members_json: JSON.stringify(unique), created_at: new Date().toISOString() };
  store.database.transaction(() => {
    const count = store.database.connection.prepare("SELECT COUNT(*) AS total FROM insight_batches WHERE account_id=?").get(accountId) as {total: number};
    if (count.total >= 50) throw invalidInput("Keep at most 50 saved batches per account.");
    store.database.connection.prepare("INSERT INTO insight_batches(id,account_id,name,members_json,created_at) VALUES (?,?,?,?,?)")
      .run(row.id, accountId, row.name, row.members_json, row.created_at);
  });
  return metadata(row);
}
export function deleteInsightBatch(store: MissionGoStore, accountId: string, id: string): void {
  const result = store.database.connection.prepare("DELETE FROM insight_batches WHERE id=? AND account_id=?").run(id, accountId);
  if (!result.changes) throw notFound("Batch");
}
export function insightBatchProgress(store: MissionGoStore, accountId: string, id: string, visibleProductIds: string[], now = new Date()): InsightBatchProgress {
  const row = store.database.connection.prepare("SELECT id,name,members_json,created_at FROM insight_batches WHERE id=? AND account_id=?").get(id,accountId) as BatchRow | undefined;
  if (!row) throw notFound("Batch");
  const members = JSON.parse(row.members_json) as Member[];
  const { items, byItem } = loadInsightData(store, visibleProductIds, members.map(member => member.itemId));
  const counts = { delivered: 0, processing: 0, waiting: 0, paused: 0, cancelled: 0 };
  const milestones: InsightBatchMilestone[] = [7,14].map(days => ({days, delivered: 0, eligible: 0, immature: 0, cancelled: 0, unknown: 0, rate: null}));
  const rows: InsightBatchItem[] = [];
  for (const item of items) {
    const stage = item.status === "done" || item.status === "pending_verification" ? "delivered"
      : item.status === "in_progress" || item.status === "development_complete" ? "processing"
      : item.status === "on_hold" ? "paused" : item.status === "cancelled" ? "cancelled" : "waiting";
    counts[stage]++;
    rows.push({ itemKey: item.item_key, productId: item.product_id, title: item.title, type: item.type,
      status: item.status, createdAt: item.created_at, stage });
    const history = (byItem.get(item.id) ?? []).filter(event => event.at <= now.toISOString())
      .sort((a,b) => a.at.localeCompare(b.at) || a.timeline_seq - b.timeline_seq);
    for (const milestone of milestones) {
      const deadline = Date.parse(item.created_at) + milestone.days * 86_400_000;
      if (deadline > now.getTime()) { milestone.immature++; continue; }
      const status = [...history].reverse().find(event => Date.parse(event.at) <= deadline)?.to_status;
      if (!status) { milestone.unknown++; continue; }
      if (status === "cancelled") { milestone.cancelled++; continue; }
      milestone.eligible++;
      if (status === "pending_verification" || status === "done") milestone.delivered++;
    }
  }
  const unavailable = members.length - rows.length;
  const effective = members.length - counts.cancelled;
  for (const milestone of milestones) milestone.rate = unavailable || milestone.unknown || !milestone.eligible ? null : milestone.delivered / milestone.eligible;
  return { batch: metadata(row), dataAsOf: now.toISOString(), total: members.length, effective, unavailable,
    ...counts, deliveryRate: unavailable || !effective ? null : counts.delivered / effective, milestones, items: rows };
}
