import { writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { expect, it, vi } from "vitest";
import { buildApp } from "./app.js";
import { createAiAccessToken, hashPassword } from "./admin-auth.js";
const config = { id: "owner", username: "owner@example.test", passwordScrypt: hashPassword("synthetic-password-long"),
  sessionSecret: randomBytes(32).toString("hex"), cookieSecure: true };
it("requires an explicitly trusted coordinator OAuth client, never a caller role tag", async () => {
  const app = buildApp({ adminAccount: config, managedExecution: { enabled: true, coordinatorClientIds: ["coordinator-fixture"] } });
  try {
    const account = app.missionGoAccounts.getAccount(config.id);
    const token = (client: string) => createAiAccessToken(config, { id: account.id, username: account.email, role: account.role },
      app.missionGoAccounts.credentialsStamp(account), client, ["missiongo:read"]).token;
    const allowed = await app.inject({ url: "/api/v1/managed-execution/repositories", headers: { authorization: `Bearer ${token("coordinator-fixture")}` } });
    expect(allowed.statusCode).toBe(200);
    expect(allowed.json()).toEqual({ repositories: [] });
    const refused = await app.inject({ url: "/api/v1/managed-execution/repositories", headers: { authorization: `Bearer ${token("worker-fixture")}`, "x-agent-role": "coordinator" } });
    expect(refused.statusCode).toBe(403);
  } finally { await app.close(); }
});
it.each(["baseline", "operate", "ai", "view-off", "view-on", "late-before", "late-ack", "terminal-before", "terminal-ack"])("binds HTTP requests and rechecks %s permission at delivery", async (revokedCapability) => {
  const managedOptions = { enabled: true, coordinatorClientIds: ["coordinator-fixture"] };
  const app = buildApp({ adminAccount: config, publicOrigin: "https://managed.test", managedExecution: managedOptions });
  try {
    const account = app.missionGoAccounts.createAccount({ email: "member@example.test", password: "synthetic-password-long", role: "member" });
    const coordinator = { authorization: `Bearer ${createAiAccessToken(config, { id: account.id, username: account.email, role: account.role },
      app.missionGoAccounts.credentialsStamp(account), "coordinator-fixture", ["missiongo:read", "missiongo:write"]).token}` };
    const { DispatchStore } = await import("./dispatch-store.js");
    const nodes = new DispatchStore(app.missionGoStore.database);
    const node = nodes.registerNode({ accountId: account.id, installationId: "fixture-node", name: "Fixture" });
    const otherNode = nodes.registerNode({ accountId: account.id, installationId: "other-node", name: "Other" });
    const db = app.missionGoStore.database.connection;
    db.exec(`INSERT INTO products(id,key_prefix,name,created_at,updated_at) VALUES ('p','AND','Test','now','now');
      INSERT INTO work_items(id,item_key,sequence,product_id,type,priority,status,title,description,created_at,updated_at)
      VALUES ('i','AND-1',1,'p','task','normal','ready','Task','Data','now','now');`);
    app.missionGoAccounts.replacePermissions(account.id, [{ productId: "p", canView: true, canOperate: true, canUseAi: true }]);
    nodes.replaceRepos(account.id, node.nodeId, [{ productId: "p", repoPath: "/synthetic/repo" }]);
    const repositories = (await app.inject({ url: "/api/v1/managed-execution/repositories", headers: coordinator })).json().repositories;
    const readOnly = createAiAccessToken(config, { id: account.id, username: account.email, role: account.role },
      app.missionGoAccounts.credentialsStamp(account), "coordinator-fixture", ["missiongo:read"]).token;
    const deniedWrite = await app.inject({ method: "POST", url: "/api/v1/managed-execution/runs", headers: { authorization: `Bearer ${readOnly}` }, payload: {
      scope: { productId: "p", repositoryRef: repositories[0].repositoryRef, itemKeys: ["AND-1"], contractRevision: 1 }, idempotencyKey: "read-only-run",
    } });
    expect(deniedWrite.statusCode).toBe(403);
    const made = await app.inject({ method: "POST", url: "/api/v1/managed-execution/runs", headers: coordinator, payload: {
      scope: { productId: "p", repositoryRef: repositories[0].repositoryRef, itemKeys: ["AND-1"], contractRevision: 1 }, idempotencyKey: "run",
    } });
    expect(made.statusCode).toBe(200);
    const run = made.json();
    const login = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { username: account.email, password: "synthetic-password-long" } });
    const human = { cookie: login.headers["set-cookie"]!.split(";", 1)[0]!, origin: "https://managed.test" };
    const d = (await app.inject({ method: "POST", url: `/api/v1/managed-runs/${run.id}/decisions`, headers: human, payload: {
      decisionKey: "d", scopeDigest: run.scopeDigest, contractRevision: 1, idempotencyKey: "propose", content: {
        title: "Review", recommendation: "Review candidate", alternatives: ["Defer"], costs: "Local resources", acceptanceCriteria: ["Read only"], allowedActions: ["review"],
      },
    } })).json();
    const guard = { version: d.version, stateVersion: d.stateVersion, contentDigest: d.contentDigest, scopeDigest: d.scopeDigest, contractRevision: 1, idempotencyKey: "approve" };
    const approved = await app.inject({ method: "POST", url: `/api/v1/managed-decisions/${d.id}/approve`, headers: human, payload: guard });
    expect(approved.statusCode).toBe(200);
    const payload = { ...guard, stateVersion: approved.json().stateVersion, idempotencyKey: "intent", runId: run.id, decisionId: d.id,
      nodeId: node.nodeId, stageKey: "review", role: "review", inputCommit: "a".repeat(40), permissionMode: "read-only" };
    expect((await app.inject({ method: "POST", url: "/api/v1/managed-execution/executors/" + node.nodeId + "/register", headers: coordinator,
      payload: { mode: "single_node_local", evidence: "fixture:exclusive-local-installation" } })).statusCode).toBe(200);
    const intentResponse = await app.inject({ method: "POST", url: "/api/v1/managed-execution/intents", headers: coordinator, payload });
    expect(intentResponse.statusCode).toBe(200);
    const intent = intentResponse.json();
    const operation = (name: string, token = node.token) => app.inject({ method: "POST", url: `/api/v1/node/managed-execution/${intent.id}/${name}`,
      headers: { authorization: `Bearer ${token}` }, payload: { generation: 1 } });
    expect((await operation("claim", otherNode.token)).statusCode).toBe(404);
    expect((await operation("claim")).json().state).toBe("acknowledged");
    expect((await operation("permit")).json().mayStart).toBe(true);
    expect((await operation("permit")).json().mayStart).toBe(false);
    if (revokedCapability.startsWith("late-")) {
      const receipt = { sequence: 1, generation: 1, state: "bound", sessionRef: "late-native-thread", resolvedModel: "late-actual-model" };
      const report = (payload = receipt, token = node.token) => app.inject({ method: "POST", url: "/api/v1/node/managed-execution/" + intent.id + "/report",
        headers: { authorization: "Bearer " + token }, payload });
      if (revokedCapability === "late-ack") expect((await report()).statusCode).toBe(200);
      const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 121_000);
      try {
        const timedOut = await app.inject({ url: "/api/v1/managed-execution/intents/" + intent.id, headers: coordinator });
        expect(timedOut.json().state).toBe("unknown");
        managedOptions.enabled = false;
        app.missionGoAccounts.replacePermissions(account.id, []);
        expect((await report()).statusCode).toBe(200);
        expect((await report()).json()).toEqual({ accepted: true });
        const persisted = JSON.parse((db.prepare("SELECT snapshot_json FROM managed_execution_intents WHERE id=?").get(intent.id) as { snapshot_json: string }).snapshot_json);
        expect(persisted).toMatchObject({ state: "unknown", ownershipHeld: true, stopRequested: true });
        expect(persisted.sessionId).toBeTruthy(); expect(persisted.attemptId).toBeTruthy();
        expect((await report({ ...receipt, generation: 2 })).statusCode).toBe(409);
        expect((await report({ ...receipt, resolvedModel: "wrong" })).statusCode).toBe(409);
        expect((await report(receipt, otherNode.token)).statusCode).toBe(404);
        app.missionGoAccounts.replacePermissions(account.id, [{ productId: "p", canView: true, canOperate: true, canUseAi: true }]);
        managedOptions.enabled = true;
        expect((await operation("permit")).statusCode).toBe(409);
      } finally { clock.mockRestore(); }
      return;
    }
    const observation = await app.inject({ method: "POST", url: "/api/v1/node/managed-execution/" + intent.id + "/report",
      headers: { authorization: "Bearer " + node.token }, payload: { sequence: 1, generation: 1, state: "running", sessionRef: "fixture-native-thread", resolvedModel: "fixture-native-model" } });
    expect(observation.statusCode).toBe(200);
    const mirror = await app.inject({ url: "/api/v1/managed-execution/intents/" + intent.id + "/session", headers: coordinator });
    expect(mirror.statusCode).toBe(200);
    expect(mirror.json().attempt.executor).toEqual({ agentKind: "codex", sessionRef: "fixture-native-thread", resolvedModel: "fixture-native-model" });
    expect(mirror.json().session.managedExecution).toMatchObject({ id: intent.id, runId: run.id, role: "review", generation: 1 });
    if (revokedCapability.startsWith("terminal-")) {
      const waiting = { sequence: 2, generation: 1, state: "waiting", sessionRef: "fixture-native-thread", resolvedModel: "fixture-native-model" };
      const report = (body = waiting, token = node.token) => app.inject({ method: "POST",
        url: "/api/v1/node/managed-execution/" + intent.id + "/report", headers: { authorization: "Bearer " + token }, payload: body });
      // Separate an already committed observation with lost ACK from a first late commit.
      if (revokedCapability === "terminal-ack") expect((await report()).json()).toEqual({ accepted: true });
      expect((await app.inject({ method: "POST", url: "/api/v1/managed-execution/intents/" + intent.id + "/finish",
        headers: coordinator, payload: { generation: 1, outcome: "failed", summary: "Stopped", evidence: "fixture:stopped" } })).statusCode).toBe(200);
      const held = (await app.inject({ url: "/api/v1/managed-execution/intents/" + intent.id, headers: coordinator })).json();
      expect(held).toMatchObject({ state: "terminal", ownershipHeld: true });
      const archived = await report();
      expect(archived.statusCode).toBe(200);
      expect(archived.json()).toEqual({ accepted: true, terminal: { intentId: intent.id, generation: 1, sequence: 2,
        state: "terminal", sessionRef: waiting.sessionRef, resolvedModel: waiting.resolvedModel } });
      expect((await app.inject({ url: "/api/v1/managed-execution/intents/" + intent.id, headers: coordinator })).json()).toEqual(held);
      expect((await app.inject({ method: "POST", url: "/api/v1/managed-execution/intents/" + intent.id + "/cleanup",
        headers: coordinator, payload: { generation: 1, evidence: "fixture:cleanup" } })).statusCode).toBe(200);
      const next = await app.inject({ method: "POST", url: "/api/v1/managed-execution/intents", headers: coordinator,
        payload: { ...payload, idempotencyKey: "next", stageKey: "review-2" } });
      expect(next.statusCode).toBe(200);
      const jobs = await app.inject({ url: "/api/v1/node/managed-execution", headers: { authorization: "Bearer " + node.token } });
      expect(jobs.json().jobs.map((j: { intent: { id: string } }) => j.intent.id)).toEqual([next.json().id]);
      expect((await app.inject({ method: "POST", url: "/api/v1/node/managed-execution/" + next.json().id + "/claim",
        headers: { authorization: "Bearer " + node.token }, payload: { generation: 1 } })).json().state).toBe("acknowledged");
      expect((await report()).json()).toEqual(archived.json());
      for (const changed of [{ generation: 2 }, { sessionRef: "wrong" }, { resolvedModel: "wrong" }, { sessionRef: undefined }, { resolvedModel: undefined }]) {
        expect((await report({ ...waiting, sequence: 3, ...changed })).statusCode).toBe(409);
      }
      expect((await report({ ...waiting, state: "running" })).statusCode).toBe(409);
      expect((await report(waiting, otherNode.token)).statusCode).toBe(404);
      expect((await operation("permit")).statusCode).toBe(409);
      const terminal = (await app.inject({ url: "/api/v1/managed-execution/intents/" + intent.id, headers: coordinator })).json();
      expect(terminal).toMatchObject({ state: "terminal", ownershipHeld: false, stopRequested: true, outcome: "failed" });
      const rows = db.prepare("SELECT payload_json FROM managed_execution_observations WHERE intent_id=? AND sequence=2").all(intent.id);
      expect(rows).toHaveLength(1); expect(JSON.parse(rows[0]!.payload_json as string)).toEqual(waiting);
      expect(db.prepare("SELECT operation FROM managed_execution_events WHERE intent_id=? AND operation='terminal_observation_archived'").all(intent.id))
        .toHaveLength(revokedCapability === "terminal-before" ? 1 : 0);
      if (process.env.MANAGED_WIRE_FIXTURE) writeFileSync(process.env.MANAGED_WIRE_FIXTURE + "." + revokedCapability + ".json",
        JSON.stringify({ job: jobs.json().jobs[0], observation: waiting, receipt: archived.json(), oldIntent: held }));
      return;
    }
    const queued = await app.inject({ method: "POST", url: "/api/v1/managed-execution/intents/" + intent.id + "/input",
      headers: coordinator, payload: { generation: 1, idempotencyKey: "reply", text: "Review regression" } });
    expect(queued.statusCode).toBe(200);
    const commandId = queued.json().id;
    const liveBinding = app.missionGoStore.database.connection.prepare("SELECT id FROM agent_sessions WHERE dispatch_id=?").get(intent.id) as { id: string };
    const staleDelivery = () => app.inject({ method: "POST", url: "/api/v1/node/agent-sessions/" + liveBinding.id + "/snapshot",
      headers: { authorization: "Bearer " + node.token }, payload: { status: "idle", messages: [], commandId, commandStatus: "delivering" } });
    if (revokedCapability.startsWith("view-")) {
      // A historical manual observer must still be returned when a managed product loses access.
      db.prepare("INSERT INTO dispatches(id,account_id,node_id,agent_kind,mode,status,repo_path,created_at,completed_at) VALUES ('manual-observer',?,?,'claude_code','default','failed','/synthetic/other','now','now')").run(account.id, node.nodeId);
      const { AgentSessionStore } = await import("./agent-session-store.js");
      const manualId = new AgentSessionStore(app.missionGoStore.database).createForDispatch({ dispatchId: "manual-observer", nodeId: node.nodeId, sessionRef: "manual-observer-thread" });
      db.prepare("UPDATE agent_sessions SET status='unavailable' WHERE id=?").run(manualId);
      managedOptions.enabled = revokedCapability === "view-on";
      app.missionGoAccounts.replacePermissions(account.id, []);
      const headers = { authorization: "Bearer " + node.token };
      const poll = await app.inject({ url: "/api/v1/node/agent-sessions", headers });
      expect.soft(poll.statusCode, "permission loss cannot block stop polling").toBe(200);
      if (poll.statusCode === 200) {
        expect(poll.json().sessions[0]).toMatchObject({ sessionRef: "fixture-native-thread", managedExecution: { stopRequested: true } });
        expect(poll.json().sessions[0].command).toBeUndefined();
        expect(poll.json().sessions.some((session: { id: string }) => session.id === manualId)).toBe(true);
      }
      const jobs = await app.inject({ url: "/api/v1/node/managed-execution", headers });
      expect.soft(jobs.statusCode, "permission loss cannot block minimal jobs").toBe(200);
      if (jobs.statusCode === 200) {
        expect(jobs.json().jobs).toEqual([]);
        expect(jobs.json().stops).toEqual([{ id: intent.id, generation: 1 }]);
        expect(jobs.body).not.toContain("Task"); expect(jobs.body).not.toContain("/synthetic/repo");
      }
      expect((await staleDelivery()).statusCode).toBe(404);
      expect((await operation("permit")).statusCode).toBe(404);
      const report = await app.inject({ method: "POST", url: "/api/v1/node/managed-execution/" + intent.id + "/report", headers,
        payload: { sequence: 2, generation: 1, state: "unknown", sessionRef: "fixture-native-thread", resolvedModel: "fixture-native-model" } });
      expect(report.statusCode, "minimal observation survives lost product access").toBe(200);
      expect(report.json()).toEqual({ accepted: true });
      if (process.env.MANAGED_WIRE_FIXTURE && revokedCapability === "view-off") {
        writeFileSync(process.env.MANAGED_WIRE_FIXTURE + ".minimal-jobs.json", jobs.body);
        writeFileSync(process.env.MANAGED_WIRE_FIXTURE + ".minimal-sessions.json", poll.body);
      }
      expect((await app.inject({ method: "POST", url: "/api/v1/node/managed-execution/" + intent.id + "/report",
        headers: { authorization: "Bearer " + otherNode.token }, payload: { sequence: 3, generation: 1, state: "unknown" } })).statusCode).toBe(404);
      app.missionGoAccounts.updateAccount(account.id, { disabled: true });
      expect((await app.inject({ url: "/api/v1/node/agent-sessions", headers })).statusCode).toBe(401);
      expect((await app.inject({ url: "/api/v1/node/managed-execution", headers })).statusCode).toBe(401);
      app.missionGoAccounts.updateAccount(account.id, { disabled: false });
      nodes.revokeNode(account.id, node.nodeId);
      expect((await app.inject({ url: "/api/v1/node/agent-sessions", headers })).statusCode).toBe(401);
      expect((await app.inject({ url: "/api/v1/node/managed-execution", headers })).statusCode).toBe(401);
      return;
    }
    if (revokedCapability !== "baseline") {
      app.missionGoAccounts.replacePermissions(account.id, [{ productId: "p", canView: true,
        canOperate: revokedCapability !== "operate", canUseAi: revokedCapability !== "ai" }]);
      const polled = await app.inject({ url: "/api/v1/node/agent-sessions", headers: { authorization: "Bearer " + node.token } });
      expect(polled.statusCode).toBe(200);
      expect.soft(polled.json().sessions[0].command, "revoked capability must suppress queued input").toBeUndefined();
      expect((await staleDelivery()).statusCode, "revoked capability must reject delivering ACK").toBe(404);
      return;
    }
    managedOptions.enabled = false;
    expect((await staleDelivery()).statusCode).toBe(409);
    managedOptions.enabled = true;
    // Revoke after enqueue and before Node's delivery acknowledgement.
    const revoked = await app.inject({ method: "POST", url: "/api/v1/managed-decisions/" + d.id + "/revoke", headers: human,
      payload: { ...guard, stateVersion: approved.json().stateVersion, idempotencyKey: "revoke" } });
    expect(revoked.statusCode).toBe(200);
    expect((await staleDelivery()).statusCode).toBe(409);
    const stopped = await app.inject({ method: "POST", url: "/api/v1/managed-execution/intents/" + intent.id + "/stop",
      headers: coordinator, payload: { generation: 1 } });
    expect(stopped.statusCode).toBe(200);
    db.prepare("UPDATE agent_sessions SET status='idle',archived_at=?,archive_source='source',updated_at=? WHERE id=?")
      .run(new Date().toISOString(), new Date().toISOString(), liveBinding.id);
    const wire = await app.inject({ url: "/api/v1/node/agent-sessions", headers: { authorization: "Bearer " + node.token } });
    expect(wire.statusCode).toBe(200);
    expect(wire.json().sessions).toHaveLength(1);
    expect(wire.json().sessions[0]).toMatchObject({ occupiesExecutionSlot: true,
      managedExecution: { id: intent.id, generation: 1, role: "review", stopRequested: true } });
    expect(wire.json().sessions[0].command).toBeUndefined();
    if (process.env.MANAGED_WIRE_FIXTURE) writeFileSync(process.env.MANAGED_WIRE_FIXTURE, wire.body);
    const bad = await app.inject({ method: "POST", url: "/api/v1/managed-execution/intents", headers: coordinator, payload: { ...payload, command: "arbitrary" } });
    expect(bad.statusCode).toBe(400);
    expect((await app.inject({ method: "POST", url: "/api/v1/managed-execution/intents", headers: { authorization: `Bearer ${node.token}` }, payload })).statusCode).toBe(403);
    expect(db.prepare("SELECT status FROM work_items").get()).toEqual({ status: "ready" });
  } finally { await app.close(); }
});
