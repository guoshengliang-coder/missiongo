import { createHash, randomUUID } from "node:crypto";
import { isManagedDecisionContent, isManagedRunScope, type ManagedDecision, type ManagedDecisionContent,
  type ManagedDecisionEvent, type ManagedDecisionGuard, type ManagedDecisionAction, type ManagedRun } from "@missiongo/domain";
import { conflict, invalidInput, notFound } from "./errors.js";
import { ManagedRunStore } from "./managed-run-store.js";
import type { MissionGoDatabase } from "./storage/database.js";

/** A trusted server callback. Resolves CURRENT session + permissions inside the transaction.
 * Returns the authenticated account ID; never constructed from an HTTP body. */
export type DecisionAccess = (productId: string) => string;
export type DecisionOperation = "approve" | "revoke" | "revise" | "explain";
export type DecisionChange = ManagedDecisionGuard & { content?: ManagedDecisionContent; explanation?: string };
interface CreateDecision {
  runId: string; decisionKey: string; scopeDigest: string; contractRevision: number;
  content: ManagedDecisionContent; idempotencyKey: string;
}
function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value, (_key, part: unknown) => {
    if (part && typeof part === "object" && !Array.isArray(part)) {
      return Object.fromEntries(Object.entries(part).sort(([a], [b]) => a.localeCompare(b)));
    }
    return part;
  })).digest("hex");
}
function text(value: unknown, max = 200): asserts value is string {
  if (typeof value !== "string" || !value.trim() || value.length > max) throw invalidInput("Invalid decision text or key.");
}
export class ManagedDecisionStore {
  constructor(private readonly db: MissionGoDatabase) {}

  create(access: DecisionAccess, input: CreateDecision): ManagedDecision {
    text(input.decisionKey); text(input.idempotencyKey);
    if (!isManagedDecisionContent(input.content)) throw invalidInput("Invalid decision content.");
    return this.db.transaction(() => {
      const run = this.readRun(access, input.runId);
      if (input.scopeDigest !== run.scopeDigest || input.contractRevision !== run.scope.contractRevision) {
        throw conflict("decision_changed", "Frozen run scope differs.");
      }
      const { idempotencyKey, ...payload } = input;
      const payloadDigest = digest(payload);
      const existing = this.db.connection.prepare("SELECT id FROM decision_records WHERE run_id=? AND decision_key=?")
        .get(run.id, input.decisionKey) as { id: string } | undefined;
      if (existing) {
        const current = this.get(access, existing.id);
        const accountId = access(current.scope.productId);
        const replay = this.replay(existing.id, accountId, "create", idempotencyKey, payloadDigest);
        if (replay) return this.currentReceipt(current, replay);
        throw conflict("decision_exists", "Decision key already exists; use a revision.");
      }
      const now = new Date().toISOString();
      const result: ManagedDecision = { id: randomUUID(), runId: run.id, decisionKey: input.decisionKey,
        scope: run.scope, scopeDigest: run.scopeDigest, version: 1, stateVersion: 1, contentDigest: digest(input.content),
        content: structuredClone(input.content), explanation: "", status: "pending", approval: null, createdAt: now, updatedAt: now };
      this.db.connection.prepare("INSERT INTO decision_records(id,run_id,decision_key,snapshot_json) VALUES (?,?,?,?)")
        .run(result.id, run.id, input.decisionKey, JSON.stringify(result));
      this.record(run.accountId, "create", idempotencyKey, payloadDigest, result);
      return result;
    });
  }

  change(access: DecisionAccess, id: string, operation: DecisionOperation, input: DecisionChange): ManagedDecision {
    text(input.idempotencyKey);
    if (![input.version, input.stateVersion, input.contractRevision].every((n) => Number.isSafeInteger(n) && n > 0)) throw invalidInput("Invalid decision version.");
    if (!["approve", "revoke", "revise", "explain"].includes(operation)) throw invalidInput("Unknown decision action.");
    if (operation === "revise" && !isManagedDecisionContent(input.content)) throw invalidInput("Invalid decision content.");
    if (operation === "explain") text(input.explanation, 4000);
    return this.db.transaction(() => {
      const current = this.get(access, id);
      const accountId = access(current.scope.productId);
      const { idempotencyKey, ...payload } = input;
      const payloadDigest = digest(payload);
      const replay = this.replay(id, accountId, operation, idempotencyKey, payloadDigest);
      if (replay) return this.currentReceipt(current, replay);
      if (current.version !== input.version || current.contentDigest !== input.contentDigest || current.scopeDigest !== input.scopeDigest
        || current.scope.contractRevision !== input.contractRevision || current.stateVersion !== input.stateVersion) {
        throw conflict("decision_changed", "Reload the current decision before confirming.");
      }
      if (operation === "approve" && current.status !== "pending") throw conflict("decision_not_pending", "Only a pending decision can be approved.");
      if (operation === "revoke" && current.status === "revoked") throw conflict("decision_revoked", "Decision already revoked.");
      const now = new Date().toISOString();
      let result: ManagedDecision;
      if (operation === "explain") {
        result = { ...current, explanation: input.explanation!, updatedAt: now };
      } else if (operation === "revise") {
        const contentDigest = digest(input.content);
        result = contentDigest === current.contentDigest ? current : { ...current,
          content: structuredClone(input.content!), contentDigest, version: current.version + 1,
          stateVersion: current.stateVersion + 1, status: "pending", approval: null, explanation: "", updatedAt: now };
      } else {
        result = { ...current, stateVersion: current.stateVersion + 1, updatedAt: now,
          status: operation === "approve" ? "approved" : "revoked", approval: operation === "approve" ? { accountId, approvedAt: now } : null };
      }
      this.db.connection.prepare("UPDATE decision_records SET snapshot_json=? WHERE id=?").run(JSON.stringify(result), id);
      if (result.version !== current.version || result.stateVersion !== current.stateVersion) {
        const intents = this.db.connection.prepare("SELECT id,snapshot_json FROM managed_execution_intents WHERE json_extract(snapshot_json,'$.binding.decisionId')=? AND ownership_held=1")
          .all(id) as { id: string; snapshot_json: string }[];
        for (const row of intents) {
          const intent = JSON.parse(row.snapshot_json);
          intent.stopRequested = true;
          if (intent.state === "requested" || intent.state === "acknowledged") {
            intent.state = "terminal"; intent.outcome = "cancelled"; intent.ownershipHeld = false;
          }
          const snapshot = JSON.stringify(intent);
          this.db.connection.prepare("UPDATE managed_execution_intents SET snapshot_json=?,ownership_held=? WHERE id=?")
            .run(snapshot, intent.ownershipHeld ? 1 : 0, row.id);
          this.db.connection.prepare(
            "INSERT INTO managed_execution_events SELECT ?,COALESCE(MAX(sequence),0)+1,'decision_invalidated',?,? FROM managed_execution_events WHERE intent_id=?"
          ).run(row.id, snapshot, now, row.id);
        }
      }
      this.record(accountId, operation, idempotencyKey, payloadDigest, result);
      return result;
    });
  }

  /** Point-in-time authorization only, NOT a worker lease or an execution command. */
  requireApproval(access: DecisionAccess, id: string, binding: Omit<ManagedDecisionGuard, "idempotencyKey"> & {
    runId: string; action: ManagedDecisionAction;
  }): ManagedDecision {
    return this.db.transaction(() => {
      const d = this.get(access, id);
      if (d.status !== "approved" || !d.approval || d.runId !== binding.runId || d.version !== binding.version
        || d.stateVersion !== binding.stateVersion || d.contentDigest !== binding.contentDigest || d.scopeDigest !== binding.scopeDigest
        || d.scope.contractRevision !== binding.contractRevision || !d.content.allowedActions.includes(binding.action)) {
        throw conflict("decision_not_approved", "No current approval for this exact action and binding.");
      }
      return d;
    });
  }

  get(access: DecisionAccess, id: string): ManagedDecision {
    const row = this.db.connection.prepare("SELECT snapshot_json FROM decision_records WHERE id=?").get(id) as { snapshot_json: string } | undefined;
    if (!row) throw notFound("Decision");
    const decision = JSON.parse(row.snapshot_json) as ManagedDecision;
    const run = this.readRun(access, decision.runId);
    if (decision.scopeDigest !== run.scopeDigest || digest(decision.scope) !== run.scopeDigest) {
      throw conflict("decision_changed", "Decision scope no longer matches the run.");
    }
    return decision;
  }

  listEvents(access: DecisionAccess, id: string, after = 0, limit = 100): ManagedDecisionEvent[] {
    this.get(access, id);
    if (!Number.isSafeInteger(after) || after < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw invalidInput("Invalid event page.");
    return this.db.connection.prepare(`SELECT sequence,operation,account_id AS accountId,created_at AS createdAt,
      json_extract(result_json,'$.version') AS version, json_extract(result_json,'$.stateVersion') AS stateVersion
      FROM decision_events WHERE decision_id=? AND sequence>? ORDER BY sequence LIMIT ?`)
      .all(id, after, limit) as unknown as ManagedDecisionEvent[];
  }

  private readRun(access: DecisionAccess, id: string): ManagedRun {
    const row = this.db.connection.prepare("SELECT product_id FROM managed_runs WHERE id=?").get(id) as { product_id: string } | undefined;
    if (!row) throw notFound("Decision run");
    const accountId = access(row.product_id);
    const run = new ManagedRunStore(this.db).getRun({ accountId, productIds: [row.product_id] }, id);
    if (!isManagedRunScope(run.scope) || run.scope.productId !== row.product_id || digest(run.scope) !== run.scopeDigest) {
      throw conflict("decision_changed", "Frozen run scope is invalid.");
    }
    for (const key of run.scope.itemKeys) {
      if (!this.db.connection.prepare("SELECT id FROM work_items WHERE item_key=? AND product_id=?").get(key, row.product_id)) throw notFound("Scoped item");
    }
    return run;
  }

  private currentReceipt(current: ManagedDecision, replay: ManagedDecision): ManagedDecision {
    if (replay.id !== current.id || replay.runId !== current.runId || replay.decisionKey !== current.decisionKey
      || replay.version !== current.version || replay.stateVersion !== current.stateVersion || replay.status !== current.status
      || replay.contentDigest !== current.contentDigest || replay.scopeDigest !== current.scopeDigest
      || replay.scope.contractRevision !== current.scope.contractRevision || digest(replay.approval) !== digest(current.approval)
      || digest(replay.content) !== replay.contentDigest || digest(current.content) !== current.contentDigest
      || digest(replay.scope) !== replay.scopeDigest) throw conflict("decision_changed", "The previous receipt is no longer current.");
    // Explanations can change without changing the approval binding. Never return an obsolete view.
    return current;
  }

  private replay(id: string, accountId: string, operation: string, key: string, payloadDigest: string): ManagedDecision | undefined {
    const row = this.db.connection.prepare(`SELECT payload_digest,result_json FROM decision_events
      WHERE decision_id=? AND account_id=? AND operation=? AND idempotency_key=?`)
      .get(id, accountId, operation, key) as { payload_digest: string; result_json: string } | undefined;
    if (!row) return undefined;
    if (row.payload_digest !== payloadDigest) throw conflict("idempotency_conflict", "Idempotency key payload differs.");
    return JSON.parse(row.result_json) as ManagedDecision;
  }

  private record(accountId: string, operation: string, key: string, payloadDigest: string, result: ManagedDecision): void {
    this.db.connection.prepare(`INSERT INTO decision_events(decision_id,sequence,account_id,operation,idempotency_key,payload_digest,result_json,created_at)
      SELECT ?,COALESCE(MAX(sequence),0)+1,?,?,?,?,?,? FROM decision_events WHERE decision_id=?`)
      .run(result.id, accountId, operation, key, payloadDigest, JSON.stringify(result), new Date().toISOString(), result.id);
  }
}
