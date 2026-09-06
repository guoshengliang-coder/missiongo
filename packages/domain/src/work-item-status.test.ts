import { describe, expect, it } from "vitest";

import { evaluateWorkItemTransition } from "./work-item-status.js";

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

  it("allows an agent to submit work for human verification", () => {
    expect(
      evaluateWorkItemTransition({
        from: "in_progress",
        to: "pending_verification",
        actor: "agent",
        reason: "resolution_submitted",
      }),
    ).toMatchObject({ allowed: true });
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

  it("lets the system release a work item after its lease expires", () => {
    expect(
      evaluateWorkItemTransition({
        from: "in_progress",
        to: "ready",
        actor: "system",
        reason: "lease_expired",
      }),
    ).toMatchObject({ allowed: true });
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
