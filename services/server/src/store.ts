import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { SQLInputValue } from "node:sqlite";

import {
  ATTACHMENT_KINDS,
  assertWorkItemTransition,
  createWorkItemKey,
  EXECUTION_MODES,
  WORK_ITEM_OCCURRENCE_FREQUENCIES,
  WORK_ITEM_PRIORITIES,
  WORK_ITEM_STATUSES,
  WORK_ITEM_TYPES,
  type ActorKind,
  type AttachmentKind,
  type ExecutionReport,
  type ExecutionStatus,
  type WorkItemEnvironment,
  type WorkItemPriority,
  type WorkItemReport,
  type WorkItemSnapshot,
  type WorkItemStatus,
  type WorkItemType,
} from "@missiongo/domain";

import { conflict, invalidInput, MissionGoError, notFound } from "./errors.js";
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
  type FeedbackDraftSnapshot,
  type FeedbackLogEntry,
  type FeedbackWebSession,
  type CreateAttachmentMetadataInput,
  type ListWorkItemsInput,
  type ProductSnapshot,
  type CreatedSdkToken,
  type SdkPrincipal,
  type SdkTokenSnapshot,
  type TransitionWorkItemInput,
  type UpsertFeedbackDraftInput,
  type UpdateWorkItemInput,
  type WorkItemEventSnapshot,
  type WorkItemListSummary,
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
  report_json: string | null;
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
  display_number: number;
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

interface SdkTokenRow {
  id: string;
  name: string;
  token_hash: string;
  product_id: string;
  platform: "android";
  source_component_id: string | null;
  expires_at: string | null;
  revoked_at: string | null;
  last_used_at: string | null;
  created_at: string;
}

interface FeedbackDraftRow {
  id: string;
  client_draft_id: string;
  product_id: string;
  source_component_id: string | null;
  status: "editing" | "submitted" | "expired";
  type: WorkItemType;
  priority: WorkItemPriority;
  title: string;
  description: string;
  environment_json: string;
  context_json: string;
  logs_json: string;
  item_key: string | null;
  expires_at: string;
  created_at: string;
  updated_at: string;
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

function parseReport(value: string | null): WorkItemReport | undefined {
  if (value === null) return undefined;
  return JSON.parse(value) as WorkItemReport;
}

function sdkTokenHash(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
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

  updateProduct(productId: string, input: { name: string }): ProductSnapshot {
    this.getProduct(productId);
    const name = requiredText(input.name, "Product name");
    const now = new Date().toISOString();
    this.database.connection.prepare("UPDATE products SET name = ?, updated_at = ? WHERE id = ?").run(name, now, productId);
    return this.getProduct(productId);
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

  updateComponent(
    productId: string,
    componentId: string,
    input: { name: string; kind: ComponentKind },
  ): ComponentSnapshot {
    this.getProduct(productId);
    const current = this.getComponent(componentId);
    if (current.productId !== productId) throw notFound("Component");
    const name = requiredText(input.name, "Component name");
    if (!isOneOf(input.kind, COMPONENT_KINDS)) throw invalidInput(`Unsupported component kind: ${String(input.kind)}.`);
    const now = new Date().toISOString();
    try {
      this.database.connection
        .prepare("UPDATE components SET name = ?, kind = ?, updated_at = ? WHERE id = ?")
        .run(name, input.kind, now, componentId);
    } catch (error) {
      if (error instanceof Error && error.message.includes("UNIQUE constraint failed")) {
        throw conflict("component_name_conflict", `Component ${name} already exists in this product.`);
      }
      throw error;
    }
    return this.getComponent(componentId);
  }

  createSdkToken(input: {
    name: string;
    productId: string;
    sourceComponentId?: string;
    expiresAt?: string;
  }): CreatedSdkToken {
    const name = requiredText(input.name, "Token name");
    if (name.length > 100) throw invalidInput("Token name must be 100 characters or fewer.");
    this.getProduct(input.productId);
    if (input.sourceComponentId) {
      this.assertComponentsBelongToProduct(input.productId, [input.sourceComponentId]);
      if (this.getComponent(input.sourceComponentId).kind !== "android") {
        throw invalidInput("An Android SDK token can only target an Android module.");
      }
    }
    const now = new Date().toISOString();
    let expiresAt: string | undefined;
    if (input.expiresAt) {
      const parsedExpiresAt = new Date(input.expiresAt);
      if (Number.isNaN(parsedExpiresAt.valueOf())) {
        throw invalidInput("expiresAt must be a future ISO 8601 timestamp.");
      }
      expiresAt = parsedExpiresAt.toISOString();
      if (expiresAt <= now) throw invalidInput("expiresAt must be a future ISO 8601 timestamp.");
    }

    const id = randomUUID();
    const token = `mg_sdk_${randomBytes(32).toString("base64url")}`;
    this.database.connection
      .prepare(
        `INSERT INTO access_tokens
           (id, kind, name, token_hash, product_id, platform, source_component_id, expires_at, created_at)
         VALUES (?, 'sdk', ?, ?, ?, 'android', ?, ?, ?)`,
      )
      .run(
        id,
        name,
        sdkTokenHash(token),
        input.productId,
        input.sourceComponentId ?? null,
        expiresAt ?? null,
        now,
      );
    return { ...this.getSdkToken(id), token };
  }

  listSdkTokens(): readonly SdkTokenSnapshot[] {
    const rows = this.database.connection
      .prepare(
        `SELECT id, name, token_hash, product_id, platform, source_component_id,
                expires_at, revoked_at, last_used_at, created_at
         FROM access_tokens WHERE kind = 'sdk' ORDER BY created_at DESC`,
      )
      .all() as unknown as SdkTokenRow[];
    return rows.map((row) => this.mapSdkToken(row));
  }

  revokeSdkToken(tokenId: string): SdkTokenSnapshot {
    const current = this.getSdkToken(tokenId);
    if (!current.revokedAt) {
      this.database.connection
        .prepare("UPDATE access_tokens SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL")
        .run(new Date().toISOString(), tokenId);
    }
    return this.getSdkToken(tokenId);
  }

  authenticateSdkToken(token: string): SdkPrincipal | undefined {
    if (!/^mg_sdk_[A-Za-z0-9_-]{43}$/.test(token)) return undefined;
    const row = this.database.connection
      .prepare(
        `SELECT id, name, token_hash, product_id, platform, source_component_id,
                expires_at, revoked_at, last_used_at, created_at
         FROM access_tokens WHERE kind = 'sdk' AND token_hash = ?`,
      )
      .get(sdkTokenHash(token)) as unknown as SdkTokenRow | undefined;
    const now = new Date().toISOString();
    if (!row || row.revoked_at || (row.expires_at && row.expires_at <= now)) return undefined;
    this.database.connection.prepare("UPDATE access_tokens SET last_used_at = ? WHERE id = ?").run(now, row.id);
    return {
      tokenId: row.id,
      productId: row.product_id,
      platform: row.platform,
      ...(row.source_component_id ? { sourceComponentId: row.source_component_id } : {}),
    };
  }

  upsertFeedbackDraft(input: UpsertFeedbackDraftInput): FeedbackDraftSnapshot {
    const clientDraftId = requiredText(input.clientDraftId, "Client draft ID");
    if (!/^[A-Za-z0-9_-]{8,100}$/.test(clientDraftId)) {
      throw invalidInput("Client draft ID must contain 8-100 URL-safe characters.");
    }
    if (!isOneOf(input.type, WORK_ITEM_TYPES)) throw invalidInput("Unsupported work-item type.");
    if (!isOneOf(input.priority, WORK_ITEM_PRIORITIES)) throw invalidInput("Unsupported priority.");
    if (input.environment.platform !== "android") throw invalidInput("Android SDK drafts must use the Android platform.");
    const title = input.title.trim();
    const description = input.description.trim();
    if (title.length > 500) throw invalidInput("Title must be 500 characters or fewer.");
    if (description.length > 20_000) throw invalidInput("Description must be 20,000 characters or fewer.");
    const context = this.validateFeedbackStringMap(input.context, "Context", 50, 2_000);
    const logs = this.validateFeedbackLogs(input.logs);
    const now = new Date().toISOString();
    const expiresAt = new Date(Date.parse(now) + 24 * 60 * 60 * 1_000).toISOString();

    return this.database.transaction(() => {
      const existing = this.getFeedbackDraftRowByClientId(input.principal.tokenId, clientDraftId);
      if (existing?.status === "submitted") {
        throw conflict("draft_already_submitted", "This feedback draft has already been submitted.");
      }
      if (existing?.status === "expired" || (existing && existing.expires_at <= now)) {
        if (existing.status !== "expired") {
          this.database.connection.prepare("UPDATE feedback_drafts SET status = 'expired', updated_at = ? WHERE id = ?")
            .run(now, existing.id);
        }
        throw conflict("draft_expired", "This feedback draft has expired.");
      }

      if (existing) {
        this.database.connection
          .prepare(
            `UPDATE feedback_drafts
             SET type = ?, priority = ?, title = ?, description = ?, environment_json = ?,
                 context_json = ?, logs_json = ?, expires_at = ?, updated_at = ?
             WHERE id = ?`,
          )
          .run(
            input.type,
            input.priority,
            title,
            description,
            JSON.stringify(input.environment),
            JSON.stringify(context),
            JSON.stringify(logs),
            expiresAt,
            now,
            existing.id,
          );
        return this.mapFeedbackDraft(this.getFeedbackDraftRow(existing.id, input.principal.tokenId)!);
      }

      const id = randomUUID();
      this.database.connection
        .prepare(
          `INSERT INTO feedback_drafts
             (id, access_token_id, client_draft_id, product_id, source_component_id, status,
              type, priority, title, description, environment_json, context_json, logs_json,
              expires_at, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, 'editing', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          input.principal.tokenId,
          clientDraftId,
          input.principal.productId,
          input.principal.sourceComponentId ?? null,
          input.type,
          input.priority,
          title,
          description,
          JSON.stringify(input.environment),
          JSON.stringify(context),
          JSON.stringify(logs),
          expiresAt,
          now,
          now,
        );
      return this.mapFeedbackDraft(this.getFeedbackDraftRow(id, input.principal.tokenId)!);
    });
  }

  getFeedbackDraft(draftId: string, principal: SdkPrincipal): FeedbackDraftSnapshot {
    const row = this.getFeedbackDraftRow(draftId, principal.tokenId);
    if (!row) throw notFound("Feedback draft");
    if (row.status === "editing" && row.expires_at <= new Date().toISOString()) {
      const now = new Date().toISOString();
      this.database.connection.prepare("UPDATE feedback_drafts SET status = 'expired', updated_at = ? WHERE id = ?")
        .run(now, row.id);
      return this.mapFeedbackDraft({ ...row, status: "expired", updated_at: now });
    }
    return this.mapFeedbackDraft(row);
  }

  finalizeFeedbackDraft(
    draftId: string,
    principal: SdkPrincipal,
    workItemStatus: "inbox" | "ready" = "inbox",
  ): FeedbackDraftSnapshot {
    return this.database.transaction(() => {
      const row = this.getFeedbackDraftRow(draftId, principal.tokenId);
      if (!row) throw notFound("Feedback draft");
      if (row.status === "submitted") return this.mapFeedbackDraft(row);
      const now = new Date().toISOString();
      if (row.status === "expired" || row.expires_at <= now) {
        this.database.connection.prepare("UPDATE feedback_drafts SET status = 'expired', updated_at = ? WHERE id = ?")
          .run(now, row.id);
        throw conflict("draft_expired", "This feedback draft has expired.");
      }
      const title = requiredText(row.title, "Title");
      const environment = JSON.parse(row.environment_json) as WorkItemEnvironment;
      const itemId = randomUUID();
      const itemKey = this.insertWorkItem(
        {
          productId: row.product_id,
          ...(row.source_component_id ? {
            sourceComponentId: row.source_component_id,
            affectedComponentIds: [row.source_component_id],
          } : {}),
          type: row.type,
          priority: row.priority,
          title,
          description: row.description,
          environment,
          status: workItemStatus,
        },
        title,
        row.description,
        itemId,
        now,
        {
          type: row.type,
          source: "android_sdk",
          feedbackDraftId: row.id,
          context: JSON.parse(row.context_json) as Readonly<Record<string, string>>,
          logs: JSON.parse(row.logs_json) as readonly FeedbackLogEntry[],
        },
      );
      this.database.connection
        .prepare("UPDATE feedback_drafts SET status = 'submitted', submitted_item_id = ?, updated_at = ? WHERE id = ?")
        .run(itemId, now, row.id);
      return this.mapFeedbackDraft(this.getFeedbackDraftRow(row.id, principal.tokenId)!, itemKey);
    });
  }

  createFeedbackWebSession(draftId: string, principal: SdkPrincipal): FeedbackWebSession {
    const draft = this.getFeedbackDraft(draftId, principal);
    if (draft.status !== "editing") {
      throw conflict("draft_not_editable", "Only an active feedback draft can open an editing session.");
    }
    const now = new Date().toISOString();
    const expiresAt = new Date(Date.parse(now) + 15 * 60 * 1_000).toISOString();
    const token = `mg_ws_${randomBytes(32).toString("base64url")}`;
    this.database.connection
      .prepare(
        `INSERT INTO feedback_web_sessions
           (id, token_hash, access_token_id, draft_id, expires_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(randomUUID(), sdkTokenHash(token), principal.tokenId, draftId, expiresAt, now);
    return { token, expiresAt };
  }

  authenticateFeedbackWebSession(token: string, draftId: string): SdkPrincipal | undefined {
    if (!/^mg_ws_[A-Za-z0-9_-]{43}$/.test(token)) return undefined;
    const now = new Date().toISOString();
    const row = this.database.connection
      .prepare(
        `SELECT a.id AS token_id, a.product_id, a.platform, a.source_component_id,
                a.expires_at AS token_expires_at, a.revoked_at
         FROM feedback_web_sessions s
         JOIN access_tokens a ON a.id = s.access_token_id
         WHERE s.token_hash = ? AND s.draft_id = ? AND s.expires_at > ? AND a.kind = 'sdk'`,
      )
      .get(sdkTokenHash(token), draftId, now) as unknown as {
        token_id: string;
        product_id: string;
        platform: "android";
        source_component_id: string | null;
        token_expires_at: string | null;
        revoked_at: string | null;
      } | undefined;
    if (!row || row.revoked_at || (row.token_expires_at && row.token_expires_at <= now)) return undefined;
    return {
      tokenId: row.token_id,
      productId: row.product_id,
      platform: row.platform,
      ...(row.source_component_id ? { sourceComponentId: row.source_component_id } : {}),
    };
  }

  consumeSdkRateLimit(
    principal: SdkPrincipal,
    bucket: string,
    limit: number,
    windowMilliseconds: number,
  ): { readonly limit: number; readonly remaining: number; readonly resetAt: string } {
    if (!/^[a-z_]{1,50}$/.test(bucket)) throw invalidInput("Rate-limit bucket is invalid.");
    if (!Number.isSafeInteger(limit) || limit < 1 || !Number.isSafeInteger(windowMilliseconds) || windowMilliseconds < 1_000) {
      throw invalidInput("Rate-limit configuration is invalid.");
    }
    const now = Date.now();
    return this.database.transaction(() => {
      const current = this.database.connection
        .prepare(
          `SELECT window_started_at_ms, request_count
           FROM sdk_rate_limits WHERE access_token_id = ? AND bucket = ?`,
        )
        .get(principal.tokenId, bucket) as unknown as { window_started_at_ms: number; request_count: number } | undefined;
      const startsNewWindow = !current || now - current.window_started_at_ms >= windowMilliseconds;
      const windowStartedAt = startsNewWindow ? now : current.window_started_at_ms;
      const requestCount = startsNewWindow ? 0 : current.request_count;
      if (requestCount >= limit) {
        throw new MissionGoError("rate_limit_exceeded", "The SDK request limit has been reached. Please retry later.", 429);
      }
      const nextCount = requestCount + 1;
      this.database.connection
        .prepare(
          `INSERT INTO sdk_rate_limits (access_token_id, bucket, window_started_at_ms, request_count)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(access_token_id, bucket) DO UPDATE SET
             window_started_at_ms = excluded.window_started_at_ms,
             request_count = excluded.request_count`,
        )
        .run(principal.tokenId, bucket, windowStartedAt, nextCount);
      return {
        limit,
        remaining: limit - nextCount,
        resetAt: new Date(windowStartedAt + windowMilliseconds).toISOString(),
      };
    });
  }

  createWorkItem(input: CreateWorkItemInput): WorkItemSnapshot {
    const title = requiredText(input.title, "Title");
    const description = input.description.trim();
    if (description.length > 20_000) throw invalidInput("Description must be 20,000 characters or fewer.");
    if (input.status !== undefined && !isOneOf(input.status, ["inbox", "ready"] as const)) {
      throw invalidInput("A work item can only be created as a draft or ready for processing.");
    }
    if (input.status === "ready" && !input.environment) {
      throw invalidInput("environment.platform is required when submitting an item for processing.");
    }
    if (!isOneOf(input.type, WORK_ITEM_TYPES)) throw invalidInput(`Unsupported work-item type: ${String(input.type)}.`);
    if (!isOneOf(input.priority, WORK_ITEM_PRIORITIES)) {
      throw invalidInput(`Unsupported priority: ${String(input.priority)}.`);
    }

    const now = new Date().toISOString();
    const id = randomUUID();
    const itemKey = this.database.transaction(() => this.insertWorkItem(input, title, description, id, now, {
      type: input.type,
    }));

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
    const search = input.search?.trim();
    if (search) {
      if (search.length > 200) throw invalidInput("search must be 200 characters or fewer.");
      const escaped = `%${search.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_")}%`;
      clauses.push("(item_key LIKE ? ESCAPE '\\' OR title LIKE ? ESCAPE '\\' OR description LIKE ? ESCAPE '\\' OR report_json LIKE ? ESCAPE '\\')");
      values.push(escaped, escaped, escaped, escaped);
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

  getWorkItemListSummary(productId: string): WorkItemListSummary {
    this.getProduct(productId);
    const rows = this.database.connection
      .prepare("SELECT status, COUNT(*) AS count FROM work_items WHERE product_id = ? GROUP BY status")
      .all(productId) as unknown as Array<{ status: WorkItemStatus; count: number }>;
    const byStatus = Object.fromEntries(WORK_ITEM_STATUSES.map((status) => [status, 0])) as Record<WorkItemStatus, number>;
    for (const row of rows) byStatus[row.status] = row.count;
    return {
      total: Object.values(byStatus).reduce((sum, count) => sum + count, 0),
      byStatus,
    };
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
    if (input.sourceComponentId) this.assertComponentsBelongToProduct(current.product_id, [input.sourceComponentId]);
    if (input.type && !isOneOf(input.type, WORK_ITEM_TYPES)) throw invalidInput("Unsupported work-item type.");
    if (input.priority && !isOneOf(input.priority, WORK_ITEM_PRIORITIES)) throw invalidInput("Unsupported priority.");
    const report = input.report !== undefined
      ? this.validateWorkItemReport(input.report)
      : input.description !== undefined && current.report_json
        ? { ...parseReport(current.report_json)!, overview: input.description.trim() }
        : undefined;

    const fields: string[] = [];
    const values: SQLInputValue[] = [];
    if (input.title !== undefined) {
      fields.push("title = ?");
      values.push(requiredText(input.title, "Title"));
    }
    if (input.description !== undefined) {
      if (input.description.trim().length > 20_000) throw invalidInput("Description must be 20,000 characters or fewer.");
      fields.push("description = ?");
      values.push(input.description.trim());
    }
    if (report !== undefined) {
      fields.push("report_json = ?");
      values.push(JSON.stringify(report));
    }
    if (input.type !== undefined) {
      fields.push("type = ?");
      values.push(input.type);
    }
    if (input.priority !== undefined) {
      fields.push("priority = ?");
      values.push(input.priority);
    }
    if (input.sourceComponentId !== undefined) {
      fields.push("source_component_id = ?");
      values.push(input.sourceComponentId);
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
    const feedbackIdempotencyFields = [input.feedbackDraftId, input.clientAttachmentId, input.contentSha256];
    if (feedbackIdempotencyFields.some((value) => value !== undefined) && feedbackIdempotencyFields.some((value) => value === undefined)) {
      throw invalidInput("Feedback attachment idempotency fields must be provided together.");
    }
    if (input.clientAttachmentId && !/^[A-Za-z0-9_-]{8,100}$/.test(input.clientAttachmentId)) {
      throw invalidInput("Client attachment ID must contain 8-100 URL-safe characters.");
    }

    const count = this.database.connection
      .prepare("SELECT COUNT(*) AS count FROM work_item_attachments WHERE item_id = ?")
      .get(item.id) as unknown as { count: number };
    if (count.count >= 10) throw conflict("attachment_limit_reached", "A work item can have at most 10 attachments.");

    const id = randomUUID();
    const now = new Date().toISOString();
    this.database.transaction(() => {
      const counter = this.database.connection
        .prepare(
          `INSERT INTO work_item_attachment_counters (item_id, kind, next_number)
           VALUES (?, ?, 2)
           ON CONFLICT (item_id, kind) DO UPDATE SET next_number = next_number + 1
           RETURNING next_number - 1 AS display_number`,
        )
        .get(item.id, input.kind) as unknown as { display_number: number };
      const displayNumber = counter.display_number;
      this.database.connection
        .prepare(
          `INSERT INTO work_item_attachments
             (id, item_id, kind, display_number, original_filename, storage_filename, content_type, size_bytes, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          item.id,
          input.kind,
          displayNumber,
          input.filename,
          input.storageFilename,
          input.contentType,
          input.sizeBytes,
          now,
        );
      if (input.feedbackDraftId && input.clientAttachmentId && input.contentSha256) {
        this.database.connection
          .prepare(
            `INSERT INTO feedback_attachment_uploads
               (draft_id, client_attachment_id, attachment_id, content_sha256, created_at)
             VALUES (?, ?, ?, ?, ?)`,
          )
          .run(input.feedbackDraftId, input.clientAttachmentId, id, input.contentSha256, now);
      }
      this.database.connection.prepare("UPDATE work_items SET updated_at = ? WHERE id = ?").run(now, item.id);
      this.insertEvent(item.id, "attachment_added", "human", null, null, {
        attachmentId: id,
        kind: input.kind,
        displayNumber,
        filename: input.filename,
        contentType: input.contentType,
        sizeBytes: input.sizeBytes,
      }, now);
    });
    return this.getAttachmentRecord(input.itemKey, id);
  }

  getFeedbackAttachmentUpload(
    draftId: string,
    clientAttachmentId: string,
  ): { readonly attachment: AttachmentRecord; readonly contentSha256: string } | undefined {
    const row = this.database.connection
      .prepare(
        `SELECT a.id, w.item_key, a.kind, a.display_number, a.original_filename, a.storage_filename,
                a.content_type, a.size_bytes, a.created_at, u.content_sha256
         FROM feedback_attachment_uploads u
         JOIN work_item_attachments a ON a.id = u.attachment_id
         JOIN work_items w ON w.id = a.item_id
         WHERE u.draft_id = ? AND u.client_attachment_id = ?`,
      )
      .get(draftId, clientAttachmentId) as unknown as (AttachmentRow & { content_sha256: string }) | undefined;
    return row ? { attachment: this.mapAttachment(row), contentSha256: row.content_sha256 } : undefined;
  }

  listAttachments(itemKey: string): readonly AttachmentRecord[] {
    const item = this.getWorkItemRow(itemKey);
    if (!item) throw notFound("Work item");
    return this.listAttachmentsByItemId(item.id);
  }

  getAttachmentRecord(itemKey: string, attachmentId: string): AttachmentRecord {
    const row = this.database.connection
      .prepare(
        `SELECT a.id, w.item_key, a.kind, a.display_number, a.original_filename, a.storage_filename,
                a.content_type, a.size_bytes, a.created_at
         FROM work_item_attachments a
         JOIN work_items w ON w.id = a.item_id
         WHERE w.item_key = ? AND a.id = ?`,
      )
      .get(itemKey, attachmentId) as unknown as AttachmentRow | undefined;
    if (!row) throw notFound("Attachment");
    return this.mapAttachment(row);
  }

  deleteAttachmentMetadata(itemKey: string, attachmentId: string): AttachmentRecord {
    const attachment = this.getAttachmentRecord(itemKey, attachmentId);
    const item = this.getWorkItemRow(itemKey)!;
    const now = new Date().toISOString();
    this.database.transaction(() => {
      this.database.connection.prepare("DELETE FROM work_item_attachments WHERE id = ? AND item_id = ?").run(attachmentId, item.id);
      this.database.connection.prepare("UPDATE work_items SET updated_at = ? WHERE id = ?").run(now, item.id);
      this.insertEvent(item.id, "attachment_removed", "human", null, null, {
        attachmentId,
        kind: attachment.kind,
        filename: attachment.filename,
      }, now);
    });
    return attachment;
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

  private insertWorkItem(
    input: CreateWorkItemInput,
    title: string,
    description: string,
    id: string,
    now: string,
    createdPayload: Readonly<Record<string, unknown>>,
  ): string {
    const status = input.status ?? "inbox";
    const affectedComponentIds = [...new Set(input.affectedComponentIds ?? [])];
    const report = this.validateWorkItemReport(input.report ?? { overview: description });
    const product = this.getProductRow(input.productId);
    if (!product) throw notFound("Product");
    this.assertComponentsBelongToProduct(
      input.productId,
      input.sourceComponentId ? [input.sourceComponentId, ...affectedComponentIds] : affectedComponentIds,
    );
    if (input.sourceComponentId && input.environment && this.getComponent(input.sourceComponentId).kind !== input.environment.platform) {
      throw invalidInput("The source module must belong to the selected platform.");
    }

    const key = createWorkItemKey(product.key_prefix, product.next_item_sequence);
    this.database.connection
      .prepare("UPDATE products SET next_item_sequence = next_item_sequence + 1, updated_at = ? WHERE id = ?")
      .run(now, input.productId);
    this.database.connection
      .prepare(
        `INSERT INTO work_items (
           id, item_key, sequence, product_id, source_component_id, area_id,
           type, priority, status, title, description, report_json, environment_json, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
        status,
        title,
        description,
        JSON.stringify(report),
        input.environment ? JSON.stringify(input.environment) : null,
        now,
        now,
      );

    const insertAffected = this.database.connection.prepare(
      "INSERT INTO work_item_affected_components (item_id, component_id) VALUES (?, ?)",
    );
    for (const componentId of affectedComponentIds) insertAffected.run(id, componentId);
    this.insertEvent(id, "item_created", "human", null, status, createdPayload, now);
    return key;
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

  private getSdkToken(tokenId: string): SdkTokenSnapshot {
    const row = this.database.connection
      .prepare(
        `SELECT id, name, token_hash, product_id, platform, source_component_id,
                expires_at, revoked_at, last_used_at, created_at
         FROM access_tokens WHERE kind = 'sdk' AND id = ?`,
      )
      .get(tokenId) as unknown as SdkTokenRow | undefined;
    if (!row) throw notFound("SDK token");
    return this.mapSdkToken(row);
  }

  private getFeedbackDraftRow(draftId: string, tokenId: string): FeedbackDraftRow | undefined {
    return this.database.connection
      .prepare(
        `SELECT d.id, d.client_draft_id, d.product_id, d.source_component_id, d.status,
                d.type, d.priority, d.title, d.description, d.environment_json,
                d.context_json, d.logs_json, w.item_key, d.expires_at, d.created_at, d.updated_at
         FROM feedback_drafts d
         LEFT JOIN work_items w ON w.id = d.submitted_item_id
         WHERE d.id = ? AND d.access_token_id = ?`,
      )
      .get(draftId, tokenId) as unknown as FeedbackDraftRow | undefined;
  }

  private getFeedbackDraftRowByClientId(tokenId: string, clientDraftId: string): FeedbackDraftRow | undefined {
    return this.database.connection
      .prepare(
        `SELECT d.id, d.client_draft_id, d.product_id, d.source_component_id, d.status,
                d.type, d.priority, d.title, d.description, d.environment_json,
                d.context_json, d.logs_json, w.item_key, d.expires_at, d.created_at, d.updated_at
         FROM feedback_drafts d
         LEFT JOIN work_items w ON w.id = d.submitted_item_id
         WHERE d.access_token_id = ? AND d.client_draft_id = ?`,
      )
      .get(tokenId, clientDraftId) as unknown as FeedbackDraftRow | undefined;
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
        `SELECT a.id, w.item_key, a.kind, a.display_number, a.original_filename, a.storage_filename,
                a.content_type, a.size_bytes, a.created_at
         FROM work_item_attachments a
         JOIN work_items w ON w.id = a.item_id
         WHERE a.item_id = ?
         ORDER BY a.created_at, a.rowid`,
      )
      .all(itemId) as unknown as AttachmentRow[];
    return rows.map((row) => this.mapAttachment(row));
  }

  private getDiagnosticSummary(itemId: string, attachments: readonly AttachmentRecord[]): WorkItemSnapshot["diagnosticSummary"] {
    const createdEvent = this.database.connection
      .prepare(
        `SELECT payload_json FROM work_item_events
         WHERE item_id = ? AND event_type = 'item_created'
         ORDER BY created_at, rowid LIMIT 1`,
      )
      .get(itemId) as unknown as { payload_json: string } | undefined;
    let structuredLogCount = 0;
    let contextEntryCount = 0;
    if (createdEvent) {
      try {
        const payload = JSON.parse(createdEvent.payload_json) as Record<string, unknown>;
        structuredLogCount = Array.isArray(payload.logs) ? payload.logs.length : 0;
        contextEntryCount = payload.context && typeof payload.context === "object" && !Array.isArray(payload.context)
          ? Object.keys(payload.context).length
          : 0;
      } catch {
        // Historical event payloads are untrusted; an invalid payload contributes no summary counts.
      }
    }
    return {
      logCount: structuredLogCount + attachments.filter((attachment) => attachment.kind === "log").length,
      contextEntryCount,
    };
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

  private mapSdkToken(row: SdkTokenRow): SdkTokenSnapshot {
    return {
      id: row.id,
      name: row.name,
      productId: row.product_id,
      platform: row.platform,
      ...(row.source_component_id ? { sourceComponentId: row.source_component_id } : {}),
      ...(row.expires_at ? { expiresAt: row.expires_at } : {}),
      ...(row.revoked_at ? { revokedAt: row.revoked_at } : {}),
      ...(row.last_used_at ? { lastUsedAt: row.last_used_at } : {}),
      createdAt: row.created_at,
    };
  }

  private mapFeedbackDraft(row: FeedbackDraftRow, itemKey?: string): FeedbackDraftSnapshot {
    return {
      id: row.id,
      clientDraftId: row.client_draft_id,
      productId: row.product_id,
      ...(row.source_component_id ? { sourceComponentId: row.source_component_id } : {}),
      status: row.status,
      type: row.type,
      priority: row.priority,
      title: row.title,
      description: row.description,
      environment: JSON.parse(row.environment_json) as WorkItemEnvironment,
      context: JSON.parse(row.context_json) as Readonly<Record<string, string>>,
      logs: JSON.parse(row.logs_json) as readonly FeedbackLogEntry[],
      ...(itemKey || row.item_key ? { itemKey: itemKey ?? row.item_key! } : {}),
      expiresAt: row.expires_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private validateFeedbackStringMap(
    value: Readonly<Record<string, string>>,
    field: string,
    maxEntries: number,
    maxValueLength: number,
  ): Readonly<Record<string, string>> {
    const entries = Object.entries(value);
    if (entries.length > maxEntries) throw invalidInput(`${field} can contain at most ${maxEntries} entries.`);
    for (const [key, entry] of entries) {
      if (!key.trim() || key.length > 100 || typeof entry !== "string" || entry.length > maxValueLength) {
        throw invalidInput(`${field} contains an invalid key or value.`);
      }
    }
    return Object.fromEntries(entries);
  }

  private validateFeedbackLogs(value: readonly FeedbackLogEntry[]): readonly FeedbackLogEntry[] {
    if (value.length > 500) throw invalidInput("Logs can contain at most 500 entries.");
    let totalBytes = 0;
    const logs = value.map((entry) => {
      if (!isOneOf(entry.level, ["debug", "info", "warn", "error"] as const)) {
        throw invalidInput("A log entry has an unsupported level.");
      }
      if (Number.isNaN(Date.parse(entry.timestamp))) throw invalidInput("A log entry has an invalid timestamp.");
      const message = requiredText(entry.message, "Log message");
      if (message.length > 4_000) throw invalidInput("Log messages must be 4,000 characters or fewer.");
      const attributes = entry.attributes
        ? this.validateFeedbackStringMap(entry.attributes, "Log attributes", 20, 1_000)
        : undefined;
      const normalized = { timestamp: new Date(entry.timestamp).toISOString(), level: entry.level, message, ...(attributes ? { attributes } : {}) };
      totalBytes += Buffer.byteLength(JSON.stringify(normalized), "utf8");
      return normalized;
    });
    if (totalBytes > 256 * 1024) throw invalidInput("Logs must be 256 KiB or smaller.");
    return logs;
  }

  private validateWorkItemReport(value: WorkItemReport): WorkItemReport {
    const normalize = (text: string | undefined, field: string, maxLength: number): string | undefined => {
      const normalized = text?.trim();
      if (normalized && normalized.length > maxLength) {
        throw invalidInput(`${field} must be ${maxLength.toLocaleString("en-US")} characters or fewer.`);
      }
      return normalized || undefined;
    };
    const overview = normalize(value.overview, "Report overview", 20_000) ?? "";
    const reproductionSteps = normalize(value.reproductionSteps, "Reproduction steps", 20_000);
    const expectedOutcome = normalize(value.expectedOutcome, "Expected outcome", 20_000);
    const impact = normalize(value.impact, "Impact", 10_000);
    if (value.occurrenceFrequency !== undefined && !isOneOf(value.occurrenceFrequency, WORK_ITEM_OCCURRENCE_FREQUENCIES)) {
      throw invalidInput("Unsupported occurrence frequency.");
    }
    return {
      overview,
      ...(reproductionSteps ? { reproductionSteps } : {}),
      ...(expectedOutcome ? { expectedOutcome } : {}),
      ...(impact ? { impact } : {}),
      ...(value.occurrenceFrequency && value.occurrenceFrequency !== "unknown"
        ? { occurrenceFrequency: value.occurrenceFrequency }
        : {}),
    };
  }

  private mapAttachment(row: AttachmentRow): AttachmentRecord {
    return {
      id: row.id,
      itemKey: row.item_key,
      kind: row.kind,
      displayNumber: row.display_number,
      filename: row.original_filename,
      storageFilename: row.storage_filename,
      contentType: row.content_type,
      sizeBytes: row.size_bytes,
      createdAt: row.created_at,
    };
  }

  private mapWorkItem(row: WorkItemRow): WorkItemSnapshot {
    const environment = parseEnvironment(row.environment_json);
    const report = parseReport(row.report_json);
    const attachments = this.listAttachmentsByItemId(row.id);
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
      ...(report ? { report } : {}),
      diagnosticSummary: this.getDiagnosticSummary(row.id, attachments),
      ...(environment ? { environment } : {}),
      attachments: attachments.map(({ storageFilename: _, ...attachment }) => attachment),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}
