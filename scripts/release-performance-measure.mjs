import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { performance } from "node:perf_hooks";
import { calibration, evaluateTarget, releaseTargetCalibration } from "./performance-budget.mjs";
import { sampleSync, sampleAsync } from "./performance-measurement.mjs";

export async function measureBackup({ root, database, directory, productId, config }) {
  const load = file => import(pathToFileURL(join(root, "services/server/dist", file)).href);
  const { buildApp } = await load("app.js");
  const { createAdminSession, ADMIN_SESSION_COOKIE } = await load("admin-auth.js");
  const { MergeDeliveries } = await load("merge-deliveries.js");
  const { DispatchStore } = await load("dispatch-store.js");
  const secret = randomBytes(32).toString("hex");
  const auth = { id: "release-smoke-bootstrap", username: "smoke@example.invalid", passwordScrypt: "unused-no-login", sessionSecret: secret, cookieSecure: false };
  const noRemote = () => { throw new Error("External provider disabled in smoke"); };
  const app = buildApp({ databasePath: database, adminAccount: auth, attachmentsPath: join(directory, "attachments"),
    dingtalkWorker: false, dingtalkFetch: noRemote, aiProviderFetch: noRemote, widgetPushFetch: noRemote, writeTools: "none" });
  let smokeStep = "scope";
  try {
    const store = app.missionGoStore, db = store.database.connection;
    // Leave room for the immutable snapshot, working database and its journals.
    // The supervisor additionally watches the whole ephemeral tree, including startup.
    const pageSize = Number(db.prepare("PRAGMA page_size").get().page_size);
    const maxPages = Math.floor((config.release.maxTempBytes - config.release.maxBackupBytes - 1024 * 1024) / 3 / pageSize);
    const actual = db.prepare(`PRAGMA max_page_count=${maxPages}`).get().max_page_count;
    assert.ok(Number(actual) <= maxPages, "Working database resource limit exceeded");
    store.getProduct(productId);
    // Preserve a real associated account's visibility. A new account would make
    // historical merge reads trivially empty and falsely fast.
    const owners = db.prepare(`SELECT account_id, COUNT(*) AS n FROM merge_batches WHERE product_id=? GROUP BY account_id ORDER BY n DESC`).all(productId);
    const account = owners.map(row => { try { return app.missionGoAccounts.getAccount(row.account_id); } catch { return undefined; } })
      .find(value => value && !value.disabledAt && app.missionGoAccounts.allows(value, productId, "view") && app.missionGoAccounts.allows(value, productId, "ai") && app.missionGoAccounts.allows(value, productId, "operate"));
    assert.ok(account, "Backup lacks an active, authorized merge-history account");
    const accountId = account.id;
    const merges = new MergeDeliveries(store), dispatches = new DispatchStore(store.database);
    const projection = () => ({ deliveries: merges.list(productId, accountId), batches: merges.batches(productId, accountId),
      attentionSessionIds: merges.attentionSessionIds(productId, accountId), sessionProgress: merges.sessionProgress(productId, accountId) });
    const initial = projection();
    assert.ok(initial.batches.length && Object.keys(initial.sessionProgress).length, "Backup must exercise associated merge history");
    const itemCount = db.prepare("SELECT COUNT(*) AS n FROM work_items WHERE product_id=?").get(productId).n;
    assert.ok(itemCount >= 100, "Backup must exercise a full item page");
    smokeStep = "node";
    const node = dispatches.registerNode({ accountId, installationId: randomUUID(), name: "Local performance smoke" });
    dispatches.recordHeartbeat(node.nodeId, [{ kind: "codex", ready: true, planApprovalProtocol: 1 }], [], "*", { supportsFreeSessions: true });
    dispatches.replaceOwnRepos(node.nodeId, [{ productId, repoPath: directory }]);
    const item = store.createWorkItem({ productId, type: "task", priority: "normal", status: "ready", title: "Ephemeral smoke", description: "Local copy only", environment: { platform: "server" } });
    const queue = () => dispatches.createDispatch({ accountId, nodeId: node.nodeId, agentKind: "codex", mode: "default", itemKeys: [item.key] });
    smokeStep = "listen";
    const origin = await app.listen({ host: "127.0.0.1", port: 0 });
    const cookie = `${ADMIN_SESSION_COOKIE}=${createAdminSession(auth, { id: accountId, username: account.email, role: account.role }, app.missionGoAccounts.credentialsStamp(account))}`;
    const http = async (path, { claim = false, waitMs = 0, expected = 200 } = {}) => {
      const response = await fetch(origin + path, { method: claim ? "POST" : "GET", headers: claim
        ? { authorization: `Bearer ${node.token}`, "content-type": "application/json" } : { cookie },
      ...(claim ? { body: JSON.stringify({ waitMs, availableAgentKinds: ["codex"] }) } : {}), signal: AbortSignal.timeout(10_000) });
      assert.equal(response.status, expected, "Smoke HTTP status mismatch");
      if (expected === 204) { await response.text(); return; }
      const value = await response.json();
      if (path.includes("merge-deliveries")) assert.ok(value.batches?.length && Object.keys(value.sessionProgress ?? {}).length, "Empty merge HTTP scope");
      else if (!claim) assert.equal(value.items?.length, 100, "Incomplete HTTP item page");
      else assert.ok(typeof value.dispatchId === "string", "No controlled dispatch claimed");
    };
    const claimPath = "/api/v1/node/dispatches/claim-next";
    // Prove the immediate work branch without executing the returned dispatch.
    smokeStep = "controlled-claim";
    const queued = queue();
    const workStarted = performance.now();
    await http(claimPath, { claim: true });
    const initialClaimWorkMs = performance.now() - workStarted;
    assert.equal(dispatches.getDispatch(accountId, queued.id).status, "delivered");
    smokeStep = "idle-claim";
    const idle = performance.now();
    await http(claimPath, { claim: true, waitMs: 2000, expected: 204 });
    const idleMs = performance.now() - idle;
    assert.ok(idleMs >= 1900, "Claim long poll returned early");
    smokeStep = "cpu";
    const targets = { "merge-deliveries": projection, "item-list": () => store.listWorkItems({ productId, limit: 100 }),
      "item-summary": () => store.getWorkItemListSummary({ productId }) };
    const baseline = () => store.getProduct(productId);
    sampleSync(baseline, config.baseline.iterations);
    const readings = Array.from({ length: config.samples }, () => sampleSync(baseline, config.baseline.iterations));
    const calibrated = { ...calibration(readings.map(v => v.cpuMs), config.baseline), wallSamplesMs: readings.map(v => v.wallMs) };
    const health = async () => {
      const response = await fetch(origin + "/health", { signal: AbortSignal.timeout(10_000) });
      assert.equal(response.status, 200, "Calibration health status mismatch");
      assert.equal((await response.json()).status, "ok", "Calibration health body mismatch");
    };
    const healthBudget = config.release.httpBaseline;
    for (let i = 0; i < config.warmups; i++) await sampleAsync(health, healthBudget.iterations);
    const healthSamples = [];
    for (let i = 0; i < config.samples; i++) healthSamples.push(await sampleAsync(health, healthBudget.iterations));
    const httpCalibration = { ...calibration(healthSamples, healthBudget), timingUnit: "wall-ms", source: "loopback-health" };
    const scoreHttp = (name, samples, budget) => {
      const selected = releaseTargetCalibration(name, config, calibrated, httpCalibration);
      return { ...evaluateTarget(name, samples, budget, selected), calibrationScale: selected.scale,
        calibrationKind: name === "claim-next" ? "loopback-health-wall" : name === "claim-next-work" ? "cpu+loopback-health-wall" : "product-read-cpu" };
    };
    const cpuTargets = [];
    for (const [name, fn] of Object.entries(targets)) {
      const budget = config.targets[name];
      for (let i = 0; i < config.warmups; i++) sampleSync(fn, budget.iterations);
      const samples = Array.from({ length: config.samples }, () => sampleSync(fn, budget.iterations));
      cpuTargets.push({ ...evaluateTarget(name, samples.map(v => v.cpuMs), budget, calibrated), wallSamplesMs: samples.map(v => v.wallMs) });
    }
    smokeStep = "http";
    const routes = { "merge-deliveries": () => http(`/api/v1/products/${encodeURIComponent(productId)}/merge-deliveries`),
      "item-list": () => http(`/api/v1/items?productId=${encodeURIComponent(productId)}&projection=list&limit=100`),
      "claim-next": () => http(claimPath, { claim: true, expected: 204 }) };
    // CPU is the independent machine baseline; transport-sensitive claims use
    // the separately measured health baseline. Never calibrate on the target.
    const httpTargets = [];
    for (const [name, fn] of Object.entries(routes)) {
      const budget = config.release.httpTargets[name];
      for (let i = 0; i < config.warmups; i++) await sampleAsync(fn, budget.iterations);
      const samples = [];
      for (let i = 0; i < config.samples; i++) samples.push(await sampleAsync(fn, budget.iterations));
      httpTargets.push(scoreHttp(name, samples, budget));
    }
    smokeStep = "work-claim";
    const workSamples = [], resetWork = () => db.prepare("UPDATE dispatches SET status='queued', delivered_at=NULL WHERE id=?").run(queued.id);
    for (let i = 0; i < config.warmups; i++) { resetWork(); await http(claimPath, { claim: true }); }
    for (let i = 0; i < config.samples; i++) {
      // Queue setup/projection writes stay outside timed HTTP work. Grouping
      // readings keeps a single GC or socket scheduling event from dominating.
      let total = 0;
      for (let n = 0; n < config.release.httpTargets["claim-next"].iterations; n++) {
        resetWork();
        total += await sampleAsync(() => http(claimPath, { claim: true }), 1);
      }
      workSamples.push(total / config.release.httpTargets["claim-next"].iterations);
    }
    httpTargets.push(scoreHttp("claim-next-work", workSamples, config.release.httpTargets["claim-next"]));
    return { calibration: calibrated, httpCalibration, cpuTargets, httpTargets, idleMs, initialClaimWorkMs,
      coverage: { items: itemCount, batches: initial.batches.length, sessionProgress: Object.keys(initial.sessionProgress).length },
      status: calibrated.valid && httpCalibration.valid && [...cpuTargets, ...httpTargets].every(t => t.status === "passed") ? "passed" : "failed" };
  } catch (error) { error.smokeStep = smokeStep; throw error; } finally { await app.close(); }
}
