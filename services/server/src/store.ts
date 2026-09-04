import { randomUUID } from "node:crypto";
import type { SQLInputValue } from "node:sqlite";

import {
  assertWorkItemTransition,
  createWorkItemKey,
  WORK_ITEM_PRIORITIES,
  WORK_ITEM_STATUSES,
  WORK_ITEM_TYPES,
  type ActorKind,
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
  type ComponentKind,
  type ComponentSnapshot,
  type CreateWorkItemInput,
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

  private insertEvent(
    itemId: string,
    eventType: string,
    actorKind: ActorKind,
    fromStatus: WorkItemStatus | null,
    toStatus: WorkItemStatus | null,
    payload: Readonly<Record<string, unknown>>,
    createdAt: string,
  ): void {
    this.database.connection
      .prepare(
        `INSERT INTO work_item_events
           (id, item_id, event_type, actor_kind, from_status, to_status, payload_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(randomUUID(), itemId, eventType, actorKind, fromStatus, toStatus, JSON.stringify(payload), createdAt);
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
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}
