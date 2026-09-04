import { describe, expect, it } from "vitest";

import { evaluateTaskTransition } from "./task-status.js";

describe("task state machine", () => {
  it("allows an agent to claim a pending task", () => {
    expect(
      evaluateTaskTransition({
        from: "pending",
        to: "in_progress",
        actor: "agent",
        reason: "claim",
      }),
    ).toMatchObject({ allowed: true, code: "allowed" });
  });

  it("allows an agent to submit work for human verification", () => {
    expect(
      evaluateTaskTransition({
        from: "in_progress",
        to: "ready_for_verification",
        actor: "agent",
        reason: "resolution_submitted",
      }),
    ).toMatchObject({ allowed: true });
  });

  it("prevents an agent from completing final verification", () => {
    expect(
      evaluateTaskTransition({
        from: "ready_for_verification",
        to: "completed",
        actor: "agent",
        reason: "verification_passed",
      }),
    ).toMatchObject({ allowed: false, code: "actor_not_allowed" });
  });

  it("allows a human to reject verification and reopen the task", () => {
    expect(
      evaluateTaskTransition({
        from: "ready_for_verification",
        to: "pending",
        actor: "human",
        reason: "verification_failed",
      }),
    ).toMatchObject({ allowed: true });
  });

  it("lets the system release a task after its lease expires", () => {
    expect(
      evaluateTaskTransition({
        from: "in_progress",
        to: "pending",
        actor: "system",
        reason: "lease_expired",
      }),
    ).toMatchObject({ allowed: true });
  });

  it("rejects a mismatched transition reason", () => {
    expect(
      evaluateTaskTransition({
        from: "pending",
        to: "in_progress",
        actor: "agent",
        reason: "verification_passed",
      }),
    ).toMatchObject({ allowed: false, code: "reason_mismatch" });
  });
});
