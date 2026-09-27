import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import * as implementation from "./managed-run-store.js";
import { MissionGoDatabase } from "./storage/database.js";

const actor = { accountId: "account-a", productIds: ["product-a"] };
const scope = { productId: "product-a", repositoryRef: "repo-a", itemKeys: ["AND-1"], contractRevision: 1 };
const commit = "a".repeat(40);
const executor = { agentKind: "hermes", sessionRef: "test-session", resolvedModel: "test-model" };
let dir: string;
let db: MissionGoDatabase;
let path: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "managed-store-"));
  path = join(dir, "test.sqlite");
  db = new MissionGoDatabase(path);
  db.connection.exec(`
    INSERT INTO products (id,key_prefix,name,created_at,updated_at) VALUES ('product-a','AND','Test','now','now');
    INSERT INTO products (id,key_prefix,name,created_at,updated_at) VALUES ('product-b','OTH','Other','now','now');
    INSERT INTO work_items (id,item_key,sequence,product_id,type,priority,status,title,description,created_at,updated_at)
      VALUES ('item-a','AND-1',1,'product-a','task','normal','in_progress','Task','Snapshot','now','now');
    INSERT INTO work_items (id,item_key,sequence,product_id,type,priority,status,title,description,created_at,updated_at)
      VALUES ('item-b','OTH-1',1,'product-b','task','normal','ready','Other','Other','now','now');
  `);
});
afterEach(async () => { db.close(); await rm(dir, { recursive: true, force: true }); });

describe("managed run ledger", () => {
  it("binds attempt writes to the stage, input commit and execution identity", () => {
    const store = new implementation.ManagedRunStore(db);
    const run = store.createRun(actor, { scope, idempotencyKey: "create" });
    const guard = (key: string) => ({ runId: run.id, expectedVersion: store.getRun(actor, run.id).version,
      contractRevision: 1, scopeDigest: run.scopeDigest, idempotencyKey: key });
    const stage = store.createStage(actor, { ...guard("stage"), stageKey: "implement", role: "implement", inputCommit: commit });
    const otherStage = store.createStage(actor, { ...guard("other-stage"), stageKey: "review", role: "review", inputCommit: commit });
    expect(() => store.beginAttempt(actor, { ...guard("bad-input"), stageId: stage.id, inputCommit: "b".repeat(40), executor })).toThrow();
    expect(() => store.beginAttempt(actor, { ...guard("bad-model"), stageId: stage.id, inputCommit: commit, executor: { ...executor, resolvedModel: "" } })).toThrow();
    const start = { ...guard("start"), stageId: stage.id, inputCommit: commit, executor };
    const attempt = store.beginAttempt(actor, start);
    expect(store.beginAttempt(actor, start)).toEqual(attempt);
    expect(() => store.beginAttempt(actor, { ...start, executor: { ...executor, sessionRef: "other-session" } })).toThrow();
    expect(() => store.beginAttempt(actor, { ...guard("parallel"), stageId: otherStage.id, inputCommit: commit, executor }))
      .toThrow(expect.objectContaining({ code: "attempt_active" }));
    const finish = { ...guard("finish"), stageId: stage.id, attemptId: attempt.id, generation: attempt.generation,
      inputCommit: commit, status: "succeeded" as const, result: { summary: "verified", evidenceRefs: ["artifact:verified"] } };
    for (const change of [{ stageId: otherStage.id }, { generation: 100 }, { inputCommit: "b".repeat(40) },
      { result: { summary: "no evidence", evidenceRefs: [] } }, { status: "done" as never }]) {
      expect(() => store.recordAttemptState(actor, { ...finish, ...change })).toThrow();
    }
    expect(store.getAttempt(actor, run.id, stage.id, attempt.id)).toEqual(attempt);
    const complete = store.recordAttemptState(actor, finish);
    expect(store.recordAttemptState(actor, finish)).toEqual(complete);
    expect(() => store.recordAttemptState(actor, { ...finish, result: { summary: "changed", evidenceRefs: ["artifact:verified"] } })).toThrow();
  });

  it("allows only one current attempt when two real connections race", async () => {
    const store = new implementation.ManagedRunStore(db);
    const run = store.createRun(actor, { scope, idempotencyKey: "create" });
    const stage = store.createStage(actor, { runId: run.id, expectedVersion: run.version, contractRevision: 1,
      scopeDigest: run.scopeDigest, idempotencyKey: "stage", stageKey: "implement", role: "implement", inputCommit: commit });
    const input = { runId: run.id, expectedVersion: store.getRun(actor, run.id).version, contractRevision: 1,
      scopeDigest: run.scopeDigest, stageId: stage.id, inputCommit: commit, executor };
    const barrier = new SharedArrayBuffer(4);
    const workers: Worker[] = [];
    const message = (worker: Worker) => new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Worker timed out")), 8000);
      worker.once("message", (value) => { clearTimeout(timer); resolve(value); });
      worker.once("error", (error) => { clearTimeout(timer); reject(error); });
    });
    try {
      for (const key of ["race-a", "race-b"]) {
        const worker = new Worker(`
          const { parentPort, workerData } = require('node:worker_threads');
          (async () => {
            const { MissionGoDatabase } = await import(workerData.databaseUrl);
            const { ManagedRunStore } = await import(workerData.storeUrl);
            const db = new MissionGoDatabase(workerData.path);
            parentPort.postMessage({ ready: true });
            Atomics.wait(new Int32Array(workerData.barrier), 0, 0, 8000);
            try {
              const result = new ManagedRunStore(db).beginAttempt(workerData.actor, workerData.input);
              parentPort.postMessage({ ok: true, id: result.id });
            } catch (error) {
              parentPort.postMessage({ ok: false, code: error.code, errcode: error.errcode });
            } finally { db.close(); }
          })().catch(error => { throw error; });
        `, { eval: true, workerData: { path, actor, barrier, input: { ...input, idempotencyKey: key },
          databaseUrl: new URL("../dist/storage/database.js", import.meta.url).href,
          storeUrl: new URL("../dist/managed-run-store.js", import.meta.url).href } });
        workers.push(worker);
        expect(await message(worker)).toEqual({ ready: true });
      }
      const outcomes = workers.map(message);
      Atomics.store(new Int32Array(barrier), 0, 1);
      Atomics.notify(new Int32Array(barrier), 0);
      const results = await Promise.all(outcomes);
      expect(results.filter((result) => result.ok)).toHaveLength(1);
      const loser = results.find((result) => !result.ok)!;
      expect(loser.code === "stale_version" || (loser.code === "ERR_SQLITE_ERROR" && loser.errcode === 5)).toBe(true);
      expect(db.connection.prepare("SELECT count(*) AS n FROM managed_attempts WHERE run_id = ?").get(run.id)).toEqual({ n: 1 });
      expect(store.getStage(actor, run.id, stage.id).currentGeneration).toBe(1);
      expect(store.listEvents(actor, run.id).map((event) => event.sequence)).toEqual([1, 2, 3]);
    } finally { await Promise.all(workers.map((worker) => worker.terminate())); }
  });

  it("rejects stale versions, scope revisions, wrong owners and cross-run references without adding events", () => {
    const store = new implementation.ManagedRunStore(db);
    const run = store.createRun(actor, { scope, idempotencyKey: "create" });
    const command = { runId: run.id, expectedVersion: run.version, contractRevision: 1, scopeDigest: run.scopeDigest,
      idempotencyKey: "stage", stageKey: "review", role: "review" as const, inputCommit: commit };
    for (const invalid of [{ scopeDigest: "wrong" }, { contractRevision: 2 }, { expectedVersion: 0 },
      { expectedVersion: 100 }, { inputCommit: "not-a-commit" }, { inputCommit: commit + "\n" }, { role: "invalid" as never }]) {
      expect(() => store.createStage(actor, { ...command, ...invalid })).toThrow();
    }
    expect(store.listEvents(actor, run.id)).toHaveLength(1);
    const stage = store.createStage(actor, command);
    expect(store.createStage(actor, command)).toEqual(stage);
    expect(() => store.createStage(actor, { ...command, idempotencyKey: "stale", stageKey: "verify" }))
      .toThrow(expect.objectContaining({ code: "stale_version" }));
    expect(() => store.createStage(actor, { ...command, inputCommit: "b".repeat(40) }))
      .toThrow(expect.objectContaining({ code: "idempotency_conflict" }));
    const other = store.createRun(actor, { scope, idempotencyKey: "other" });
    expect(() => store.getStage(actor, other.id, stage.id)).toThrow();
    expect(() => store.getStage({ ...actor, accountId: "other" }, run.id, stage.id)).toThrow();
    expect(() => store.listEvents({ ...actor, productIds: [] }, run.id)).toThrow();
    expect(() => store.listEvents(actor, run.id, -1)).toThrow();
    expect(() => store.listEvents(actor, run.id, 0, 101)).toThrow();
    expect(() => store.createRun(actor, { scope: { ...scope, itemKeys: ["AND-1", "OTH-1"] }, idempotencyKey: "mixed" }))
      .toThrow(expect.objectContaining({ code: "not_found" }));
  });

  it("rolls back stage and attempt state when event insertion fails", () => {
    const store = new implementation.ManagedRunStore(db);
    const run = store.createRun(actor, { scope, idempotencyKey: "create" });
    const guard = (key: string) => ({ runId: run.id, expectedVersion: store.getRun(actor, run.id).version,
      contractRevision: 1, scopeDigest: run.scopeDigest, idempotencyKey: key });
    const stage = store.createStage(actor, { ...guard("stage"), stageKey: "implement", role: "implement", inputCommit: commit });
    const before = store.getRun(actor, run.id);
    db.connection.exec("CREATE TRIGGER reject_test_event BEFORE INSERT ON managed_run_events BEGIN SELECT RAISE(ABORT, 'test failure'); END;");
    expect(() => store.beginAttempt(actor, { ...guard("start"), stageId: stage.id, inputCommit: commit, executor })).toThrow("test failure");
    expect(store.getStage(actor, run.id, stage.id)).toEqual(stage);
    expect(store.getRun(actor, run.id)).toEqual(before);
    expect(db.connection.prepare("SELECT count(*) AS n FROM managed_attempts").get()).toEqual({ n: 0 });
    db.connection.exec("DROP TRIGGER reject_test_event;");
    const attempt = store.beginAttempt(actor, { ...guard("start"), stageId: stage.id, inputCommit: commit, executor });
    db.connection.exec("CREATE TRIGGER reject_test_event BEFORE INSERT ON managed_run_events BEGIN SELECT RAISE(ABORT, 'test failure'); END;");
    expect(() => store.recordAttemptState(actor, { ...guard("finish"), stageId: stage.id, attemptId: attempt.id,
      generation: attempt.generation, inputCommit: commit, status: "succeeded", result: { summary: "result", evidenceRefs: ["artifact:test"] } })).toThrow();
    expect(store.getAttempt(actor, run.id, stage.id, attempt.id)).toEqual(attempt);
    expect(store.getStage(actor, run.id, stage.id).status).toBe("running");
    expect(store.listEvents(actor, run.id).map((event) => event.sequence)).toEqual([1, 2, 3]);
  });

  it("retains immutable history when an original work item is deleted", () => {
    const store = new implementation.ManagedRunStore(db);
    const run = store.createRun(actor, { scope, idempotencyKey: "create" });
    expect(() => db.connection.prepare("UPDATE managed_runs SET scope_json = '{}' WHERE id = ?").run(run.id)).toThrow();
    expect(() => db.connection.prepare("UPDATE managed_run_events SET event_json = '{}' WHERE run_id = ?").run(run.id)).toThrow();
    expect(() => db.connection.prepare("DELETE FROM managed_run_events WHERE run_id = ?").run(run.id)).toThrow();
    db.connection.exec("DELETE FROM work_items WHERE id='item-a';");
    expect(store.getRun(actor, run.id)).toEqual(run);
    expect(store.createRun(actor, { scope, idempotencyKey: "create" })).toEqual(run);
    expect(db.connection.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });

  it("keeps unknown attempts fenced until evidence resolves them and rejects late old results", () => {
    const store = new implementation.ManagedRunStore(db);
    expect(store).toHaveProperty("recordAttemptState");
    const run = store.createRun(actor, { scope, idempotencyKey: "create" });
    const guard = (key: string) => ({ runId: run.id, expectedVersion: store.getRun(actor, run.id).version,
      contractRevision: 1, scopeDigest: run.scopeDigest, idempotencyKey: key });
    const stage = store.createStage(actor, { ...guard("stage"), stageKey: "implement", role: "implement", inputCommit: commit });
    const attempt = store.beginAttempt(actor, { ...guard("start"), stageId: stage.id, inputCommit: commit, executor });
    const result = { summary: "Observed locally", evidenceRefs: ["artifact:check"] };
    const identity = { stageId: stage.id, attemptId: attempt.id, generation: attempt.generation, inputCommit: commit };
    store.recordAttemptState(actor, { ...guard("wait"), ...identity, status: "waiting_for_human", result });
    store.recordAttemptState(actor, { ...guard("unknown"), ...identity, status: "unknown", result });
    expect(() => store.beginAttempt(actor, { ...guard("retry"), stageId: stage.id, inputCommit: commit, executor })).toThrow();
    expect(() => store.recordAttemptState(actor, { ...guard("resolve"), ...identity, status: "failed", result }))
      .toThrow(expect.objectContaining({ code: "reconciliation_required" }));
    const failedCommand = { ...guard("resolve"), ...identity, status: "failed" as const, result, reconciliationEvidence: "artifact:stopped" };
    const failed = store.recordAttemptState(actor, failedCommand);
    expect(failed.result?.evidenceRefs).toContain("artifact:stopped");
    const next = store.beginAttempt(actor, { ...guard("retry"), stageId: stage.id, inputCommit: commit, executor });
    expect(next.generation).toBe(attempt.generation + 1);
    expect(() => store.recordAttemptState(actor, { ...guard("late"), ...identity, status: "succeeded", result }))
      .toThrow(expect.objectContaining({ code: "stale_attempt" }));
    expect(store.recordAttemptState(actor, failedCommand)).toEqual(failed);
    expect(store.getAttempt(actor, run.id, stage.id, next.id).status).toBe("running");
    store.recordAttemptState(actor, { ...guard("done"), ...identity, attemptId: next.id, generation: next.generation, status: "succeeded", result });
    expect(() => store.recordAttemptState(actor, { ...guard("rewrite"), ...identity, attemptId: next.id, generation: next.generation, status: "failed", result })).toThrow();
    expect(store.getStage(actor, run.id, stage.id).status).toBe("succeeded");
    expect(db.connection.prepare("SELECT status FROM work_items WHERE id='item-a'").get()).toEqual({ status: "in_progress" });
  });

  it("persists a stage and its native execution reference with ordered events", () => {
    const store = new implementation.ManagedRunStore(db);
    expect(store).toHaveProperty("createStage");
    const run = store.createRun(actor, { scope, idempotencyKey: "create" });
    const guard = (key: string) => ({ runId: run.id, expectedVersion: store.getRun(actor, run.id).version,
      contractRevision: scope.contractRevision, scopeDigest: run.scopeDigest, idempotencyKey: key });
    const stage = store.createStage(actor, { ...guard("stage"), stageKey: "implement", role: "implement", inputCommit: commit });
    const attempt = store.beginAttempt(actor, { ...guard("attempt"), stageId: stage.id, inputCommit: commit, executor });
    db.close(); db = new MissionGoDatabase(path);
    const reopened = new implementation.ManagedRunStore(db);
    expect(reopened.getStage(actor, run.id, stage.id)).toEqual({ ...stage, currentGeneration: 1, status: "running" });
    expect(reopened.getAttempt(actor, run.id, stage.id, attempt.id)).toEqual(attempt);
    expect(attempt.executor).toEqual(executor);
    expect(reopened.listEvents(actor, run.id).map((event) => event.sequence)).toEqual([1, 2, 3]);
    expect(reopened.listEvents(actor, run.id, 1, 1).map((event) => event.operation)).toEqual(["create_stage"]);
  });

  it("replays creation by account/operation/target/key and rejects a changed payload", () => {
    const store = new implementation.ManagedRunStore(db);
    const input = { scope, idempotencyKey: "same" };
    const run = store.createRun(actor, input);
    expect(store.createRun(actor, input)).toEqual(run);
    expect(() => store.createRun(actor, { ...input, scope: { ...scope, contractRevision: 2 } }))
      .toThrow(expect.objectContaining({ code: "idempotency_conflict" }));
    expect(store.listEvents(actor, run.id)).toHaveLength(1);
    expect(store.createRun({ ...actor, accountId: "account-b" }, input).id).not.toBe(run.id);
    expect(() => store.getRun({ ...actor, accountId: "account-b" }, run.id)).toThrow();
    expect(() => store.createRun({ ...actor, productIds: [] }, input)).toThrow();
    expect(() => store.createRun(actor, { ...input, scope: { ...scope, itemKeys: ["OTH-1"] } })).toThrow();
  });

  it("persists a frozen run and its creation event across restart without touching work items", () => {
    expect(implementation).toHaveProperty("ManagedRunStore");
    const store = new implementation.ManagedRunStore(db);
    const run = store.createRun(actor, { scope, idempotencyKey: "create-1" });
    expect(run.scope).toEqual(scope);
    expect(run.version).toBe(1);
    db.close(); db = new MissionGoDatabase(path);
    const reopened = new implementation.ManagedRunStore(db);
    expect(reopened.getRun(actor, run.id)).toEqual(run);
    expect(reopened.listEvents(actor, run.id).map((event) => event.operation)).toEqual(["create_run"]);
    expect(db.connection.prepare("SELECT status FROM work_items WHERE id='item-a'").get()).toEqual({ status: "in_progress" });
  });
});
