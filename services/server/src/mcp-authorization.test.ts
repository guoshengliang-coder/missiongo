import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";

import type { ServerContext } from "@modelcontextprotocol/server";
import { afterEach, describe, expect, it } from "vitest";

import { AttachmentStorage } from "./attachment-storage.js";
import {
  createMissionGoMcpServer,
  requireItemAccess,
  requireWriteScope,
  WRITE_TOOLS_BY_TIER,
  type McpWriteTier,
} from "./mcp.js";
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

const SECTION_MARKER = "// MCP_WRITE_SECTION:";
const TIER_MARKER = "// MCP_WRITE_TIER:";

function mcpSource(): string {
  return readFileSync(new URL("./mcp.ts", import.meta.url), "utf8");
}

/** Everything registered after the write-section marker, which must be authorized. */
function writeSection(): string {
  const source = mcpSource();
  const start = source.indexOf(SECTION_MARKER);
  expect(start, `${SECTION_MARKER} is missing from mcp.ts`).toBeGreaterThan(-1);
  return source.slice(start);
}

/** Tool names registered under one `// MCP_WRITE_TIER:` marker, in source order. */
function toolNamesInTier(tier: string): readonly string[] {
  const sections = writeSection().split(TIER_MARKER).slice(1);
  const section = sections.find((part) => part.trimStart().startsWith(tier));
  expect(section, `${TIER_MARKER} ${tier} is missing from mcp.ts`).toBeDefined();
  return [...(section ?? "").matchAll(/^  server\.registerTool\(\n\s*"([a-z_]+)"/gm)].map((match) => match[1]!);
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

  it("keeps every write-section tool handler behind an authorization check", () => {
    // The write tools are unreachable in a default build, so no integration test
    // exercises them. Guard the invariant structurally instead: a tool registered
    // in the write section must authorize the caller, or the product scope in
    // ADMIN_AUTHORIZED_PRODUCT_IDS silently stops applying to writes.
    //
    // Anchor on the section marker rather than on the tier check itself. Slicing
    // from the literal source of a condition means renaming the option silently
    // empties the slice, and an assertion over nothing passes.
    const gated = writeSection();

    const unauthorized = gated
      .split(/^  server\.registerTool\($/m)
      .slice(1)
      .filter((block) => !/require(Item|Execution)Access\(/.test(block))
      .map((block) => block.match(/"([a-z_]+)"/)?.[1] ?? "unknown");
    expect(unauthorized).toEqual([]);
  });

  it("makes every mutating tool check the write scope", () => {
    // The tier says what this deployment offers; the scope says what this
    // connection was allowed to do. A client that connected while the server was
    // read-only holds a read-only token, and it has to stay read-only.
    const withoutScopeCheck = writeSection()
      .split(/^  server\.registerTool\($/m)
      .slice(1)
      .filter((block) => /readOnlyHint: false/.test(block) && !/requireWriteScope\(/.test(block))
      .map((block) => block.match(/"([a-z_]+)"/)?.[1] ?? "unknown");
    expect(withoutScopeCheck).toEqual([]);
  });

  it("announces exactly the write tools it registers", () => {
    // get_current_account tells a client what it may write, and a Skill is told
    // to trust that over its own copy. A tool missing from the announcement is
    // therefore a tool no client will ever use.
    const mutating = (tier: string) => writeSection()
      .split(TIER_MARKER)
      .slice(1)
      .filter((part) => tier === "all" || part.trimStart().startsWith(tier))
      .join(TIER_MARKER)
      .split(/^  server\.registerTool\($/m)
      .slice(1)
      .filter((block) => /readOnlyHint: false/.test(block))
      .map((block) => block.match(/"([a-z_]+)"/)?.[1] ?? "unknown");

    expect(WRITE_TOOLS_BY_TIER.none).toEqual([]);
    expect(WRITE_TOOLS_BY_TIER.comments).toEqual(mutating("comments"));
  });

  it("keeps each write tool in the tier it belongs to", () => {
    // The tiers exist so that opening comment writing does not also open
    // claiming, leases, and status transitions. Naming the members explicitly
    // means a new tool has to be placed on purpose rather than by where it
    // happened to be pasted.
    expect(toolNamesInTier("comments")).toEqual(["append_comment", "claim_item", "submit_for_verification"]);
  });
});

describe("MCP write scope", () => {
  function contextWithScopes(scopes: readonly string[]): ServerContext {
    return { http: { authInfo: { scopes } } } as unknown as ServerContext;
  }

  it("accepts a connection the user granted writing to", () => {
    expect(() => requireWriteScope(contextWithScopes(["missiongo:read", "missiongo:write"]))).not.toThrow();
  });

  it("rejects a read-only or unauthorized connection", () => {
    expect(() => requireWriteScope(contextWithScopes(["missiongo:read"])))
      .toThrowError(/does not include write access/);
    expect(() => requireWriteScope(contextWithScopes([]))).toThrowError(/does not include write access/);
    expect(() => requireWriteScope({} as ServerContext)).toThrowError(/does not include write access/);
  });
});

describe("MCP write tiers", () => {
  async function serverForTier(writeTools?: McpWriteTier) {
    const { store } = await seed();
    const directory = directories.at(-1)!;
    return createMissionGoMcpServer(
      store,
      new AttachmentStorage(join(directory, "attachments")),
      writeTools ? { writeTools } : {},
    );
  }

  it("exposes no write tool by default", async () => {
    const server = await serverForTier();
    expect(server.toolInputSchemaJson("get_item_context")).toBeDefined();
    expect(server.toolInputSchemaJson("append_comment")).toBeUndefined();
    expect(server.toolInputSchemaJson("claim_item")).toBeUndefined();
    expect(server.toolInputSchemaJson("submit_for_verification")).toBeUndefined();
  });

  it("exposes commenting and claiming, and nothing that ends the work", async () => {
    const server = await serverForTier("comments");
    expect(server.toolInputSchemaJson("append_comment")).toBeDefined();
    expect(server.toolInputSchemaJson("claim_item")).toBeDefined();
    expect(server.toolInputSchemaJson("submit_for_verification")).toBeDefined();
    // Accepting, reopening, pausing and giving up stay with the user, so there
    // is no tool for any of them.
    for (const gone of ["submit_resolution", "mark_pending_verification", "release_item", "resume_execution"]) {
      expect(server.toolInputSchemaJson(gone)).toBeUndefined();
    }
  });
});
