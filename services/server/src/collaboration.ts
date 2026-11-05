import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import type {
  ActorKind,
  WorkItemEnvironment,
  WorkItemReport,
  WorkItemSnapshot,
  WorkItemStatus,
} from "@missiongo/domain";
import { AccountStore, type AccountSnapshot } from "./accounts-store.js";
import type { MissionGoStore } from "./store.js";
import { conflict, invalidInput, notFound, MissionGoError } from "./errors.js";
import {
  assertCollaborationAcyclic,
  collaborationBlockers,
  collaborationLinkedRead,
} from "./collaboration-policy.js";
import { enqueuePersonalNotification } from "./personal-notifications.js";

const text = z.string().trim().min(1);
const occurrenceFrequency = z.enum(["unknown", "once", "intermittent", "frequent", "always"]);
// AND-406: the request carries the same report and environment a normal
// creation does, so the target item does not lose what the sender filled in.
export const collaborationReportSchema = z.object({
  overview: z.string().trim().min(1).max(20000),
  reproductionSteps: z.string().trim().max(20000).optional(),
  expectedOutcome: z.string().trim().max(20000).optional(),
  impact: z.string().trim().max(10000).optional(),
  occurrenceFrequency: occurrenceFrequency.optional(),
});
export const collaborationEnvironmentSchema = z.object({
  platform: z.enum(["android", "macos", "web", "server", "shared", "other"]),
  appVersion: z.string().trim().max(500).optional(),
  buildNumber: z.string().trim().max(500).optional(),
  sourceRevision: z.string().trim().max(500).optional(),
  osVersion: z.string().trim().max(500).optional(),
  deviceModel: z.string().trim().max(500).optional(),
  metadata: z.record(z.string().trim().min(1).max(100), z.string().max(2000)).optional(),
});
export const collaborationDraftSchema = z.object({
  grantId: text.max(100),
  title: text.max(300),
  description: text.max(20000),
  acceptance: text.max(10000),
  type: z.enum(["bug", "requirement"]).default("requirement"),
  priority: z.enum(["urgent", "high", "normal", "low"]).default("normal"),
  // Kept for old drafts and the MCP draft path; new requests read the source
  // item directly and no longer copy selected attachments.
  attachmentIds: z.array(text.max(100)).max(10).default([]),
  report: collaborationReportSchema.optional(),
  environment: collaborationEnvironmentSchema.optional(),
});
export type CollaborationDraftInput = z.infer<typeof collaborationDraftSchema>;
export const collaborationGrantSchema = z.object({
  sourceProductId: text.max(100),
  moduleId: z.string().max(100).default(""),
  builderAccountId: z.string().max(100).nullable().default(null),
  enabled: z.boolean().default(true),
  expectedRevision: z.number().int().nonnegative(),
});
export type CollaborationGrantInput = z.infer<typeof collaborationGrantSchema>;
export interface Grant {
  id: string;
  source_product_id: string;
  target_product_id: string;
  module_id: string;
  builder_account_id: string | null;
  enabled: number;
  revision: number;
}
interface Draft {
  id: string;
  source_item_id: string;
  grant_id: string;
  payload_json: string;
  version: number;
  created_by: string;
  actor_kind: ActorKind;
  agent_name: string | null;
  invalidated_at: string | null;
  submitted_request_id: string | null;
}
export interface CollaborationRow {
  id: string;
  source_item_id: string;
  target_item_id: string;
  grant_id: string;
  payload_json: string;
  verifier_account_id: string;
  approved_by: string;
  owner_account_id: string | null;
  created_at: string;
  withdrawn_at: string | null;
  withdrawal_reason: string | null;
  access_revoked_at: string | null;
  revision: number;
}
interface SharedAttachment {
  id: string;
  filename: string;
  revision?: string;
  sizeBytes: number;
  contentType: string;
}
interface Payload extends CollaborationDraftInput {
  attachments: SharedAttachment[];
}
const terminal = (s: string) => s === "done" || s === "cancelled";

/** Drop absent optional fields so the strict report type stays satisfied. */
function reportFromDraft(value: Payload["report"]): WorkItemReport | undefined {
  if (!value) return undefined;
  return {
    overview: value.overview,
    ...(value.reproductionSteps ? { reproductionSteps: value.reproductionSteps } : {}),
    ...(value.expectedOutcome ? { expectedOutcome: value.expectedOutcome } : {}),
    ...(value.impact ? { impact: value.impact } : {}),
    ...(value.occurrenceFrequency ? { occurrenceFrequency: value.occurrenceFrequency } : {}),
  };
}

function environmentFromDraft(
  value: Payload["environment"],
  fallback: WorkItemEnvironment["platform"],
): WorkItemEnvironment {
  if (!value) return { platform: fallback };
  return {
    platform: value.platform,
    ...(value.appVersion ? { appVersion: value.appVersion } : {}),
    ...(value.buildNumber ? { buildNumber: value.buildNumber } : {}),
    ...(value.sourceRevision ? { sourceRevision: value.sourceRevision } : {}),
    ...(value.osVersion ? { osVersion: value.osVersion } : {}),
    ...(value.deviceModel ? { deviceModel: value.deviceModel } : {}),
    ...(value.metadata && Object.keys(value.metadata).length > 0
      ? { metadata: value.metadata }
      : {}),
  };
}

export class Collaborations {
  readonly accounts: AccountStore;
  constructor(readonly store: MissionGoStore) {
    this.accounts = new AccountStore(store.database);
  }
  private get db() {
    return this.store.database.connection;
  }
  private account(id: string) {
    const a = this.accounts.findActive(id);
    if (!a) throw notFound("Account");
    return a;
  }
  private item(id: string) {
    const r = this.db
      .prepare("SELECT item_key FROM work_items WHERE id=?")
      .get(id) as { item_key: string } | undefined;
    if (!r) throw notFound("Work item");
    return this.store.getWorkItem(r.item_key);
  }
  private view(account: AccountSnapshot, productId: string) {
    if (!this.accounts.allows(account, productId, "view"))
      throw notFound("Product");
  }
  private manager(account: AccountSnapshot, productId: string) {
    this.view(account, productId);
    if (
      account.role !== "admin" &&
      !this.accounts.isProjectAdministrator(account, productId)
    )
      throw new MissionGoError(
        "collaboration_manager_required",
        "需要接收项目管理员权限。",
        403,
      );
  }
  private sourceBuilder(account: AccountSnapshot, item: WorkItemSnapshot) {
    this.view(account, item.productId);
    if (
      !this.accounts.allows(account, item.productId, "operate") ||
      (item.builderAccountId !== account.id &&
        account.role !== "admin" &&
        !this.accounts.isProjectAdministrator(account, item.productId))
    )
      throw new MissionGoError(
        "collaboration_builder_required",
        "需要原条目 Builder 或授权管理员处理。",
        403,
      );
    this.store.assertWorkItemWritable(item.key);
  }
  private assertSourceOpen(item: WorkItemSnapshot) {
    if (!["ready", "in_progress", "on_hold"].includes(item.status))
      throw conflict(
        "collaboration_source_stage",
        "请先将原条目退回处理，再建立必要依赖。",
      );
  }
  private grant(id: string) {
    const g = this.db
      .prepare("SELECT * FROM collaboration_grants WHERE id=?")
      .get(id) as unknown as Grant | undefined;
    if (!g) throw notFound("Collaboration grant");
    return g;
  }
  private activeGrant(id: string, source: WorkItemSnapshot) {
    const g = this.grant(id);
    if (g.source_product_id !== source.productId || !g.enabled)
      throw conflict(
        "collaboration_grant_disabled",
        "当前项目未获准向此目标提出请求。",
      );
    this.store.assertProductWritable(g.target_product_id);
    if (
      g.module_id &&
      !this.store
        .listComponents(g.target_product_id)
        .some((m) => m.id === g.module_id)
    )
      throw conflict("collaboration_module_unavailable", "接收模块已停用。");
    return g;
  }
  private draft(id: string) {
    const d = this.db
      .prepare("SELECT * FROM collaboration_drafts WHERE id=?")
      .get(id) as unknown as Draft | undefined;
    if (!d) throw notFound("Collaboration draft");
    return d;
  }
  private row(id: string) {
    const r = this.db
      .prepare("SELECT * FROM collaboration_requests WHERE id=?")
      .get(id) as unknown as CollaborationRow | undefined;
    if (!r) throw notFound("Collaboration");
    return r;
  }
  private authorized(id: string, accountId: string, allowRevoked = false) {
    const r = this.row(id),
      a = this.account(accountId),
      s = this.item(r.source_item_id),
      t = this.item(r.target_item_id);
    if (
      !this.accounts.allows(a, s.productId, "view") &&
      !this.accounts.allows(a, t.productId, "view")
    )
      throw notFound("Collaboration");
    if (r.access_revoked_at && !allowRevoked) throw notFound("Collaboration");
    return { r, a, s, t };
  }
  private command<T>(
    accountId: string,
    key: string,
    input: unknown,
    fn: () => T,
  ): T {
    this.account(accountId);
    if (!key.trim() || key.length > 200)
      throw invalidInput("Invalid command key.");
    return this.store.database.transaction(() => {
      const digest = createHash("sha256")
        .update(JSON.stringify(input))
        .digest("hex");
      const old = this.db
        .prepare(
          "SELECT digest,result_json FROM collaboration_receipts WHERE account_id=? AND command_key=?",
        )
        .get(accountId, key) as
        | { digest: string; result_json: string }
        | undefined;
      if (old) {
        if (old.digest !== digest)
          throw conflict("idempotency_conflict", "请求编号已用于不同内容。");
        return JSON.parse(old.result_json) as T;
      }
      const result = fn();
      this.db
        .prepare("INSERT INTO collaboration_receipts VALUES (?,?,?,?)")
        .run(accountId, key, digest, JSON.stringify(result));
      return result;
    });
  }
  private audit(
    kind: string,
    accountId: string,
    payload: unknown,
    requestId: string | null = null,
    draftId: string | null = null,
    actor: ActorKind = "human",
  ) {
    this.db
      .prepare("INSERT INTO collaboration_events VALUES (?,?,?,?,?,?,?,?)")
      .run(
        randomUUID(),
        requestId,
        draftId,
        kind,
        accountId,
        actor,
        JSON.stringify(payload),
        new Date().toISOString(),
      );
  }
  private notify(
    item: WorkItemSnapshot,
    note: string,
    accountId: string,
    kind: "decision" | "verification" = "decision",
    actor: ActorKind = "human",
    recipients: string[] = [],
  ) {
    const now = new Date().toISOString(),
      eventId = this.store.recordCollaborationEvent(
        item.id,
        { note },
        accountId,
        actor,
        now,
      );
    const fallback = this.accounts
      .listAccounts()
      .filter(
        (a) =>
          !a.disabledAt &&
          (a.role === "admin" ||
            this.accounts.isProjectAdministrator(a, item.productId)),
      )
      .map((a) => a.id);
    const ids = recipients.length
      ? recipients
      : item.builderAccountId
        ? [item.builderAccountId]
        : fallback;
    for (const id of new Set(ids))
      enqueuePersonalNotification(this.store.database, {
        itemId: item.id,
        productId: item.productId,
        accountId: id,
        kind,
        businessEventId: eventId,
        createdAt: now,
      });
  }
  private both(
    r: CollaborationRow,
    note: string,
    accountId: string,
    kind: "decision" | "verification" = "decision",
    actor: ActorKind = "human",
  ) {
    const s = this.item(r.source_item_id),
      t = this.item(r.target_item_id);
    this.notify(s, note, accountId, kind, actor, [
      r.verifier_account_id,
      ...(r.owner_account_id ? [r.owner_account_id] : []),
      ...(s.builderAccountId ? [s.builderAccountId] : []),
    ]);
    this.notify(t, note, accountId, kind, actor);
  }
  directory(accountId: string, productId: string) {
    this.manager(this.account(accountId), productId);
    return this.store
      .listProducts()
      .filter((p) => !p.archivedAt && p.id !== productId)
      .map((p) => ({ id: p.id, name: p.name }));
  }
  candidates(accountId: string, id: string) {
    const { r, a, s } = this.authorized(id, accountId);
    if (a.id !== r.verifier_account_id) this.manager(a, s.productId);
    const sources = (
      this.db
        .prepare(
          "SELECT DISTINCT s.product_id FROM collaboration_requests r JOIN work_items s ON s.id=r.source_item_id WHERE r.target_item_id=?",
        )
        .all(r.target_item_id) as { product_id: string }[]
    ).map((r) => r.product_id);
    return this.accounts
      .listAccounts()
      .filter(
        (a) =>
          !a.disabledAt &&
          sources.every((p) => this.accounts.allows(a, p, "view")),
      )
      .map((a) => ({ id: a.id, name: a.nickname || a.email.split("@")[0]! }));
  }
  grants(accountId: string, productId: string) {
    const a = this.account(accountId);
    this.view(a, productId);
    return (
      this.db
        .prepare(
          "SELECT * FROM collaboration_grants WHERE source_product_id=? OR target_product_id=?",
        )
        .all(productId, productId) as unknown as Grant[]
    ).map((g) => this.grantSnapshot(g));
  }
  private grantSnapshot(g: Grant) {
    return {
      id: g.id,
      sourceProductId: g.source_product_id,
      targetProductId: g.target_product_id,
      sourceName: this.store.getProduct(g.source_product_id).name,
      targetName: this.store.getProduct(g.target_product_id).name,
      moduleId: g.module_id,
      moduleName: g.module_id
        ? this.store
            .listComponents(g.target_product_id, { includeArchived: true })
            .find((m) => m.id === g.module_id)?.name
        : undefined,
      builderAccountId: g.builder_account_id,
      enabled: !!g.enabled,
      revision: g.revision,
    };
  }
  targets(accountId: string, itemKey: string) {
    const a = this.account(accountId),
      s = this.store.getWorkItem(itemKey);
    this.view(a, s.productId);
    return this.grants(accountId, s.productId).filter(
      (g) =>
        g.sourceProductId === s.productId &&
        g.enabled &&
        !this.store.getProduct(g.targetProductId).archivedAt,
    );
  }
  configure(
    accountId: string,
    targetProductId: string,
    input: CollaborationGrantInput,
  ) {
    return this.store.database.transaction(() => {
      const a = this.account(accountId);
      this.manager(a, targetProductId);
      this.store.assertProductWritable(targetProductId);
      this.store.getProduct(input.sourceProductId);
      if (input.sourceProductId === targetProductId)
        throw invalidInput("Choose another project.");
      if (
        input.moduleId &&
        !this.store
          .listComponents(targetProductId)
          .some((m) => m.id === input.moduleId)
      )
        throw invalidInput("Module is unavailable.");
      if (input.builderAccountId) {
        const b = this.account(input.builderAccountId);
        if (!this.accounts.allows(b, targetProductId, "operate"))
          throw invalidInput("Builder needs target operation permission.");
      }
      const old = this.db
        .prepare(
          "SELECT * FROM collaboration_grants WHERE source_product_id=? AND target_product_id=? AND module_id=?",
        )
        .get(
          input.sourceProductId,
          targetProductId,
          input.moduleId,
        ) as unknown as Grant | undefined;
      if ((old?.revision ?? 0) !== input.expectedRevision)
        throw conflict("collaboration_stale", "配置已更新，请刷新。");
      const id = old?.id ?? randomUUID();
      this.db
        .prepare(
          `INSERT INTO collaboration_grants(id,source_product_id,target_product_id,module_id,builder_account_id,enabled,revision,updated_by,updated_at)
      VALUES (?,?,?,?,?,?,1,?,?) ON CONFLICT(id) DO UPDATE SET builder_account_id=excluded.builder_account_id,enabled=excluded.enabled,revision=revision+1,updated_by=excluded.updated_by,updated_at=excluded.updated_at`,
        )
        .run(
          id,
          input.sourceProductId,
          targetProductId,
          input.moduleId,
          input.builderAccountId,
          Number(input.enabled),
          accountId,
          new Date().toISOString(),
        );
      this.audit("grant_changed", accountId, {
        before: old ?? null,
        after: input,
      });
      return this.grantSnapshot(this.grant(id));
    });
  }
  prepareCommand(
    accountId: string,
    itemKey: string,
    input: CollaborationDraftInput,
    key: string,
    actor: ActorKind = "human",
    agentName?: string,
    id?: string,
    version?: number,
  ) {
    this.sourceBuilder(
      this.account(accountId),
      this.store.getWorkItem(itemKey),
    );
    return this.command(
      accountId,
      key,
      { action: "prepare", itemKey, input, actor, agentName, id, version },
      () =>
        this.prepare(accountId, itemKey, input, actor, agentName, id, version),
    );
  }
  prepare(
    accountId: string,
    itemKey: string,
    input: CollaborationDraftInput,
    actor: ActorKind = "human",
    agentName?: string,
    id?: string,
    expectedVersion?: number,
  ) {
    return this.store.database.transaction(() => {
      input = collaborationDraftSchema.parse(input);
      const a = this.account(accountId),
        s = this.store.getWorkItem(itemKey);
      this.sourceBuilder(a, s);
      this.assertSourceOpen(s);
      this.activeGrant(input.grantId, s);
      if (new Set(input.attachmentIds).size !== input.attachmentIds.length)
        throw invalidInput("Duplicate attachment.");
      const hidden = this.store.getWithdrawnCommentAttachmentIds(s.key);
      const attachments = input.attachmentIds.map((id) => {
        const f = s.attachments.find((f) => f.id === id && !hidden.has(id));
        if (!f) throw notFound("Attachment");
        return {
          id: f.id,
          filename: f.filename,
          revision: f.revision,
          sizeBytes: f.sizeBytes,
          contentType: f.contentType,
        };
      });
      const old = id ? this.draft(id) : undefined;
      if (
        old &&
        (old.source_item_id !== s.id ||
          old.version !== expectedVersion ||
          old.invalidated_at ||
          old.submitted_request_id)
      )
        throw conflict("collaboration_stale", "草稿已更新或已提交，请刷新。");
      const draftId = id ?? randomUUID(),
        now = new Date().toISOString(),
        payload = { ...input, attachments };
      if (old)
        this.db
          .prepare(
            "UPDATE collaboration_drafts SET payload_json=?,grant_id=?,version=version+1,updated_at=? WHERE id=?",
          )
          .run(JSON.stringify(payload), input.grantId, now, draftId);
      else
        this.db
          .prepare(
            "INSERT INTO collaboration_drafts(id,source_item_id,grant_id,payload_json,created_by,actor_kind,agent_name,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)",
          )
          .run(
            draftId,
            s.id,
            input.grantId,
            JSON.stringify(payload),
            accountId,
            actor,
            agentName ?? null,
            now,
            now,
          );
      this.audit(
        "draft_prepared",
        accountId,
        { version: (old?.version ?? 0) + 1 },
        null,
        draftId,
        actor,
      );
      this.notify(
        s,
        "协作草稿等待人工审核；尚未建立交付依赖。",
        accountId,
        "decision",
        actor,
      );
      return { id: draftId, version: (old?.version ?? 0) + 1, ...payload };
    });
  }
  submit(accountId: string, draftId: string, version: number, key: string) {
    const a = this.account(accountId),
      d = this.draft(draftId);
    this.sourceBuilder(a, this.item(d.source_item_id));
    return this.command(
      accountId,
      key,
      { action: "submit", draftId, version },
      () => {
        const draft = this.draft(draftId),
          s = this.item(draft.source_item_id);
        this.sourceBuilder(a, s);
        this.assertSourceOpen(s);
        if (draft.invalidated_at || draft.version !== version)
          throw conflict(
            "collaboration_stale",
            "草稿版本已失效，请重新预览批准。",
          );
        if (draft.submitted_request_id) {
          const existing = this.row(draft.submitted_request_id);
          return {
            id: draft.submitted_request_id,
            targetKey: this.item(existing.target_item_id).key,
          };
        }
        const g = this.activeGrant(draft.grant_id, s),
          payload = JSON.parse(draft.payload_json) as Payload;
        for (const f of payload.attachments) {
          const current = s.attachments.find((x) => x.id === f.id);
          if (
            !current ||
            current.revision !== f.revision ||
            this.store.getWithdrawnCommentAttachmentIds(s.key).has(f.id)
          )
            throw conflict(
              "collaboration_evidence_changed",
              "共享附件已变化，请重新整理并批准。",
            );
        }
        const module = g.module_id
          ? this.store
              .listComponents(g.target_product_id)
              .find((m) => m.id === g.module_id)
          : undefined;
        const candidate =
            g.builder_account_id ?? module?.defaultBuilderAccountId,
          b = candidate ? this.accounts.findActive(candidate) : undefined;
        const builder =
          b && this.accounts.allows(b, g.target_product_id, "operate")
            ? b.id
            : undefined;
        const report = reportFromDraft(payload.report);
        const target = this.store.createWorkItem({
          productId: g.target_product_id,
          status: "ready",
          type: payload.type,
          priority: payload.priority,
          title: payload.title,
          description:
            payload.description + "\n\n验收标准\n" + payload.acceptance,
          ...(report ? { report } : {}),
          environment: environmentFromDraft(payload.environment, module?.kind ?? "shared"),
          ...(module ? { sourceComponentId: module.id } : {}),
          ...(builder ? { builderAccountId: builder } : {}),
          attribution: { accountId },
        });
        const id = this.insert(
          s,
          target,
          g,
          draft.payload_json,
          accountId,
          draftId,
          version,
        );
        this.db
          .prepare(
            "UPDATE collaboration_drafts SET submitted_request_id=? WHERE id=?",
          )
          .run(id, draftId);
        this.audit(
          "approved_and_submitted",
          accountId,
          { version, targetKey: target.key },
          id,
          draftId,
        );
        this.both(
          this.row(id),
          `协作请求已提交：${target.key}。由接收方安排处理，待验证时通知提需方验收。`,
          accountId,
        );
        return { id, targetKey: target.key };
      },
    );
  }
  private insert(
    s: WorkItemSnapshot,
    t: WorkItemSnapshot,
    g: Grant,
    payload: string,
    accountId: string,
    draftId: string | null,
    version: number,
  ) {
    assertCollaborationAcyclic(this.store.database, s.id, t.id);
    const existing = this.db
      .prepare(
        "SELECT verifier_account_id FROM collaboration_requests WHERE target_item_id=? LIMIT 1",
      )
      .get(t.id) as { verifier_account_id: string } | undefined;
    if (existing && existing.verifier_account_id !== accountId)
      throw conflict(
        "collaboration_verifier_conflict",
        "该条目已有不同验收人，请另建协作请求。",
      );
    if (
      this.db
        .prepare(
          "SELECT 1 FROM collaboration_requests WHERE source_item_id=? AND target_item_id=? AND withdrawn_at IS NULL",
        )
        .get(s.id, t.id)
    )
      throw conflict("collaboration_duplicate", "已存在此依赖。");
    const id = randomUUID();
    this.db
      .prepare(
        `INSERT INTO collaboration_requests(id,source_item_id,target_item_id,grant_id,draft_id,approved_version,payload_json,approved_by,verifier_account_id,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        id,
        s.id,
        t.id,
        g.id,
        draftId,
        version,
        payload,
        accountId,
        accountId,
        new Date().toISOString(),
      );
    return id;
  }
  private compatibleTarget(
    accountId: string,
    targetId: string,
    verifierId: string,
  ) {
    const rows = this.db
      .prepare(
        "SELECT * FROM collaboration_requests WHERE target_item_id=? AND verifier_account_id=? AND access_revoked_at IS NULL",
      )
      .all(targetId, verifierId) as unknown as CollaborationRow[];
    const match = rows.find((r) => {
      try {
        this.authorized(r.id, accountId);
        return true;
      } catch {
        return false;
      }
    });
    if (!match)
      throw conflict(
        "collaboration_existing_not_compatible",
        "只能关联可访问且验收人相同的协作条目；内部条目请另建请求。",
      );
    return match;
  }
  associate(
    accountId: string,
    sourceKey: string,
    targetKey: string,
    grantId: string,
    note: string,
    key: string,
  ) {
    return this.command(
      accountId,
      key,
      { action: "associate", sourceKey, targetKey, grantId, note },
      () => {
        const a = this.account(accountId),
          s = this.store.getWorkItem(sourceKey),
          t = this.store.getWorkItem(targetKey);
        this.sourceBuilder(a, s);
        this.assertSourceOpen(s);
        const compatible = this.compatibleTarget(accountId, t.id, accountId);
        this.store.assertWorkItemWritable(t.key);
        const g = this.activeGrant(grantId, s);
        if (
          t.productId !== g.target_product_id ||
          (g.module_id && g.module_id !== t.sourceComponentId)
        )
          throw invalidInput("Target does not match grant.");
        // Linking must never silently turn an internal task into an externally accepted one.
        if (
          !this.db
            .prepare(
              "SELECT 1 FROM collaboration_requests WHERE target_item_id=? AND verifier_account_id=?",
            )
            .get(t.id, accountId)
        )
          throw conflict(
            "collaboration_existing_not_compatible",
            "只能关联验收人相同的已有协作条目；内部条目请另建请求。",
          );
        const payload = JSON.parse(compatible.payload_json) as Payload;
        payload.attachments = [];
        payload.attachmentIds = [];
        const id = this.insert(
          s,
          t,
          g,
          JSON.stringify(payload),
          accountId,
          null,
          1,
        );
        this.audit("associated", accountId, { note }, id);
        this.both(this.row(id), `已关联协作 ${t.key}：${note}`, accountId);
        return { id };
      },
    );
  }
  context(accountId: string, itemKey: string) {
    const a = this.account(accountId),
      item = this.store.getWorkItem(itemKey);
    // AND-406: a linked reader of the source item is not a member of its
    // project. They see the relationships their own side already knows about,
    // never that project's unsubmitted drafts.
    const linkedRead =
      !this.accounts.allows(a, item.productId, "view") &&
      collaborationLinkedRead(this.store.database, item, a.id);
    if (!linkedRead) this.view(a, item.productId);
    const rows = (
      this.db
        .prepare(
          "SELECT * FROM collaboration_requests WHERE source_item_id=? OR target_item_id=? ORDER BY created_at",
        )
        .all(item.id, item.id) as unknown as CollaborationRow[]
    ).filter(
      (r) =>
        !linkedRead ||
        this.accounts.allows(a, this.item(r.target_item_id).productId, "view"),
    );
    const drafts = linkedRead
      ? []
      : (this.db
          .prepare(
            "SELECT * FROM collaboration_drafts WHERE source_item_id=? AND invalidated_at IS NULL AND submitted_request_id IS NULL",
          )
          .all(item.id) as unknown as Draft[]);
    return {
      blocked: collaborationBlockers(this.store.database, item.id) > 0,
      requests: rows.map((r) =>
        r.access_revoked_at
          ? {
              id: r.id,
              revision: r.revision,
              restricted: true,
              direction: r.source_item_id === item.id ? "outgoing" : "incoming",
              blocking:
                !r.withdrawn_at &&
                !terminal(this.item(r.target_item_id).status),
              canManageAccess:
                a.role === "admin" ||
                this.accounts.isProjectAdministrator(
                  a,
                  this.item(r.target_item_id).productId,
                ),
              canWithdraw:
                r.source_item_id === item.id && this.canWithdraw(a, item, r),
            }
          : {
              ...this.summary(r),
              direction: r.source_item_id === item.id ? "outgoing" : "incoming",
            },
      ),
      drafts: drafts.map((d) => ({
        id: d.id,
        version: d.version,
        ...JSON.parse(d.payload_json),
        actorKind: d.actor_kind,
        agentName: d.agent_name,
      })),
      canRequest: this.canRequest(a, item),
    };
  }
  private canWithdraw(
    a: AccountSnapshot,
    s: WorkItemSnapshot,
    r: CollaborationRow,
  ) {
    try {
      if (a.id !== r.owner_account_id) this.sourceBuilder(a, s);
      return true;
    } catch {
      return false;
    }
  }
  private canRequest(a: AccountSnapshot, s: WorkItemSnapshot) {
    try {
      this.sourceBuilder(a, s);
      this.assertSourceOpen(s);
      return true;
    } catch {
      return false;
    }
  }
  private summary(r: CollaborationRow) {
    const s = this.item(r.source_item_id),
      t = this.item(r.target_item_id),
      names = this.accounts.displayNames([r.verifier_account_id]);
    return {
      id: r.id,
      revision: r.revision,
      sourceKey: s.key,
      targetKey: t.key,
      targetTitle: (JSON.parse(r.payload_json) as Payload).title,
      targetProductName: this.store.getProduct(t.productId).name,
      sourceProductName: this.store.getProduct(s.productId).name,
      status: t.status,
      builderName: t.builderName ?? "",
      verifierName: names.get(r.verifier_account_id) ?? "",
      verifierAccountId: r.verifier_account_id,
      withdrawn: !!r.withdrawn_at,
      blocking: !r.withdrawn_at && !terminal(t.status),
    };
  }
  detail(accountId: string, id: string) {
    const { r, a, s, t } = this.authorized(id, accountId),
      payload = JSON.parse(r.payload_json) as Payload;
    return {
      ...this.summary(r),
      request: payload,
      targetRevision: t.revision,
      canVerify:
        a.id === r.verifier_account_id &&
        t.status === "pending_verification" &&
        !collaborationBlockers(this.store.database, t.id),
      canTransferVerifier:
        a.id === r.verifier_account_id ||
        a.role === "admin" ||
        this.accounts.isProjectAdministrator(a, s.productId),
      canManageAccess:
        a.role === "admin" ||
        this.accounts.isProjectAdministrator(a, t.productId),
      canDiscuss: this.canDiscuss(a, s, t, r, "human"),
      canDeliver:
        this.accounts.allows(a, t.productId, "operate") &&
        (a.id === t.builderAccountId ||
          a.role === "admin" ||
          this.accounts.isProjectAdministrator(a, t.productId)),
      canWithdraw: this.canWithdraw(a, s, r),
      events: this.db
        .prepare(
          "SELECT id,kind,actor_id AS actorId,actor_kind AS actorKind,payload_json,created_at AS createdAt FROM collaboration_events WHERE request_id=? ORDER BY rowid",
        )
        .all(id)
        .map((row) => ({
          ...row,
          payload: JSON.parse(row.payload_json as string),
          actorName:
            this.accounts
              .displayNames([row.actorId as string])
              .get(row.actorId as string) ?? "",
          payload_json: undefined,
        })),
    };
  }
  withdraw(
    accountId: string,
    id: string,
    revision: number,
    note: string,
    key: string,
  ) {
    this.authorized(id, accountId, true);
    return this.command(
      accountId,
      key,
      { action: "withdraw", id, revision, note },
      () => {
        const { r, a, s } = this.authorized(id, accountId, true);
        if (r.owner_account_id !== accountId) this.sourceBuilder(a, s);
        if (r.revision !== revision)
          throw conflict("collaboration_stale", "依赖已变化，请刷新。");
        this.db
          .prepare(
            "UPDATE collaboration_requests SET withdrawn_at=?,withdrawal_reason=?,revision=revision+1 WHERE id=?",
          )
          .run(new Date().toISOString(), note, id);
        this.audit("withdrawn", accountId, { note }, id);
        this.both(
          r,
          `提需方撤回依赖：${note}。接收条目由接收方决定后续处理。`,
          accountId,
        );
        return { id };
      },
    );
  }
  verify(
    accountId: string,
    id: string,
    revision: number,
    targetRevision: number,
    passed: boolean,
    note: string,
    key: string,
  ) {
    this.authorized(id, accountId);
    return this.command(
      accountId,
      key,
      { action: "verify", id, revision, targetRevision, passed, note },
      () => {
        const { r, t } = this.authorized(id, accountId);
        if (r.verifier_account_id !== accountId)
          throw new MissionGoError(
            "collaboration_verifier_required",
            "仅指定提需方人工验收人可验收。",
            403,
          );
        if (r.revision !== revision || t.status !== "pending_verification")
          throw conflict("collaboration_stale", "验收对象已变化，请刷新。");
        this.store.transitionWorkItem({
          itemKey: t.key,
          to: passed ? "done" : "ready",
          actor: "human",
          reason: passed ? "verification_passed" : "verification_failed",
          note,
          expectedRevision: targetRevision,
          expectedStatus: "pending_verification",
          attribution: { accountId },
        });
        return { id };
      },
    );
  }
  private canDiscuss(
    a: AccountSnapshot,
    s: WorkItemSnapshot,
    t: WorkItemSnapshot,
    r: CollaborationRow,
    actor: ActorKind,
  ) {
    return (
      this.accounts.allows(a, s.productId, "operate") ||
      this.accounts.allows(a, t.productId, "operate") ||
      (actor === "human" &&
        a.id === r.verifier_account_id &&
        this.accounts.allows(a, s.productId, "view"))
    );
  }
  discuss(
    accountId: string,
    id: string,
    note: string,
    key: string,
    actor: ActorKind = "human",
    delivery = false,
  ) {
    this.authorized(id, accountId);
    return this.command(
      accountId,
      key,
      { action: "discuss", id, note, actor, delivery },
      () => {
        const { r, a, s, t } = this.authorized(id, accountId);
        if (!this.canDiscuss(a, s, t, r, actor))
          throw new MissionGoError(
            "collaboration_comment_forbidden",
            "当前账号没有协作讨论权限。",
            403,
          );
        if (
          delivery &&
          (!this.accounts.allows(a, t.productId, "operate") ||
            (a.id !== t.builderAccountId &&
              a.role !== "admin" &&
              !this.accounts.isProjectAdministrator(a, t.productId)))
        )
          throw new MissionGoError(
            "collaboration_builder_required",
            "交付说明由接收方提供。",
            403,
          );
        this.db
          .prepare(
            "UPDATE collaboration_requests SET revision=revision+1 WHERE id=?",
          )
          .run(id);
        this.audit(
          delivery ? "delivery" : "discussion",
          accountId,
          { note },
          id,
          null,
          actor,
        );
        this.both(r, note, accountId, "decision", actor);
        return { id };
      },
    );
  }
  transferVerifier(
    accountId: string,
    id: string,
    successorId: string,
    note: string,
    key: string,
  ) {
    this.authorized(id, accountId);
    return this.command(
      accountId,
      key,
      { action: "verifier", id, successorId, note },
      () => {
        const { r, a, s } = this.authorized(id, accountId);
        if (accountId !== r.verifier_account_id) this.manager(a, s.productId);
        const next = this.account(successorId);
        this.view(next, s.productId);
        const rows = this.db
          .prepare(
            "SELECT * FROM collaboration_requests WHERE target_item_id=?",
          )
          .all(r.target_item_id) as unknown as CollaborationRow[];
        for (const other of rows) {
          this.view(next, this.item(other.source_item_id).productId);
          if (accountId !== other.verifier_account_id)
            this.manager(a, this.item(other.source_item_id).productId);
        }
        this.db
          .prepare(
            "UPDATE collaboration_requests SET verifier_account_id=?,revision=revision+1 WHERE target_item_id=?",
          )
          .run(successorId, r.target_item_id);
        for (const other of rows) {
          this.audit(
            "verifier_transferred",
            accountId,
            { from: other.verifier_account_id, to: successorId, note },
            other.id,
          );
          this.both(this.row(other.id), `验收责任已转交：${note}`, accountId);
        }
        return { id };
      },
    );
  }
  rebind(
    accountId: string,
    id: string,
    revision: number,
    targetKey: string,
    note: string,
    key: string,
  ) {
    this.authorized(id, accountId);
    return this.command(
      accountId,
      key,
      { action: "rebind", id, revision, targetKey, note },
      () => {
        const { r, a, s } = this.authorized(id, accountId);
        this.sourceBuilder(a, s);
        this.assertSourceOpen(s);
        if (r.revision !== revision)
          throw conflict("collaboration_stale", "依赖已变化。");
        const t = this.store.getWorkItem(targetKey);
        const compatible = this.compatibleTarget(
          accountId,
          t.id,
          r.verifier_account_id,
        );
        this.store.assertWorkItemWritable(t.key);
        const g = this.activeGrant(r.grant_id, s);
        if (
          t.productId !== g.target_product_id ||
          (g.module_id && t.sourceComponentId !== g.module_id) ||
          !this.db
            .prepare(
              "SELECT 1 FROM collaboration_requests WHERE target_item_id=? AND verifier_account_id=?",
            )
            .get(t.id, r.verifier_account_id)
        )
          throw conflict(
            "collaboration_existing_not_compatible",
            "目标必须是同项目、模块、验收人的协作条目。",
          );
        assertCollaborationAcyclic(this.store.database, s.id, t.id, id);
        if (
          this.db
            .prepare(
              "SELECT 1 FROM collaboration_requests WHERE source_item_id=? AND target_item_id=? AND withdrawn_at IS NULL AND id!=?",
            )
            .get(s.id, t.id, id)
        )
          throw conflict("collaboration_duplicate", "已存在此依赖。");
        const payload = JSON.parse(compatible.payload_json) as Payload;
        payload.attachments = [];
        payload.attachmentIds = [];
        this.db
          .prepare(
            "UPDATE collaboration_requests SET withdrawn_at=?,withdrawal_reason=?,revision=revision+1 WHERE id=?",
          )
          .run(new Date().toISOString(), note, id);
        const replacement = this.insert(
          s,
          t,
          g,
          JSON.stringify(payload),
          r.verifier_account_id,
          null,
          1,
        );
        this.db
          .prepare("UPDATE collaboration_requests SET approved_by=? WHERE id=?")
          .run(accountId, replacement);
        this.audit(
          "rebound",
          accountId,
          { replacementId: replacement, targetKey: t.key, note },
          id,
        );
        this.audit(
          "associated",
          accountId,
          { replacesId: id, note },
          replacement,
        );
        this.both(
          r,
          `依赖已转接到 ${t.key}，原接收条目仍由其 Builder 决定后续处理：${note}`,
          accountId,
        );
        this.both(this.row(replacement), `已接续依赖：${note}`, accountId);
        return { id: replacement };
      },
    );
  }

  revoke(accountId: string, id: string, note: string, key: string) {
    return this.command(accountId, key, { action: "revoke", id, note }, () => {
      const r = this.row(id);
      this.manager(
        this.account(accountId),
        this.item(r.target_item_id).productId,
      );
      this.db
        .prepare(
          "UPDATE collaboration_requests SET access_revoked_at=?,revision=revision+1 WHERE id=?",
        )
        .run(new Date().toISOString(), id);
      this.audit("access_revoked", accountId, { note }, id);
      this.both(r, `共享访问已撤销，依赖仍按条目结论计算：${note}`, accountId);
      return { id };
    });
  }
  restoreAccess(accountId: string, id: string, note: string, key: string) {
    return this.command(
      accountId,
      key,
      { action: "restoreAccess", id, note },
      () => {
        const r = this.row(id);
        this.manager(
          this.account(accountId),
          this.item(r.target_item_id).productId,
        );
        this.db
          .prepare(
            "UPDATE collaboration_requests SET access_revoked_at=NULL,revision=revision+1 WHERE id=?",
          )
          .run(id);
        this.audit("access_restored", accountId, { note }, id);
        this.both(r, `共享访问已恢复：${note}`, accountId);
        return { id };
      },
    );
  }
  sharedAttachment(accountId: string, id: string, attachmentId: string) {
    const { r, s } = this.authorized(id, accountId),
      p = JSON.parse(r.payload_json) as Payload,
      f = p.attachments.find((x) => x.id === attachmentId),
      current = s.attachments.find((x) => x.id === attachmentId);
    if (
      !f ||
      !current ||
      f.revision !== current.revision ||
      this.store.getWithdrawnCommentAttachmentIds(s.key).has(attachmentId)
    )
      throw notFound("Shared attachment");
    return this.store.getAttachmentRecord(s.key, attachmentId);
  }
  /** Called by the single status write path while its transaction owns the writer lock. */
  beforeTransition(
    item: WorkItemSnapshot,
    to: WorkItemStatus,
    actor: ActorKind,
    accountId: string | undefined,
    note: string | undefined,
    disposition?: { mode: "withdraw" | "keep"; successorAccountId?: string },
  ) {
    if (to !== "cancelled") return;
    const rows = this.db
      .prepare(
        `SELECT r.* FROM collaboration_requests r JOIN work_items t ON t.id=r.target_item_id WHERE r.source_item_id=? AND r.withdrawn_at IS NULL AND t.status NOT IN ('done','cancelled')`,
      )
      .all(item.id) as unknown as CollaborationRow[];
    if (rows.length) {
      if (actor !== "human" || !accountId || !disposition || !note?.trim())
        throw conflict(
          "collaboration_disposition_required",
          "取消前须处理未完成协作：撤回，或保留并指定接续负责人。",
        );
      if (disposition.mode === "keep") {
        if (!disposition.successorAccountId)
          throw invalidInput("Successor required.");
        const successor = this.account(disposition.successorAccountId);
        if (!this.accounts.allows(successor, item.productId, "operate"))
          throw invalidInput("Successor needs operation permission.");
      }
      for (const r of rows) {
        if (disposition.mode === "withdraw")
          this.db
            .prepare(
              "UPDATE collaboration_requests SET withdrawn_at=?,withdrawal_reason=?,revision=revision+1 WHERE id=?",
            )
            .run(new Date().toISOString(), note, r.id);
        else
          this.db
            .prepare(
              "UPDATE collaboration_requests SET owner_account_id=?,revision=revision+1 WHERE id=?",
            )
            .run(disposition.successorAccountId!, r.id);
        this.audit(
          "source_cancelled",
          accountId,
          { ...disposition, note },
          r.id,
        );
        this.both(
          this.row(r.id),
          `原条目取消；协作${disposition.mode === "withdraw" ? "已撤回" : "保留并指定接续负责人"}：${note}`,
          accountId,
        );
      }
    }
    this.db
      .prepare(
        "UPDATE collaboration_drafts SET invalidated_at=? WHERE source_item_id=? AND submitted_request_id IS NULL",
      )
      .run(new Date().toISOString(), item.id);
  }
  afterTransition(
    item: WorkItemSnapshot,
    to: WorkItemStatus,
    accountId?: string,
    note?: string,
    actor: ActorKind = "human",
  ) {
    const rows = this.db
      .prepare("SELECT * FROM collaboration_requests WHERE target_item_id=?")
      .all(item.id) as unknown as CollaborationRow[];
    for (const r of rows) {
      this.db
        .prepare("UPDATE work_items SET revision=revision+1 WHERE id=?")
        .run(r.source_item_id);
      this.audit(
        "target_status",
        accountId ?? "system",
        { from: item.status, to, note: note ?? "" },
        r.id,
        null,
        actor,
      );
      if (
        ["pending_verification", "done", "cancelled"].includes(to) ||
        terminal(item.status) ||
        item.status === "pending_verification"
      ) {
        const message =
          to === "pending_verification"
            ? "协作已待验证，请提需方验收；依赖尚未解除。"
            : terminal(to)
              ? `协作${to === "done" ? "已验收完成" : "已取消"}，等待解除；原条目由 Builder 决定下一步。`
              : `协作已重新进入处理；请核对后续交付依赖。`;
        this.both(
          r,
          `${item.key}：${message}${note ? "\n" + note : ""}`,
          accountId ?? "system",
          to === "pending_verification" ? "verification" : "decision",
          actor,
        );
      }
    }
  }
}
