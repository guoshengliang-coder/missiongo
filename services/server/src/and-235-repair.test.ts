import { randomBytes } from "node:crypto";
import { expect, it, vi } from "vitest";
import { MISSIONGO_SKILL_VERSION } from "@missiongo/contracts";
import { buildApp } from "./app.js";
import { hashPassword } from "./admin-auth.js";
import { DispatchStore } from "./dispatch-store.js";
import { AgentSessionStore } from "./agent-session-store.js";
import { ManagedRunStore } from "./managed-run-store.js";
import { ManagedDecisionStore } from "./managed-decision-store.js";
import { ManagedExecutionStore } from "./managed-execution-store.js";

const config = { id: "owner", username: "owner@example.test", passwordScrypt: hashPassword("synthetic-password-long"),
  sessionSecret: randomBytes(32).toString("hex"), cookieSecure: true };

// Real Fastify routes/auth/SQLite through inject; this does not open TCP.
it.each(["running", "unknown", "stop", "wait-managed", "ordinary", "wait-ordinary"])(
  "AND-235 repair claim-next capacity through inject: %s", async (scenario) => {
    const app = buildApp({ adminAccount: config });
    let waitSpy: ReturnType<typeof vi.spyOn> | undefined;
    try {
      const database = app.missionGoStore.database;
      const db = database.connection;
      const dispatches = new DispatchStore(database);
      const sessions = new AgentSessionStore(database);
      const managed = new ManagedExecutionStore(database, true);
      const access = () => "owner";
      const node = dispatches.registerNode({ accountId: "owner", installationId: "fixture-node", name: "Fixture" });
      db.exec(`INSERT INTO products(id,key_prefix,name,created_at,updated_at) VALUES ('p','AND','Test','now','now');
        INSERT INTO work_items(id,item_key,sequence,product_id,type,priority,status,title,description,created_at,updated_at)
        VALUES ('i','AND-1',1,'p','task','normal','ready','Task','Data','now','now'),
          ('ordinary-item','AND-2',2,'p','task','normal','ready','Ordinary','Data','now','now');`);
      dispatches.replaceRepos("owner", node.nodeId, [{ productId: "p", repoPath: "/synthetic/repo" }]);
      const repo = db.prepare("SELECT id FROM node_product_repos WHERE node_id=?").get(node.nodeId) as { id: string };
      const headers = { authorization: `Bearer ${node.token}` };
      expect((await app.inject({ method: "POST", url: "/api/v1/node/heartbeat", headers, payload: {
        agents: [{ kind: "codex", ready: true, models: [], skill: { localVersion: MISSIONGO_SKILL_VERSION,
          expectedVersion: MISSIONGO_SKILL_VERSION, syncState: "ready" } }],
      } })).statusCode).toBe(200);
      const login = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: {
        username: config.username, password: "synthetic-password-long",
      } });
      const human = { cookie: login.headers["set-cookie"]!.split(";", 1)[0]! };
      const enqueue = () => app.inject({ method: "POST", url: "/api/v1/dispatches", headers: human,
        payload: { nodeId: node.nodeId, agentKind: "codex", mode: "plan", itemKeys: ["AND-2"] } });
      const claim = (waitMs = 0) => app.inject({ method: "POST", url: "/api/v1/node/dispatches/claim-next", headers,
        payload: { waitMs } });
      const fill = () => {
        if (scenario.includes("ordinary")) {
          for (let index = 0; index < 10; index++) {
            const id = `ordinary-${index}`;
            db.prepare(`INSERT INTO dispatches(id,account_id,node_id,agent_kind,mode,status,repo_path,created_at)
              VALUES (?,'owner',?,'codex','plan','launched','/synthetic/repo','now')`).run(id, node.nodeId);
            const session = sessions.createForDispatch({ dispatchId: id, nodeId: node.nodeId, sessionRef: id });
            db.prepare("UPDATE agent_sessions SET status=? WHERE id=?").run(index % 2 ? "active" : "stalled", session);
          }
          return;
        }
        managed.registerExecutor(access, node.nodeId, { mode: "single_node_local", evidence: "fixture:local" });
        for (let index = 0; index < 10; index++) {
          const run = new ManagedRunStore(database).createRun({ accountId: "owner", productIds: ["p"] }, {
            scope: { productId: "p", repositoryRef: repo.id, itemKeys: ["AND-1"], contractRevision: 1 }, idempotencyKey: `run-${index}`,
          });
          const decisions = new ManagedDecisionStore(database);
          let decision = decisions.create(access, { runId: run.id, decisionKey: "d", scopeDigest: run.scopeDigest,
            contractRevision: 1, idempotencyKey: "create", content: { title: "Review", recommendation: "Review",
              alternatives: ["Defer"], costs: "Local", acceptanceCriteria: ["Pass"], allowedActions: ["review"] } });
          const guard = { version: decision.version, stateVersion: decision.stateVersion, contentDigest: decision.contentDigest,
            scopeDigest: decision.scopeDigest, contractRevision: 1, idempotencyKey: "approve" };
          decision = decisions.change(access, decision.id, "approve", guard);
          const intent = managed.request(access, { ...guard, stateVersion: decision.stateVersion, idempotencyKey: "start",
            runId: run.id, decisionId: decision.id, stageKey: "review", role: "review", inputCommit: "a".repeat(40),
            nodeId: node.nodeId, permissionMode: "read-only" });
          managed.claim(access, node.nodeId, intent.id, 1);
          expect(managed.permit(access, node.nodeId, intent.id, 1).mayStart).toBe(true);
          const observed = managed.report(access, node.nodeId, intent.id, { sequence: 1, generation: 1,
            state: scenario === "running" ? "running" : "unknown", sessionRef: `managed-${index}`, resolvedModel: "fixture-model" });
          if (scenario === "stop" || scenario === "wait-managed") managed.stop(access, intent.id, 1);
          db.prepare("UPDATE agent_sessions SET status=? WHERE id=?").run(index % 2 ? "active" : "stalled", observed.sessionId!);
        }
      };
      let pending: ReturnType<typeof claim>;
      if (scenario.startsWith("wait-")) {
        const original = DispatchStore.prototype.waitForDispatch;
        let entered!: () => void;
        const waiting = new Promise<void>((resolve) => { entered = resolve; });
        waitSpy = vi.spyOn(DispatchStore.prototype, "waitForDispatch").mockImplementation(function(nodeId, ms, signal) {
          const result = original.call(this, nodeId, ms, signal);
          entered();
          return result;
        });
        pending = claim(10_000);
        // Start injection and wait for the real waiter to be installed before filling capacity.
        const response = pending.then((value) => value);
        await waiting;
        fill();
        const queued = await enqueue();
        expect(queued.statusCode, queued.body).toBe(201);
        const claimed = await response;
        expect(claimed.statusCode, claimed.body).toBe(scenario === "wait-ordinary" ? 204 : 200);
        if (claimed.statusCode === 200) expect(claimed.json().dispatchId).toBe(queued.json().id);
      } else {
        fill();
        const queued = await enqueue();
        expect(queued.statusCode, queued.body).toBe(201);
        const claimed = await claim();
        expect(claimed.statusCode, claimed.body).toBe(scenario === "ordinary" ? 204 : 200);
        if (claimed.statusCode === 200) expect(claimed.json().dispatchId).toBe(queued.json().id);
      }
      if (scenario.includes("ordinary")) {
        expect(sessions.countExecutionSlots(node.nodeId)).toBe(10);
        db.prepare("UPDATE agent_sessions SET archived_at='old',archive_source='missiongo' WHERE dispatch_id='ordinary-0'").run();
        expect(sessions.countExecutionSlots(node.nodeId)).toBe(9);
        expect(sessions.listForNode(node.nodeId).filter((session) => session.occupiesExecutionSlot)).toHaveLength(9);
        expect((await claim()).statusCode).toBe(200);
      } else {
        expect(sessions.countExecutionSlots(node.nodeId)).toBe(0);
        expect(db.prepare("SELECT id FROM managed_execution_intents WHERE ownership_held=1").all()).toHaveLength(10);
      }
    } finally { waitSpy?.mockRestore(); await app.close(); }
  });
