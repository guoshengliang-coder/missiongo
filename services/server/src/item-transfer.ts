import { randomUUID } from "node:crypto";
import { chmodSync, copyFileSync, statSync, unlinkSync } from "node:fs";
import { constants } from "node:fs";
import { extname } from "node:path";

import type { WorkItemSnapshot } from "@missiongo/domain";

import type { AttachmentStorage } from "./attachment-storage.js";
import { autoArchiveForItem } from "./auto-archive.js";
import { conflict, invalidInput } from "./errors.js";
import type { MissionGoStore } from "./store.js";

/** Human-only transfer. Files are copied while the synchronous transaction holds
 * the writer lock: attachment edits, dispatches and another transfer cannot race
 * the snapshot. A crash may leave an unreferenced file, never a partial item. */
export function transferWorkItem(store: MissionGoStore, storage: AttachmentStorage, input: {
  itemKey: string; targetProductId: string; accountId: string; idempotencyKey: string;
}): WorkItemSnapshot {
  const key = input.itemKey.toUpperCase();
  if (!input.idempotencyKey.trim() || input.idempotencyKey.length > 200) throw invalidInput("Invalid idempotency key.");
  const operation = `transfer_item:${input.accountId}:${key}:${input.targetProductId}`;
  const db = store.database.connection;
  const copies: string[] = [];
  try {
    return store.database.transaction(() => {
      const repeated = db.prepare("SELECT operation, result_json FROM idempotency_keys WHERE key = ?")
        .get(input.idempotencyKey) as { operation: string; result_json: string } | undefined;
      if (repeated) {
        if (repeated.operation !== operation) throw conflict("idempotency_conflict", "This request key was used for another operation.");
        return store.getWorkItem((JSON.parse(repeated.result_json) as { key: string }).key);
      }
      store.assertWorkItemWritable(key);
      const source = store.getWorkItem(key);
      const targetProduct = store.getProduct(input.targetProductId);
      if (source.productId === targetProduct.id) throw conflict("transfer_same_product", "Choose a different target product.");
      if (targetProduct.archivedAt) throw conflict("transfer_target_archived", "Restore the target product before transferring.");
      // A launched dispatch is terminal as a dispatch, so inspect its session.
      // Without a session or a later lifecycle event it may still start/claim.
      const activeDispatch = db.prepare(`
        SELECT 1 FROM dispatch_items di JOIN dispatches d ON d.id = di.dispatch_id
        LEFT JOIN agent_sessions s ON s.dispatch_id = d.id
        WHERE di.item_id = ? AND (
          d.status IN ('queued', 'delivered') OR (
            s.status IN ('active', 'stalled', 'unavailable') OR EXISTS (
              SELECT 1 FROM agent_session_commands r WHERE r.session_id = s.id
              AND r.status IN ('queued', 'delivering', 'delivery_unknown')
            ) OR (d.status = 'launched' AND s.id IS NULL AND NOT EXISTS (
              SELECT 1 FROM work_item_events e WHERE e.item_id = di.item_id
              AND e.history_source_key IS NULL AND e.created_at >= d.created_at
              AND e.to_status IN ('development_complete', 'pending_verification', 'done', 'cancelled')
            ))
          )
        ) LIMIT 1`).get(source.id);
      const activeExecution = db.prepare(`SELECT 1 FROM ai_executions WHERE item_id = ?
        AND status IN ('created', 'running', 'waiting_for_human') LIMIT 1`).get(source.id);
      const managedExecution = db.prepare(`SELECT 1 FROM managed_runs r JOIN managed_stages s ON s.run_id = r.id,
        json_each(r.scope_json, '$.itemKeys') i WHERE i.value = ?
        AND s.status IN ('ready', 'running', 'waiting_for_human', 'unknown') LIMIT 1`).get(key);
      if (activeDispatch || activeExecution || managedExecution) {
        throw conflict("transfer_active_execution", "End queued or running AI work before transferring this item.");
      }
      const target = store.createWorkItem({
        productId: targetProduct.id, type: source.type, priority: source.priority,
        title: source.title, description: source.description,
        ...(source.report ? { report: source.report } : {}),
        ...(source.environment ? { environment: source.environment } : {}),
        attribution: { accountId: input.accountId },
      });
      // The creation history supplies the original byline and diagnostics. It
      // is provenance, not a new execution or a release handover in this project.
      db.prepare("DELETE FROM work_item_events WHERE item_id = ?").run(target.id);
      db.prepare("UPDATE work_items SET status = ? WHERE id = ?").run(source.status, target.id);
      const idMap = new Map<string, string>();
      for (const attachment of store.listAttachments(key)) {
        const id = randomUUID();
        idMap.set(attachment.id, id);
        const name = `${randomUUID()}${extname(attachment.storageFilename)}`;
        const path = storage.resolveStoredFile(name);
        copyFileSync(storage.resolveStoredFile(attachment.storageFilename), path, constants.COPYFILE_EXCL);
        copies.push(path);
        chmodSync(path, 0o600);
        if (statSync(path).size !== attachment.sizeBytes) throw conflict("transfer_attachment_changed", "Attachment bytes do not match their recorded size.");
        db.prepare(`INSERT INTO work_item_attachments
          (id, item_id, kind, display_number, original_filename, storage_filename, content_type, size_bytes, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, target.id, attachment.kind, attachment.displayNumber,
          attachment.filename, name, attachment.contentType, attachment.sizeBytes, attachment.createdAt);
      }
      db.prepare(`INSERT INTO work_item_attachment_counters (item_id, kind, next_number)
        SELECT ?, kind, next_number FROM work_item_attachment_counters WHERE item_id = ?`).run(target.id, source.id);
      const comments = db.prepare("SELECT id FROM work_item_comments WHERE item_id = ?").all(source.id) as { id: string }[];
      for (const comment of comments) {
        const id = randomUUID();
        idMap.set(comment.id, id);
        db.prepare(`INSERT INTO work_item_comments
          (id, item_id, actor_kind, account_id, client_id, execution_id, body_kind, body_json, agent_name, summary,
           timeline_seq, created_at, withdrawn_at, withdrawn_by, history_source_key)
          SELECT ?, ?, actor_kind, account_id, client_id, NULL, body_kind, body_json, agent_name, summary,
           timeline_seq, created_at, withdrawn_at, withdrawn_by, COALESCE(history_source_key, ?)
          FROM work_item_comments WHERE id = ?`).run(id, target.id, key, comment.id);
      }
      const events = db.prepare(`SELECT id, payload_json FROM work_item_events WHERE item_id = ?
        AND event_type NOT IN ('dispatched', 'derived_item_created') ORDER BY timeline_seq`).all(source.id) as { id: string; payload_json: string }[];
      for (const event of events) {
        const payload = JSON.parse(event.payload_json) as Record<string, unknown>;
        for (const field of ["attachmentId", "commentId"]) {
          if (typeof payload[field] === "string" && idMap.has(payload[field])) payload[field] = idMap.get(payload[field]);
        }
        db.prepare(`INSERT INTO work_item_events
          (id, item_id, event_type, actor_kind, from_status, to_status, payload_json,
           account_id, client_id, execution_id, timeline_seq, created_at, history_source_key)
          SELECT ?, ?, event_type, actor_kind, from_status, to_status, ?, account_id, client_id, NULL,
           timeline_seq, created_at, COALESCE(history_source_key, ?) FROM work_item_events WHERE id = ?`)
          .run(randomUUID(), target.id, JSON.stringify(payload), key, event.id);
      }
      const now = new Date().toISOString();
      const componentIds = new Set([source.sourceComponentId, ...source.affectedComponentIds].filter((id): id is string => Boolean(id)));
      const components = store.listComponents(source.productId, { includeArchived: true }).filter((c) => componentIds.has(c.id));
      const provenance = { clearedSourceComponentId: source.sourceComponentId ?? null,
        clearedAffectedComponentIds: source.affectedComponentIds, clearedComponents: components.map(({ id, name, kind }) => ({ id, name, kind })) };
      // No cross-product target identifiers in outgoing timeline payloads. The
      // separate relation is returned only when the reader can see its project.
      store.appendSystemEvent(target.id, "item_transferred_in", provenance);
      store.appendSystemEvent(source.id, "item_transferred_out", provenance);
      // Attribute the transfer itself to the person, not the copied creator.
      db.prepare(`UPDATE work_item_events SET actor_kind = 'human', account_id = ?,
        to_status = CASE WHEN item_id = ? THEN 'cancelled' ELSE ? END
        WHERE item_id IN (?, ?) AND event_type IN ('item_transferred_in', 'item_transferred_out')
        AND history_source_key IS NULL`).run(input.accountId, source.id, source.status, source.id, target.id);
      db.prepare("UPDATE work_items SET status = 'cancelled', updated_at = ? WHERE id = ?").run(now, source.id);
      autoArchiveForItem(store.database, source.id, now);
      db.prepare(`INSERT INTO item_transfers (source_item_id, target_item_id, account_id, created_at)
        VALUES (?, ?, ?, ?)`).run(source.id, target.id, input.accountId, now);
      db.prepare("INSERT INTO idempotency_keys (key, operation, result_json, created_at) VALUES (?, ?, ?, ?)")
        .run(input.idempotencyKey, operation, JSON.stringify({ key: target.key }), now);
      return store.getWorkItem(target.key);
    });
  } catch (error) {
    for (const path of copies) { try { unlinkSync(path); } catch { /* Unreferenced leftovers are harmless. */ } }
    throw error;
  }
}
