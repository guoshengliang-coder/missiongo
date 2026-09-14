import { describe, expect, it } from "vitest";

import {
  agentLabelKey,
  dispatchProblemKey,
  isDispatchable,
  nodeIneligibility,
  selectionScope,
  toggleItemSelection,
} from "./dispatch-eligibility";
import type { DispatchNode, WorkItemStatus } from "./types";

const item = (key: string, status: WorkItemStatus) => ({ key, status });

const node = (overrides: Partial<DispatchNode> = {}): DispatchNode => ({
  id: "node-1",
  name: "MacBook",
  deviceName: "MacBook",
  agents: [{ kind: "claude_code", version: "2.1.0" }],
  repos: [],
  repoCandidates: [],
  online: true,
  createdAt: "2026-09-13T10:00:00Z",
  ...overrides,
});

describe("picking items to dispatch", () => {
  it("only takes items that are waiting", () => {
    expect(isDispatchable("ready")).toBe(true);
    for (const status of ["inbox", "in_progress", "on_hold", "pending_verification", "done", "cancelled"] as const) {
      expect(isDispatchable(status)).toBe(false);
    }
  });

  it("ticks and unticks a ready item", () => {
    const first = toggleItemSelection(new Set(), item("AND-37", "ready"));
    expect([...first]).toEqual(["AND-37"]);
    const second = toggleItemSelection(first, item("AND-38", "ready"));
    expect([...second]).toEqual(["AND-37", "AND-38"]);
    expect([...toggleItemSelection(second, item("AND-37", "ready"))]).toEqual(["AND-38"]);
  });

  it("refuses an item that is not ready even when the row is activated another way", () => {
    const selected = toggleItemSelection(new Set(["AND-37"]), item("AND-40", "in_progress"));
    expect([...selected]).toEqual(["AND-37"]);
  });

  it("leaves the set it was given alone", () => {
    const before = new Set(["AND-37"]);
    toggleItemSelection(before, item("AND-38", "ready"));
    expect([...before]).toEqual(["AND-37"]);
  });
});

describe("a selection belongs to the rows it was made on", () => {
  /**
   * Models what App() does: ticks accumulate while the list is showing the same
   * thing, and a changed scope drops them. Written here rather than clicked
   * through a browser, the same way navigation.test.ts models the back stack.
   */
  function walk(steps: readonly ({ tick: string } | { filters: Parameters<typeof selectionScope>[0] })[]) {
    const start = { productId: "p1", status: "ready", type: "all", search: "" };
    let scope = selectionScope(start);
    let selected: ReadonlySet<string> = new Set();
    for (const step of steps) {
      if ("tick" in step) {
        selected = toggleItemSelection(selected, item(step.tick, "ready"));
        continue;
      }
      const next = selectionScope(step.filters);
      if (next !== scope) selected = new Set();
      scope = next;
    }
    return [...selected];
  }

  it("keeps the ticks while the list keeps showing the same rows", () => {
    expect(walk([
      { tick: "AND-37" },
      { tick: "AND-38" },
      { filters: { productId: "p1", status: "ready", type: "all", search: "" } },
    ])).toEqual(["AND-37", "AND-38"]);
  });

  it("clears them when the status filter moves the rows off screen", () => {
    expect(walk([
      { tick: "AND-37" },
      { filters: { productId: "p1", status: "done", type: "all", search: "" } },
    ])).toEqual([]);
  });

  it("clears them when the product changes, so a batch never spans two products", () => {
    expect(walk([
      { tick: "AND-37" },
      { filters: { productId: "p2", status: "ready", type: "all", search: "" } },
    ])).toEqual([]);
  });

  it("clears them for a type or search change too, which hides rows just as completely", () => {
    expect(walk([{ tick: "AND-37" }, { filters: { productId: "p1", status: "ready", type: "bug", search: "" } }]))
      .toEqual([]);
    expect(walk([{ tick: "AND-37" }, { filters: { productId: "p1", status: "ready", type: "all", search: "csv" } }]))
      .toEqual([]);
  });

  it("does not count whitespace as a different search", () => {
    expect(selectionScope({ productId: "p1", status: "ready", type: "all", search: " csv " }))
      .toBe(selectionScope({ productId: "p1", status: "ready", type: "all", search: "csv" }));
  });
});

describe("which machine can take a batch", () => {
  const batch = { productIds: ["p1"], agentKind: "claude_code" } as const;
  const withRepo = { productId: "p1", productKey: "AND", repoPath: "/srv/and" };

  it("accepts a machine that is online, reported the agent, and knows the repository", () => {
    expect(nodeIneligibility(node({ repos: [withRepo] }), batch)).toBeNull();
  });

  it("refuses a machine that has not checked in", () => {
    expect(nodeIneligibility(node({ online: false, repos: [withRepo] }), batch))
      .toEqual({ reason: "offline" });
  });

  it("refuses a revoked machine before anything else, since signing in again from the client is the fix", () => {
    expect(nodeIneligibility(node({ online: false, revokedAt: "2026-09-13T11:00:00Z" }), batch))
      .toEqual({ reason: "revoked" });
  });

  it("refuses a machine that never reported the chosen agent", () => {
    expect(nodeIneligibility(node({ agents: [{ kind: "codex" }], repos: [withRepo] }), batch))
      .toEqual({ reason: "agent_unavailable" });
  });

  it("names the products it has no checkout for", () => {
    expect(nodeIneligibility(node({ repos: [withRepo] }), { productIds: ["p1", "p2"], agentKind: "claude_code" }))
      .toEqual({ reason: "repo_unmapped", productIds: ["p2"] });
  });

  it("refuses a batch that spans two repositories, because one session runs in one checkout", () => {
    const mapped = node({
      repos: [withRepo, { productId: "p2", productKey: "HG", repoPath: "/srv/hg" }],
    });
    expect(nodeIneligibility(mapped, { productIds: ["p1", "p2"], agentKind: "claude_code" }))
      .toEqual({ reason: "repo_conflict", repoPaths: ["/srv/and", "/srv/hg"] });
  });

  it("treats two products in one checkout as one repository", () => {
    const monorepo = node({
      repos: [withRepo, { productId: "p2", productKey: "HG", repoPath: "/srv/and" }],
    });
    expect(nodeIneligibility(monorepo, { productIds: ["p1", "p2"], agentKind: "claude_code" })).toBeNull();
  });

  it("does not report a missing checkout twice when two items share a product", () => {
    expect(nodeIneligibility(node(), { productIds: ["p1", "p1"], agentKind: "claude_code" }))
      .toEqual({ reason: "repo_unmapped", productIds: ["p1"] });
  });
});

describe("wording for values that come from the server", () => {
  it("has a message for every problem code the dispatch endpoint returns", () => {
    for (const code of ["node_offline", "agent_unavailable", "repo_unmapped", "repo_conflict", "item_not_dispatchable"]) {
      expect(dispatchProblemKey(code)).not.toBeNull();
    }
  });

  it("keeps the server's own title for a code this build has never heard of", () => {
    expect(dispatchProblemKey("some_future_code")).toBeNull();
  });

  it("falls back rather than crashing on an agent kind it does not know", () => {
    expect(agentLabelKey("claude_code")).toBe("agentClaudeCode");
    expect(agentLabelKey("gemini")).toBeNull();
  });
});
