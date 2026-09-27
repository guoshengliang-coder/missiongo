import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { MissionGoDatabase } from "./storage/database.js";
import { ManagedRunStore } from "./managed-run-store.js";
import { ManagedDecisionStore } from "./managed-decision-store.js";
import { AgentSessionStore } from "./agent-session-store.js";
import { ManagedExecutionStore } from "./managed-execution-store.js";
import { restoreNodeOwnership } from "./test-fixtures/before-dispatch-separation.js";

let sequence = 0;
let db: MissionGoDatabase;
let dir: string;
const access = () => "owner";
beforeEach(async () => {
  sequence = 0;
  dir = await mkdtemp(join(tmpdir(), "managed-control-"));
  db = new MissionGoDatabase(join(dir, "test.sqlite"));
  db.connection.exec(`INSERT INTO products(id,key_prefix,name,created_at,updated_at) VALUES ('p','AND','Test','now','now');
    INSERT INTO work_items(id,item_key,sequence,product_id,type,priority,status,title,description,created_at,updated_at)
    VALUES ('i','AND-1',1,'p','task','normal','ready','Task','Data only','now','now');
    INSERT INTO nodes(id,account_id,installation_id,name,token_hash,agents_json,created_at,updated_at) VALUES ('n','owner','install','Node','synthetic','[{"kind":"codex","models":[]}]','now','now');
    INSERT INTO node_product_repos(id,node_id,product_id,repo_path,created_at,updated_at) VALUES ('repo','n','p','/synthetic/repo','now','now');`);
});
afterEach(async () => { db.close(); await rm(dir, { recursive: true, force: true }); });
function setup(_registerExecutor = true, runKey = "run", nodeId = "n", repositoryRef = "repo") {
  const runs = new ManagedRunStore(db);
  const run = runs.createRun({ accountId: "owner", productIds: ["p"] }, { scope: {
    productId: "p", repositoryRef, itemKeys: ["AND-1"], contractRevision: 1,
  }, idempotencyKey: runKey });
  const decisions = new ManagedDecisionStore(db);
  let decision = decisions.create(access, { runId: run.id, decisionKey: "d", scopeDigest: run.scopeDigest,
    contractRevision: 1, idempotencyKey: "create", content: { title: "Task", recommendation: "Local work",
      alternatives: ["Defer"], costs: "Tests", acceptanceCriteria: ["Pass"], allowedActions: ["implement", "review", "verify"] } });
  const guard = (key: string) => ({ version: decision.version, stateVersion: decision.stateVersion, contentDigest: decision.contentDigest,
    scopeDigest: decision.scopeDigest, contractRevision: 1, idempotencyKey: key });
  decision = decisions.change(access, decision.id, "approve", guard("approve"));
  const input = { runId: run.id, decisionId: decision.id, ...guard("start"), stageKey: "implement-1", role: "implement" as const,
    inputCommit: "a".repeat(40), nodeId, permissionMode: "workspace-write" as const };
  const store = new ManagedExecutionStore(db, true);
  if (_registerExecutor) store.registerExecutor(access, nodeId, { mode: "single_node_local", evidence: "fixture:exclusive-local-installation" });
  return { store, decisions, decision, guard, run, input };
}
it.each(["message", "settings", "restore", "delivery"])("AND-235 ordinary %s ignores another managed unknown", (control) => {
  const { store, input } = setup();
  db.connection.exec(`INSERT INTO dispatches(id,account_id,node_id,agent_kind,mode,status,repo_path,created_at)
    VALUES ('ordinary','owner','n','codex','plan','failed','/synthetic/repo','now');`);
  const sessions = new AgentSessionStore(db);
  const id = sessions.createForDispatch({ dispatchId: "ordinary", nodeId: "n", sessionRef: "ordinary-thread" });
  const queued = control === "delivery" ? sessions.enqueue("owner", id, "Queued before managed") : undefined;
  if (control === "restore") {
    sessions.setArchived("owner", id, true);
    db.connection.prepare("UPDATE agent_sessions SET source_archived_at='now' WHERE id=?").run(id);
  }
  const intent = store.request(access, input);
  store.claim(access, "n", intent.id, 1); store.permit(access, "n", intent.id, 1);
  store.report(access, "n", intent.id, { sequence: 1, generation: 1, state: "unknown" });
  if (control === "message") expect(sessions.enqueue("owner", id, "Continue").status).toBe("queued");
  if (control === "settings") {
    expect(() => sessions.requestSettings("owner", id, { mode: "auto" })).not.toThrow();
    expect(sessions.listForNode("n").find((s) => s.id === id)?.desiredSettings?.mode).toBe("auto");
  }
  if (control === "restore") {
    expect(() => sessions.setArchived("owner", id, false)).not.toThrow();
    expect(sessions.listForNode("n").find((s) => s.id === id)?.restoreInSource).toBe(true);
  }
  if (queued) {
    expect(sessions.listForNode("n").find((s) => s.id === id)?.command?.id).toBe(queued.id);
    expect(() => sessions.recordSnapshot({ nodeId: "n", sessionId: id, status: "idle", messages: [], commandId: queued.id, commandStatus: "delivering" })).not.toThrow();
  }
});
it("AND-235 keeps ordinary controls available during managed unknown and stop reconciliation", () => {
  const { store, input } = setup();
  const intent = store.request(access, input);
  store.claim(access, "n", intent.id, 1); store.permit(access, "n", intent.id, 1);
  store.report(access, "n", intent.id, { sequence: 1, generation: 1, state: "unknown" });
  store.stop(access, intent.id, 1);
  db.connection.exec(`INSERT INTO dispatches(id,account_id,node_id,agent_kind,mode,status,repo_path,created_at)
    VALUES ('ordinary','owner','n','codex','plan','queued','/synthetic/repo','now');
    UPDATE dispatches SET status='delivered' WHERE id='ordinary';`);
  const sessions = new AgentSessionStore(db);
  const id = sessions.createForDispatch({ dispatchId: "ordinary", nodeId: "n", sessionRef: "ordinary-thread" });
  sessions.requestSettings("owner", id, { mode: "auto" });
  sessions.setArchived("owner", id, true);
  sessions.setArchived("owner", id, false);
  const command = sessions.enqueue("owner", id, "Continue ordinary work");
  expect(sessions.listForNode("n").find((s) => s.id === id)?.command?.id).toBe(command.id);
  expect(() => sessions.recordSnapshot({ nodeId: "n", sessionId: id, status: "idle", messages: [], commandId: command.id, commandStatus: "delivering" })).not.toThrow();
  expect(store.get(access, intent.id)).toMatchObject({ state: "unknown", ownershipHeld: true, stopRequested: true });
});
it("AND-235 permits separate managed batches on one repository while fencing the unknown batch", () => {
  const { store, input } = setup();
  const first = store.request(access, input);
  store.claim(access, "n", first.id, 1); store.permit(access, "n", first.id, 1);
  store.report(access, "n", first.id, { sequence: 1, generation: 1, state: "unknown" });
  const second = setup(true, "separate-batch");
  const intent = second.store.request(access, second.input);
  expect(intent.id).not.toBe(first.id);
  second.store.claim(access, "n", intent.id, 1);
  expect(second.store.permit(access, "n", intent.id, 1).mayStart).toBe(true);
  expect(store.permit(access, "n", first.id, 1).mayStart).toBe(false);
  expect(() => store.request(access, { ...input, idempotencyKey: "replacement" })).toThrow();
  expect(db.connection.prepare("SELECT id FROM managed_execution_intents WHERE ownership_held=1").all()).toHaveLength(2);
});
it("AND-235 upgrades old unknown intents without changing receipts, attempts or audit evidence", () => {
  const { store, input } = setup();
  db.connection.exec(`INSERT INTO dispatches(id,account_id,node_id,agent_kind,mode,status,repo_path,created_at,delivered_at)
    VALUES ('manual-history','owner','n','codex','default','launched','/synthetic/repo','now','delivery');
    INSERT INTO dispatch_items(dispatch_id,item_id,position) VALUES ('manual-history','i',0);`);
  store.reconcileManual(access, "manual-history", { generation: 1, deliveredAt: "delivery", evidence: "fixture:stopped" });
  const intent = store.request(access, input);
  store.claim(access, "n", intent.id, 1); store.permit(access, "n", intent.id, 1);
  const observation = { sequence: 1, generation: 1, state: "unknown" as const, sessionRef: "old-native", resolvedModel: "old-model" };
  store.report(access, "n", intent.id, observation);
  restoreNodeOwnership(db.connection);
  const tables = ["managed_execution_intents", "managed_execution_bindings", "managed_execution_events",
    "managed_execution_observations", "managed_manual_reconciliations", "managed_attempts", "managed_run_events", "agent_sessions",
    "managed_executor_registrations", "managed_execution_inputs", "managed_runs", "managed_stages", "decision_records", "decision_events"];
  const rows = () => tables.map((table) => db.connection.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all());
  const before = rows();
  db.close(); db = new MissionGoDatabase(join(dir, "test.sqlite"));
  expect(rows()).toEqual(before);
  expect(() => db.connection.prepare("DELETE FROM managed_execution_observations WHERE intent_id=?").run(intent.id)).toThrow("immutable observation");
  expect(() => db.connection.prepare("DELETE FROM managed_execution_events WHERE intent_id=?").run(intent.id)).toThrow("immutable execution event");
  const restarted = new ManagedExecutionStore(db, true);
  expect(restarted.report(access, "n", intent.id, observation)).toMatchObject({ state: "unknown", ownershipHeld: true });
  expect(restarted.permit(access, "n", intent.id, 1).mayStart).toBe(false);
  expect(() => restarted.request(access, { ...input, idempotencyKey: "replacement" })).toThrow();
  const other = setup(true, "after-upgrade");
  expect(other.store.request(access, other.input).ownershipHeld).toBe(true);
  expect(db.connection.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
});
it("AND-235 synthetic Agent adapter runs ordinary and managed worktrees sharing one Git common directory", async () => {
  // Real Git and SQLite; native model execution is intentionally synthetic.
  // Disable user/system Git configuration for this isolated test repository.
  const git = (args: string[], cwd = dir) => execFileSync("git", args, { cwd, encoding: "utf8",
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_AUTHOR_NAME: "Fixture", GIT_AUTHOR_EMAIL: "fixture@example.test",
      GIT_COMMITTER_NAME: "Fixture", GIT_COMMITTER_EMAIL: "fixture@example.test" }, stdio: ["pipe", "pipe", "pipe"] }).trim();
  const repo = join(dir, "repository");
  git(["init", repo]);
  git(["commit", "--allow-empty", "-m", "Synthetic worktree fixture"], repo);
  const commit = git(["rev-parse", "HEAD"], repo);
  db.connection.prepare("UPDATE node_product_repos SET repo_path=? WHERE id='repo'").run(repo);
  const ordinaryTree = join(dir, "missiongo-ordinary");
  git(["worktree", "add", "--detach", ordinaryTree, commit], repo);
  db.connection.prepare(`INSERT INTO dispatches(id,account_id,node_id,agent_kind,mode,status,repo_path,created_at,delivered_at)
    VALUES ('ordinary-tree','owner','n','codex','plan','launched',?,'now','delivery')`).run(repo);
  const first = setup();
  const one = first.store.request(access, { ...first.input, inputCommit: commit });
  const launchSynthetic = (intent: typeof one) => {
    first.store.claim(access, "n", intent.id, intent.generation);
    if (!first.store.permit(access, "n", intent.id, intent.generation).mayStart) return undefined;
    const tree = join(dir, "missiongo-managed-" + intent.id);
    git(["worktree", "add", "--detach", tree, commit], repo);
    return tree;
  };
  const firstTree = launchSynthetic(one)!;
  first.store.report(access, "n", one.id, { sequence: 1, generation: 1, state: "unknown" });
  const second = setup(true, "parallel-tree");
  const two = second.store.request(access, { ...second.input, inputCommit: commit });
  const secondTree = launchSynthetic(two)!;
  await Promise.all([ordinaryTree, firstTree, secondTree].map((tree) => writeFile(join(tree, "independent.txt"), tree)));
  const common = [ordinaryTree, firstTree, secondTree].map((tree) => git(["rev-parse", "--path-format=absolute", "--git-common-dir"], tree));
  expect(new Set(common).size).toBe(1);
  expect(launchSynthetic(one)).toBeUndefined();
  expect(launchSynthetic(two)).toBeUndefined();
  expect(() => git(["worktree", "add", "--detach", firstTree, commit], repo)).toThrow();
  for (const tree of [ordinaryTree, firstTree, secondTree]) expect(await readFile(join(tree, "independent.txt"), "utf8")).toBe(tree);
  expect(first.store.get(access, one.id)).toMatchObject({ state: "unknown", ownershipHeld: true });
});
it("persists an approved start intent without inventing an AND-230 runtime attempt", () => {
  const { store, input } = setup();
  const intent = store.request(access, input);
  expect(intent).toMatchObject({ state: "requested", generation: 1, attemptId: null, sessionId: null, ownershipHeld: true });
  expect(db.connection.prepare("SELECT * FROM managed_attempts").all()).toHaveLength(0);
  expect(store.request(access, input)).toEqual(intent);
  expect(() => store.request(access, { ...input, inputCommit: "b".repeat(40) })).toThrow(expect.objectContaining({ code: "idempotency_conflict" }));
});
it("delivers the managed binding and stop request in the actual Node session projection", () => {
  const { store, input } = setup();
  const intent = store.request(access, input);
  store.claim(access, "n", intent.id, 1);
  store.permit(access, "n", intent.id, 1);
  const running = store.report(access, "n", intent.id, {
    sequence: ++sequence, generation: 1, state: "running", sessionRef: "node-projection-thread", resolvedModel: "fixture-model",
  });
  db.connection.prepare("UPDATE agent_sessions SET status='active' WHERE id=?").run(running.sessionId!);
  store.stop(access, intent.id, 1);
  const sessions = new AgentSessionStore(db);
  const expected = { id: intent.id, runId: input.runId, stageId: intent.stageId,
    generation: 1, role: "implement", stopRequested: true };
  expect(sessions.managedBinding(running.sessionId!)).toMatchObject(expected);
  const nodeSession = sessions.listForNode("n").find((session) => session.id === running.sessionId);
  expect(nodeSession).toMatchObject({ managedExecution: expected });
});
it("AND-235 managed running and unknown sessions do not consume ordinary Node capacity", () => {
  const { store, input } = setup();
  const intent = store.request(access, input);
  store.claim(access, "n", intent.id, 1); store.permit(access, "n", intent.id, 1);
  const running = store.report(access, "n", intent.id, { sequence: 1, generation: 1, state: "running", sessionRef: "managed-capacity", resolvedModel: "fixture-model" });
  const sessions = new AgentSessionStore(db);
  db.connection.prepare("UPDATE agent_sessions SET status='active' WHERE id=?").run(running.sessionId!);
  expect(sessions.listForNode("n").find((s) => s.id === running.sessionId)?.occupiesExecutionSlot).toBe(false);
  store.report(access, "n", intent.id, { sequence: 2, generation: 1, state: "unknown" });
  store.stop(access, intent.id, 1);
  db.connection.prepare("UPDATE agent_sessions SET status='stalled' WHERE id=?").run(running.sessionId!);
  expect(sessions.listForNode("n").find((s) => s.id === running.sessionId)?.occupiesExecutionSlot).toBe(false);
  expect(store.get(access, intent.id).ownershipHeld).toBe(true);
  db.connection.exec(`INSERT INTO dispatches(id,account_id,node_id,agent_kind,mode,status,repo_path,created_at)
    VALUES ('ordinary-capacity','owner','n','codex','default','launched','/synthetic/repo','now');`);
  const ordinary = sessions.createForDispatch({ dispatchId: "ordinary-capacity", nodeId: "n", sessionRef: "ordinary-capacity-thread" });
  db.connection.prepare("UPDATE agent_sessions SET status='active' WHERE id=?").run(ordinary);
  expect(sessions.listForNode("n").find((s) => s.id === ordinary)?.occupiesExecutionSlot).toBe(true);
});
it("AND-235 managed recovery pages cannot starve ordinary queued controls", () => {
  const sessions = new AgentSessionStore(db);
  db.connection.exec(`INSERT INTO dispatches(id,account_id,node_id,agent_kind,mode,status,repo_path,created_at)
    VALUES ('ordinary-page','owner','n','codex','plan','launched','/synthetic/repo','now');`);
  const ordinary = sessions.createForDispatch({ dispatchId: "ordinary-page", nodeId: "n", sessionRef: "ordinary-page-thread" });
  const command = sessions.enqueue("owner", ordinary, "Queued ordinary control");
  for (let index = 0; index < 100; index++) {
    const { store, input } = setup(true, "page-" + index);
    const intent = store.request(access, input);
    store.claim(access, "n", intent.id, 1); store.permit(access, "n", intent.id, 1);
    store.report(access, "n", intent.id, { sequence: 1, generation: 1, state: "unknown", sessionRef: "managed-page-" + index, resolvedModel: "fixture-model" });
    store.stop(access, intent.id, 1);
  }
  const page = sessions.listForNode("n");
  expect(page.find((s) => s.id === ordinary)?.command?.id).toBe(command.id);
  expect(page.filter((s) => s.managedExecution?.stopRequested)).toHaveLength(100);
});
it("revalidates decision at delivery and gives permission to start only once", () => {
  const { store, decisions, decision, guard, input } = setup();
  const intent = store.request(access, input);
  expect(store.claim(access, "n", intent.id, 1).state).toBe("acknowledged");
  expect(store.claim(access, "n", intent.id, 1).state).toBe("acknowledged");
  decisions.change(access, decision.id, "revoke", guard("revoke"));
  expect(() => store.permit(access, "n", intent.id, 1)).toThrow();
  expect(store.get(access, intent.id)).toMatchObject({ state: "terminal", outcome: "cancelled", ownershipHeld: false });
  expect(store.request(access, input)).toMatchObject({ state: "terminal", outcome: "cancelled", ownershipHeld: false });
});
it("retains ownership on interrupted launch and creates a ledger attempt only from real runtime receipts", () => {
  const { store, decisions, decision, guard, input } = setup();
  const intent = store.request(access, input);
  store.claim(access, "n", intent.id, 1);
  expect(store.permit(access, "n", intent.id, 1).mayStart).toBe(true);
  expect(store.permit(access, "n", intent.id, 1).mayStart).toBe(false);
  expect(store.report(access, "n", intent.id, { sequence: ++sequence, generation: 1, state: "running", sessionRef: "native-thread" })).toMatchObject({ state: "unknown", attemptId: null, ownershipHeld: true });
  expect(db.connection.prepare("SELECT * FROM managed_attempts").all()).toHaveLength(0);
  decisions.change(access, decision.id, "revoke", guard("revoke"));
  const known = store.report(access, "n", intent.id, { sequence: ++sequence, generation: 1, state: "unknown", sessionRef: "native-thread", resolvedModel: "actual-model" });
  expect(known).toMatchObject({ state: "unknown", stopRequested: true, ownershipHeld: true });
  expect(known.attemptId).toBeTruthy();
  expect(store.get(access, intent.id).sessionId).toBeTruthy();
  expect(() => store.report(access, "n", intent.id, { sequence: ++sequence, generation: 2, state: "running" })).toThrow(expect.objectContaining({ code: "stale_generation" }));
  expect(db.connection.prepare("SELECT status FROM work_items").get()).toEqual({ status: "ready" });
});
it("does not reserve an executor for an old uncertain manual delivery", () => {
  const { store, input } = setup();
  db.connection.exec(`INSERT INTO dispatches(id,account_id,node_id,agent_kind,mode,status,repo_path,created_at,delivered_at)
    VALUES ('manual','owner','n','codex','default','failed','/synthetic/alias','now','yesterday');`);
  expect(store.request(access, input).ownershipHeld).toBe(true);
  expect(db.connection.prepare("SELECT * FROM managed_stages").all()).toHaveLength(1);
});
it("separates terminal result from explicit cleanup reconciliation and never releases on elapsed time", () => {
  const { store, input } = setup();
  const intent = store.request(access, input);
  store.claim(access, "n", intent.id, 1); store.permit(access, "n", intent.id, 1);
  store.report(access, "n", intent.id, { sequence: ++sequence, generation: 1, state: "running", sessionRef: "native-thread", resolvedModel: "actual-model" });
  const result = { generation: 1, outcome: "failed" as const, summary: "Test failed", evidence: "native:turn-finished" };
  expect(store.finish(access, intent.id, result)).toMatchObject({ state: "terminal", outcome: "failed", ownershipHeld: true, cleanup: null });
  expect(store.finish(access, intent.id, result)).toMatchObject({ state: "terminal" });
  expect(() => store.finish(access, intent.id, { ...result, outcome: "succeeded" })).toThrow();
  expect(store.reconcileCleanup(access, intent.id, 1, "inspected:stopped-and-workspace-retained")).toMatchObject({ ownershipHeld: false, outcome: "failed" });
});
it("archives a first late terminal observation without reviving the old owner", () => {
  const { store, input } = setup();
  const intent = store.request(access, input);
  store.claim(access, "n", intent.id, 1); store.permit(access, "n", intent.id, 1);
  const identity = { generation: 1, sessionRef: "terminal-thread", resolvedModel: "actual-model" };
  store.report(access, "n", intent.id, { ...identity, sequence: 1, state: "bound" });
  store.permit(access, "n", intent.id, 1);
  store.report(access, "n", intent.id, { ...identity, sequence: 2, state: "running" });
  const pending = { ...identity, sequence: 3, state: "waiting" as const };
  store.finish(access, intent.id, { generation: 1, outcome: "failed", summary: "Stopped", evidence: "fixture:stopped" });
  const terminal = store.reconcileCleanup(access, intent.id, 1, "fixture:cleanup");
  const next = store.request(access, { ...input, idempotencyKey: "next" });
  expect(next.generation).toBe(2);
  expect(store.report(access, "n", intent.id, pending)).toEqual(terminal);
  expect(store.report(access, "n", intent.id, pending)).toEqual(terminal);
  expect(JSON.parse((db.connection.prepare("SELECT payload_json FROM managed_execution_observations WHERE intent_id=? AND sequence=3")
    .get(intent.id) as { payload_json: string }).payload_json)).toEqual(pending);
  expect(db.connection.prepare("SELECT operation FROM managed_execution_events WHERE intent_id=? AND operation='terminal_observation_archived'").all(intent.id)).toHaveLength(1);
  expect(() => store.report(access, "n", next.id, pending)).toThrow(expect.objectContaining({ code: "stale_generation" }));
  expect(store.claim(access, "n", next.id, next.generation).state).toBe("acknowledged");
  expect(store.get(access, intent.id)).toEqual(terminal);
});
it("does not invent a terminal runtime identity or release unknown ownership", () => {
  const { store, input } = setup();
  const intent = store.request(access, input);
  store.claim(access, "n", intent.id, 1); store.permit(access, "n", intent.id, 1);
  store.report(access, "n", intent.id, { sequence: 1, generation: 1, state: "unknown" });
  const terminal = store.finish(access, intent.id, { generation: 1, outcome: "failed", summary: "Uncertain", evidence: "fixture:inspect" });
  expect(() => store.report(access, "n", intent.id, { sequence: 2, generation: 1, state: "waiting",
    sessionRef: "unbound-thread", resolvedModel: "invented-model" })).toThrow(expect.objectContaining({ code: "runtime_identity_changed" }));
  expect(store.get(access, intent.id)).toEqual(terminal);
  expect(terminal).toMatchObject({ ownershipHeld: true, sessionId: null, attemptId: null });
  expect(db.connection.prepare("SELECT sequence FROM managed_execution_observations WHERE intent_id=?").all(intent.id)).toEqual([{ sequence: 1 }]);
});
it("the off switch still allows stop and reconciliation while refusing another launch", () => {
  const { store, input } = setup();
  const intent = store.request(access, input);
  store.claim(access, "n", intent.id, 1); store.permit(access, "n", intent.id, 1);
  const off = new ManagedExecutionStore(db);
  expect(() => off.request(access, input)).toThrow(expect.objectContaining({ code: "managed_execution_disabled" }));
  expect(off.stop(access, intent.id, 1)).toMatchObject({ state: "starting", ownershipHeld: true, stopRequested: true });
  expect(() => off.permit(access, "n", intent.id, 1)).toThrow();
});
it("scopes supplemental input to the current native attempt and rejects manual policy changes", async () => {
  const { store, input } = setup();
  const intent = store.request(access, input);
  store.claim(access, "n", intent.id, 1); store.permit(access, "n", intent.id, 1);
  const running = store.report(access, "n", intent.id, { sequence: ++sequence, generation: 1, state: "running", sessionRef: "native-thread", resolvedModel: "actual-model" });
  const { AgentSessionStore } = await import("./agent-session-store.js");
  const sessions = new AgentSessionStore(db);
  expect(() => sessions.requestSettings("owner", running.sessionId!, { mode: "auto" })).toThrow(expect.objectContaining({ code: "managed_session_control" }));
  expect(() => sessions.enqueue("owner", running.sessionId!, "Unscoped reply")).toThrow(expect.objectContaining({ code: "managed_session_control" }));
  const command = store.input(access, intent.id, { generation: 1, idempotencyKey: "supplement", text: "Check the regression" });
  expect(store.input(access, intent.id, { generation: 1, idempotencyKey: "supplement", text: "Check the regression" })).toEqual(command);
  expect(() => store.input(access, intent.id, { generation: 2, idempotencyKey: "supplement", text: "Check the regression" })).toThrow();
});
it("retries a reconciled failed stage with a new generation, fencing old runtime reports", () => {
  const { store, input } = setup();
  const first = store.request(access, input);
  store.claim(access, "n", first.id, 1); store.permit(access, "n", first.id, 1);
  store.report(access, "n", first.id, { sequence: ++sequence, generation: 1, state: "running", sessionRef: "native-one", resolvedModel: "actual-model" });
  store.finish(access, first.id, { generation: 1, outcome: "failed", summary: "Failed", evidence: "fixture:failed" });
  store.reconcileCleanup(access, first.id, 1, "fixture:stopped");
  const second = store.request(access, { ...input, idempotencyKey: "retry" });
  expect(second).toMatchObject({ stageId: first.stageId, generation: 2, state: "requested" });
  expect(() => store.report(access, "n", first.id, { sequence: ++sequence, generation: 1, state: "running" })).toThrow();
  store.claim(access, "n", second.id, 2); store.permit(access, "n", second.id, 2);
  expect(() => store.report(access, "n", second.id, { sequence: ++sequence, generation: 2, state: "running", sessionRef: "native-one", resolvedModel: "actual-model" }))
    .toThrow(expect.objectContaining({ code: "runtime_session_bound" }));
  const running = store.report(access, "n", second.id, { sequence: ++sequence, generation: 2, state: "running", sessionRef: "native-two", resolvedModel: "actual-model" });
  expect(new ManagedRunStore(db).getAttempt({ accountId: "owner", productIds: ["p"] }, input.runId, second.stageId, running.attemptId!).generation).toBe(2);
});
it("degrades silent starts to unknown without granting a replacement writer", () => {
  const { store, input } = setup();
  const intent = store.request(access, input);
  store.claim(access, "n", intent.id, 1); store.permit(access, "n", intent.id, 1);
  db.connection.prepare("UPDATE managed_execution_intents SET snapshot_json=json_set(snapshot_json,'$.updatedAt',?) WHERE id=?").run("2001-01-01T00:00:00.000Z", intent.id);
  expect(store.get(access, intent.id)).toMatchObject({ state: "unknown", ownershipHeld: true });
  expect(() => store.request(access, { ...input, stageKey: "replacement", idempotencyKey: "replacement" })).toThrow(expect.objectContaining({ code: "workspace_owned" }));
});
it("uses two real connections to serialize ownership and single permission-to-start delivery", () => {
  const { store, input } = setup();
  const peer = new MissionGoDatabase(join(dir, "test.sqlite"));
  try {
    const other = new ManagedExecutionStore(peer, true);
    let intentId = "";
    db.transaction(() => {
      intentId = store.request(access, input).id;
      expect(() => other.request(access, input)).toThrow(); // BEGIN IMMEDIATE cannot pass the held write lock.
    });
    expect(other.request(access, input).id).toBe(intentId);
    store.claim(access, "n", intentId, 1);
    expect(other.permit(access, "n", intentId, 1).mayStart).toBe(true);
    expect(store.permit(access, "n", intentId, 1).mayStart).toBe(false);
    expect(() => other.request(access, { ...input, stageKey: "another", idempotencyKey: "another" })).toThrow(expect.objectContaining({ code: "workspace_owned" }));
    expect(() => peer.connection.exec(`INSERT INTO dispatches(id,account_id,node_id,agent_kind,mode,status,repo_path,created_at)
      VALUES ('manual','owner','n','codex','default','queued','/synthetic/alias','now')`)).not.toThrow();
  } finally { peer.close(); }
});
it("rechecks account, product scope, node and permissions on current receipts", () => {
  const { store, input } = setup();
  const intent = store.request(access, input);
  expect(() => store.get(() => "other-account", intent.id)).toThrow();
  expect(() => store.claim(access, "other-node", intent.id, 1)).toThrow();
  expect(() => store.request(() => { throw new Error("grant revoked"); }, input)).toThrow("grant revoked");
  db.connection.exec("INSERT INTO products(id,key_prefix,name,created_at,updated_at) VALUES ('other','OTH','Other','now','now'); UPDATE node_product_repos SET product_id='other' WHERE id='repo'");
  expect(() => store.claim(access, "n", intent.id, 1)).toThrow();
});
it("cannot certify success when a real session/model receipt is missing", () => {
  const { store, input } = setup();
  const intent = store.request(access, input);
  store.claim(access, "n", intent.id, 1); store.permit(access, "n", intent.id, 1);
  store.report(access, "n", intent.id, { sequence: ++sequence, generation: 1, state: "unknown" });
  expect(() => store.finish(access, intent.id, { generation: 1, outcome: "succeeded", summary: "Unproven", evidence: "fixture:missing" }))
    .toThrow(expect.objectContaining({ code: "runtime_receipt_missing" }));
});
it("records a timed-out known runtime as unknown in both the control intent and AND-230 ledger", () => {
  const { store, input } = setup();
  const intent = store.request(access, input);
  store.claim(access, "n", intent.id, 1); store.permit(access, "n", intent.id, 1);
  const running = store.report(access, "n", intent.id, { sequence: ++sequence, generation: 1, state: "running", sessionRef: "native-thread", resolvedModel: "actual-model" });
  db.connection.prepare("UPDATE managed_execution_intents SET snapshot_json=json_set(snapshot_json,'$.updatedAt',?) WHERE id=?").run("2001-01-01T00:00:00.000Z", intent.id);
  expect(store.get(access, intent.id).state).toBe("unknown");
  expect(new ManagedRunStore(db).getAttempt({ accountId: "owner", productIds: ["p"] }, input.runId, intent.stageId, running.attemptId!).status).toBe("unknown");
});
it("retains scoped manual reconciliation evidence without fencing ordinary continuation", () => {
  const { store, input } = setup();
  db.connection.exec(`INSERT INTO dispatches(id,account_id,node_id,agent_kind,mode,status,repo_path,created_at,delivered_at)
    VALUES ('manual','owner','n','codex','default','launched','/synthetic/repo','now','observed-delivery');
    INSERT INTO dispatch_items(dispatch_id,item_id,position) VALUES ('manual','i',0);`);
  expect(store.request(access, input).ownershipHeld).toBe(true);
  expect(() => store.reconcileManual(access, "manual", { generation: 1, deliveredAt: "stale", evidence: "fixture:stopped" })).toThrow();
  expect(() => store.reconcileManual(() => "other-account", "manual", { generation: 1, deliveredAt: "observed-delivery", evidence: "fixture:stopped" })).toThrow();
  const sessions = new AgentSessionStore(db);
  const sessionId = sessions.createForDispatch({ dispatchId: "manual", nodeId: "n", sessionRef: "manual-thread" });
  store.reconcileManual(access, "manual", { generation: 1, deliveredAt: "observed-delivery", evidence: "fixture:stopped" });
  expect(store.request(access, input).ownershipHeld).toBe(true);
  expect(sessions.enqueue("owner", sessionId, "Continue ordinary writer").status).toBe("queued");
  expect(() => db.connection.exec("UPDATE dispatches SET status='queued' WHERE id='manual'")).not.toThrow();
});
it("accepts a second waiting observation after running without reusing the ledger operation", () => {
  const { store, input } = setup();
  const intent = store.request(access, input);
  store.claim(access, "n", intent.id, 1); store.permit(access, "n", intent.id, 1);
  const receipt = { generation: 1, sessionRef: "cycle-thread", resolvedModel: "cycle-model" };
  for (const state of ["running", "waiting", "running", "waiting"] as const) {
    expect(store.report(access, "n", intent.id, { ...receipt, sequence: ++sequence, state }).state).toBe(state);
  }
  expect(db.connection.prepare("SELECT count(*) AS count FROM managed_attempts").get()).toEqual({ count: 1 });
});
it("replays exact durable observations and fences changed, reordered and late reports", () => {
  const { store, input } = setup();
  const intent = store.request(access, input);
  store.claim(access, "n", intent.id, 1); store.permit(access, "n", intent.id, 1);
  const receipt = { generation: 1, sessionRef: "replay-thread", resolvedModel: "replay-model" };
  const first = { ...receipt, sequence: 1, state: "waiting" as const };
  const waiting = store.report(access, "n", intent.id, first);
  expect(waiting.state).toBe("waiting");
  const next = { ...receipt, sequence: 3, state: "running" as const };
  const running = store.report(access, "n", intent.id, next);
  expect(store.report(access, "n", intent.id, first)).toEqual(running);
  expect(() => store.report(access, "n", intent.id, { ...first, state: "unknown" })).toThrow(expect.objectContaining({ code: "idempotency_conflict" }));
  expect(() => store.report(access, "n", intent.id, { ...first, sequence: 2 })).toThrow(expect.objectContaining({ code: "observation_out_of_order" }));
  expect(db.connection.prepare("SELECT count(*) AS count FROM managed_attempts").get()).toEqual({ count: 1 });
  store.finish(access, intent.id, { generation: 1, outcome: "failed", summary: "Failure", evidence: "fixture:stopped" });
  expect(store.report(access, "n", intent.id, first).state).toBe("terminal");
});
it("acknowledges identity before granting one first-turn permit and rechecks approval", () => {
  const { store, input, decisions, decision, guard } = setup();
  const intent = store.request(access, input);
  store.claim(access, "n", intent.id, 1); store.permit(access, "n", intent.id, 1);
  const report = { sequence: 1, generation: 1, state: "bound" as const, sessionRef: "bound-thread", resolvedModel: "bound-model" };
  expect(store.report(access, "n", intent.id, report).state).toBe("bound");
  expect(store.permit(access, "n", intent.id, 1)).toMatchObject({ mayStart: true, intent: { state: "turn_starting" } });
  expect(store.report(access, "n", intent.id, report).state).toBe("turn_starting");
  expect(store.permit(access, "n", intent.id, 1).mayStart).toBe(false);
  decisions.change(access, decision.id, "revoke", guard("revoke"));
  expect(() => store.permit(access, "n", intent.id, 1)).toThrow();
});
it.each(["cancel", "failed-without-receipt", "failed-with-receipt"])("allocates independent intent generations after %s and another unstarted cancellation", (mode) => {
  const { store, input } = setup();
  const first = store.request(access, input);
  if (mode === "cancel") store.stop(access, first.id, 1);
  else {
    store.claim(access, "n", first.id, 1); store.permit(access, "n", first.id, 1);
    if (mode === "failed-with-receipt") store.report(access, "n", first.id, {
      sequence: 1, generation: 1, state: "running", sessionRef: "first-real-thread", resolvedModel: "model",
    });
    store.finish(access, first.id, { generation: 1, outcome: "failed", summary: "Failed", evidence: "fixture:failed" });
    store.reconcileCleanup(access, first.id, 1, "fixture:clean");
  }
  const secondInput = { ...input, idempotencyKey: "second" };
  const second = store.request(access, secondInput);
  expect(second.generation).toBe(2);
  expect(store.request(access, secondInput)).toEqual(second);
  store.stop(access, second.id, 2);
  const third = store.request(access, { ...input, idempotencyKey: "third" });
  expect(third.generation).toBe(3);
  store.claim(access, "n", third.id, 3); store.permit(access, "n", third.id, 3);
  const running = store.report(access, "n", third.id, { sequence: 1, generation: 3, state: "waiting", sessionRef: "third-real-thread", resolvedModel: "model" });
  expect(new ManagedRunStore(db).getAttempt({ accountId: "owner", productIds: ["p"] }, input.runId, third.stageId, running.attemptId!).generation)
    .toBe(mode === "failed-with-receipt" ? 2 : 1);
  expect(() => store.report(access, "n", second.id, { sequence: 1, generation: 2, state: "running", sessionRef: "stale", resolvedModel: "model" })).toThrow();
  store.finish(access, third.id, { generation: 3, outcome: "failed", summary: "Failure", evidence: "fixture:failure" });
  store.reconcileCleanup(access, third.id, 3, "fixture:clean");
});
it("preserves frozen repository identity on no-op save and protects occupied mapping edits", async () => {
  const { DispatchStore } = await import("./dispatch-store.js");
  const nodes = new DispatchStore(db);
  const { store, input } = setup();
  const intent = store.request(access, input);
  store.claim(access, "n", intent.id, 1); store.permit(access, "n", intent.id, 1);
  nodes.replaceRepos("owner", "n", [{ productId: "p", repoPath: "/synthetic/repo" }]);
  expect(db.connection.prepare("SELECT id FROM node_product_repos WHERE node_id='n'").get()).toEqual({ id: "repo" });
  expect(() => nodes.replaceRepos("owner", "n", [{ productId: "p", repoPath: "/synthetic/changed" }])).toThrow(expect.objectContaining({ code: "repository_owned" }));
  expect(() => nodes.replaceRepos("owner", "n", [])).toThrow(expect.objectContaining({ code: "repository_owned" }));
  // Simulate a disappeared legacy mapping: authentic receipts still use the frozen launch binding.
  db.connection.prepare("DELETE FROM node_product_repos WHERE id='repo'").run();
  expect(store.report(access, "n", intent.id, { sequence: 1, generation: 1, state: "running", sessionRef: "frozen-thread", resolvedModel: "model" }).sessionId).toBeTruthy();
  expect(db.connection.prepare("SELECT repo_path FROM dispatches WHERE id=?").get(intent.id)).toEqual({ repo_path: "/synthetic/repo" });
  expect(() => store.report(() => "other-account", "n", intent.id, { sequence: 2, generation: 1, state: "waiting" })).toThrow();
  expect(() => store.report(() => { throw new Error("grant revoked"); }, "n", intent.id, { sequence: 2, generation: 1, state: "waiting" })).toThrow("grant revoked");
});
it("scopes executor ownership to a registered Node instead of unrelated accounts and machines", () => {
  const { store, input } = setup();
  db.connection.exec(`INSERT INTO nodes(id,account_id,installation_id,name,token_hash,agents_json,created_at,updated_at)
    VALUES ('other-node','other-account','other-install','Other','other-synthetic','[]','now','now');
    INSERT INTO dispatches(id,account_id,node_id,agent_kind,mode,status,repo_path,created_at,delivered_at,archived_at)
    VALUES ('other-history','other-account','other-node','codex','default','launched','/synthetic/other','now','old','old');`);
  expect(store.request(access, input).ownershipHeld).toBe(true);
  expect(() => db.connection.exec(`INSERT INTO dispatches(id,account_id,node_id,agent_kind,mode,status,repo_path,created_at)
    VALUES ('other-new','other-account','other-node','codex','default','queued','/synthetic/other','now')`)).not.toThrow();
});
it("lets a reconciled manual session reacquire a new execution generation without deleting audit", () => {
  const { store, input } = setup();
  db.connection.exec(`INSERT INTO dispatches(id,account_id,node_id,agent_kind,mode,status,repo_path,created_at,delivered_at)
    VALUES ('manual','owner','n','codex','default','launched','/synthetic/repo','now','delivery-one');
    INSERT INTO dispatch_items(dispatch_id,item_id,position) VALUES ('manual','i',0);`);
  const sessions = new AgentSessionStore(db);
  const session = sessions.createForDispatch({ dispatchId: "manual", nodeId: "n", sessionRef: "manual-native" });
  store.reconcileManual(access, "manual", { generation: 1, deliveredAt: "delivery-one", evidence: "fixture:stopped" });
  const intent = store.request(access, input);
  expect(sessions.enqueue("owner", session, "Continue while managed owns its tree").status).toBe("queued");
  db.connection.exec("UPDATE agent_session_commands SET status='delivered'");
  store.stop(access, intent.id, 1);
  const off = new ManagedExecutionStore(db);
  expect(sessions.enqueue("owner", session, "Continue manually").status).toBe("queued");
  expect(db.connection.prepare("SELECT execution_generation FROM dispatches WHERE id='manual'").get()).toEqual({ execution_generation: 2 });
  expect(db.connection.prepare("SELECT * FROM managed_manual_reconciliations").all()).toHaveLength(1);
  expect(store.manualSnapshot(access, "manual")).toMatchObject({ generation: 2, reconciliations: [{ generation: 1 }] });
  expect(() => store.manualSnapshot(() => "other-account", "manual")).toThrow();
  expect(store.request(access, { ...input, idempotencyKey: "next" }).ownershipHeld).toBe(true);
  expect(() => off.reconcileManual(access, "manual", { generation: 1, deliveredAt: "delivery-one", evidence: "fixture:stopped" })).toThrow();
});

it("requires explicit single-Node local executor registration and rejects shared workspace mode", () => {
  const { store, input } = setup(false);
  expect(() => store.request(access, input)).toThrow(expect.objectContaining({ code: "executor_not_registered" }));
  expect(() => store.registerExecutor(access, "n", { mode: "shared", evidence: "fixture:shared" })).toThrow(expect.objectContaining({ code: "unsupported_executor" }));
  expect(() => store.registerExecutor(() => "other-account", "n", { mode: "single_node_local", evidence: "fixture:exclusive" })).toThrow();
  store.registerExecutor(access, "n", { mode: "single_node_local", evidence: "fixture:exclusive" });
  expect(store.request(access, input).ownershipHeld).toBe(true);
});
it("keeps registration independent of manual continuation and queued delivery", () => {
  const { store } = setup(false);
  db.connection.exec(`INSERT INTO dispatches(id,account_id,node_id,agent_kind,mode,status,repo_path,created_at,delivered_at)
    VALUES ('manual-one','owner','n','codex','default','launched','/synthetic/repo','now','one'),
           ('manual-two','owner','n','codex','default','failed','/synthetic/alias','now','two');
    INSERT INTO dispatch_items(dispatch_id,item_id,position) VALUES ('manual-one','i',0),('manual-two','i',0);`);
  const sessions = new AgentSessionStore(db);
  const session = sessions.createForDispatch({ dispatchId: "manual-one", nodeId: "n", sessionRef: "manual-one-thread" });
  store.registerExecutor(access, "n", { mode: "single_node_local", evidence: "fixture:exclusive" });
  expect(sessions.enqueue("owner", session, "Independent ordinary work").status).toBe("queued");
  db.connection.exec("UPDATE agent_session_commands SET status='delivered'");
  expect(() => db.connection.exec(`INSERT INTO dispatches(id,account_id,node_id,agent_kind,mode,status,repo_path,created_at)
    VALUES ('third','owner','n','codex','default','queued','/synthetic/alias','now')`)).not.toThrow();
  store.reconcileManual(access, "manual-two", { generation: 1, deliveredAt: "two", evidence: "fixture:stopped" });
  expect(sessions.enqueue("owner", session, "Continue with ownership").status).toBe("queued");
});
it("delivers queued manual controls after executor registration", () => {
  const { store } = setup(false);
  db.connection.exec(`INSERT INTO dispatches(id,account_id,node_id,agent_kind,mode,status,repo_path,created_at,delivered_at)
    VALUES ('one','owner','n','codex','default','launched','/synthetic/repo','now','one'),
           ('two','owner','n','codex','default','failed','/synthetic/alias','now','two');`);
  const sessions = new AgentSessionStore(db);
  const sessionId = sessions.createForDispatch({ dispatchId: "one", nodeId: "n", sessionRef: "one-thread" });
  const command = sessions.enqueue("owner", sessionId, "Legacy queued reply");
  store.registerExecutor(access, "n", { mode: "single_node_local", evidence: "fixture:exclusive" });
  expect(sessions.listForNode("n").find((s) => s.id === sessionId)?.command?.id).toBe(command.id);
  expect(() => sessions.recordSnapshot({ nodeId: "n", sessionId, status: "idle", messages: [], commandId: command.id, commandStatus: "delivering" })).not.toThrow();
});
it("restoring a reconciled manual mirror acquires a new generation even without source archive", () => {
  const { store } = setup();
  db.connection.exec(`INSERT INTO dispatches(id,account_id,node_id,agent_kind,mode,status,repo_path,created_at,delivered_at)
    VALUES ('manual','owner','n','codex','default','launched','/synthetic/repo','now','delivery');
    INSERT INTO dispatch_items(dispatch_id,item_id,position) VALUES ('manual','i',0);`);
  const sessions = new AgentSessionStore(db);
  const sessionId = sessions.createForDispatch({ dispatchId: "manual", nodeId: "n", sessionRef: "manual-thread" });
  sessions.setArchived("owner", sessionId, true);
  store.reconcileManual(access, "manual", { generation: 1, deliveredAt: "delivery", evidence: "fixture:stopped" });
  sessions.setArchived("owner", sessionId, false);
  expect(db.connection.prepare("SELECT execution_generation FROM dispatches WHERE id='manual'").get()).toEqual({ execution_generation: 2 });
});
it("prioritizes the owned stopped thread over the Node session page limit", () => {
  const { store, input } = setup();
  const intent = store.request(access, input);
  store.claim(access, "n", intent.id, 1); store.permit(access, "n", intent.id, 1);
  const running = store.report(access, "n", intent.id, { sequence: 1, generation: 1, state: "running", sessionRef: "owned", resolvedModel: "model" });
  store.stop(access, intent.id, 1);
  db.connection.prepare("UPDATE agent_sessions SET status='idle',archived_at='old',archive_source='source',updated_at='2001-01-01' WHERE id=?").run(running.sessionId!);
  const sessions = new AgentSessionStore(db);
  for (let i = 0; i < 101; i++) {
    // Unlaunched historical failure mirrors do not reserve an executor.
    const id = "historical-" + i;
    db.connection.prepare("INSERT INTO dispatches(id,account_id,node_id,agent_kind,mode,status,repo_path,created_at) VALUES (?,'owner','n','codex','default','failed','/synthetic/repo','now')").run(id);
    const sessionId = sessions.createForDispatch({ dispatchId: id, nodeId: "n", sessionRef: id });
    db.connection.prepare("UPDATE agent_sessions SET status='active' WHERE id=?").run(sessionId);
  }
  expect(sessions.listForNode("n")[0]?.managedExecution?.id).toBe(intent.id);
});
it("does not let a late manual launch receipt reacquire ownership after reconciliation", () => {
  const { store, input } = setup();
  db.connection.exec(`INSERT INTO dispatches(id,account_id,node_id,agent_kind,mode,status,repo_path,created_at,delivered_at)
    VALUES ('manual','owner','n','codex','default','launched','/synthetic/repo','now','delivery');
    INSERT INTO dispatch_items(dispatch_id,item_id,position) VALUES ('manual','i',0);`);
  store.reconcileManual(access, "manual", { generation: 1, deliveredAt: "delivery", evidence: "fixture:stopped" });
  db.connection.exec("UPDATE dispatches SET status='launched' WHERE id='manual'");
  expect(db.connection.prepare("SELECT execution_generation FROM dispatches WHERE id='manual'").get()).toEqual({ execution_generation: 1 });
  expect(store.request(access, input).ownershipHeld).toBe(true);
});

it.each([false, true])("records late bound receipt after timeout and restart, committed=%s", (committed) => {
  const { store, input } = setup();
  const intent = store.request(access, input);
  store.claim(access, "n", intent.id, 1); store.permit(access, "n", intent.id, 1);
  const receipt = { sequence: 1, generation: 1, state: "bound" as const, sessionRef: "late-thread", resolvedModel: "actual-model" };
  if (committed) store.report(access, "n", intent.id, receipt);
  const now = Date.now();
  const clock = vi.spyOn(Date, "now").mockReturnValue(now + 121_000);
  try {
    expect(store.get(access, intent.id).state).toBe("unknown");
    db.close(); db = new MissionGoDatabase(join(dir, "test.sqlite"));
    const restarted = new ManagedExecutionStore(db, true);
    const late = restarted.report(access, "n", intent.id, receipt);
    expect(late).toMatchObject({ state: "unknown", ownershipHeld: true });
    expect(late.sessionId).toBeTruthy(); expect(late.attemptId).toBeTruthy();
    expect(restarted.report(access, "n", intent.id, receipt)).toEqual(late);
    expect(restarted.permit(access, "n", intent.id, 1).mayStart).toBe(false);
    expect(() => restarted.report(access, "n", intent.id, { ...receipt, generation: 2 })).toThrow(expect.objectContaining({ code: "stale_generation" }));
    expect(() => restarted.report(access, "n", intent.id, { ...receipt, resolvedModel: "changed" })).toThrow(expect.objectContaining({ code: "idempotency_conflict" }));
    expect(() => restarted.report(access, "n", intent.id, { ...receipt, sequence: 2, sessionRef: "changed" })).toThrow(expect.objectContaining({ code: "runtime_identity_changed" }));
    expect(() => restarted.report(access, "n", intent.id, { ...receipt, sequence: 2, resolvedModel: "changed" })).toThrow(expect.objectContaining({ code: "runtime_identity_changed" }));
    expect(db.connection.prepare("SELECT COUNT(*) AS n FROM managed_attempts").get()).toEqual({ n: 1 });
  } finally { clock.mockRestore(); }
});

it("AND-235 repair traverses every held batch across polls, connections, restarts and queue changes", () => {
  const add = (index: number) => {
    const { store, input } = setup(true, `fair-${index}`);
    const intent = store.request(access, input);
    store.claim(access, "n", intent.id, 1);
    expect(store.permit(access, "n", intent.id, 1).mayStart).toBe(true);
    const observed = store.report(access, "n", intent.id, { sequence: 1, generation: 1,
      state: index % 2 ? "running" : "unknown", sessionRef: `fair-thread-${index}`, resolvedModel: "fixture-model" });
    // Deliberately make the oldest batch sort behind every newer one in the old query.
    db.connection.prepare("UPDATE agent_sessions SET updated_at=? WHERE id=?").run(String(index).padStart(6, "0"), observed.sessionId!);
    return observed;
  };
  const intents = Array.from({ length: 205 }, (_, index) => add(index));
  const store = new ManagedExecutionStore(db, true);
  // More than a whole page of persistent stops: stop priority alone cannot pass.
  for (const intent of intents.slice(0, 105)) store.stop(access, intent.id, 1);
  const evidenceTables = ["managed_execution_intents", "managed_execution_bindings", "managed_execution_observations",
    "managed_execution_events", "managed_attempts", "agent_sessions"];
  const evidence = () => evidenceTables.map((table) => db.connection.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all());
  const beforeUpgrade = evidence();
  // Reopen an actual pre-cursor database containing held unknown/stop evidence.
  db.connection.exec(`DROP TABLE managed_session_poll_cursors; DROP INDEX idx_agent_sessions_node_id;
    DELETE FROM schema_migrations WHERE version=202609271554;`);
  db.close(); db = new MissionGoDatabase(join(dir, "test.sqlite"));
  expect(evidence()).toEqual(beforeUpgrade);
  db.connection.exec(`INSERT INTO dispatches(id,account_id,node_id,agent_kind,mode,status,repo_path,created_at)
    VALUES ('fair-ordinary','owner','n','codex','plan','launched','/synthetic/repo','now');`);
  const sessions = new AgentSessionStore(db);
  const ordinary = sessions.createForDispatch({ dispatchId: "fair-ordinary", nodeId: "n", sessionRef: "fair-ordinary" });
  const command = sessions.enqueue("owner", ordinary, "Ordinary control remains visible");
  const seen = new Set<string>();
  for (let poll = 0; poll < 3; poll++) {
    // Two connections share persisted progress; reopening also simulates server restart.
    const other = new MissionGoDatabase(join(dir, "test.sqlite"));
    try {
      const page = new AgentSessionStore(other).listForNode("n");
      expect(page.find((s) => s.id === ordinary)?.command?.id).toBe(command.id);
      const managed = page.filter((s) => s.managedExecution);
      expect(managed.length).toBeLessThanOrEqual(100);
      for (const session of managed) {
        expect(seen.has(session.id)).toBe(false);
        seen.add(session.id);
        expect(session.managedExecution?.ownershipHeld).toBe(true);
      }
    } finally { other.close(); }
    if (poll === 0) {
      add(205); // A new arrival must not postpone completion of this sweep.
      // Updates to an already seen session must not put it ahead of unseen ones.
      db.connection.prepare("UPDATE agent_sessions SET updated_at='999999' WHERE id=?").run(intents[0]!.sessionId!);
    }
  }
  for (const intent of intents) expect(seen.has(intent.sessionId!)).toBe(true);
  // Every old batch is delivered again even when stop/unknown remains unresolved.
  const again = new Set<string>();
  for (let poll = 0; poll < 3; poll++) {
    for (const session of new AgentSessionStore(db).listForNode("n")) {
      if (session.managedExecution) again.add(session.id);
    }
  }
  expect(again.size).toBe(206);
  const restarted = new ManagedExecutionStore(db, true);
  for (const intent of intents) {
    const held = restarted.get(access, intent.id);
    expect(held.ownershipHeld).toBe(true);
    if (held.stopRequested) expect(() => restarted.permit(access, "n", intent.id, 1)).toThrow();
    else expect(restarted.permit(access, "n", intent.id, 1).mayStart).toBe(false);
  }
  expect(db.connection.prepare("SELECT id FROM managed_attempts").all()).toHaveLength(206);
});

it("AND-235 repair isolates node cursors and serializes competing poll connections", () => {
  db.connection.exec(`INSERT INTO nodes(id,account_id,installation_id,name,token_hash,agents_json,created_at,updated_at)
    VALUES ('other','owner','other-install','Other','synthetic-other','[{"kind":"codex","models":[]}]','now','now');
    INSERT INTO node_product_repos(id,node_id,product_id,repo_path,created_at,updated_at)
    VALUES ('other-repo','other','p','/synthetic/other','now','now');`);
  const expected = new Map<string, Set<string>>();
  for (const node of ["n", "other"]) {
    const ids = new Set<string>();
    for (let index = 0; index < 101; index++) {
      const { store, input } = setup(true, `${node}-${index}`, node, node === "n" ? "repo" : "other-repo");
      const intent = store.request(access, input);
      store.claim(access, node, intent.id, 1); store.permit(access, node, intent.id, 1);
      const observed = store.report(access, node, intent.id, { sequence: 1, generation: 1, state: "unknown",
        sessionRef: `${node}-thread-${index}`, resolvedModel: "fixture-model" });
      ids.add(observed.sessionId!);
    }
    expected.set(node, ids);
  }
  const other = new MissionGoDatabase(join(dir, "test.sqlite"));
  try {
    const a = new AgentSessionStore(db);
    const b = new AgentSessionStore(other);
    const first = a.listForNode("n");
    expect(first).toHaveLength(100);
    const cursor = () => db.connection.prepare("SELECT * FROM managed_session_poll_cursors ORDER BY node_id").all();
    const before = cursor();
    db.transaction(() => {
      expect(() => b.listForNode("n")).toThrow(/locked/);
      expect(cursor()).toEqual(before);
    });
    const otherFirst = b.listForNode("other");
    expect(otherFirst).toHaveLength(100);
    const tail = b.listForNode("n");
    expect(tail).toHaveLength(1);
    const otherTail = a.listForNode("other");
    expect(otherTail).toHaveLength(1);
    expect(new Set([...first, ...tail].map((s) => s.id))).toEqual(expected.get("n"));
    expect(new Set([...otherFirst, ...otherTail].map((s) => s.id))).toEqual(expected.get("other"));
  } finally { other.close(); }
});
