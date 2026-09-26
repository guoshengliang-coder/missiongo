import { createHash, randomUUID } from "node:crypto";
import { isManagedRunScope, MANAGED_STAGE_ROLES, type ManagedRun, type ManagedRunEvent, type ManagedRunScope,
  type ManagedStage, type ManagedStageRole, type ManagedAttempt, type ManagedExecutor, type ManagedRunCommand,
  type ManagedAttemptStatus, type ManagedAttemptResult } from "@missiongo/domain";

import { conflict, invalidInput, notFound } from "./errors.js";
import type { MissionGoDatabase } from "./storage/database.js";

/** Only a server-authenticated caller may supply this context. Not an HTTP body. */
export interface ManagedRunActor {
  readonly accountId: string;
  readonly productIds: readonly string[];
}

interface RunRow {
  id: string; account_id: string; product_id: string; scope_json: string;
  scope_digest: string; version: number; created_at: string;
}

const ATTEMPT_TRANSITIONS: Readonly<Record<ManagedAttemptStatus, readonly ManagedAttemptStatus[]>> = {
  running: ["waiting_for_human", "unknown", "succeeded", "failed"],
  waiting_for_human: ["running", "unknown", "succeeded", "failed"],
  unknown: ["succeeded", "failed"],
  succeeded: [],
  failed: [],
};

function requiredText(value: unknown, name: string, max = 200): asserts value is string {
  if (typeof value !== "string" || !value.trim() || value.length > max) throw invalidInput(`Invalid ${name}.`);
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value, (_key, part: unknown) => {
    if (part && typeof part === "object" && !Array.isArray(part)) {
      return Object.fromEntries(Object.entries(part).sort(([a], [b]) => a.localeCompare(b)));
    }
    return part;
  })).digest("hex");
}

export class ManagedRunStore {
  constructor(private readonly db: MissionGoDatabase) {}

  createRun(actor: ManagedRunActor, input: { scope: ManagedRunScope; idempotencyKey: string }): ManagedRun {
    if (!isManagedRunScope(input.scope)) throw invalidInput("Invalid managed scope.");
    this.requireProduct(actor, input.scope.productId);
    requiredText(input.idempotencyKey, "idempotency key");
    // Fixed field order keeps the digest independent of JS object property order.
    const scope = { productId: input.scope.productId, repositoryRef: input.scope.repositoryRef,
      itemKeys: [...input.scope.itemKeys], contractRevision: input.scope.contractRevision };
    return this.db.transaction(() => {
      const replay = this.replay<ManagedRun>(actor, "create_run", scope.productId, input.idempotencyKey, digest(scope));
      if (replay) return replay;
      for (const key of scope.itemKeys) {
        if (!this.db.connection.prepare("SELECT id FROM work_items WHERE item_key = ? AND product_id = ?").get(key, scope.productId)) {
          throw notFound("Scoped work item");
        }
      }
      const run: ManagedRun = { id: randomUUID(), accountId: actor.accountId, scope, scopeDigest: digest(scope),
        version: 1, createdAt: new Date().toISOString() };
      this.db.connection.prepare(`INSERT INTO managed_runs
        (id,account_id,product_id,scope_json,scope_digest,version,created_at) VALUES (?,?,?,?,?,?,?)`)
        .run(run.id, run.accountId, scope.productId, JSON.stringify(scope), run.scopeDigest, run.version, run.createdAt);
      this.recordEvent(actor, run.id, 1, "create_run", scope.productId, input.idempotencyKey, run.scopeDigest, run);
      return run;
    });
  }

  createStage(actor: ManagedRunActor, input: ManagedRunCommand & {
    stageKey: string; role: ManagedStageRole; inputCommit: string;
  }): ManagedStage {
    requiredText(input.stageKey, "stage key");
    if (!MANAGED_STAGE_ROLES.includes(input.role) || !/^[a-fA-F0-9]{40}$/.test(input.inputCommit)) {
      throw invalidInput("Invalid stage role or input commit.");
    }
    return this.mutate(actor, input, "create_stage", input.runId, () => {
      if (this.db.connection.prepare("SELECT id FROM managed_stages WHERE run_id = ? AND stage_key = ?").get(input.runId, input.stageKey)) {
        throw conflict("stage_exists", "Stage key already exists in this run.");
      }
      const stage: ManagedStage = { id: randomUUID(), runId: input.runId, stageKey: input.stageKey,
        role: input.role, inputCommit: input.inputCommit, currentGeneration: 0, status: "ready" };
      this.db.connection.prepare(`INSERT INTO managed_stages
        (id,run_id,stage_key,role,input_commit,current_generation,status) VALUES (?,?,?,?,?,?,?)`)
        .run(stage.id, stage.runId, stage.stageKey, stage.role, stage.inputCommit, stage.currentGeneration, stage.status);
      return stage;
    });
  }

  beginAttempt(actor: ManagedRunActor, input: ManagedRunCommand & {
    stageId: string; inputCommit: string; executor: ManagedExecutor;
  }): ManagedAttempt {
    if (!input.executor || typeof input.executor !== "object") throw invalidInput("Missing execution identity.");
    for (const field of ["agentKind", "sessionRef", "resolvedModel"] as const) requiredText(input.executor[field], field);
    return this.mutate(actor, input, "begin_attempt", input.stageId, () => {
      const stage = this.getStage(actor, input.runId, input.stageId);
      if (stage.inputCommit !== input.inputCommit) throw conflict("input_changed", "Stage input commit differs.");
      if (stage.status !== "ready" && stage.status !== "failed") throw conflict("stage_not_ready", "Stage cannot start another attempt.");
      if (this.db.connection.prepare("SELECT id FROM managed_attempts WHERE run_id = ? AND status IN ('running','waiting_for_human','unknown')").get(input.runId)) {
        throw conflict("attempt_active", "An unresolved attempt still owns this run.");
      }
      const now = new Date().toISOString();
      const attempt: ManagedAttempt = { id: randomUUID(), runId: input.runId, stageId: stage.id,
        generation: stage.currentGeneration + 1, status: "running", executor: { agentKind: input.executor.agentKind,
          sessionRef: input.executor.sessionRef, resolvedModel: input.executor.resolvedModel }, result: null, createdAt: now, updatedAt: now };
      this.db.connection.prepare(`INSERT INTO managed_attempts
        (id,run_id,stage_id,generation,status,executor_json,result_json,created_at,updated_at) VALUES (?,?,?,?,?,?,NULL,?,?)`)
        .run(attempt.id, attempt.runId, attempt.stageId, attempt.generation, attempt.status, JSON.stringify(attempt.executor), now, now);
      this.db.connection.prepare("UPDATE managed_stages SET current_generation = ?, status = 'running' WHERE id = ?")
        .run(attempt.generation, stage.id);
      return attempt;
    });
  }

  recordAttemptState(actor: ManagedRunActor, input: ManagedRunCommand & {
    stageId: string; attemptId: string; generation: number; inputCommit: string;
    status: ManagedAttemptStatus; result: ManagedAttemptResult; reconciliationEvidence?: string;
  }): ManagedAttempt {
    if (!Object.hasOwn(ATTEMPT_TRANSITIONS, input.status) || !Number.isSafeInteger(input.generation) || input.generation < 1) {
      throw invalidInput("Invalid attempt status or generation.");
    }
    requiredText(input.result?.summary, "result summary", 4000);
    if (!Array.isArray(input.result.evidenceRefs) || input.result.evidenceRefs.length < 1 || input.result.evidenceRefs.length > 50) {
      throw invalidInput("Evidence references are required.");
    }
    for (const ref of input.result.evidenceRefs) requiredText(ref, "evidence reference", 1000);
    return this.mutate(actor, input, "record_attempt_state", input.attemptId, () => {
      const stage = this.getStage(actor, input.runId, input.stageId);
      const attempt = this.getAttempt(actor, input.runId, stage.id, input.attemptId);
      if (stage.inputCommit !== input.inputCommit) throw conflict("input_changed", "Stage input commit differs.");
      if (stage.currentGeneration !== input.generation || attempt.generation !== input.generation) {
        throw conflict("stale_attempt", "Attempt is no longer current.");
      }
      if (!ATTEMPT_TRANSITIONS[attempt.status].includes(input.status)) throw conflict("invalid_attempt_transition", "Attempt transition is not allowed.");
      if (attempt.status === "unknown" && (typeof input.reconciliationEvidence !== "string" || !input.reconciliationEvidence.trim())) {
        throw conflict("reconciliation_required", "Unknown delivery requires reconciliation evidence.");
      }
      if (input.reconciliationEvidence !== undefined) requiredText(input.reconciliationEvidence, "reconciliation evidence", 1000);
      const updated: ManagedAttempt = { ...attempt, status: input.status, result: {
        summary: input.result.summary, evidenceRefs: [...input.result.evidenceRefs,
          ...(input.reconciliationEvidence ? [input.reconciliationEvidence] : [])] }, updatedAt: new Date().toISOString() };
      this.db.connection.prepare("UPDATE managed_attempts SET status = ?,result_json = ?,updated_at = ? WHERE id = ?")
        .run(updated.status, JSON.stringify(updated.result), updated.updatedAt, attempt.id);
      this.db.connection.prepare("UPDATE managed_stages SET status = ? WHERE id = ?").run(updated.status, stage.id);
      return updated;
    });
  }

  getStage(actor: ManagedRunActor, runId: string, stageId: string): ManagedStage {
    this.getRun(actor, runId);
    const row = this.db.connection.prepare(`SELECT id,run_id AS runId,stage_key AS stageKey,role,
      input_commit AS inputCommit,current_generation AS currentGeneration,status FROM managed_stages WHERE id = ? AND run_id = ?`)
      .get(stageId, runId) as unknown as ManagedStage | undefined;
    if (!row) throw notFound("Managed stage");
    return row;
  }

  getAttempt(actor: ManagedRunActor, runId: string, stageId: string, attemptId: string): ManagedAttempt {
    this.getStage(actor, runId, stageId);
    const row = this.db.connection.prepare(`SELECT id,run_id AS runId,stage_id AS stageId,generation,status,
      executor_json,result_json,created_at AS createdAt,updated_at AS updatedAt FROM managed_attempts
      WHERE id = ? AND run_id = ? AND stage_id = ?`).get(attemptId, runId, stageId) as unknown as
      (Omit<ManagedAttempt, "executor" | "result"> & { executor_json: string; result_json: string | null }) | undefined;
    if (!row) throw notFound("Managed attempt");
    const { executor_json, result_json, ...attempt } = row;
    return { ...attempt, executor: JSON.parse(executor_json), result: result_json ? JSON.parse(result_json) : null };
  }

  getRun(actor: ManagedRunActor, runId: string): ManagedRun {
    const row = this.db.connection.prepare("SELECT * FROM managed_runs WHERE id = ? AND account_id = ?")
      .get(runId, actor.accountId) as unknown as RunRow | undefined;
    if (!row) throw notFound("Managed run");
    this.requireProduct(actor, row.product_id);
    return { id: row.id, accountId: row.account_id, scope: JSON.parse(row.scope_json), scopeDigest: row.scope_digest,
      version: row.version, createdAt: row.created_at };
  }

  listEvents(actor: ManagedRunActor, runId: string, after = 0, limit = 100): ManagedRunEvent[] {
    this.getRun(actor, runId);
    if (!Number.isSafeInteger(after) || after < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw invalidInput("Invalid event cursor or limit.");
    }
    return this.db.connection.prepare("SELECT event_json FROM managed_run_events WHERE run_id = ? AND sequence > ? ORDER BY sequence LIMIT ?")
      .all(runId, after, limit).map((row) => JSON.parse(row.event_json as string) as ManagedRunEvent);
  }

  private mutate<T>(actor: ManagedRunActor, input: ManagedRunCommand, operation: string, targetId: string, apply: () => T): T {
    requiredText(input.idempotencyKey, "idempotency key");
    if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 1) throw invalidInput("Invalid expected version.");
    const { idempotencyKey, ...payload } = input;
    const payloadDigest = digest(payload);
    return this.db.transaction(() => {
      const run = this.getRun(actor, input.runId);
      if (run.scope.contractRevision !== input.contractRevision || run.scopeDigest !== input.scopeDigest) {
        throw conflict("scope_changed", "Frozen scope or contract revision differs.");
      }
      const replay = this.replay<T>(actor, operation, targetId, idempotencyKey, payloadDigest);
      if (replay) return replay;
      if (run.version !== input.expectedVersion) throw conflict("stale_version", "Run has changed; reload before writing.");
      const result = apply();
      this.db.connection.prepare("UPDATE managed_runs SET version = version + 1 WHERE id = ? AND version = ?")
        .run(run.id, input.expectedVersion);
      this.recordEvent(actor, run.id, run.version + 1, operation, targetId, idempotencyKey, payloadDigest, result);
      return result;
    });
  }

  private requireProduct(actor: ManagedRunActor, productId: string): void {
    requiredText(actor.accountId, "account");
    if (!actor.productIds.includes(productId)) throw notFound("Managed product");
  }

  private replay<T>(actor: ManagedRunActor, operation: string, targetId: string, key: string, payloadDigest: string): T | undefined {
    const row = this.db.connection.prepare(`SELECT run_id,payload_digest,event_json FROM managed_run_events
      WHERE account_id = ? AND operation = ? AND target_id = ? AND idempotency_key = ?`)
      .get(actor.accountId, operation, targetId, key) as { run_id: string; payload_digest: string; event_json: string } | undefined;
    if (!row) return undefined;
    this.getRun(actor, row.run_id);
    if (row.payload_digest !== payloadDigest) throw conflict("idempotency_conflict", "Idempotency key has a different payload.");
    return (JSON.parse(row.event_json) as ManagedRunEvent).result as T;
  }

  private recordEvent(actor: ManagedRunActor, runId: string, sequence: number, operation: string,
    targetId: string, key: string, payloadDigest: string, result: unknown): void {
    const createdAt = new Date().toISOString();
    const event: ManagedRunEvent = { runId, sequence, operation, targetId, createdAt, result };
    this.db.connection.prepare(`INSERT INTO managed_run_events
      (run_id,sequence,account_id,operation,target_id,idempotency_key,payload_digest,event_json,created_at) VALUES (?,?,?,?,?,?,?,?,?)`)
      .run(runId, sequence, actor.accountId, operation, targetId, key, payloadDigest, JSON.stringify(event), createdAt);
  }
}
