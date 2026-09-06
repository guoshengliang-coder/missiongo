import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { MissionGoDatabase } from "./storage/database.js";
import { MissionGoStore } from "./store.js";

const stores: MissionGoStore[] = [];
const directories: string[] = [];

afterEach(async () => {
  stores.splice(0).forEach((store) => store.close());
  await Promise.all(directories.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function seed() {
  const directory = await mkdtemp(join(tmpdir(), "missiongo-attribution-"));
  directories.push(directory);
  const store = new MissionGoStore(join(directory, "missiongo.sqlite"));
  stores.push(store);
  const product = store.createProduct({ name: "Hermes Go", keyPrefix: "HG" });
  const item = store.createWorkItem({
    productId: product.id,
    type: "bug",
    priority: "high",
    title: "Crash",
    description: "Fails on launch",
    environment: { platform: "other" },
  });
  return { directory, store, item };
}

describe("work-item event attribution", () => {
  it("records which account and client an agent wrote through", async () => {
    const { store, item } = await seed();
    store.createComment({
      itemKey: item.key,
      actorKind: "agent",
      bodyKind: "structured",
      body: {
        understanding: "启动崩溃，要定位",
        finding: "The crash is in the launch path.",
        evidence: ["stack trace"],
        openQuestions: [],
      },
      attribution: { accountId: "account-1", clientId: "client-9" },
      idempotencyKey: "analysis-1",
    });

    const entry = store.getTimeline(item.key).find((event) => event.eventType === "comment_added");
    expect(entry?.actorKind).toBe("agent");
    expect(entry?.accountId).toBe("account-1");
    expect(entry?.clientId).toBe("client-9");
  });

  it("leaves the attribution off events that carry none", async () => {
    const { store, item } = await seed();
    // Human events are unattributed on purpose: one administrator owns this
    // deployment, so actor_kind already names the account.
    const created = store.getTimeline(item.key).find((entry) => entry.eventType === "item_created");
    expect(created?.actorKind).toBe("human");
    expect(created?.accountId).toBeUndefined();
    expect(created?.clientId).toBeUndefined();
    expect(created?.executionId).toBeUndefined();
  });

  it("ties an execution's events back to the execution", async () => {
    const { store, item } = await seed();
    store.transitionWorkItem({ itemKey: item.key, to: "ready", actor: "human", reason: "triaged" });
    const execution = store.claimExecution({
      itemKey: item.key,
      agentId: "agent-1",
      mode: "process",
      leaseSeconds: 900,
      idempotencyKey: "claim-1",
    });

    const claimed = store.getTimeline(item.key).find((entry) => entry.eventType === "execution_claimed");
    expect(claimed?.executionId).toBe(execution.id);
  });

  it("applies the attribution migration once and keeps the columns on reopen", async () => {
    const { directory, store } = await seed();
    store.close();
    stores.splice(stores.indexOf(store), 1);

    const database = new MissionGoDatabase(join(directory, "missiongo.sqlite"));
    try {
      const columns = database.connection
        .prepare("PRAGMA table_info(work_item_events)")
        .all() as unknown as Array<{ name: string }>;
      const names = columns.map((column) => column.name);
      expect(names).toContain("account_id");
      expect(names).toContain("client_id");
      expect(names).toContain("execution_id");

      const applied = database.connection
        .prepare("SELECT COUNT(*) AS count FROM schema_migrations WHERE version = 13")
        .get() as unknown as { count: number };
      expect(applied.count).toBe(1);
    } finally {
      database.close();
    }
  });
});
