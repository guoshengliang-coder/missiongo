import { assertBuilderExecution, latestBuilderHandover } from "./builder-authority.js";
import { completionFields, normalizeCompletion, sameCompletion } from "./completion.js";
import type { CompletionReference } from "@missiongo/contracts";
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { conflict, invalidInput, notFound } from "./errors.js";
import type { MissionGoStore } from "./store.js";
import { isReleaseArtifactId, MAX_RELEASE_ARTIFACTS } from "./types.js";

const sha = z.string().regex(/^[a-f0-9]{40}$/);
const timestamp = z.iso.datetime({ offset: true });
export const handoverRegistrationSchema = z.object({
  ...completionFields,
  requiredArtifacts: z.array(z.string().refine(isReleaseArtifactId)).max(MAX_RELEASE_ARTIFACTS).optional(),
  noReleaseReason: z.string().trim().min(1).max(4000).optional(),
}).superRefine((input, ctx) => {
  try { normalizeCompletion(input); } catch { ctx.addIssue({ code: "custom", message: "Provide a valid completion reference." }); }
});
export const humanConfirmationSchema = z.discriminatedUnion("stage", [
  z.object({ stage: z.literal("integration"), note: z.string().trim().min(1).max(2000), commit: sha }),
  z.object({ stage: z.literal("release"), note: z.string().trim().min(1).max(2000),
    releases: z.array(z.object({ artifact: z.string().refine(isReleaseArtifactId), version: z.string().trim().min(1).max(100), sourceCommit: sha })).max(MAX_RELEASE_ARTIFACTS) }),
]);
export const handoverEvidenceSchema = z.object({
  merged: z.object({ commit: sha, occurredAt: timestamp }).optional(),
  releases: z.array(z.object({ artifact: z.string().refine(isReleaseArtifactId), version: z.string().trim().min(1).max(100),
    sourceCommit: sha, containsMergeCommit: sha, verifiedAt: timestamp, receiptDigest: z.string().regex(/^[a-f0-9]{64}$/) })).max(MAX_RELEASE_ARTIFACTS).optional(),
  failure: z.enum(["permission_failed", "evidence_missing", "waiting_merge", "waiting_release", "failed"]).optional(),
});
export type HandoverRegistration = z.infer<typeof handoverRegistrationSchema>;
export type HandoverEvidence = z.infer<typeof handoverEvidenceSchema>;
interface Row {
  completion_json: string | null;
  id: string; item_id: string; account_id: string; round_key: string; pull_request_url: string;
  required_json: string | null; no_release_reason: string | null; evidence_json: string; evidence_source_json: string;
  revision: number; checked_revision: number; check_status: string; reason: string;
  checked_at: string | null; requested_at: string | null; lease_token: string | null; lease_node_id: string | null;
  lease_repo_path: string | null; lease_until: string | null; created_at: string; updated_at: string;
}
const messages: Record<string, string> = {
  evidence_missing: "缺少可信证据，等待执行端上报或本机节点核实。", waiting_merge: "完成依据尚未核实集成。", waiting_confirmation: "等待登录用户确认集成或发布。",
  waiting_release: "仍有必需产物未核实发布。", waiting_node: "已排队，等待有仓库权限的本机节点检查。",
  checking: "本机节点正在检查。", checked: "交接条件已核对。", needs_scope: "已核实集成；可补充本条发布范围并核实发布，或由人工安排验证。",
  stale: "条目处理轮次已变化，旧交接记录已失效。", permission_failed: "检查未获授权，请核对本机 Git、gh/glab 登录和仓库权限。",
  failed: "检查未完成，可以查看本机检查记录并重试。", inactive: "条目当前不参与自动交接。",
};

/** Durable evidence belongs to one processing round, never to the item's lifetime. */
export class StatusChecks {
  constructor(readonly store: MissionGoStore) {}
  private get db() { return this.store.database.connection; }
  private row(id: string): Row {
    const row = this.db.prepare("SELECT * FROM status_handovers WHERE id=?").get(id) as unknown as Row | undefined;
    if (!row) throw notFound("Handover"); return row;
  }
  private round(itemId: string): string | null {
    const row = this.db.prepare(`SELECT id FROM work_item_events WHERE item_id=? AND history_source_key IS NULL
      AND (event_type='status_changed' AND to_status='in_progress' OR event_type='execution_taken_over' OR event_type='builder_changed' AND json_extract(payload_json,'$.handoverId') IS NOT NULL) ORDER BY timeline_seq DESC LIMIT 1`).get(itemId) as { id: string } | undefined;
    return row?.id ?? null;
  }
  private completion(row: Row): CompletionReference {
    return normalizeCompletion(row.completion_json ? { completion: JSON.parse(row.completion_json) as CompletionReference } : { pullRequestUrl: row.pull_request_url });
  }
  private valid(row: Row): boolean {
    const item = this.db.prepare("SELECT status,product_id FROM work_items WHERE id=?").get(row.item_id) as { status: string; product_id: string } | undefined;
    const builder = latestBuilderHandover(this.store.database,row.item_id);
    return Boolean((!builder || builder.status === "completed" && (builder.to_account_id === null || builder.to_account_id === row.account_id))
      && item && !this.store.getProduct(item.product_id).archivedAt && this.round(row.item_id) === row.round_key
      && ["in_progress", "development_complete"].includes(item.status) && !this.db.prepare("SELECT 1 FROM item_transfers WHERE source_item_id=?").get(row.item_id));
  }
  private state(row: Row, status: string, reason = messages[status] ?? status, now = new Date().toISOString()) {
    this.db.prepare("UPDATE status_handovers SET check_status=?,reason=?,checked_at=?,checked_revision=revision WHERE id=?").run(status, reason, now, row.id);
  }
  register(itemKey: string, accountId: string, raw: HandoverRegistration) {
    const input = handoverRegistrationSchema.parse(raw);
    const completion = normalizeCompletion(input);
    const pullRequestUrl = "url" in completion ? completion.url : "";
    this.store.assertWorkItemWritable(itemKey);
    const item = this.store.getWorkItem(itemKey);
    assertBuilderExecution(this.store.database,item.id,accountId);
    if (!["in_progress", "development_complete"].includes(item.status)) throw conflict("handover_not_active", "Register a handover for active work only.");
    if (item.status === "development_complete") {
      const current = [...this.store.getTimeline(itemKey)].reverse().find(e => !e.historySourceKey && e.eventType === "status_changed" && e.toStatus === "development_complete");
      if (current && !sameCompletion(normalizeCompletion(current.payload), completion)) throw conflict("handover_pr_conflict","Reopen the item before replacing a completed integration reference.");
    }
    const round = this.round(item.id);
    if (!round) throw conflict("handover_round_missing", "The processing round has no recorded start.");
    if (input.requiredArtifacts && new Set(input.requiredArtifacts).size !== input.requiredArtifacts.length) throw invalidInput("Use unique release artifact identifiers.");
    if (input.requiredArtifacts?.length === 0 && !input.noReleaseReason || input.noReleaseReason && input.requiredArtifacts?.length !== 0) {
      throw invalidInput("An empty release scope requires an explicit no-release reason; unknown scope must be omitted.");
    }
    const existing = this.db.prepare("SELECT * FROM status_handovers WHERE item_id=? AND round_key=?").get(item.id, round) as unknown as Row | undefined;
    const keepScope = existing && sameCompletion(this.completion(existing), completion) && input.requiredArtifacts === undefined;
    const required = input.requiredArtifacts ? JSON.stringify([...input.requiredArtifacts].sort()) : keepScope ? existing.required_json : null;
    const noReleaseReason = keepScope ? existing.no_release_reason : input.noReleaseReason ?? null;
    const now = new Date().toISOString();
    let id: string;
    if (existing) {
      id = existing.id;
      if (!sameCompletion(this.completion(existing), completion) || existing.required_json !== required || existing.no_release_reason !== noReleaseReason) {
        this.db.prepare(`UPDATE status_handovers SET account_id=?,pull_request_url=?,completion_json=?,required_json=?,no_release_reason=?,
          evidence_json=?,revision=revision+1,updated_at=?,lease_token=NULL,lease_until=NULL,requested_at=? WHERE id=?`)
          .run(accountId, pullRequestUrl, JSON.stringify(completion), required, noReleaseReason,
            sameCompletion(this.completion(existing), completion) ? existing.evidence_json : "{}", now, now, id);
      }
    } else {
      id = randomUUID();
      this.db.prepare(`INSERT INTO status_handovers(id,item_id,account_id,round_key,pull_request_url,completion_json,required_json,no_release_reason,
        created_at,updated_at,requested_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(id,item.id,accountId,round,pullRequestUrl,JSON.stringify(completion),required,noReleaseReason,now,now,now);
    }
    // An explicit correction is also reflected in the recorded development handover.
    if (item.status === "development_complete" && required !== (existing?.required_json ?? null)) {
      this.store.appendSystemEvent(item.id, "handover_scope_confirmed", { handoverId: id, requiredArtifacts: required ? JSON.parse(required) as string[] : undefined, ...(noReleaseReason ? {noReleaseReason} : {}), accountId });
    }
    this.store.recordProductReleaseArtifacts(item.productId, input.requiredArtifacts ?? []);
    this.reconcile(id);
    return this.snapshot(id);
  }
  importLegacy(productId: string, accountId: string) {
    const rows = this.db.prepare(`SELECT w.item_key FROM work_items w WHERE w.product_id=? AND w.status='development_complete'
      AND NOT EXISTS (SELECT 1 FROM status_handovers h WHERE h.item_id=w.id AND h.round_key=(SELECT id FROM work_item_events r WHERE r.item_id=w.id AND r.history_source_key IS NULL AND r.to_status='in_progress' ORDER BY r.timeline_seq DESC LIMIT 1))`).all(productId) as Array<{ item_key: string }>;
    for (const row of rows) {
      if (this.store.getWorkItem(row.item_key).transferred) continue;
      const event = [...this.store.getTimeline(row.item_key)].reverse().find(e => !e.historySourceKey && e.eventType === "status_changed" && e.toStatus === "development_complete");
      if (!event) continue;
      try { this.register(row.item_key, accountId, { completion: normalizeCompletion(event.payload),
        ...(Array.isArray(event.payload.requiredArtifacts) ? { requiredArtifacts: event.payload.requiredArtifacts as string[] } : {}),
        ...(typeof event.payload.noReleaseReason === "string" ? { noReleaseReason: event.payload.noReleaseReason } : {}) }); } catch { /* Invalid legacy records remain visible as missing evidence. */ }
    }
  }
  snapshot(id: string) {
    const row = this.row(id);
    const item = this.db.prepare("SELECT item_key,product_id,status FROM work_items WHERE id=?").get(row.item_id) as {item_key: string; product_id: string; status: string};
    const evidence = JSON.parse(row.evidence_json) as HandoverEvidence;
    return { id, itemKey: item.item_key, productId: item.product_id, itemStatus: item.status, pullRequestUrl: row.pull_request_url, completion: this.completion(row),
      requiredArtifacts: row.required_json ? JSON.parse(row.required_json) as string[] : null, noReleaseReason: row.no_release_reason,
      status: this.round(row.item_id) !== row.round_key ? "stale" : row.check_status,
      reason: this.round(row.item_id) !== row.round_key ? messages.stale! : row.reason, checkedAt: row.checked_at, requestedAt: row.requested_at,
      evidence, evidenceSource: (JSON.parse(row.evidence_source_json) as {kind?:string}).kind ?? "authorized_executor", evidenceReporter: JSON.parse(row.evidence_source_json), evidenceUpdatedAt: row.updated_at, roundKey: row.round_key };
  }
  list(productId: string, itemKey?: string, limit = 100, offset = 0) {
    const rows = this.db.prepare(`SELECT h.id FROM status_handovers h JOIN work_items w ON w.id=h.item_id
      WHERE w.product_id=? ${itemKey ? "AND w.item_key=?" : ""} ORDER BY h.created_at DESC,h.id LIMIT ? OFFSET ?`)
      .all(productId, ...(itemKey ? [itemKey] : []), limit + 1, offset) as Array<{id: string}>;
    return { items: rows.slice(0,limit).map(r => this.snapshot(r.id)), ...(rows.length > limit ? { nextOffset: offset + limit } : {}) };
  }
  authorize(id: string, accountId: string, authorizeProduct: (productId: string) => void) {
    const row = this.row(id); const snapshot = this.snapshot(id); authorizeProduct(snapshot.productId);
    // A scoped MCP authorization may report to an item another executor registered.
    // Node reports instead require a lease owned by that exact account and node.
    if (!accountId) throw notFound("Handover"); return row;
  }
  report(id: string, raw: HandoverEvidence, source: {accountId: string; nodeId?: string; leaseToken?: string; human?: true; note?: string}, now = new Date().toISOString()) {
    const evidence = handoverEvidenceSchema.parse(raw);
    const row = this.row(id);
    const completion = this.completion(row);
    if (completion.kind === "manual" && !source.human) throw invalidInput("This handover requires human confirmation.");
    if (evidence.merged && "commit" in completion && evidence.merged.commit !== completion.commit) throw invalidInput("Evidence must match the registered commit.");
    if (source.nodeId && (row.account_id !== source.accountId || row.lease_node_id !== source.nodeId || row.lease_token !== source.leaseToken)) throw notFound("Status check lease");
    if (source.nodeId && (!row.lease_until || row.lease_until < now
      || !this.db.prepare("SELECT 1 FROM node_product_repos r JOIN work_items w ON w.product_id=r.product_id WHERE w.id=? AND r.node_id=? AND r.repo_path=?").get(row.item_id,source.nodeId,row.lease_repo_path))) {
      throw conflict("status_check_lease_expired","The lease or repository mapping changed; perform a fresh check.");
    }
    if (!this.valid(row)) { this.state(row,"stale"); return this.snapshot(id); }
    for (const date of [evidence.merged?.occurredAt, ...(evidence.releases ?? []).map(r => r.verifiedAt)]) {
      if (date && Date.parse(date) > Date.parse(now) + 60_000) throw invalidInput("Evidence cannot be dated in the future.");
    }
    const round = this.db.prepare("SELECT created_at FROM work_item_events WHERE id=?").get(row.round_key) as {created_at:string};
    if (evidence.merged && Date.parse(evidence.merged.occurredAt) < Date.parse(round.created_at)) {
      this.state(row,"evidence_missing","集成时间早于本轮处理，请人工核对关联，不能复用旧证据。");
      this.db.prepare("UPDATE status_handovers SET requested_at=NULL,lease_token=NULL,lease_node_id=NULL,lease_until=NULL WHERE id=?").run(id);
      return this.snapshot(id);
    }
    const previous = JSON.parse(row.evidence_json) as HandoverEvidence;
    if (previous.merged && evidence.merged && previous.merged.commit !== evidence.merged.commit) throw conflict("merge_evidence_conflict", "Integrated commit differs; register the correct completion reference for this round.");
    const merged = evidence.merged ?? previous.merged;
    // A supplied release list is the current observation, not an append-only bag.
    // Otherwise a reverted artifact's old proof could combine with a later release.
    const releases = new Map((evidence.releases === undefined ? previous.releases ?? [] : []).map(r => [r.artifact,r]));
    for (const release of evidence.releases ?? []) {
      if (!merged || release.containsMergeCommit !== merged.commit) throw invalidInput("Release evidence must name the verified merge commit it contains.");
      if (row.required_json && !(JSON.parse(row.required_json) as string[]).includes(release.artifact)) throw invalidInput("Unknown handover release artifact.");
      releases.set(release.artifact,release);
    }
    const combined: HandoverEvidence = { ...(merged ? {merged} : {}), releases: [...releases.values()] };
    const json = JSON.stringify(combined);
    const saved = this.db.prepare(`UPDATE status_handovers SET evidence_json=?,evidence_source_json=?,revision=revision+?,updated_at=?,requested_at=NULL,
      lease_token=NULL,lease_node_id=NULL,lease_until=NULL WHERE id=? AND revision=? AND pull_request_url=?
      ${source.nodeId ? "AND lease_token=?" : ""}`).run(json,JSON.stringify({accountId:source.accountId,kind:source.human ? "human_confirmation" : "authorized_executor",...(source.note ? {note:source.note} : {}),...(source.nodeId ? {nodeId:source.nodeId} : {}),recordedAt:now}),
        json === row.evidence_json ? 0 : 1, now,id,row.revision,row.pull_request_url,...(source.nodeId ? [source.leaseToken!] : []));
    if (!saved.changes) throw conflict("handover_changed","The handover changed during this check; refresh before reporting again.");
    this.store.recordProductReleaseArtifacts(this.snapshot(id).productId, [...new Set((evidence.releases ?? []).map(release => release.artifact))]);
    this.reconcile(id);
    if (evidence.failure && !["checked", "stale", "needs_scope"].includes(this.row(id).check_status)) this.state(this.row(id), evidence.failure);
    return this.snapshot(id);
  }
  reconcile(id: string) {
    const row = this.row(id);
    if (!this.valid(row)) {
      if (this.round(row.item_id) !== row.round_key) this.state(row,"stale");
      else if (row.check_status !== "checked") this.state(row,"inactive");
      return;
    }
    const evidence = JSON.parse(row.evidence_json) as HandoverEvidence;
    if (!evidence.merged) { this.state(row,this.completion(row).kind === "manual" ? "waiting_confirmation" : "waiting_merge"); return; }
    const required = row.required_json ? JSON.parse(row.required_json) as string[] : null;
    const reporter = JSON.parse(row.evidence_source_json) as {accountId?:string;kind?:string};
    const actor = reporter.kind === "human_confirmation" ? "human" as const : "system" as const;
    let item = this.store.getWorkItem(this.snapshot(id).itemKey);
    if (item.status === "in_progress") {
      item = this.store.submitDevelopmentComplete({ itemKey: item.key, completion: this.completion(row), ...(required ? { requiredArtifacts: required } : {}),
        ...(row.no_release_reason ? { noReleaseReason: row.no_release_reason } : {}),
        summary: actor === "human" ? "用户已确认集成。" : "已由授权执行端核实集成，自动补齐开发交接。", attribution: { accountId: reporter.accountId ?? row.account_id },
        idempotencyKey: `status-check:${row.id}:development` }, { actor, occurredAt: evidence.merged.occurredAt, handoverId: row.id });
    }
    if (!required) {
      this.state(row,"needs_scope");
      this.db.prepare("UPDATE status_handovers SET requested_at=NULL WHERE id=?").run(id);
      return;
    }
    if (!required.length) { this.state(row,"checked","已确认集成，明确无需发布；请人工安排验证。"); return; }
    const releases = required.map(a => evidence.releases?.find(r => r.artifact === a && r.containsMergeCommit === evidence.merged!.commit));
    if (releases.some(r => !r)) { this.state(row,this.completion(row).kind === "manual" ? "waiting_confirmation" : "waiting_release"); return; }
    const verified = releases.filter((r): r is NonNullable<typeof r> => Boolean(r));
    const occurredAt = verified.map(r => r.verifiedAt).sort().at(-1)!;
    this.store.submitForVerification({ itemKey: item.key, completion: this.completion(row),
      releases: verified.map(({artifact,version,sourceCommit}) => ({artifact,version,sourceCommit})),
      deployedCommit: evidence.merged.commit,
      receiptDigest: createHash("sha256").update(JSON.stringify(verified)).digest("hex"),
      idempotencyKey: `status-check:${row.id}:verification`, attribution: { accountId: reporter.accountId ?? row.account_id } },
      { actor, occurredAt, handoverId: row.id, requiredArtifacts: required });
    this.state(row,"checked");
  }
  /** Called only by the authenticated console route, never exposed over MCP/node reports. */
  confirm(id: string, accountId: string, raw: z.infer<typeof humanConfirmationSchema>) {
    const input = humanConfirmationSchema.parse(raw);
    return this.store.database.transaction(() => {
      const row = this.row(id);
      if (!this.valid(row)) throw conflict("handover_not_active", "This handover is no longer active.");
      const now = new Date().toISOString();
      if (input.stage === "integration") {
        const result = this.report(id, { merged: { commit: input.commit, occurredAt: now } }, { accountId, human: true, note: input.note }, now);
        this.store.appendSystemEvent(row.item_id, "handover_human_confirmed", { stage: input.stage, accountId, note: input.note, commit: input.commit, handoverId: id });
        return result;
      }
      const evidence = JSON.parse(row.evidence_json) as HandoverEvidence;
      const required = row.required_json ? JSON.parse(row.required_json) as string[] : null;
      if (!evidence.merged || (required ? input.releases.length !== required.length
        || new Set(input.releases.map(r => r.artifact)).size !== required.length || input.releases.some(r => !required.includes(r.artifact)) : input.releases.length > 0)) {
        throw invalidInput("Confirm integration and provide a version and source commit for every required artifact.");
      }
      if (!required?.length) {
        this.store.transitionWorkItem({ itemKey: this.snapshot(id).itemKey, to: "pending_verification", actor: "human", reason: "release_verified", note: input.note, attribution: { accountId } });
        this.db.prepare("UPDATE status_handovers SET evidence_source_json=?,updated_at=?,requested_at=NULL,lease_token=NULL,lease_until=NULL WHERE id=?")
          .run(JSON.stringify({accountId,kind:"human_confirmation",note:input.note,recordedAt:now}),now,id);
        this.state(this.row(id), "checked", "已由用户安排人工验证。", now);
        this.store.appendSystemEvent(row.item_id, "handover_human_confirmed", { stage: "verification_arranged", accountId, note: input.note, handoverId: id });
        return this.snapshot(id);
      }
      const digest = createHash("sha256").update(JSON.stringify({ input, accountId, recordedAt: now })).digest("hex");
      const result = this.report(id, { releases: input.releases.map(r => ({ ...r, containsMergeCommit: evidence.merged!.commit, verifiedAt: now, receiptDigest: digest })) },
        { accountId, human: true, note: input.note }, now);
      this.store.appendSystemEvent(row.item_id, "handover_human_confirmed", { stage: input.stage, accountId, note: input.note, releases: input.releases, handoverId: id });
      return result;
    });
  }
  request(productId: string, accountId: string, itemKey?: string) {
    this.importLegacy(productId, accountId);
    const rows = this.db.prepare(`SELECT h.* FROM status_handovers h JOIN work_items w ON w.id=h.item_id
      WHERE w.product_id=? AND w.status IN ('in_progress','development_complete') ${itemKey ? "AND w.item_key=?" : ""}`).all(productId,...(itemKey ? [itemKey] : [])) as unknown as Row[];
    const now = new Date().toISOString();
    let queued = 0;
    for (const row of rows) {
      this.reconcile(row.id);
      if (this.completion(row).kind === "manual") continue;
      if (!this.valid(this.row(row.id)) || this.row(row.id).check_status === "checked" || this.row(row.id).check_status === "needs_scope") continue;
      // Repeated button presses do not replace a worker's lease.
      this.db.prepare("UPDATE status_handovers SET requested_at=COALESCE(requested_at,?) WHERE id=?").run(now,row.id);
      if (!row.lease_token || !row.lease_until || row.lease_until < now) this.state(row,"waiting_node");
      queued++;
    }
    return { queued, missingAssociation: itemKey ? !rows.length : false, ...this.list(productId,itemKey) };
  }
  schedule(hourMinute: string, allowed: (accountId: string, productId: string) => boolean, now = new Date()) {
    const minute = new Intl.DateTimeFormat("en-GB", {timeZone:"Asia/Shanghai", hour:"2-digit",minute:"2-digit",hourCycle:"h23"}).format(now);
    if (minute < hourMinute) return;
    const day = new Intl.DateTimeFormat("en-CA", {timeZone:"Asia/Shanghai",year:"numeric",month:"2-digit",day:"2-digit"}).format(now);
    const legacy = this.db.prepare(`SELECT DISTINCT w.product_id,e.account_id FROM work_items w JOIN work_item_events e ON e.item_id=w.id
      WHERE w.status='development_complete' AND e.event_type='status_changed' AND e.to_status='development_complete'
      AND e.account_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM status_handovers h WHERE h.item_id=w.id AND h.round_key=(SELECT id FROM work_item_events r WHERE r.item_id=w.id AND r.history_source_key IS NULL AND r.to_status='in_progress' ORDER BY r.timeline_seq DESC LIMIT 1))`).all() as Array<{product_id:string;account_id:string}>;
    for (const group of legacy) if (allowed(group.account_id,group.product_id)) this.importLegacy(group.product_id,group.account_id);
    const groups = this.db.prepare(`SELECT DISTINCT h.account_id,w.product_id FROM status_handovers h JOIN work_items w ON w.id=h.item_id
      WHERE w.status IN ('in_progress','development_complete')`).all() as Array<{account_id: string;product_id: string}>;
    for (const group of groups) {
      if (!allowed(group.account_id,group.product_id) || this.store.getProduct(group.product_id).archivedAt) continue;
      if (this.db.prepare("SELECT 1 FROM status_check_days WHERE account_id=? AND product_id=? AND day=?").get(group.account_id,group.product_id,day)) continue;
      this.request(group.product_id,group.account_id);
      this.db.prepare("INSERT OR IGNORE INTO status_check_days(account_id,product_id,day) VALUES (?,?,?)").run(group.account_id,group.product_id,day);
    }
  }
  claim(nodeId: string, accountId: string, allowed: (productId: string) => void) {
    const now = new Date().toISOString();
    const rows = this.db.prepare(`SELECT h.*,r.repo_path,w.product_id FROM status_handovers h JOIN work_items w ON w.id=h.item_id
      JOIN node_product_repos r ON r.product_id=w.product_id AND r.node_id=?
      WHERE h.account_id=? AND h.requested_at IS NOT NULL AND (h.lease_until IS NULL OR h.lease_until<?)
      ORDER BY h.requested_at LIMIT 50`).all(nodeId,accountId,now) as unknown as Array<Row & {repo_path:string; product_id:string}>;
    for (const row of rows) {
      try { allowed(row.product_id); } catch { continue; }
      if (this.completion(row).kind === "manual") continue;
      if (!this.valid(row)) { this.state(row,"stale"); this.db.prepare("UPDATE status_handovers SET requested_at=NULL WHERE id=?").run(row.id); continue; }
      const token = randomUUID();
      const claimed = this.db.prepare(`UPDATE status_handovers SET lease_node_id=?,lease_token=?,lease_repo_path=?,lease_until=?,check_status='checking',reason=?
        WHERE id=? AND (lease_until IS NULL OR lease_until<?)`).run(nodeId,token,row.repo_path,new Date(Date.now()+10*60_000).toISOString(),messages.checking!,row.id,now);
      if (claimed.changes) return { ...this.snapshot(row.id), repoPath: row.repo_path, leaseToken: token };
    }
    return null;
  }
}
