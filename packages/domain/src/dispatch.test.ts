import { describe, expect, it } from "vitest";

import { isNodeOnline, isSupportedDispatchMode, NODE_ONLINE_WINDOW_MS } from "./dispatch.js";

describe("Dispatch modes", () => {
  it("accepts the Claude Code modes a person can still supervise", () => {
    expect(isSupportedDispatchMode("claude_code", "plan")).toBe(true);
    expect(isSupportedDispatchMode("claude_code", "acceptEdits")).toBe(true);
  });

  it("refuses the modes that remove the human from the loop", () => {
    // A dispatched session runs with nobody at the machine, so these two must
    // not be reachable from a web form.
    expect(isSupportedDispatchMode("claude_code", "bypassPermissions")).toBe(false);
    expect(isSupportedDispatchMode("claude_code", "dontAsk")).toBe(false);
  });

  it("has no modes for the agents that are not wired up yet", () => {
    expect(isSupportedDispatchMode("codex", "plan")).toBe(false);
    expect(isSupportedDispatchMode("hermes", "plan")).toBe(false);
  });
});

describe("Node liveness", () => {
  const now = Date.parse("2026-09-13T12:00:00.000Z");

  it("counts a node seen inside the window as online", () => {
    expect(isNodeOnline(new Date(now - 30_000).toISOString(), now)).toBe(true);
  });

  it("counts a silent node as offline rather than assuming it is listening", () => {
    expect(isNodeOnline(new Date(now - NODE_ONLINE_WINDOW_MS - 1).toISOString(), now)).toBe(false);
    expect(isNodeOnline(undefined, now)).toBe(false);
    expect(isNodeOnline("not a timestamp", now)).toBe(false);
  });
});
