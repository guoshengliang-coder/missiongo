import { describe, expect, it } from "vitest";
import { sessionHealth, SESSION_OBSERVATION_TIMEOUT_MS, SESSION_PROGRESS_WARNING_MS } from "./agent-session-health.js";

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
