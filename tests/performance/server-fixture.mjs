import assert from "node:assert/strict";
import { buildApp } from "../../services/server/dist/app.js";
import { createAiAccessToken, hashPassword } from "../../services/server/dist/admin-auth.js";
import { DispatchStore } from "../../services/server/dist/dispatch-store.js";
import { MergeDeliveries } from "../../services/server/dist/merge-deliveries.js";

// Only synthetic data. Outside src so fixtures are never server build outputs.
export async function serverFixture(shape) {
  const config = { id: "budget-owner", username: "budget@example.test", passwordScrypt: hashPassword("synthetic-budget-password"),
    sessionSecret: "synthetic-budget-signing-secret", cookieSecure: false };
  const app = buildApp({ databasePath: ":memory:", adminAccount: config, writeTools: "comments", statusCheckTime: false });
  try {
    const store = app.missionGoStore, db = store.database.connection, accountId = config.id;
    const product = store.createProduct({ name: "Synthetic budget", keyPrefix: "PERF", createdByAccountId: accountId });
    const merges = new MergeDeliveries(store), dispatches = new DispatchStore(store.database);
    const node = dispatches.registerNode({ accountId, installationId: "budget-node", name: "Synthetic" });
    dispatches.recordHeartbeat(node.nodeId, [{ kind: "codex", ready: true, planApprovalProtocol: 1 }], [], "*", { supportsFreeSessions: true });
    dispatches.replaceOwnRepos(node.nodeId, [{ productId: product.id, repoPath: "/synthetic/budget" }]);
    const account = app.missionGoAccounts.getAccount(accountId);
    const token = createAiAccessToken(config, { id: accountId, username: account.email, role: account.role },
      app.missionGoAccounts.credentialsStamp(account), "budget-client", ["missiongo:read", "missiongo:write"]).token;
    const items = [], batches = [], deliveries = [];
    const sha = "a".repeat(40);
    for (let batchIndex = 0; batchIndex < shape.batches; batchIndex++) {
      const selected = [], groups = [];
      for (let deliveryIndex = 0; deliveryIndex < shape.deliveriesPerBatch; deliveryIndex++) {
        const number = batchIndex * shape.deliveriesPerBatch + deliveryIndex + 1;
        const keys = [];
        let identity;
        for (let index = 0; index < shape.itemsPerDelivery; index++) {
          const item = store.createWorkItem({ productId: product.id, title: `Synthetic ${number}-${index}`, description: "Synthetic item body. ".repeat(Math.ceil(shape.payloadBytes * 4 / 21)),
            type: "task", priority: "normal", status: "ready", environment: { platform: "server" } });
          items.push(item); keys.push(item.key);
          // Use the real claim protocol to ensure list eligibility does not
          // silently short-circuit on invalid credentials, scope or ownership.
          const response = await app.inject({ method: "POST", url: "/mcp",
            headers: { authorization: `Bearer ${token}`, accept: "application/json, text/event-stream" },
            payload: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "claim_item", arguments: {
              itemKey: item.key, agentId: "Synthetic budget", authorizationMode: "conversation", idempotencyKey: `claim-${item.key}`,
              session: { agentKind: "codex", refKind: "tracking", sessionRef: `budget-session-${number}` },
            } } } });
          const wire = response.headers["content-type"]?.includes("text/event-stream")
            ? response.body.split("\n").find(line => line.startsWith("data: "))?.slice(6) : response.body;
          const result = JSON.parse(wire).result;
          assert.ok(result && !result.isError, "Synthetic claim must succeed");
          identity = result.structuredContent.executionIdentity;
          assert.ok(identity?.sessionId);
        }
        const input = { itemKeys: keys, repository: "https://github.com/example/synthetic", pullRequest: number, head: sha, targetBranch: "main",
          summary: "Synthetic performance history", validation: "Synthetic fixture only", requiredArtifacts: ["web"],
          evidence: { head: sha, base: "b".repeat(40), checkedAt: new Date().toISOString(), checks: "passed", mergeable: "clean", source: "synthetic" } };
        const d = merges.propose(accountId, "budget-client", identity, `offer-${number}`, input);
        assert.equal(d.blocker, undefined);
        merges.decide(accountId, d.id, d.revision, "confirm");
        selected.push({ id: d.id, revision: d.revision }); groups.push({ d, keys, number }); deliveries.push(d);
      }
      const batch = merges.start(accountId, `batch-${batchIndex}`, selected,
        { productId: product.id, nodeId: node.nodeId, agentKind: "codex", mode: "default" }, true);
      batches.push(batch);
      // Keep one active batch to cover both pending and historical projections.
      if (batchIndex === shape.batches - 1) continue;
      for (const { d, keys, number } of groups) {
        for (const key of keys) {
          const completion = { kind: "github", url: `${d.repository}/pull/${number}` };
          store.submitDevelopmentComplete({ itemKey: key, completion, requiredArtifacts: ["web"], idempotencyKey: `complete-${key}` });
          store.submitForVerification({ itemKey: key, completion, releases: [{ artifact: "web", version: "synthetic", sourceCommit: sha }],
            deployedCommit: sha, receiptDigest: "c".repeat(64), idempotencyKey: `release-${key}` });
        }
        batch.results[d.id] = { status: "merged", head: sha, commit: sha, detail: "Synthetic historical integration" };
        const raw = JSON.parse(db.prepare("SELECT data_json FROM merge_deliveries WHERE id=?").get(d.id).data_json);
        raw.state = "merged";
        db.prepare("UPDATE merge_deliveries SET state='merged',data_json=? WHERE id=?").run(JSON.stringify(raw), d.id);
      }
      batch.state = "finished";
      db.prepare("UPDATE merge_batches SET state='finished',data_json=? WHERE id=?").run(JSON.stringify(batch), batch.id);
    }
    const event = db.prepare(`INSERT INTO work_item_events(id,item_id,event_type,actor_kind,payload_json,timeline_seq,created_at)
      VALUES (?,?,'comment_added','human',?,?,?)`);
    const payload = JSON.stringify({ text: "Synthetic historical comment. ".repeat(Math.ceil(shape.payloadBytes / 30)) });
    store.database.transaction(() => {
      for (const item of items) {
        const count = db.prepare("SELECT COUNT(*) AS n, MAX(timeline_seq) AS last FROM work_item_events WHERE item_id=?").get(item.id);
        for (let i = count.n; i < shape.eventsPerItem; i++) event.run(`${item.id}-history-${i}`, item.id, payload, count.last + i + 1, "2026-01-01T00:00:00.000Z");
      }
    });
    const expectedItems = shape.batches * shape.deliveriesPerBatch * shape.itemsPerDelivery;
    assert.equal(items.length, expectedItems);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM work_item_events").get().n, expectedItems * shape.eventsPerItem);
    const mergeProjection = () => ({ deliveries: merges.list(product.id, accountId), batches: merges.batches(product.id, accountId),
      attentionSessionIds: merges.attentionSessionIds(product.id, accountId), sessionProgress: merges.sessionProgress(product.id, accountId) });
    const initial = mergeProjection();
    assert.equal(initial.deliveries.length, shape.deliveriesPerBatch);
    assert.equal(initial.batches.length, shape.batches);
    assert.ok(Object.values(initial.sessionProgress).includes("published"));
    assert.ok(Object.values(initial.sessionProgress).includes("merging"));
    assert.equal(Object.keys(initial.sessionProgress).length, deliveries.length + batches.length);
    const list = () => store.listWorkItems({ productId: product.id, limit: 100 });
    assert.equal(list().length, 100);
    return { app, store, shape: { ...shape, items: expectedItems, events: expectedItems * shape.eventsPerItem, deliveries: deliveries.length },
      baseline: () => store.getProduct(product.id),
      targets: { "merge-deliveries": mergeProjection, "item-list": list,
        "item-summary": () => store.getWorkItemListSummary({ productId: product.id }) } };
  } catch (error) { await app.close(); throw error; }
}
