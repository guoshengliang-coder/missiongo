import { describe, expect, it } from "vitest";

import {
  agentLabelKey,
  aiAvailability,
  canJoinSelection,
  isSelectable,
  dispatchModeHelpKey,
  dispatchModeLabelKey,
  dispatchProblemKey,
  isDispatchable,
  nodeIneligibility,
  selectionScope,
  sessionLinkLabelKey,
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
    const selected = toggleItemSelection(new Set(["AND-37"]), item("AND-40", "in_progress"), "ready");
    expect([...selected]).toEqual(["AND-37"]);
  });

  it("also takes items waiting for verification, for closing them in bulk (AND-66)", () => {
    expect(isSelectable("pending_verification")).toBe(true);
    for (const status of ["inbox", "in_progress", "on_hold", "done", "cancelled"] as const) {
      expect(isSelectable(status)).toBe(false);
    }
    const picked = toggleItemSelection(new Set(), item("AND-50", "pending_verification"));
    expect([...toggleItemSelection(picked, item("AND-51", "pending_verification"), "pending_verification")])
      .toEqual(["AND-50", "AND-51"]);
  });

  it("keeps one status per selection, since each batch action takes one", () => {
    const ready = toggleItemSelection(new Set(), item("AND-37", "ready"));
    expect([...toggleItemSelection(ready, item("AND-50", "pending_verification"), "ready")]).toEqual(["AND-37"]);
    expect(canJoinSelection("pending_verification", "ready")).toBe(false);
    expect(canJoinSelection("pending_verification", undefined)).toBe(true);
    // Unticking always works, whatever the row's status is now.
    expect([...toggleItemSelection(ready, item("AND-37", "in_progress"), "ready")]).toEqual([]);
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
    for (const code of ["node_offline", "agent_unavailable", "repo_unmapped", "repo_conflict", "item_not_dispatchable", "item_already_dispatched"]) {
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

  it("labels every Codex mode, and nothing that only looks like a mode", () => {
    for (const mode of ["plan", "default", "auto"]) expect(dispatchModeLabelKey(mode)).not.toBeNull();
    expect(dispatchModeLabelKey("never")).toBeNull();
    // An inherited property name is not a mode.
    expect(dispatchModeLabelKey("toString")).toBeNull();
  });

  it("does not promise a web page for a Codex thread", () => {
    expect(sessionLinkLabelKey("codex://threads/01a09f35-d6fa-7eb2-9d90-1352cf2fb661")).toBe("dispatchOpenInCodex");
    expect(sessionLinkLabelKey("https://claude.ai/code/session_1")).toBe("dispatchOpenSession");
  });

  it("warns that Codex plan mode rests on the prompt alone", () => {
    expect(dispatchModeHelpKey("codex", "plan")).toBe("dispatchCodexPlanHelp");
    expect(dispatchModeHelpKey("claude_code", "plan")).toBe("dispatchPlanHelp");
    expect(dispatchModeHelpKey("codex", "auto")).toBe("dispatchCodexAutoHelp");
    expect(dispatchModeHelpKey("claude_code", "default")).toBeNull();
  });
});

describe("whether start work can offer an AI (AND-68)", () => {
  const product = { id: "p1", access: { canOperate: true, canUseAi: true } };
  const mapped = { repos: [{ productId: "p1", productKey: "AND", repoPath: "/repo" }] };

  it("tells a missing permission apart from a missing setup", () => {
    expect(aiAvailability({ id: "p1", access: { canOperate: true, canUseAi: false } }, [node(mapped)]))
      .toEqual({ kind: "no_permission" });
    expect(aiAvailability(product, [])).toEqual({ kind: "not_configured", reason: "no_nodes" });
  });

  it("names what is missing from the setup, in the order it has to be fixed", () => {
    expect(aiAvailability(product, [node({ revokedAt: "2026-09-14T00:00:00Z", ...mapped })]))
      .toEqual({ kind: "not_configured", reason: "no_nodes" });
    expect(aiAvailability(product, [node()])).toEqual({ kind: "not_configured", reason: "repo_unmapped" });
    expect(aiAvailability(product, [node({ online: false, ...mapped })])).toEqual({ kind: "not_configured", reason: "offline" });
    expect(aiAvailability(product, [node({ agents: [{ kind: "hermes" }], ...mapped })]))
      .toEqual({ kind: "not_configured", reason: "agent_unavailable" });
  });

  it("offers it once one machine can take the item", () => {
    expect(aiAvailability(product, [node({ online: false, ...mapped }), node({ id: "node-2", ...mapped })]))
      .toEqual({ kind: "available" });
    // A server that does not report access yet: offer it, the route still decides.
    expect(aiAvailability({ id: "p1" }, [node(mapped)])).toEqual({ kind: "available" });
  });

  it("waits for the machine list before saying anything about setup", () => {
    expect(aiAvailability(product, undefined)).toEqual({ kind: "checking" });
  });
});
