import { randomUUID } from "node:crypto";
import type { SQLInputValue } from "node:sqlite";

import {
  ATTACHMENT_KINDS,
  assertWorkItemTransition,
  createWorkItemKey,
  EXECUTION_MODES,
  WORK_ITEM_PRIORITIES,
  WORK_ITEM_STATUSES,
  WORK_ITEM_TYPES,
  type ActorKind,
  type AttachmentKind,
  type ExecutionReport,
  type ExecutionStatus,
  type WorkItemEnvironment,
  type WorkItemPriority,
  type WorkItemSnapshot,
  type WorkItemStatus,
  type WorkItemType,
} from "@missiongo/domain";

import { conflict, invalidInput, notFound } from "./errors.js";
import { MissionGoDatabase } from "./storage/database.js";
import {
  COMPONENT_KINDS,
  type AppendAnalysisInput,
  type AttachmentRecord,
  type ClaimExecutionInput,
  type ComponentKind,
  type ComponentSnapshot,
  type CreateWorkItemInput,
  type ExecutionSnapshot,
  type CreateAttachmentMetadataInput,
  type ListWorkItemsInput,
  type ProductSnapshot,
  type TransitionWorkItemInput,
  type UpdateWorkItemInput,
  type WorkItemEventSnapshot,
} from "./types.js";

interface ProductRow {
  id: string;
  key_prefix: string;
  name: string;
  next_item_sequence: number;
  created_at: string;
  updated_at: string;
}

interface ComponentRow {
  id: string;
  product_id: string;
  name: string;
  kind: ComponentKind;
  created_at: string;
  updated_at: string;
}

interface WorkItemRow {
  id: string;
  item_key: string;
  sequence: number;
  product_id: string;
  source_component_id: string | null;
  area_id: string | null;
  type: WorkItemType;
  priority: WorkItemPriority;
  status: WorkItemStatus;
  title: string;
  description: string;
  environment_json: string | null;
  created_at: string;
  updated_at: string;
}

interface EventRow {
  id: string;
  item_key: string;
  event_type: string;
  actor_kind: ActorKind;
  from_status: WorkItemStatus | null;
  to_status: WorkItemStatus | null;
  payload_json: string;
  created_at: string;
}

interface AttachmentRow {
  id: string;
  item_key: string;
  kind: AttachmentKind;
  original_filename: string;
  storage_filename: string;
  content_type: string;
  size_bytes: number;
  created_at: string;
}

interface ExecutionRow {
  id: string;
  item_key: string;
  agent_id: string;
  mode: "process" | "continue" | "verify";
  trigger_source: "agent_pull" | "web_dispatch" | "android_dispatch" | "scheduler";
  status: ExecutionStatus;
  report_json: string | null;
  human_question: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
  lease_id: string | null;
  lease_expires_at: string | null;
}

interface LeaseRow {
  id: string;
  execution_id: string;
  item_id: string;
  item_key: string;
  expires_at: string;
  released_at: string | null;
  execution_status: ExecutionStatus;
}

const PRODUCT_PREFIX_PATTERN = /^[A-Z][A-Z0-9]{1,9}$/;

function requiredText(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized) {
    throw invalidInput(`${field} is required.`);
  }
  return normalized;
}

function isOneOf<T extends string>(value: string, choices: readonly T[]): value is T {
  return choices.includes(value as T);
}

function parseEnvironment(value: string | null): WorkItemEnvironment | undefined {
  if (value === null) return undefined;
  return JSON.parse(value) as WorkItemEnvironment;
}

export class MissionGoStore {
  readonly database: MissionGoDatabase;

  constructor(databasePath: string) {
    this.database = new MissionGoDatabase(databasePath);
  }

  close(): void {
    this.database.close();
  }

  createProduct(input: { name: string; keyPrefix: string }): ProductSnapshot {
    const name = requiredText(input.name, "Product name");
    const keyPrefix = input.keyPrefix.trim().toUpperCase();
    if (!PRODUCT_PREFIX_PATTERN.test(keyPrefix)) {
      throw invalidInput("Product keyPrefix must be 2-10 uppercase letters or digits and start with a letter.");
    }

    const now = new Date().toISOString();
    const id = randomUUID();
    try {
      this.database.connection
        .prepare(
          `INSERT INTO products (id, key_prefix, name, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(id, keyPrefix, name, now, now);
    } catch (error) {
      if (error instanceof Error && error.message.includes("UNIQUE constraint failed")) {
        throw conflict("product_prefix_conflict", `Product prefix ${keyPrefix} is already in use.`);
      }
      throw error;
    }

    return this.getProduct(id);
  }

  listProducts(): readonly ProductSnapshot[] {
    const rows = this.database.connection
      .prepare("SELECT id, key_prefix, name, next_item_sequence, created_at, updated_at FROM products ORDER BY name")
      .all() as unknown as ProductRow[];
    return rows.map((row) => this.mapProduct(row));
  }

  getProduct(productId: string): ProductSnapshot {
    const row = this.getProductRow(productId);
    if (!row) throw notFound("Product");
    return this.mapProduct(row);
  }

  createComponent(input: { productId: string; name: string; kind: ComponentKind }): ComponentSnapshot {
    this.getProduct(input.productId);
    const name = requiredText(input.name, "Component name");
    if (!isOneOf(input.kind, COMPONENT_KINDS)) {
      throw invalidInput(`Unsupported component kind: ${String(input.kind)}.`);
    }

    const now = new Date().toISOString();
    const id = randomUUID();
    try {
      this.database.connection
        .prepare(
          `INSERT INTO components (id, product_id, name, kind, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(id, input.productId, name, input.kind, now, now);
    } catch (error) {
      if (error instanceof Error && error.message.includes("UNIQUE constraint failed")) {
        throw conflict("component_name_conflict", `Component ${name} already exists in this product.`);
      }
      throw error;
    }

    return this.getComponent(id);
  }

  listComponents(productId: string): readonly ComponentSnapshot[] {
    this.getProduct(productId);
    const rows = this.database.connection
      .prepare(
        `SELECT id, product_id, name, kind, created_at, updated_at
         FROM components WHERE product_id = ? ORDER BY name`,
      )
      .all(productId) as unknown as ComponentRow[];
    return rows.map((row) => this.mapComponent(row));
  }

  createWorkItem(input: CreateWorkItemInput): WorkItemSnapshot {
    const title = requiredText(input.title, "Title");
    const description = input.description.trim();
    if (!isOneOf(input.type, WORK_ITEM_TYPES)) throw invalidInput(`Unsupported work-item type: ${String(input.type)}.`);
    if (!isOneOf(input.priority, WORK_ITEM_PRIORITIES)) {
      throw invalidInput(`Unsupported priority: ${String(input.priority)}.`);
    }

    const affectedComponentIds = [...new Set(input.affectedComponentIds ?? [])];
    const now = new Date().toISOString();
    const id = randomUUID();

    const itemKey = this.database.transaction(() => {
      const product = this.getProductRow(input.productId);
      if (!product) throw notFound("Product");
      this.assertComponentsBelongToProduct(
        input.productId,
        input.sourceComponentId ? [input.sourceComponentId, ...affectedComponentIds] : affectedComponentIds,
      );

      const key = createWorkItemKey(product.key_prefix, product.next_item_sequence);
      this.database.connection
        .prepare("UPDATE products SET next_item_sequence = next_item_sequence + 1, updated_at = ? WHERE id = ?")
        .run(now, input.productId);
      this.database.connection
        .prepare(
          `INSERT INTO work_items (
             id, item_key, sequence, product_id, source_component_id, area_id,
             type, priority, status, title, description, environment_json, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'inbox', ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          key,
          product.next_item_sequence,
          input.productId,
          input.sourceComponentId ?? null,
          input.areaId ?? null,
          input.type,
          input.priority,
          title,
          description,
          input.environment ? JSON.stringify(input.environment) : null,
          now,
          now,
        );

      const insertAffected = this.database.connection.prepare(
        "INSERT INTO work_item_affected_components (item_id, component_id) VALUES (?, ?)",
      );
      for (const componentId of affectedComponentIds) insertAffected.run(id, componentId);
      this.insertEvent(id, "item_created", "human", null, "inbox", { type: input.type }, now);
      return key;
    });

    return this.getWorkItem(itemKey);
  }

  listWorkItems(input: ListWorkItemsInput): readonly WorkItemSnapshot[] {
    this.getProduct(input.productId);
    const limit = input.limit ?? 50;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw invalidInput("limit must be an integer between 1 and 100.");
    }
    if (input.beforeSequence !== undefined && (!Number.isInteger(input.beforeSequence) || input.beforeSequence < 1)) {
      throw invalidInput("beforeSequence must be a positive integer.");
    }
    const clauses = ["product_id = ?"];
    const values: SQLInputValue[] = [input.productId];
    if (input.status) {
      if (!isOneOf(input.status, WORK_ITEM_STATUSES)) throw invalidInput("Unsupported work-item status.");
      clauses.push("status = ?");
      values.push(input.status);
    }
    if (input.type) {
      if (!isOneOf(input.type, WORK_ITEM_TYPES)) throw invalidInput("Unsupported work-item type.");
      clauses.push("type = ?");
      values.push(input.type);
    }
    if (input.beforeSequence !== undefined) {
      clauses.push("sequence < ?");
      values.push(input.beforeSequence);
    }
    values.push(limit);

    const rows = this.database.connection
      .prepare(
        `SELECT * FROM work_items
         WHERE ${clauses.join(" AND ")}
         ORDER BY sequence DESC
         LIMIT ?`,
      )
      .all(...values) as unknown as WorkItemRow[];
    return rows.map((row) => this.mapWorkItem(row));
  }

  getWorkItem(itemKey: string): WorkItemSnapshot {
    const row = this.getWorkItemRow(itemKey);
    if (!row) throw notFound("Work item");
    return this.mapWorkItem(row);
  }

  updateWorkItem(itemKey: string, input: UpdateWorkItemInput): WorkItemSnapshot {
    const current = this.getWorkItemRow(itemKey);
    if (!current) throw notFound("Work item");
    const affectedComponentIds = input.affectedComponentIds
      ? [...new Set(input.affectedComponentIds)]
      : undefined;
    if (affectedComponentIds) this.assertComponentsBelongToProduct(current.product_id, affectedComponentIds);
    if (input.type && !isOneOf(input.type, WORK_ITEM_TYPES)) throw invalidInput("Unsupported work-item type.");
    if (input.priority && !isOneOf(input.priority, WORK_ITEM_PRIORITIES)) throw invalidInput("Unsupported priority.");

    const fields: string[] = [];
    const values: SQLInputValue[] = [];
    if (input.title !== undefined) {
      fields.push("title = ?");
      values.push(requiredText(input.title, "Title"));
    }
    if (input.description !== undefined) {
      fields.push("description = ?");
      values.push(input.description.trim());
    }
    if (input.type !== undefined) {
      fields.push("type = ?");
      values.push(input.type);
    }
    if (input.priority !== undefined) {
      fields.push("priority = ?");
      values.push(input.priority);
    }
    if (input.environment !== undefined) {
      fields.push("environment_json = ?");
      values.push(input.environment === null ? null : JSON.stringify(input.environment));
    }
    if (fields.length === 0 && affectedComponentIds === undefined) throw invalidInput("No editable fields were provided.");

    const now = new Date().toISOString();
    this.database.transaction(() => {
      if (fields.length > 0) {
        fields.push("updated_at = ?");
        values.push(now, current.id);
        this.database.connection.prepare(`UPDATE work_items SET ${fields.join(", ")} WHERE id = ?`).run(...values);
      }
      if (affectedComponentIds !== undefined) {
        this.database.connection.prepare("DELETE FROM work_item_affected_components WHERE item_id = ?").run(current.id);
        const insert = this.database.connection.prepare(
          "INSERT INTO work_item_affected_components (item_id, component_id) VALUES (?, ?)",
        );
        for (const componentId of affectedComponentIds) insert.run(current.id, componentId);
        this.database.connection.prepare("UPDATE work_items SET updated_at = ? WHERE id = ?").run(now, current.id);
      }
      this.insertEvent(current.id, "item_updated", "human", null, null, {}, now);
    });

    return this.getWorkItem(itemKey);
  }

  createAttachmentMetadata(input: CreateAttachmentMetadataInput): AttachmentRecord {
    const item = this.getWorkItemRow(input.itemKey);
    if (!item) throw notFound("Work item");
    if (!isOneOf(input.kind, ATTACHMENT_KINDS)) throw invalidInput("Unsupported attachment kind.");
    if (!Number.isSafeInteger(input.sizeBytes) || input.sizeBytes < 1) throw invalidInput("Attachment size is invalid.");

    const count = this.database.connection
      .prepare("SELECT COUNT(*) AS count FROM work_item_attachments WHERE item_id = ?")
      .get(item.id) as unknown as { count: number };
    if (count.count >= 10) throw conflict("attachment_limit_reached", "A work item can have at most 10 attachments.");

    const id = randomUUID();
    const now = new Date().toISOString();
    this.database.transaction(() => {
      this.database.connection
        .prepare(
          `INSERT INTO work_item_attachments
             (id, item_id, kind, original_filename, storage_filename, content_type, size_bytes, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          item.id,
          input.kind,
          input.filename,
          input.storageFilename,
          input.contentType,
          input.sizeBytes,
          now,
        );
      this.database.connection.prepare("UPDATE work_items SET updated_at = ? WHERE id = ?").run(now, item.id);
      this.insertEvent(item.id, "attachment_added", "human", null, null, {
        attachmentId: id,
        kind: input.kind,
        filename: input.filename,
        contentType: input.contentType,
        sizeBytes: input.sizeBytes,
      }, now);
    });
    return this.getAttachmentRecord(input.itemKey, id);
  }

  listAttachments(itemKey: string): readonly AttachmentRecord[] {
    const item = this.getWorkItemRow(itemKey);
    if (!item) throw notFound("Work item");
    return this.listAttachmentsByItemId(item.id);
  }

  getAttachmentRecord(itemKey: string, attachmentId: string): AttachmentRecord {
    const row = this.database.connection
      .prepare(
        `SELECT a.id, w.item_key, a.kind, a.original_filename, a.storage_filename,
                a.content_type, a.size_bytes, a.created_at
         FROM work_item_attachments a
         JOIN work_items w ON w.id = a.item_id
         WHERE w.item_key = ? AND a.id = ?`,
      )
      .get(itemKey, attachmentId) as unknown as AttachmentRow | undefined;
    if (!row) throw notFound("Attachment");
    return this.mapAttachment(row);
  }

  transitionWorkItem(input: TransitionWorkItemInput): WorkItemSnapshot {
    const now = new Date().toISOString();
    this.database.transaction(() => {
      const current = this.getWorkItemRow(input.itemKey);
      if (!current) throw notFound("Work item");
      if (!isOneOf(input.to, WORK_ITEM_STATUSES)) throw invalidInput("Unsupported work-item status.");
      try {
        assertWorkItemTransition({ from: current.status, to: input.to, actor: input.actor, reason: input.reason });
      } catch (error) {
        throw conflict("invalid_state_transition", error instanceof Error ? error.message : "Invalid state transition.");
      }

      this.database.connection
        .prepare("UPDATE work_items SET status = ?, updated_at = ? WHERE id = ?")
        .run(input.to, now, current.id);
      this.insertEvent(
        current.id,
        "status_changed",
        input.actor,
        current.status,
        input.to,
        input.note ? { reason: input.reason, note: input.note } : { reason: input.reason },
        now,
      );
    });
    return this.getWorkItem(input.itemKey);
  }

  getTimeline(itemKey: string): readonly WorkItemEventSnapshot[] {
    const item = this.getWorkItemRow(itemKey);
    if (!item) throw notFound("Work item");
    const rows = this.database.connection
      .prepare(
        `SELECT e.id, w.item_key, e.event_type, e.actor_kind, e.from_status, e.to_status, e.payload_json, e.created_at
         FROM work_item_events e
         JOIN work_items w ON w.id = e.item_id
         WHERE e.item_id = ?
         ORDER BY e.created_at, e.rowid`,
      )
      .all(item.id) as unknown as EventRow[];
    return rows.map((row) => ({
      id: row.id,
      itemKey: row.item_key,
      eventType: row.event_type,
      actorKind: row.actor_kind,
      ...(row.from_status ? { fromStatus: row.from_status } : {}),
      ...(row.to_status ? { toStatus: row.to_status } : {}),
      payload: JSON.parse(row.payload_json) as Readonly<Record<string, unknown>>,
      createdAt: row.created_at,
    }));
  }

  appendAnalysis(input: AppendAnalysisInput): WorkItemEventSnapshot {
    const conclusion = requiredText(input.conclusion, "Conclusion");
    if (conclusion.length > 20_000) throw invalidInput("Conclusion must be 20,000 characters or fewer.");
    const evidence = this.validateAnalysisList(input.evidence, "Evidence");
    const risks = this.validateAnalysisList(input.risks, "Risks");
    const agentName = input.agentName?.trim();
    if (agentName && agentName.length > 100) throw invalidInput("Agent name must be 100 characters or fewer.");
    const idempotencyKey = requiredText(input.idempotencyKey, "Idempotency key");
    if (idempotencyKey.length > 200) throw invalidInput("Idempotency key must be 200 characters or fewer.");
    const operation = `append_analysis:${input.itemKey}`;

    return this.database.transaction(() => {
      const existing = this.database.connection
        .prepare("SELECT operation, result_json FROM idempotency_keys WHERE key = ?")
        .get(idempotencyKey) as unknown as { operation: string; result_json: string } | undefined;
      if (existing) {
        if (existing.operation !== operation) {
          throw conflict("idempotency_conflict", "This idempotency key was already used for another operation.");
        }
        return JSON.parse(existing.result_json) as WorkItemEventSnapshot;
      }

      const item = this.getWorkItemRow(input.itemKey);
      if (!item) throw notFound("Work item");
      const now = new Date().toISOString();
      const payload = {
        conclusion,
        evidence,
        risks,
        ...(agentName ? { agentName } : {}),
      };
      const eventId = this.insertEvent(item.id, "analysis_appended", "agent", null, null, payload, now);
      this.database.connection.prepare("UPDATE work_items SET updated_at = ? WHERE id = ?").run(now, item.id);
      const result: WorkItemEventSnapshot = {
        id: eventId,
        itemKey: item.item_key,
        eventType: "analysis_appended",
        actorKind: "agent",
        payload,
        createdAt: now,
      };
      this.database.connection
        .prepare("INSERT INTO idempotency_keys (key, operation, result_json, created_at) VALUES (?, ?, ?, ?)")
        .run(idempotencyKey, operation, JSON.stringify(result), now);
      return result;
    });
  }

  claimExecution(input: ClaimExecutionInput): ExecutionSnapshot {
    const itemKey = requiredText(input.itemKey, "Item key").toUpperCase();
    const agentId = requiredText(input.agentId, "Agent ID");
    if (!EXECUTION_MODES.includes(input.mode)) {
      throw invalidInput("Execution mode must be process, continue, or verify.");
    }
    this.validateLeaseSeconds(input.leaseSeconds);
    const idempotencyKey = this.validateIdempotencyKey(input.idempotencyKey);
    const operation = `claim_item:${itemKey}`;

    return this.database.transaction(() => {
      const repeated = this.getIdempotentResult<ExecutionSnapshot>(idempotencyKey, operation);
      if (repeated) return repeated;
      let item = this.getWorkItemRow(itemKey);
      if (!item) throw notFound("Work item");
      const now = new Date().toISOString();
      item = this.expireStaleLease(item, now);
      const activeLease = this.database.connection
        .prepare("SELECT id FROM execution_leases WHERE item_id = ? AND released_at IS NULL")
        .get(item.id) as unknown as { id: string } | undefined;
      if (activeLease) throw conflict("lease_conflict", "This work item already has an active AI lease.");

      if (input.mode === "process" && item.status !== "ready") {
        throw conflict("item_not_claimable", "A processing execution can only claim a ready work item.");
      }
      if (input.mode === "continue" && item.status !== "on_hold") {
        throw conflict("item_not_claimable", "A continuation can only claim an on-hold work item.");
      }
      if (input.mode === "verify" && item.status !== "pending_verification") {
        throw conflict("item_not_claimable", "A verification execution can only claim a pending-verification item.");
      }

      const executionId = randomUUID();
      const leaseId = randomUUID();
      const expiresAt = new Date(Date.parse(now) + input.leaseSeconds * 1000).toISOString();
      this.database.connection
        .prepare(
          `INSERT INTO ai_executions
             (id, item_id, agent_id, mode, trigger_source, status, created_at, updated_at)
           VALUES (?, ?, ?, ?, 'agent_pull', 'running', ?, ?)`,
        )
        .run(executionId, item.id, agentId, input.mode, now, now);
      this.database.connection
        .prepare(
          `INSERT INTO execution_leases (id, execution_id, item_id, expires_at, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(leaseId, executionId, item.id, expiresAt, now, now);
      if (input.mode !== "verify") {
        this.applyTransition(item, "in_progress", "agent", input.mode === "continue" ? "resume" : "claim", undefined, now);
      }
      this.insertEvent(item.id, "execution_claimed", "agent", null, null, {
        executionId,
        leaseId,
        leaseExpiresAt: expiresAt,
        agentId,
        mode: input.mode,
      }, now);
      const result = this.getExecution(executionId);
      this.saveIdempotentResult(idempotencyKey, operation, result, now);
      return result;
    });
  }

  getExecution(executionId: string): ExecutionSnapshot {
    const row = this.database.connection
      .prepare(
        `SELECT e.id, w.item_key, e.agent_id, e.mode, e.trigger_source, e.status,
                e.report_json, e.human_question, e.created_at, e.updated_at, e.completed_at,
                l.id AS lease_id, l.expires_at AS lease_expires_at
         FROM ai_executions e
         JOIN work_items w ON w.id = e.item_id
         LEFT JOIN execution_leases l ON l.execution_id = e.id AND l.released_at IS NULL
         WHERE e.id = ?`,
      )
      .get(executionId) as unknown as ExecutionRow | undefined;
    if (!row) throw notFound("Execution");
    return {
      id: row.id,
      itemKey: row.item_key,
      agentId: row.agent_id,
      mode: row.mode,
      triggerSource: row.trigger_source,
      status: row.status,
      ...(row.report_json ? { report: JSON.parse(row.report_json) as ExecutionReport } : {}),
      ...(row.human_question ? { humanQuestion: row.human_question } : {}),
      ...(row.lease_id && row.lease_expires_at
        ? { activeLease: { id: row.lease_id, expiresAt: row.lease_expires_at } }
        : {}),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      ...(row.completed_at ? { completedAt: row.completed_at } : {}),
    };
  }

  renewExecutionLease(input: {
    executionId: string;
    leaseId: string;
    leaseSeconds: number;
    idempotencyKey: string;
  }): ExecutionSnapshot {
    this.validateLeaseSeconds(input.leaseSeconds);
    const key = this.validateIdempotencyKey(input.idempotencyKey);
    const operation = `renew_item_lease:${input.executionId}:${input.leaseId}`;
    return this.database.transaction(() => {
      const repeated = this.getIdempotentResult<ExecutionSnapshot>(key, operation);
      if (repeated) return repeated;
      const now = new Date().toISOString();
      const lease = this.requireActiveLease(input.executionId, input.leaseId, now);
      const expiresAt = new Date(Date.parse(now) + input.leaseSeconds * 1000).toISOString();
      this.database.connection
        .prepare("UPDATE execution_leases SET expires_at = ?, updated_at = ? WHERE id = ?")
        .run(expiresAt, now, lease.id);
      this.database.connection.prepare("UPDATE ai_executions SET updated_at = ? WHERE id = ?").run(now, lease.execution_id);
      const result = this.getExecution(lease.execution_id);
      this.saveIdempotentResult(key, operation, result, now);
      return result;
    });
  }

  appendExecutionProgress(input: {
    executionId: string;
    leaseId: string;
    message: string;
    idempotencyKey: string;
  }): WorkItemEventSnapshot {
    const message = requiredText(input.message, "Progress message");
    if (message.length > 4_000) throw invalidInput("Progress message must be 4,000 characters or fewer.");
    return this.withExecutionEvent(input, "append_progress", "execution_progress", { message });
  }

  requestExecutionHumanInput(input: {
    executionId: string;
    leaseId: string;
    question: string;
    idempotencyKey: string;
  }): ExecutionSnapshot {
    const question = requiredText(input.question, "Question");
    if (question.length > 4_000) throw invalidInput("Question must be 4,000 characters or fewer.");
    const key = this.validateIdempotencyKey(input.idempotencyKey);
    const operation = `request_human_input:${input.executionId}`;
    return this.database.transaction(() => {
      const repeated = this.getIdempotentResult<ExecutionSnapshot>(key, operation);
      if (repeated) return repeated;
      const now = new Date().toISOString();
      const lease = this.requireActiveLease(input.executionId, input.leaseId, now);
      const item = this.getWorkItemRow(lease.item_key)!;
      if (item.status !== "in_progress") {
        throw conflict("invalid_state_transition", "Only an in-progress item can wait for human input.");
      }
      this.database.connection
        .prepare("UPDATE ai_executions SET status = 'waiting_for_human', human_question = ?, updated_at = ? WHERE id = ?")
        .run(question, now, lease.execution_id);
      this.releaseLease(lease.id, now);
      this.applyTransition(item, "on_hold", "agent", "request_human_input", question, now);
      this.insertEvent(item.id, "human_input_requested", "agent", null, null, { executionId: lease.execution_id, question }, now);
      const result = this.getExecution(lease.execution_id);
      this.saveIdempotentResult(key, operation, result, now);
      return result;
    });
  }

  submitExecutionResolution(input: {
    executionId: string;
    leaseId: string;
    report: ExecutionReport;
    idempotencyKey: string;
  }): ExecutionSnapshot {
    const key = this.validateIdempotencyKey(input.idempotencyKey);
    const operation = `submit_resolution:${input.executionId}`;
    return this.database.transaction(() => {
      const repeated = this.getIdempotentResult<ExecutionSnapshot>(key, operation);
      if (repeated) return repeated;
      const now = new Date().toISOString();
      const lease = this.requireActiveLease(input.executionId, input.leaseId, now);
      this.database.connection
        .prepare("UPDATE ai_executions SET status = 'succeeded', report_json = ?, updated_at = ?, completed_at = ? WHERE id = ?")
        .run(JSON.stringify(input.report), now, now, lease.execution_id);
      const item = this.getWorkItemRow(lease.item_key)!;
      this.insertEvent(item.id, "resolution_submitted", "agent", null, null, {
        executionId: lease.execution_id,
        report: input.report,
      }, now);
      const result = this.getExecution(lease.execution_id);
      this.saveIdempotentResult(key, operation, result, now);
      return result;
    });
  }

  markExecutionPendingVerification(input: {
    executionId: string;
    leaseId: string;
    idempotencyKey: string;
  }): ExecutionSnapshot {
    const key = this.validateIdempotencyKey(input.idempotencyKey);
    const operation = `mark_pending_verification:${input.executionId}`;
    return this.database.transaction(() => {
      const repeated = this.getIdempotentResult<ExecutionSnapshot>(key, operation);
      if (repeated) return repeated;
      const now = new Date().toISOString();
      const lease = this.requireActiveLease(input.executionId, input.leaseId, now);
      const execution = this.getExecution(lease.execution_id);
      if (execution.status !== "succeeded" || !execution.report) {
        throw conflict("resolution_required", "A structured resolution report is required before human verification.");
      }
      const item = this.getWorkItemRow(lease.item_key)!;
      if (item.status === "in_progress") {
        this.applyTransition(item, "pending_verification", "agent", "resolution_submitted", undefined, now);
      } else if (item.status !== "pending_verification") {
        throw conflict(
          "invalid_state_transition",
          "Only an in-progress or already pending-verification item can complete this handoff.",
        );
      }
      this.releaseLease(lease.id, now);
      const result = this.getExecution(lease.execution_id);
      this.saveIdempotentResult(key, operation, result, now);
      return result;
    });
  }

  releaseExecution(input: {
    executionId: string;
    leaseId: string;
    note?: string;
    idempotencyKey: string;
  }): ExecutionSnapshot {
    const key = this.validateIdempotencyKey(input.idempotencyKey);
    const operation = `release_item:${input.executionId}`;
    return this.database.transaction(() => {
      const repeated = this.getIdempotentResult<ExecutionSnapshot>(key, operation);
      if (repeated) return repeated;
      const now = new Date().toISOString();
      const lease = this.requireActiveLease(input.executionId, input.leaseId, now);
      const item = this.getWorkItemRow(lease.item_key)!;
      this.database.connection
        .prepare("UPDATE ai_executions SET status = 'aborted', updated_at = ?, completed_at = ? WHERE id = ?")
        .run(now, now, lease.execution_id);
      this.releaseLease(lease.id, now);
      if (item.status === "in_progress") this.applyTransition(item, "ready", "agent", "released", input.note, now);
      this.insertEvent(item.id, "execution_released", "agent", null, null, {
        executionId: lease.execution_id,
        ...(input.note ? { note: input.note } : {}),
      }, now);
      const result = this.getExecution(lease.execution_id);
      this.saveIdempotentResult(key, operation, result, now);
      return result;
    });
  }

  resumeExecution(input: {
    executionId: string;
    leaseSeconds: number;
    idempotencyKey: string;
  }): ExecutionSnapshot {
    this.validateLeaseSeconds(input.leaseSeconds);
    const key = this.validateIdempotencyKey(input.idempotencyKey);
    const operation = `resume_execution:${input.executionId}`;
    return this.database.transaction(() => {
      const repeated = this.getIdempotentResult<ExecutionSnapshot>(key, operation);
      if (repeated) return repeated;
      const execution = this.getExecution(input.executionId);
      if (execution.status !== "waiting_for_human") {
        throw conflict("item_not_claimable", "Only an execution waiting for human input can be resumed.");
      }
      const item = this.getWorkItemRow(execution.itemKey)!;
      if (item.status !== "on_hold") {
        throw conflict("item_not_claimable", "The work item must be on hold before its execution can resume.");
      }
      const activeLease = this.database.connection
        .prepare("SELECT id FROM execution_leases WHERE item_id = ? AND released_at IS NULL")
        .get(item.id) as unknown as { id: string } | undefined;
      if (activeLease) throw conflict("lease_conflict", "This work item already has an active AI lease.");
      const now = new Date().toISOString();
      const leaseId = randomUUID();
      const expiresAt = new Date(Date.parse(now) + input.leaseSeconds * 1000).toISOString();
      this.database.connection
        .prepare(
          `INSERT INTO execution_leases (id, execution_id, item_id, expires_at, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(leaseId, execution.id, item.id, expiresAt, now, now);
      this.database.connection
        .prepare("UPDATE ai_executions SET status = 'running', human_question = NULL, updated_at = ?, completed_at = NULL WHERE id = ?")
        .run(now, execution.id);
      this.applyTransition(item, "in_progress", "agent", "resume", undefined, now);
      this.insertEvent(item.id, "execution_resumed", "agent", null, null, {
        executionId: execution.id,
        leaseId,
        leaseExpiresAt: expiresAt,
      }, now);
      const result = this.getExecution(execution.id);
      this.saveIdempotentResult(key, operation, result, now);
      return result;
    });
  }

  private withExecutionEvent(
    input: { executionId: string; leaseId: string; idempotencyKey: string },
    operationName: string,
    eventType: string,
    payload: Readonly<Record<string, unknown>>,
  ): WorkItemEventSnapshot {
    const key = this.validateIdempotencyKey(input.idempotencyKey);
    const operation = `${operationName}:${input.executionId}`;
    return this.database.transaction(() => {
      const repeated = this.getIdempotentResult<WorkItemEventSnapshot>(key, operation);
      if (repeated) return repeated;
      const now = new Date().toISOString();
      const lease = this.requireActiveLease(input.executionId, input.leaseId, now);
      const item = this.getWorkItemRow(lease.item_key)!;
      const eventPayload = { executionId: lease.execution_id, ...payload };
      const eventId = this.insertEvent(item.id, eventType, "agent", null, null, eventPayload, now);
      this.database.connection.prepare("UPDATE ai_executions SET updated_at = ? WHERE id = ?").run(now, lease.execution_id);
      this.database.connection.prepare("UPDATE work_items SET updated_at = ? WHERE id = ?").run(now, item.id);
      const result: WorkItemEventSnapshot = {
        id: eventId,
        itemKey: item.item_key,
        eventType,
        actorKind: "agent",
        payload: eventPayload,
        createdAt: now,
      };
      this.saveIdempotentResult(key, operation, result, now);
      return result;
    });
  }

  private getIdempotentResult<T>(key: string, operation: string): T | undefined {
    const existing = this.database.connection
      .prepare("SELECT operation, result_json FROM idempotency_keys WHERE key = ?")
      .get(key) as unknown as { operation: string; result_json: string } | undefined;
    if (!existing) return undefined;
    if (existing.operation !== operation) {
      throw conflict("idempotency_conflict", "This idempotency key was already used for another operation.");
    }
    return JSON.parse(existing.result_json) as T;
  }

  private saveIdempotentResult(key: string, operation: string, result: unknown, now: string): void {
    this.database.connection
      .prepare("INSERT INTO idempotency_keys (key, operation, result_json, created_at) VALUES (?, ?, ?, ?)")
      .run(key, operation, JSON.stringify(result), now);
  }

  private validateIdempotencyKey(value: string): string {
    const key = requiredText(value, "Idempotency key");
    if (key.length > 200) throw invalidInput("Idempotency key must be 200 characters or fewer.");
    return key;
  }

  private validateLeaseSeconds(value: number): void {
    if (!Number.isInteger(value) || value < 60 || value > 3_600) {
      throw invalidInput("Lease seconds must be an integer between 60 and 3600.");
    }
  }

  private requireActiveLease(executionId: string, leaseId: string, now: string): LeaseRow {
    const lease = this.database.connection
      .prepare(
        `SELECT l.id, l.execution_id, l.item_id, w.item_key, l.expires_at, l.released_at,
                e.status AS execution_status
         FROM execution_leases l
         JOIN ai_executions e ON e.id = l.execution_id
         JOIN work_items w ON w.id = l.item_id
         WHERE l.id = ? AND l.execution_id = ?`,
      )
      .get(leaseId, executionId) as unknown as LeaseRow | undefined;
    if (!lease || lease.released_at) throw conflict("lease_expired", "The AI execution lease is no longer active.");
    if (lease.expires_at <= now) throw conflict("lease_expired", "The AI execution lease has expired.");
    return lease;
  }

  private releaseLease(leaseId: string, now: string): void {
    this.database.connection
      .prepare("UPDATE execution_leases SET released_at = ?, updated_at = ? WHERE id = ? AND released_at IS NULL")
      .run(now, now, leaseId);
  }

  private expireStaleLease(item: WorkItemRow, now: string): WorkItemRow {
    const stale = this.database.connection
      .prepare(
        `SELECT l.id, l.execution_id
         FROM execution_leases l
         WHERE l.item_id = ? AND l.released_at IS NULL AND l.expires_at <= ?`,
      )
      .get(item.id, now) as unknown as { id: string; execution_id: string } | undefined;
    if (!stale) return item;
    this.releaseLease(stale.id, now);
    this.database.connection
      .prepare("UPDATE ai_executions SET status = 'lease_expired', updated_at = ?, completed_at = ? WHERE id = ?")
      .run(now, now, stale.execution_id);
    if (item.status === "in_progress") {
      this.applyTransition(item, "ready", "system", "lease_expired", undefined, now);
      return this.getWorkItemRow(item.item_key)!;
    }
    return item;
  }

  private applyTransition(
    current: WorkItemRow,
    to: WorkItemStatus,
    actor: ActorKind,
    reason: Parameters<typeof assertWorkItemTransition>[0]["reason"],
    note: string | undefined,
    now: string,
  ): void {
    try {
      assertWorkItemTransition({ from: current.status, to, actor, reason });
    } catch (error) {
      throw conflict("invalid_state_transition", error instanceof Error ? error.message : "Invalid state transition.");
    }
    this.database.connection.prepare("UPDATE work_items SET status = ?, updated_at = ? WHERE id = ?").run(to, now, current.id);
    this.insertEvent(
      current.id,
      "status_changed",
      actor,
      current.status,
      to,
      note ? { reason, note } : { reason },
      now,
    );
  }

  private getProductRow(productId: string): ProductRow | undefined {
    return this.database.connection
      .prepare("SELECT id, key_prefix, name, next_item_sequence, created_at, updated_at FROM products WHERE id = ?")
      .get(productId) as unknown as ProductRow | undefined;
  }

  private getComponent(componentId: string): ComponentSnapshot {
    const row = this.database.connection
      .prepare("SELECT id, product_id, name, kind, created_at, updated_at FROM components WHERE id = ?")
      .get(componentId) as unknown as ComponentRow | undefined;
    if (!row) throw notFound("Component");
    return this.mapComponent(row);
  }

  private getWorkItemRow(itemKey: string): WorkItemRow | undefined {
    return this.database.connection.prepare("SELECT * FROM work_items WHERE item_key = ?").get(itemKey) as unknown as
      | WorkItemRow
      | undefined;
  }

  private assertComponentsBelongToProduct(productId: string, componentIds: readonly string[]): void {
    if (componentIds.length === 0) return;
    const statement = this.database.connection.prepare("SELECT product_id FROM components WHERE id = ?");
    for (const componentId of new Set(componentIds)) {
      const row = statement.get(componentId) as unknown as { product_id: string } | undefined;
      if (!row) throw notFound("Component");
      if (row.product_id !== productId) {
        throw invalidInput(`Component ${componentId} does not belong to the selected product.`);
      }
    }
  }

  private getAffectedComponentIds(itemId: string): readonly string[] {
    const rows = this.database.connection
      .prepare("SELECT component_id FROM work_item_affected_components WHERE item_id = ? ORDER BY component_id")
      .all(itemId) as unknown as Array<{ component_id: string }>;
    return rows.map((row) => row.component_id);
  }

  private listAttachmentsByItemId(itemId: string): readonly AttachmentRecord[] {
    const rows = this.database.connection
      .prepare(
        `SELECT a.id, w.item_key, a.kind, a.original_filename, a.storage_filename,
                a.content_type, a.size_bytes, a.created_at
         FROM work_item_attachments a
         JOIN work_items w ON w.id = a.item_id
         WHERE a.item_id = ?
         ORDER BY a.created_at, a.rowid`,
      )
      .all(itemId) as unknown as AttachmentRow[];
    return rows.map((row) => this.mapAttachment(row));
  }

  private insertEvent(
    itemId: string,
    eventType: string,
    actorKind: ActorKind,
    fromStatus: WorkItemStatus | null,
    toStatus: WorkItemStatus | null,
    payload: Readonly<Record<string, unknown>>,
    createdAt: string,
  ): string {
    const id = randomUUID();
    this.database.connection
      .prepare(
        `INSERT INTO work_item_events
           (id, item_id, event_type, actor_kind, from_status, to_status, payload_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, itemId, eventType, actorKind, fromStatus, toStatus, JSON.stringify(payload), createdAt);
    return id;
  }

  private validateAnalysisList(value: readonly string[], field: string): readonly string[] {
    if (value.length > 50) throw invalidInput(`${field} can contain at most 50 entries.`);
    return value.map((entry) => {
      const normalized = requiredText(entry, `${field} entry`);
      if (normalized.length > 2_000) throw invalidInput(`${field} entries must be 2,000 characters or fewer.`);
      return normalized;
    });
  }

  private mapProduct(row: ProductRow): ProductSnapshot {
    return {
      id: row.id,
      keyPrefix: row.key_prefix,
      name: row.name,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private mapComponent(row: ComponentRow): ComponentSnapshot {
    return {
      id: row.id,
      productId: row.product_id,
      name: row.name,
      kind: row.kind,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private mapAttachment(row: AttachmentRow): AttachmentRecord {
    return {
      id: row.id,
      itemKey: row.item_key,
      kind: row.kind,
      filename: row.original_filename,
      storageFilename: row.storage_filename,
      contentType: row.content_type,
      sizeBytes: row.size_bytes,
      createdAt: row.created_at,
    };
  }

  private mapWorkItem(row: WorkItemRow): WorkItemSnapshot {
    const environment = parseEnvironment(row.environment_json);
    return {
      id: row.id,
      key: row.item_key,
      productId: row.product_id,
      ...(row.source_component_id ? { sourceComponentId: row.source_component_id } : {}),
      affectedComponentIds: this.getAffectedComponentIds(row.id),
      ...(row.area_id ? { areaId: row.area_id } : {}),
      type: row.type,
      priority: row.priority,
      status: row.status,
      title: row.title,
      description: row.description,
      ...(environment ? { environment } : {}),
      attachments: this.listAttachmentsByItemId(row.id).map(({ storageFilename: _, ...attachment }) => attachment),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}
