import { describe, expect, it } from "vitest";
import { evaluateWorkItemTransition } from "@missiongo/domain";

import { TRANSITIONS } from "./work-item-transitions";
import { ITEM_STATUSES, type WorkItemStatus } from "./types";

// The web transition table is written by hand while the rules live in
// packages/domain. They drifted once already: every status kept its forward
// actions but none of them offered `cancelled`, so a mis-captured item could
// never leave the list. These tests compare the two directly.

const DOMAIN_HUMAN_TARGETS: Record<WorkItemStatus, readonly WorkItemStatus[]> = {
  inbox: ["ready", "on_hold", "cancelled"],
  ready: ["in_progress", "on_hold", "inbox", "cancelled"],
  in_progress: ["on_hold", "pending_verification", "ready", "cancelled"],
  on_hold: ["in_progress", "ready", "cancelled"],
  pending_verification: ["done", "ready", "cancelled"],
  done: ["ready"],
  cancelled: ["inbox"],
};

describe("web transition table", () => {
  it("only offers transitions the domain accepts from a human", () => {
    for (const from of ITEM_STATUSES) {
      for (const action of TRANSITIONS[from]) {
        const decision = evaluateWorkItemTransition({
          from,
          to: action.to,
          actor: "human",
          reason: action.reason,
        });
        expect(decision.allowed, `${from} → ${action.to} (${action.reason}): ${decision.message}`).toBe(true);
      }
    }
  });

  it("reaches cancelled from every status the domain allows it from", () => {
    const cancellable = ITEM_STATUSES.filter((status) => DOMAIN_HUMAN_TARGETS[status].includes("cancelled"));
    expect(cancellable).toEqual(["inbox", "ready", "in_progress", "on_hold", "pending_verification"]);
    for (const from of cancellable) {
      const cancel = TRANSITIONS[from].find((action) => action.to === "cancelled");
      expect(cancel, `${from} has no way to cancel`).toBeDefined();
      expect(cancel?.reason).toBe("cancelled");
      expect(cancel?.tone).toBe("danger");
    }
  });

  it("offers a way back out of cancelled and done", () => {
    expect(TRANSITIONS.cancelled.map((action) => action.to)).toContain("inbox");
    expect(TRANSITIONS.done.map((action) => action.to)).toContain("ready");
  });

  it("leads with a primary or positive action wherever one exists", () => {
    for (const from of ITEM_STATUSES) {
      const [first] = TRANSITIONS[from];
      expect(first, `${from} has no actions`).toBeDefined();
      expect(first?.tone, `${from} leads with a destructive or neutral action`).not.toBe("danger");
    }
  });

  it("never lists the same target twice for one status", () => {
    for (const from of ITEM_STATUSES) {
      const keys = TRANSITIONS[from].map((action) => `${action.to}:${action.reason}`);
      expect(new Set(keys).size, `${from} repeats a transition`).toBe(keys.length);
    }
  });
});
