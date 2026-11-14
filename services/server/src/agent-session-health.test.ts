import { describe, expect, it } from "vitest";
import { sessionHealth, mergeSessionHealth, sessionHealthDeadlines, SESSION_OBSERVATION_TIMEOUT_MS, SESSION_PROGRESS_WARNING_MS } from "./agent-session-health.js";

const now = Date.parse("2026-11-02T10:00:00Z");
const at = (age: number) => new Date(now - age).toISOString();
const active = { turnActive: true, observedAt: at(0), lastProgressAt: at(SESSION_PROGRESS_WARNING_MS) };

describe("native execution health", () => {
  it("warns at ten minutes without marking failure, even when a tool is still waiting", () => {
    expect(sessionHealth("active", active, now)).toMatchObject({ status: "stalled" });
    expect(sessionHealth("active", { ...active, lastProgressAt: at(SESSION_PROGRESS_WARNING_MS - 1) }, now)).toEqual({ status: "active" });
    expect(sessionHealth("active", { ...active, lastProgressAt: at(0) }, now)).toEqual({ status: "active" });
  });
  it("distinguishes lost observation from absent execution progress", () => {
    expect(sessionHealth("active", { ...active, observedAt: at(SESSION_OBSERVATION_TIMEOUT_MS) }, now)).toMatchObject({ status: "unavailable" });
    expect(sessionHealth("active", { ...active, observedAt: at(SESSION_OBSERVATION_TIMEOUT_MS - 1) }, now)).toMatchObject({ status: "stalled" });
  });
  it("excludes waiting for people and inactive turns and supports old nodes", () => {
    expect(sessionHealth("active", { ...active, waitingForInput: true }, now)).toEqual({ status: "active" });
    expect(sessionHealth("active", { ...active, turnActive: false }, now)).toEqual({ status: "active" });
    expect(sessionHealth("active", {}, now)).toEqual({ status: "active" });
  });
  it.each(["idle", "suspended", "failed", "unavailable"] as const)("preserves confirmed %s regardless of old clocks", (status) => {
    expect(sessionHealth(status, { ...active, observedAt: at(999_999) }, now)).toEqual({ status });
  });
});

describe("delivery boundaries", () => {
  const idle = { turnActive: false, observedAt: at(1_000), lastProgressAt: at(900_000) };
  const receipt = { kind: "message", status: "delivered", previousStatus: "delivering", acceptedAt: at(0) };
  it("floors ages at a durable start without rewriting source clocks or accepting node-owned boundaries", () => {
    const started = mergeSessionHealth("idle", idle, "active", { turnActive: true, healthStartedAt: at(-100_000) }, receipt);
    expect(started.turnState).toMatchObject({ ...idle, turnActive: true, healthStartedAt: receipt.acceptedAt });
    expect(sessionHealth("active", started.turnState, now)).toEqual({ status: "active" });
    expect(sessionHealthDeadlines(started.turnState)).toEqual([now + 120_000, now + 600_000]);
    expect(sessionHealth("active", started.turnState, now + 119_999).status).toBe("active");
    expect(sessionHealth("active", started.turnState, now + 120_000).status).toBe("unavailable");
    // Even a source heartbeat carrying an unchanged old progress clock cannot
    // immediately warn; its real ten-minute budget starts at this turn's start.
    const observed = mergeSessionHealth("active", started.turnState, "active", { observedAt: at(-600_000) });
    expect(sessionHealth("active", observed.turnState, now + 599_999).status).toBe("active");
    expect(sessionHealth("active", observed.turnState, now + 600_000).status).toBe("stalled");
    expect(observed.turnState.lastProgressAt).toBe(idle.lastProgressAt);
  });
  it.each(["queued", "delivering", "failed", "delivery_unknown"])("does not create a boundary from a %s receipt", status => {
    expect(mergeSessionHealth("idle", idle, "active", { turnActive: true }, { ...receipt, status }).turnState.healthStartedAt).toBeUndefined();
  });
  it("keeps steer ages, retries, stale observations and stop results in their original turn", () => {
    const running = { ...idle, turnActive: true };
    const steer = mergeSessionHealth("active", running, "active", { turnActive: true }, receipt);
    expect(steer.turnState).toEqual(running);
    expect(sessionHealth("active", steer.turnState, now).status).toBe("stalled");
    const started = mergeSessionHealth("idle", idle, "active", { turnActive: true }, receipt);
    expect(mergeSessionHealth("active", started.turnState, "idle", idle)).toMatchObject(started);
    const stopped = mergeSessionHealth("active", started.turnState, "idle", { turnActive: false, observedAt: at(-1_000) });
    expect(stopped.turnState.healthStartedAt).toBeUndefined();
    expect(mergeSessionHealth(stopped.status, stopped.turnState, "active", { turnActive: true },
      { ...receipt, previousStatus: "delivered", acceptedAt: at(-100_000) })).toMatchObject(stopped);
    expect(mergeSessionHealth(stopped.status, stopped.turnState, "active", { turnActive: true, observedAt: at(-500) },
      { ...receipt, previousStatus: "delivered" })).toMatchObject(stopped);
  });
  it("does not invent observation support for old nodes or reset after an uncertain source read", () => {
    expect(mergeSessionHealth("idle", {}, "active", { turnActive: true }, receipt).turnState.healthStartedAt).toBeUndefined();
    const started = mergeSessionHealth("idle", idle, "active", { turnActive: true }, receipt);
    expect(mergeSessionHealth("active", started.turnState, "unavailable", { turnActive: false }).turnState).toEqual(started.turnState);
    expect(mergeSessionHealth("unavailable", running(), "active", { turnActive: true }, receipt).turnState.healthStartedAt).toBeUndefined();
    function running() { return { ...idle, turnActive: true }; }
  });
  it("still accepts foreground-stop confirmation after an interrupt was acknowledged", () => {
    expect(mergeSessionHealth("active", { ...idle, turnActive: true }, "idle", { turnActive: false },
      { ...receipt, kind: "interrupt", previousStatus: "delivered" })).toMatchObject({ status: "idle", turnState: { turnActive: false } });
    const ended = mergeSessionHealth("active", { ...idle, turnActive: true, healthStartedAt: at(0) }, "idle", {},
      { ...receipt, previousStatus: "delivered" });
    expect(ended.status).toBe("idle");
    expect(ended.turnState.healthStartedAt).toBeUndefined();
  });
});
