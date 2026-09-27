import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { expect, it } from "vitest";
import { buildApp } from "./app.js";
import { hashPassword } from "./admin-auth.js";
import { DispatchStore } from "./dispatch-store.js";
import { ManagedRunStore } from "./managed-run-store.js";
import { ManagedDecisionStore } from "./managed-decision-store.js";
import { ManagedExecutionStore } from "./managed-execution-store.js";
import type { ExecutionObservation } from "@missiongo/domain";

// In-memory synthetic approval and native identities; never business acceptance.
async function fixture() {
  const config = { id: "fixture-owner", username: "owner@example.test", passwordScrypt: hashPassword("synthetic-password"),
    sessionSecret: randomBytes(32).toString("hex"), cookieSecure: true };
  const app = buildApp({ adminAccount: config, databasePath: ":memory:", logger: false,
    managedExecution: { enabled: true, coordinatorClientIds: ["fixture-only"] } });
  const db = app.missionGoStore.database;
  const access = () => config.id;
  const nodes = new DispatchStore(db);
  const node = nodes.registerNode({ accountId: config.id, installationId: "fixture-install", name: "Fixture" });
  db.connection.exec(`INSERT INTO products(id,key_prefix,name,created_at,updated_at) VALUES ('p','AND','Synthetic','now','now');
    INSERT INTO work_items(id,item_key,sequence,product_id,type,priority,status,title,description,created_at,updated_at)
    VALUES ('i','AND-1',1,'p','task','normal','ready','Fixture','Synthetic only','now','now');`);
  nodes.replaceRepos(config.id, node.nodeId, [{ productId: "p", repoPath: "/synthetic/repo" }]);
  const mapping = db.connection.prepare("SELECT id FROM node_product_repos WHERE node_id=?").get(node.nodeId) as { id: string };
  const run = new ManagedRunStore(db).createRun({ accountId: config.id, productIds: ["p"] }, {
    scope: { productId: "p", repositoryRef: mapping.id, itemKeys: ["AND-1"], contractRevision: 1 }, idempotencyKey: "fixture-run" });
  const decisions = new ManagedDecisionStore(db);
  let decision = decisions.create(access, { runId: run.id, decisionKey: "fixture-d", scopeDigest: run.scopeDigest,
    contractRevision: 1, idempotencyKey: "fixture-create", content: { title: "Fixture", recommendation: "Local protocol test",
      alternatives: ["Defer"], costs: "Tests", acceptanceCriteria: ["Pass"], allowedActions: ["implement"] } });
  const guard = (key: string) => ({ version: decision.version, stateVersion: decision.stateVersion, contentDigest: decision.contentDigest,
    scopeDigest: decision.scopeDigest, contractRevision: 1, idempotencyKey: key });
  decision = decisions.change(access, decision.id, "approve", guard("fixture-approval-not-human"));
  const store = new ManagedExecutionStore(db, true);
  store.registerExecutor(access, node.nodeId, { mode: "single_node_local", evidence: "synthetic exclusive fixture" });
  const request = (key: string) => ({ runId: run.id, decisionId: decision.id, ...guard(key), stageKey: key, role: "implement" as const,
    inputCommit: "a".repeat(40), nodeId: node.nodeId, permissionMode: "workspace-write" as const });
  const old = store.request(access, request("old"));
  store.claim(access, node.nodeId, old.id, 1);
  store.permit(access, node.nodeId, old.id, 1);
  const identity = { sessionRef: "synthetic-old-thread", resolvedModel: "synthetic-old-model" };
  store.report(access, node.nodeId, old.id, { sequence: 1, generation: 1, state: "bound", ...identity });
  store.permit(access, node.nodeId, old.id, 1);
  const running = store.report(access, node.nodeId, old.id, { sequence: 2, generation: 1, state: "running", ...identity });
  store.finish(access, old.id, { generation: 1, outcome: "succeeded", summary: "fixture finish", evidence: "fixture-only" });
  const address = process.env.MANAGED_REAL_HTTP === "1" ? await app.listen({ host: "127.0.0.1", port: 0 }) : undefined;
  const report = async (observation: ExecutionObservation) => {
    const url = "/api/v1/node/managed-execution/" + old.id + "/report";
    const headers = { authorization: "Bearer " + node.token, "content-type": "application/json" };
    if (address) {
      const response = await fetch(address + url, { method: "POST", headers, body: JSON.stringify(observation) });
      return { status: response.status, body: await response.json() };
    }
    const response = await app.inject({ method: "POST", url, headers, payload: JSON.stringify(observation) });
    return { status: response.statusCode, body: response.json() };
  };
  const snapshot = () => ({
    intents: db.connection.prepare("SELECT * FROM managed_execution_intents ORDER BY id").all(),
    observations: db.connection.prepare("SELECT * FROM managed_execution_observations ORDER BY intent_id,sequence").all(),
    events: db.connection.prepare("SELECT * FROM managed_execution_events ORDER BY intent_id,sequence").all(),
  });
  return { app, db, access, node, store, old, running, identity, request, address, report, snapshot };
}

// The native fixture is compiled by test-managed-native-fixtures.sh. Its pipe
// transport feeds APIClient requests through the real Fastify route and Store.
// No listening socket or production endpoint is needed for process recovery.
type ProcessMessage = { request?: { method: string; path: string; body: string }; ack?: unknown;
  errors?: string[]; rejected?: boolean };
async function nativeProcess(f: Awaited<ReturnType<typeof fixture>>, root: string, mode: string) {
  const child = spawn(process.env.MANAGED_PROCESS_EXECUTABLE!, [], { stdio: ["pipe", "pipe", "pipe"] });
  const messages: ProcessMessage[] = [];
  const requests: { body: ExecutionObservation; status: number }[] = [];
  let stderr = "";
  child.stderr.setEncoding("utf8").on("data", (text) => { stderr += text; });
  const lines = createInterface({ input: child.stdout });
  let failure: unknown;
  const result = new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => failure ? reject(failure) : resolve(code));
  });
  const timer = setTimeout(() => { failure = new Error("Native fixture timed out"); child.kill("SIGKILL"); }, 10_000);
  lines.on("line", (line) => {
    void (async () => {
      const message = JSON.parse(line) as ProcessMessage;
      messages.push(message);
      if (message.request) {
        expect(message.request.method).toBe("POST");
        expect(message.request.path).toBe("/api/v1/node/managed-execution/" + f.old.id + "/report");
        const body = JSON.parse(message.request.body) as ExecutionObservation;
        const response = await f.report(body);
        requests.push({ body, status: response.status });
        child.stdin.write(JSON.stringify({ status: response.status, body: JSON.stringify(response.body) }) + "\n");
      }
    })().catch((error: unknown) => { failure = error; child.kill("SIGKILL"); });
  });
  child.stdin.write(JSON.stringify({ root, id: f.old.id, mode }) + "\n");
  try { return { code: await result, messages, requests, stderr }; }
  finally { clearTimeout(timer); lines.close(); child.stdin.destroy(); }
}

function pendingEntry(f: Awaited<ReturnType<typeof fixture>>, observation: ExecutionObservation) {
  return { job: { intent: f.running, repoPath: "/synthetic/repo", taskContext: "{}", enabled: true },
    nextSequence: observation.sequence, phase: "bound", receipt: { ...f.identity, cwd: "/synthetic/work" }, pending: observation };
}

it.skipIf(!process.env.MANAGED_PROCESS_EXECUTABLE)("native process preserves rejected whitespace pending bytes across restart", async () => {
  const f = await fixture();
  const root = await mkdtemp(join(tmpdir(), "managed-rejected-"));
  try {
    const file = join(root, f.old.id + ".json");
    const snapshot = f.snapshot();
    for (const field of ["sessionRef", "resolvedModel"] as const) for (const [, before, after] of mutations) {
      const observation = { sequence: 3, generation: 1, state: "waiting" as const, ...f.identity,
        [field]: before + f.identity[field] + after };
      // Deliberately noncanonical JSON formatting, so byte equality is stronger than decode equality.
      const original = "\n" + JSON.stringify(pendingEntry(f, observation), null, 2) + "\n";
      await writeFile(file, original, { mode: 0o600 });
      for (let restart = 0; restart < 2; restart++) {
        const result = await nativeProcess(f, root, "reject");
        expect(result.stderr).toBe(""); expect(result.code).toBe(0);
        expect(result.messages.at(-1)).toEqual({ rejected: true });
        expect(result.requests).toEqual([{ body: observation, status: 400 }]);
        expect(await readFile(file, "utf8")).toBe(original);
        expect(f.snapshot()).toEqual(snapshot);
      }
    }
  } finally { await f.app.close(); await rm(root, { recursive: true, force: true }); }
});

it.skipIf(!process.env.MANAGED_PROCESS_EXECUTABLE)("native process dies after terminal ACK before save and replays beside corrupt JSON", async () => {
  const f = await fixture();
  const root = await mkdtemp(join(tmpdir(), "managed-terminal-"));
  try {
    f.store.reconcileCleanup(f.access, f.old.id, 1, "fixture-only cleanup");
    f.store.request(f.access, f.request("next"));
    const originalSnapshot = f.snapshot();
    const observation: ExecutionObservation = { sequence: 3, generation: 1, state: "waiting", ...f.identity };
    const entry = pendingEntry(f, observation);
    const file = join(root, f.old.id + ".json");
    const original = "\n" + JSON.stringify(entry, null, 2) + "\n";
    await writeFile(file, original, { mode: 0o600 });
    const crashed = await nativeProcess(f, root, "crash");
    expect(crashed.stderr).toBe(""); expect(crashed.code).toBe(73);
    expect(crashed.requests).toEqual([{ body: observation, status: 200 }]);
    const ack = { accepted: true, terminal: { intentId: f.old.id, generation: 1, sequence: 3, state: "terminal", ...f.identity } };
    expect(crashed.messages.at(-1)).toEqual({ ack });
    expect(await readFile(file, "utf8")).toBe(original);
    const committed = f.snapshot();
    expect(committed.intents).toEqual(originalSnapshot.intents);
    expect(committed.observations).toHaveLength(originalSnapshot.observations.length + 1);
    expect(committed.events).toHaveLength(originalSnapshot.events.length + 1);
    const corruptFile = join(root, "corrupt-neighbor.json");
    const corrupt = "{broken JSON evidence\n";
    await writeFile(corruptFile, corrupt, { mode: 0o600 });
    const restarted = await nativeProcess(f, root, "replay");
    expect(restarted.stderr).toBe(""); expect(restarted.code).toBe(0);
    expect(restarted.requests).toEqual(crashed.requests);
    expect(restarted.messages.at(-1)).toEqual({ errors: ["corrupt-neighbor"] });
    expect(f.snapshot()).toEqual(committed);
    const sealedBytes = await readFile(file);
    // Swift omits nil properties and ignores server-only updatedAt when encoding its journal.
    const { cleanup: _cleanup, outcome: _outcome, updatedAt: _updatedAt, ...nativeIntent } = entry.job.intent;
    expect(JSON.parse(sealedBytes.toString())).toEqual({ job: { ...entry.job, intent: nativeIntent }, nextSequence: 4, phase: "terminal",
      receipt: entry.receipt, terminalObservation: observation, terminalReceipt: ack.terminal });
    // A second real restart neither sends another observation nor enters claim/permit/launch/turn.
    const sealedRestart = await nativeProcess(f, root, "replay");
    expect(sealedRestart.stderr).toBe(""); expect(sealedRestart.code).toBe(0);
    expect(sealedRestart.requests).toEqual([]);
    expect(sealedRestart.messages).toEqual([{ errors: ["corrupt-neighbor"] }]);
    expect(await readFile(file)).toEqual(sealedBytes);
    expect(await readFile(corruptFile, "utf8")).toBe(corrupt);
    expect(f.snapshot()).toEqual(committed);
  } finally { await f.app.close(); await rm(root, { recursive: true, force: true }); }
});

const mutations = [["leading-space", " ", ""], ["trailing-space", "", " "],
  ["leading-newline", "\n", ""], ["trailing-newline", "", "\n"]] as const;
for (const field of ["sessionRef", "resolvedModel"] as const) {
  it.each(mutations)(`rejects raw ${field} %s over HTTP without changing terminal evidence`, async (_label, before, after) => {
    const f = await fixture();
    try {
      // Cover both the old held terminal and a released terminal with a new owner.
      for (const released of [false, true]) {
        if (released) {
          f.store.reconcileCleanup(f.access, f.old.id, 1, "fixture-only cleanup");
          f.store.request(f.access, f.request("next"));
        }
        const exact: ExecutionObservation = { sequence: released ? 4 : 3, generation: 1, state: "waiting", ...f.identity };
        const bad = { ...exact, [field]: before + f.identity[field] + after };
        expect(() => f.store.report(f.access, f.node.nodeId, f.old.id, bad))
          .toThrow(expect.objectContaining({ code: "runtime_identity_changed" }));
        const original = f.snapshot();
        // First late sequence: validation must not normalize then archive it.
        expect((await f.report(bad)).status).toBe(400);
        expect(f.snapshot()).toEqual(original);
        const accepted = await f.report(exact);
        expect(accepted.status).toBe(200);
        expect(accepted.body).toEqual({ accepted: true, terminal: { intentId: f.old.id, generation: 1,
          sequence: exact.sequence, state: "terminal", ...f.identity } });
        expect(f.snapshot().intents).toEqual(original.intents);
        const committed = f.snapshot();
        expect(committed.observations).toHaveLength(original.observations.length + 1);
        expect(committed.events).toHaveLength(original.events.length + 1);
        const row = f.db.connection.prepare("SELECT payload_json FROM managed_execution_observations WHERE intent_id=? AND sequence=?")
          .get(f.old.id, exact.sequence) as { payload_json: string };
        expect(JSON.parse(row.payload_json)).toEqual(exact);
        // Already committed sequence: altered raw input must not become an identical replay.
        expect((await f.report(bad)).status).toBe(400);
        expect(f.snapshot()).toEqual(committed);
        expect((await f.report({ ...exact, state: "running" })).status).toBe(409);
        expect((await f.report(exact))).toEqual(accepted);
        expect(f.snapshot()).toEqual(committed);
      }
    } finally { await f.app.close(); }
  });
}
