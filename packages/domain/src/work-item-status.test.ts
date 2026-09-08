import { describe, expect, it } from "vitest";

import { evaluateWorkItemTransition, TRANSITION_REASONS } from "./work-item-status.js";
import { WORK_ITEM_STATUSES } from "./work-item.js";

describe("work item state machine", () => {
  it("allows a human to move a captured item from inbox to ready", () => {
    expect(
      evaluateWorkItemTransition({ from: "inbox", to: "ready", actor: "human", reason: "triaged" }),
    ).toMatchObject({ allowed: true, code: "allowed" });
  });

  it("allows an agent to claim a ready work item", () => {
    expect(
      evaluateWorkItemTransition({ from: "ready", to: "in_progress", actor: "agent", reason: "claim" }),
    ).toMatchObject({ allowed: true, code: "allowed" });
  });

  it("lets an agent hand merged work over, and nothing else that leaves in_progress", () => {
    // A merged pull request is a fact the agent can check, so it may say the work
    // is ready to verify. Giving up, pausing and resuming are judgements about
    // what the work is worth, and those stay with the person.
    expect(evaluateWorkItemTransition({
      from: "in_progress",
      to: "pending_verification",
      actor: "agent",
      reason: "resolution_submitted",
    })).toMatchObject({ allowed: true });

    for (const [to, reason] of [
      ["on_hold", "request_human_input"],
      ["ready", "released"],
    ] as const) {
      expect(evaluateWorkItemTransition({ from: "in_progress", to, actor: "agent", reason }))
        .toMatchObject({ allowed: false, code: "actor_not_allowed" });
    }
    expect(evaluateWorkItemTransition({ from: "on_hold", to: "in_progress", actor: "agent", reason: "resume" }))
      .toMatchObject({ allowed: false, code: "actor_not_allowed" });
  });

  it("prevents an agent from completing final verification", () => {
    expect(
      evaluateWorkItemTransition({
        from: "pending_verification",
        to: "done",
        actor: "agent",
        reason: "verification_passed",
      }),
    ).toMatchObject({ allowed: false, code: "actor_not_allowed" });
  });

  it("allows a human to reject verification and reopen the work item", () => {
    expect(
      evaluateWorkItemTransition({
        from: "pending_verification",
        to: "ready",
        actor: "human",
        reason: "verification_failed",
      }),
    ).toMatchObject({ allowed: true });
  });

  it("leaves the agent exactly two paths through the whole table", () => {
    const edges: Array<[string, string, string]> = [];
    for (const from of WORK_ITEM_STATUSES) {
      for (const to of WORK_ITEM_STATUSES) {
        for (const reason of TRANSITION_REASONS) {
          if (evaluateWorkItemTransition({ from, to, actor: "agent", reason }).allowed) {
            edges.push([from, to, reason]);
          }
        }
      }
    }
    // Reasons are counted, not just status pairs. A rule is the cartesian product
    // of its actors and its reasons, so an extra reason on an agent edge grants a
    // path nobody intended -- which is how `resume` used to reach this list.
    expect(edges).toEqual([
      ["ready", "in_progress", "claim"],
      ["in_progress", "pending_verification", "resolution_submitted"],
    ]);
  });

  it("rejects a mismatched transition reason", () => {
    expect(
      evaluateWorkItemTransition({
        from: "ready",
        to: "in_progress",
        actor: "agent",
        reason: "verification_passed",
      }),
    ).toMatchObject({ allowed: false, code: "reason_mismatch" });
  });
});

describe("manual override", () => {
  it("lets a person move an item straight to a status the pipeline cannot reach", () => {
    expect(
      evaluateWorkItemTransition({ from: "ready", to: "done", actor: "human", reason: "manual_override" }),
    ).toMatchObject({ allowed: true, code: "allowed" });
    expect(
      evaluateWorkItemTransition({ from: "inbox", to: "in_progress", actor: "human", reason: "manual_override" }),
    ).toMatchObject({ allowed: true });
    expect(
      evaluateWorkItemTransition({ from: "cancelled", to: "done", actor: "human", reason: "manual_override" }),
    ).toMatchObject({ allowed: true });
  });

  it("is closed to agents and to the system, so only a person can still close verification", () => {
    for (const actor of ["agent", "system"] as const) {
      expect(
        evaluateWorkItemTransition({ from: "ready", to: "done", actor, reason: "manual_override" }),
      ).toMatchObject({ allowed: false, code: "invalid_transition" });
    }
    expect(
      evaluateWorkItemTransition({ from: "pending_verification", to: "done", actor: "agent", reason: "verification_passed" }),
    ).toMatchObject({ allowed: false, code: "actor_not_allowed" });
  });

  it("refuses a move that goes nowhere", () => {
    expect(
      evaluateWorkItemTransition({ from: "ready", to: "ready", actor: "human", reason: "manual_override" }),
    ).toMatchObject({ allowed: false, code: "invalid_transition" });
  });

  it("leaves the pipeline reasons alone, so a real step is never labelled an override", () => {
    expect(
      evaluateWorkItemTransition({ from: "ready", to: "done", actor: "human", reason: "verification_passed" }),
    ).toMatchObject({ allowed: false, code: "invalid_transition" });
  });
});
