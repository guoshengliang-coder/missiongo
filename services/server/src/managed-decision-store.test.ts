import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { afterEach, beforeEach, expect, it } from "vitest";
import type { ManagedDecision, ManagedDecisionContent } from "@missiongo/domain";
import { MissionGoDatabase } from "./storage/database.js";
import { ManagedRunStore } from "./managed-run-store.js";
import * as implementation from "./managed-decision-store.js";

let dir: string;
let path: string;
let db: MissionGoDatabase;
const actor = { accountId: "owner", productIds: ["p"] };
const access = (productId: string) => { expect(productId).toBe("p"); return actor.accountId; };
const content: ManagedDecisionContent = { title: "Approval", recommendation: "Implement in isolation",
  alternatives: ["Defer: no new capability"], costs: "Local test resources",
  acceptanceCriteria: ["Authentication tests pass"], allowedActions: ["implement", "review", "verify"] };
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "decision-store-")); path = join(dir, "test.sqlite");
  db = new MissionGoDatabase(path);
  db.connection.exec(`INSERT INTO products(id,key_prefix,name,created_at,updated_at) VALUES ('p','AND','Test','now','now');
    INSERT INTO work_items(id,item_key,sequence,product_id,type,priority,status,title,description,created_at,updated_at)
    VALUES ('i','AND-1',1,'p','task','normal','ready','Task','Unchanged','now','now');`);
});
afterEach(async () => { db.close(); await rm(dir, { recursive: true, force: true }); });
function setup() {
  const run = new ManagedRunStore(db).createRun(actor, { scope: { productId: "p", repositoryRef: "repo", itemKeys: ["AND-1"], contractRevision: 1 }, idempotencyKey: "run" });
  const store = new implementation.ManagedDecisionStore(db);
  const input = { runId: run.id, decisionKey: "implementation", content, scopeDigest: run.scopeDigest, contractRevision: 1, idempotencyKey: "create" };
  return { store, run, input };
}
it("rolls back approval if its audit receipt fails, and rechecks every scoped item", () => {
  const { store, input } = setup();
  const d = store.create(access, input);
  db.connection.exec("CREATE TRIGGER fail_decision_event BEFORE INSERT ON decision_events WHEN NEW.operation='approve' BEGIN SELECT RAISE(ABORT,'audit failure'); END;");
  expect(() => store.change(access, d.id, "approve", guard(d, "approve"))).toThrow("audit failure");
  expect(store.get(access, d.id)).toEqual(d);
  expect(store.listEvents(access, d.id)).toHaveLength(1);
  db.connection.exec("DROP TRIGGER fail_decision_event;");
  expect(() => store.get(() => "other-owner", d.id)).toThrow(expect.objectContaining({ code: "not_found" }));
  const approved = store.change(access, d.id, "approve", guard(d, "approve"));
  expect(() => store.change(access, d.id, "approve", { ...guard(d, "approve"), stateVersion: 99 })).toThrow(expect.objectContaining({ code: "idempotency_conflict" }));
  expect(() => store.change(() => { throw new Error("permission revoked"); }, d.id, "approve", guard(d, "approve"))).toThrow("permission revoked");
  db.connection.exec("INSERT INTO products(id,key_prefix,name,created_at,updated_at) VALUES ('other','OTH','Other','now','now'); UPDATE work_items SET product_id='other' WHERE item_key='AND-1';");
  for (const operation of [() => store.get(access, d.id), () => store.listEvents(access, d.id),
    () => store.change(access, d.id, "revoke", guard(approved, "revoke")), () => store.create(access, input)]) expect(operation).toThrow();
  expect(db.connection.prepare("SELECT count(*) AS n FROM decision_events").get()).toEqual({ n: 2 });
});

it("serializes conflicting approvals and revocations from two real SQLite connections", async () => {
  const { store, input } = setup();
  const d = store.create(access, input);
  const barrier = new SharedArrayBuffer(4);
  const workers: Worker[] = [];
  const message = (worker: Worker) => new Promise<{ ready?: boolean; ok?: boolean; code?: string; errcode?: number }>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Worker timed out")), 8000);
    worker.once("message", (value) => { clearTimeout(timer); resolve(value); });
    worker.once("error", (error) => { clearTimeout(timer); reject(error); });
  });
  try {
    for (const operation of ["approve", "revoke"]) {
      const worker = new Worker(`const { parentPort,workerData:w } = require('node:worker_threads');
        (async () => {
          const { MissionGoDatabase } = await import(w.databaseUrl);
          const { ManagedDecisionStore } = await import(w.storeUrl);
          const db = new MissionGoDatabase(w.path);
          parentPort.postMessage({ ready: true });
          Atomics.wait(new Int32Array(w.barrier),0,0,8000);
          try { new ManagedDecisionStore(db).change(()=>'owner',w.id,w.operation,w.input); parentPort.postMessage({ok:true}); }
          catch(error) { parentPort.postMessage({ok:false,code:error.code,errcode:error.errcode}); }
          finally { db.close(); }
        })().catch(error=>{throw error;});`, { eval: true, workerData: {
          path, barrier, id: d.id, operation, input: guard(d, operation),
          databaseUrl: new URL("../dist/storage/database.js", import.meta.url).href,
          storeUrl: new URL("../dist/managed-decision-store.js", import.meta.url).href,
        } });
      workers.push(worker); expect(await message(worker)).toEqual({ ready: true });
    }
    const outcomes = workers.map(message);
    Atomics.store(new Int32Array(barrier), 0, 1); Atomics.notify(new Int32Array(barrier), 0);
    const results = await Promise.all(outcomes);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    const loser = results.find((r) => !r.ok)!;
    expect(loser.code === "decision_changed" || (loser.code === "ERR_SQLITE_ERROR" && loser.errcode === 5)).toBe(true);
    expect(store.get(access, d.id).stateVersion).toBe(2);
    expect(store.listEvents(access, d.id).map((e) => e.sequence)).toEqual([1, 2]);
  } finally { await Promise.all(workers.map((w) => w.terminate())); }
});

function guard(d: ManagedDecision, key: string) {
  return { version: d.version, stateVersion: d.stateVersion, contentDigest: d.contentDigest, scopeDigest: d.scopeDigest,
    contractRevision: d.scope.contractRevision, idempotencyKey: key };
}
it("binds approval to current content and prevents a revoked receipt from resurrecting authority", () => {
  const { store, input } = setup();
  const d = store.create(access, input);
  const request = guard(d, "approve");
  const approved = store.change(access, d.id, "approve", request);
  expect(approved).toMatchObject({ status: "approved", stateVersion: 2, approval: { accountId: "owner" } });
  expect(store.change(access, d.id, "approve", request)).toEqual(approved);
  const revoke = guard(approved, "revoke");
  const revoked = store.change(access, d.id, "revoke", revoke);
  expect(revoked).toMatchObject({ status: "revoked", stateVersion: 3, approval: null });
  expect(store.change(access, d.id, "revoke", revoke)).toEqual(revoked);
  expect(() => store.change(access, d.id, "approve", request)).toThrow(expect.objectContaining({ code: "decision_changed" }));
  expect(store.listEvents(access, d.id)).toHaveLength(3);
});

it("revisions invalidate only their own approval while explanations preserve approved content", () => {
  const { store, input } = setup();
  const a = store.create(access, input);
  const b = store.create(access, { ...input, decisionKey: "independent", idempotencyKey: "other" });
  const approved = store.change(access, a.id, "approve", guard(a, "approve"));
  const otherApproved = store.change(access, b.id, "approve", guard(b, "approve"));
  const explained = store.change(access, a.id, "explain", { ...guard(approved, "explain"), explanation: "Clarification only; no authority" });
  expect(explained).toMatchObject({ status: "approved", version: 1, stateVersion: 2, contentDigest: approved.contentDigest, approval: approved.approval });
  const same = store.change(access, a.id, "revise", { ...guard(explained, "identical"), content });
  expect(same).toMatchObject({ version: 1, stateVersion: 2, status: "approved" });
  const revised = store.change(access, a.id, "revise", { ...guard(same, "revise"), content: { ...content, costs: "Changed cost" } });
  expect(revised).toMatchObject({ version: 2, stateVersion: 3, status: "pending", approval: null, explanation: "" });
  expect(store.get(access, b.id)).toEqual(otherApproved);
  expect(() => store.change(access, a.id, "approve", guard(a, "approve"))).toThrow(expect.objectContaining({ code: "decision_changed" }));
  const revoked = store.change(access, a.id, "revoke", guard(revised, "revoke"));
  expect(() => store.change(access, a.id, "approve", guard(revoked, "retry"))).toThrow();
});

it("requires a current approved binding and an explicitly allowed action", () => {
  const { store, input } = setup();
  const d = store.create(access, { ...input, content: { ...content, allowedActions: ["review"] } });
  const binding = (x: ManagedDecision) => ({ ...guard(x, "ignored"), runId: x.runId, action: "review" as const });
  expect(() => store.requireApproval(access, d.id, binding(d))).toThrow();
  const approved = store.change(access, d.id, "approve", guard(d, "approve"));
  expect(store.requireApproval(access, d.id, binding(approved))).toEqual(approved);
  for (const change of [{ runId: "other-run" }, { action: "implement" as const }, { action: "merge" as never },
    { version: 999 }, { scopeDigest: "wrong" }, { contractRevision: 999 }, { contentDigest: "wrong" }]) {
    expect(() => store.requireApproval(access, d.id, { ...binding(approved), ...change })).toThrow();
  }
  store.change(access, d.id, "revoke", guard(approved, "revoke"));
  expect(() => store.requireApproval(access, d.id, binding(approved))).toThrow();
});

it("replays a substantive revision only while its committed result remains current", () => {
  const { store, input } = setup();
  const d = store.create(access, input);
  const request = { ...guard(d, "revision-replay"), content: { ...content, costs: "new reviewed costs" } };
  const revised = store.change(access, d.id, "revise", request);
  expect(store.change(access, d.id, "revise", request)).toEqual(revised);
  expect(() => store.change(access, d.id, "revise", { ...request, content: { ...content, costs: "different payload" } })).toThrow(/Idempotency/);
  expect(() => store.change(() => { throw new Error("permission revoked"); }, d.id, "revise", request)).toThrow("permission revoked");
  expect(store.listEvents(access, d.id).map((e) => e.operation)).toEqual(["create", "revise"]);
  const clarified = store.change(access, d.id, "explain", { ...guard(revised, "clarify-revision"), explanation: "Current explanation" });
  expect(store.change(access, d.id, "revise", request)).toEqual(clarified);
  expect(() => store.change(access, d.id, "revise", { ...request, idempotencyKey: "new-key-old-guard" })).toThrow(/Reload/);
  const again = store.change(access, d.id, "revise", { ...guard(revised, "new-revision"), content: { ...content, costs: "later change" } });
  expect(() => store.change(access, d.id, "revise", request)).toThrow(/no longer current/);
  const approved = store.change(access, d.id, "approve", guard(again, "approve-later"));
  store.change(access, d.id, "revoke", guard(approved, "revoke-later"));
  expect(() => store.change(access, d.id, "revise", request)).toThrow(/no longer current/);
});

it("rejects creation receipts after their approval binding changes", () => {
  const { store, input } = setup();
  for (const action of ["revise", "approve", "revoke"] as const) {
    const request = { ...input, decisionKey: `create-replay-${action}` };
    const d = store.create(access, request);
    const next = store.change(access, d.id, action, { ...guard(d, action), ...(action === "revise" ? { content: { ...content, costs: "Revised cost" } } : {}) });
    expect(() => store.create(access, request)).toThrow(/no longer current/);
    expect(store.get(access, d.id)).toEqual(next);
    expect(store.listEvents(access, d.id)).toHaveLength(2);
  }
  const request = { ...input, decisionKey: "create-explanation" };
  const d = store.create(access, request);
  const explained = store.change(access, d.id, "explain", { ...guard(d, "note"), explanation: "Current note" });
  expect(store.create(access, request)).toEqual(explained);
  expect(store.listEvents(access, d.id)).toHaveLength(2);
  expect(() => store.create(access, { ...request, content: { ...content, costs: "Other payload" } })).toThrow(/Idempotency/);
  expect(() => store.create(() => { throw new Error("permission revoked"); }, request)).toThrow("permission revoked");
});

it("persists a scoped pending decision and its idempotent creation receipt without execution", () => {
  const { store, run, input } = setup();
  const decision = store.create(access, input);
  expect(decision).toMatchObject({ runId: run.id, scope: run.scope, version: 1, stateVersion: 1, status: "pending", content, approval: null });
  expect(store.create(access, input)).toEqual(decision);
  expect(() => store.create(access, { ...input, content: { ...content, costs: "Different cost" } })).toThrow(expect.objectContaining({ code: "idempotency_conflict" }));
  expect(store.listEvents(access, decision.id)).toHaveLength(1);
  db.close(); db = new MissionGoDatabase(path);
  expect(new implementation.ManagedDecisionStore(db).get(access, decision.id)).toEqual(decision);
  expect(db.connection.prepare("SELECT * FROM managed_attempts").all()).toEqual([]);
  expect(db.connection.prepare("SELECT status FROM work_items").get()).toEqual({ status: "ready" });
});
