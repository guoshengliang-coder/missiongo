import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";

import type { ServerContext } from "@modelcontextprotocol/server";
import { afterEach, describe, expect, it } from "vitest";

import { requireExecutionAccess, requireItemAccess } from "./mcp.js";
import { MissionGoStore } from "./store.js";

const stores: MissionGoStore[] = [];
const directories: string[] = [];

afterEach(async () => {
  stores.splice(0).forEach((store) => store.close());
  await Promise.all(directories.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

function contextFor(productIds: "*" | readonly string[]): ServerContext {
  return {
    http: { authInfo: { extra: { accountId: "account-1", username: "owner", productIds } } },
  } as unknown as ServerContext;
}

async function seed() {
  const directory = await mkdtemp(join(tmpdir(), "missiongo-authz-"));
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
  return { store, product, item };
}

describe("MCP write-tool authorization", () => {
  it("accepts an item inside the account's product scope and normalizes its key", async () => {
    const { store, product, item } = await seed();
    expect(requireItemAccess(contextFor([product.id]), store, item.key.toLowerCase())).toBe(item.key);
    expect(requireItemAccess(contextFor("*"), store, item.key)).toBe(item.key);
  });

  it("rejects an item outside the account's product scope", async () => {
    const { store, item } = await seed();
    expect(() => requireItemAccess(contextFor(["some-other-product"]), store, item.key))
      .toThrowError(/not permitted/);
    expect(() => requireItemAccess(contextFor([]), store, item.key)).toThrowError(/not permitted/);
  });

  it("rejects a caller with no MissionGo account authorization", async () => {
    const { store, item } = await seed();
    expect(() => requireItemAccess({} as ServerContext, store, item.key))
      .toThrowError(/account authorization is required/);
  });

  it("resolves an execution back to its product before allowing a write", async () => {
    const { store, product, item } = await seed();
    store.transitionWorkItem({ itemKey: item.key, to: "ready", actor: "human", reason: "triaged" });
    const execution = store.claimExecution({
      itemKey: item.key,
      agentId: "agent-1",
      mode: "process",
      leaseSeconds: 900,
      idempotencyKey: "claim-1",
    });

    expect(() => requireExecutionAccess(contextFor([product.id]), store, execution.id)).not.toThrow();
    expect(() => requireExecutionAccess(contextFor(["some-other-product"]), store, execution.id))
      .toThrowError(/not permitted/);
  });

  it("keeps every gated tool handler behind an authorization check", () => {
    // The write tools are unreachable today, so no integration test exercises
    // them. Guard the invariant structurally instead: a new tool registered
    // after the enableWriteTools gate must authorize the caller, or the product
    // scope in ADMIN_AUTHORIZED_PRODUCT_IDS silently stops applying to writes.
    const source = readFileSync(new URL("./mcp.ts", import.meta.url), "utf8");
    const gated = source.slice(source.indexOf("if (!options.enableWriteTools) return server;"));
    const handlers = gated.match(/^    async \(.*$/gm) ?? [];
    expect(handlers.length).toBeGreaterThanOrEqual(10);

    const unauthorized = gated
      .split(/^  server\.registerTool\($/m)
      .slice(1)
      .filter((block) => !/require(Item|Execution)Access\(/.test(block))
      .map((block) => block.match(/"([a-z_]+)"/)?.[1] ?? "unknown");
    expect(unauthorized).toEqual([]);
  });
});
