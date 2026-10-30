import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "./app.js";
import { hashPassword } from "./admin-auth.js";

const apps: FastifyInstance[] = [];
const password = "synthetic-filter-password";
const passwordScrypt = hashPassword(password);
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});
async function fixture() {
  const app = buildApp({
    adminAccount: {
      id: "admin",
      username: "admin@example.test",
      passwordScrypt,
      sessionSecret: "synthetic-filter-session-secret",
      cookieSecure: false,
    },
  });
  apps.push(app);
  const login = await app.inject({
    method: "POST",
    url: "/api/v1/auth/login",
    payload: { username: "admin@example.test", password },
  });
  const cookie = login.headers["set-cookie"]!.toString().split(";")[0]!;
  const store = app.missionGoStore;
  const product = store.createProduct({
    name: "Filter fixture",
    keyPrefix: "FL",
  });
  const other = store.createProduct({ name: "Other fixture", keyPrefix: "FO" });
  const module = store.createComponent({
    productId: product.id,
    name: "Frontend",
    kind: "web",
  });
  const create = (
    type: "bug" | "requirement" | "task",
    priority: "high" | "normal",
    accountId = "admin",
    sourceComponentId?: string,
  ) =>
    store.createWorkItem({
      productId: product.id,
      status: "ready",
      type,
      priority,
      title: `Filter ${type}`,
      description: "Synthetic description",
      environment: { platform: "web" },
      attribution: { accountId },
      ...(sourceComponentId ? { sourceComponentId } : {}),
    });
  const query = (values: Record<string, unknown>, bootstrap = false) => {
    const params = new URLSearchParams({ productId: product.id });
    for (const [key, value] of Object.entries(values))
      params.set(
        key,
        typeof value === "string" ? value : JSON.stringify(value),
      );
    return app.inject({
      method: "GET",
      url: `/api/v1/${bootstrap ? "bootstrap" : "items"}?${params}`,
      headers: { cookie },
    });
  };
  return { app, store, product, other, module, create, query, cookie };
}

describe("AND-308 combined list filters", () => {
  it("applies OR within dimensions and AND across them to pagination, counts and bootstrap", async () => {
    const f = await fixture();
    const a = f.create("bug", "high", "admin", f.module.id);
    const b = f.create("requirement", "high", "admin", f.module.id);
    const done = f.create("bug", "high", "admin", f.module.id);
    f.store.transitionWorkItem({
      itemKey: done.key,
      to: "in_progress",
      actor: "human",
      reason: "claim",
    });
    f.create("task", "high", "admin", f.module.id);
    f.create("bug", "normal", "admin", f.module.id);
    f.create("bug", "high", "someone-else", f.module.id);
    f.create("bug", "high");
    const filters = {
      types: ["bug", "requirement"],
      priorities: ["high"],
      sourceComponentIds: [f.module.id],
      proposerKeys: ["mine"],
      status: "ready",
      search: "Filter",
      limit: "1",
    };
    const first = await f.query(filters);
    expect(first.statusCode).toBe(200);
    expect(first.json().items.map((i: { key: string }) => i.key)).toEqual([
      b.key,
    ]);
    expect(first.json().summary).toMatchObject({
      total: 3,
      productTotal: 7,
      byStatus: { ready: 2, in_progress: 1 },
    });
    const second = await f.query({
      ...filters,
      beforeSequence: String(first.json().nextBeforeSequence),
    });
    expect(second.json().items.map((i: { key: string }) => i.key)).toEqual([
      a.key,
    ]);
    const boot = await f.query(filters, true);
    expect(boot.json().items).toEqual(first.json().items);
    expect(boot.json().summary).toEqual(first.json().summary);
    expect(
      (await f.query({ ...filters, builder: "unassigned" })).json().summary
        .total,
    ).toBe(3);
  });

  it("groups AI-assisted submissions under their proposer account and keeps unowned sources distinct", async () => {
    const f = await fixture();
    const human = f.create("task", "normal");
    const agent = f.store.createDerivedWorkItem({
      productId: f.product.id,
      type: "task",
      priority: "normal",
      status: "inbox",
      title: "Agent proposal",
      description: "x",
      agentName: "Synthetic Agent",
      attribution: { accountId: "admin", clientId: "synthetic-client" },
      idempotencyKey: "synthetic-proposer-agent",
    });
    const unowned=f.store.createDerivedWorkItem({productId:f.product.id,type:"task",priority:"normal",status:"inbox",title:"Unowned AI proposal",description:"x",agentName:"Synthetic Agent",idempotencyKey:"synthetic-proposer-unowned"});
    f.store.createWorkItem({
      productId: f.other.id,
      type: "task",
      priority: "normal",
      title: "Outside",
      description: "x",
      attribution: { accountId: "outside" },
    });
    const response = await f.app.inject({
      method: "GET",
      url: `/api/v1/products/${f.product.id}/item-filter-options`,
      headers: { cookie: f.cookie },
    });
    expect(response.statusCode).toBe(200);
    const choices = response.json().proposers;
    expect(choices).toHaveLength(2);
    expect(
      choices.find((p: { kind: string }) => p.kind === "agent").label,
    ).toContain("Synthetic Agent");
    expect(
      (await f.query({ proposerKeys: ["mine"] }))
        .json()
        .items.map((i: { key: string }) => i.key),
    ).toEqual([agent.key,human.key]);
    const agentKey = choices.find(
      (p: { kind: string }) => p.kind === "agent",
    ).value;
    expect(
      (await f.query({ proposerKeys: [agentKey] }))
        .json()
        .items.map((i: { key: string }) => i.key),
    ).toEqual([unowned.key]);
    expect(
      (await f.query({ proposerKeys: ["mine", agentKey] })).json().items,
    ).toHaveLength(3);
    expect(JSON.stringify(choices)).not.toContain("outside");
    expect(
      (
        await f.app.inject({
          method: "GET",
          url: `/api/v1/products/${f.product.id}/item-filter-options`,
        })
      ).statusCode,
    ).toBe(401);
    const member = f.app.missionGoAccounts.createAccount({
      email: "no-access@example.test",
      password,
      role: "member",
    });
    const login = await f.app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { username: member.email, password },
    });
    expect(
      (
        await f.app.inject({
          method: "GET",
          url: `/api/v1/products/${f.product.id}/item-filter-options`,
          headers: {
            cookie: login.headers["set-cookie"]!.toString().split(";")[0]!,
          },
        })
      ).statusCode,
    ).toBe(404);
  });

  it("filters SDK sources by token identity and keeps unattributed history selectable", async () => {
    const f = await fixture();
    f.create("bug", "high");
    const token = f.store.createSdkToken({
      productId: f.product.id,
      name: "Synthetic SDK",
    });
    const principal = f.store.authenticateSdkToken(token.token)!;
    const draft = f.store.upsertFeedbackDraft({
      principal,
      clientDraftId: "sdk-filter-fixture",
      type: "bug",
      priority: "high",
      title: "SDK report",
      description: "x",
      environment: { platform: "android" },
      context: {},
      logs: [],
    });
    const sdk = f.store.finalizeFeedbackDraft(draft.id, principal);
    const unknown = f.store.createWorkItem({
      productId: f.product.id,
      type: "task",
      priority: "normal",
      title: "Legacy record",
      description: "x",
    });
    const response = await f.app.inject({
      method: "GET",
      url: `/api/v1/products/${f.product.id}/item-filter-options`,
      headers: { cookie: f.cookie },
    });
    const choices = response.json().proposers;
    const sdkKey = choices.find(
      (p: { kind: string }) => p.kind === "sdk",
    ).value;
    expect(choices.find((p: { kind: string }) => p.kind === "sdk").label).toBe(
      "Synthetic SDK",
    );
    expect(
      (await f.query({ proposerKeys: [sdkKey] }))
        .json()
        .items.map((i: { key: string }) => i.key),
    ).toEqual([sdk.itemKey]);
    expect(
      (await f.query({ proposerKeys: [JSON.stringify(["unknown"])] }))
        .json()
        .items.map((i: { key: string }) => i.key),
    ).toEqual([unknown.key]);
    expect(
      (await f.query({ proposerKeys: ["mine"] })).json().items,
    ).toHaveLength(1);
  });

  it("uses inclusive start and exclusive end instants for creation and update dates", async () => {
    const f = await fixture();
    const item = f.create("bug", "high");
    const at = item.createdAt;
    const next = new Date(Date.parse(at) + 1).toISOString();
    expect(
      (
        await f.query({
          createdFrom: at,
          createdTo: next,
          updatedFrom: item.updatedAt,
          updatedTo: next,
        })
      ).json().items,
    ).toHaveLength(1);
    expect((await f.query({ createdTo: at })).json().items).toHaveLength(0);
    expect((await f.query({ createdFrom: next })).json().items).toHaveLength(0);
  });

  it("rejects malformed, excessive and unsupported filter inputs without broadening the query", async () => {
    const f = await fixture();
    f.create("bug", "high");
    for (const filters of [
      { types: ["sql"] },
      { types: "bad-json" },
      { priorities: ["unknown"] },
      { types: Array(51).fill("bug") },
      { sourceComponentIds: [42] },
      { proposerKeys: ["admin"] },
      { proposerKeys: ['["human"]'] },
      { createdFrom: "2026-02-30T00:00:00.000Z" },
      {
        createdFrom: "2026-02-02T00:00:00.000Z",
        createdTo: "2026-02-01T00:00:00.000Z",
      },
    ]) {
      expect((await f.query(filters)).statusCode, JSON.stringify(filters)).toBe(
        400,
      );
    }
  });
});
