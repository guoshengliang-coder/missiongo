import { describe, expect, it } from "vitest";

import {
  isAcceptedSessionUrl,
  isNodeOnline,
  isSupportedDispatchMode,
  nodeConnectionState,
  NODE_ONLINE_WINDOW_MS,
  NODE_STABLE_WINDOW_MS,
} from "./dispatch.js";

describe("Dispatch modes", () => {
  it("accepts the Claude Code modes MissionGo can start", () => {
    expect(isSupportedDispatchMode("claude_code", "plan")).toBe(true);
    expect(isSupportedDispatchMode("claude_code", "acceptEdits")).toBe(true);
    expect(isSupportedDispatchMode("claude_code", "bypassPermissions")).toBe(true);
  });

  it("refuses unsupported modes", () => {
    expect(isSupportedDispatchMode("claude_code", "dontAsk")).toBe(false);
  });

  it("offers Codex only the modes that keep its sandbox and approvals", () => {
    expect(isSupportedDispatchMode("codex", "plan")).toBe(true);
    expect(isSupportedDispatchMode("codex", "default")).toBe(true);
    expect(isSupportedDispatchMode("codex", "auto")).toBe(true);
    expect(isSupportedDispatchMode("codex", "never")).toBe(false);
    expect(isSupportedDispatchMode("codex", "danger-full-access")).toBe(false);
    // A Claude Code mode is not a Codex mode just because the other agent has it.
    expect(isSupportedDispatchMode("codex", "acceptEdits")).toBe(false);
  });

  it("has no modes for the agents that are not wired up yet", () => {
    expect(isSupportedDispatchMode("hermes", "plan")).toBe(false);
  });
});

describe("Session links", () => {
  it("accepts an https address and a bare Codex thread link", () => {
    expect(isAcceptedSessionUrl("https://claude.ai/code/session_016Jhieb3iHbCW5ymeG2kns6")).toBe(true);
    expect(isAcceptedSessionUrl("codex://threads/01a09f35-d6fa-7eb2-9d90-1352cf2fb661")).toBe(true);
  });

  it("refuses anything a click should not follow", () => {
    expect(isAcceptedSessionUrl("javascript:alert(1)")).toBe(false);
    expect(isAcceptedSessionUrl("http://claude.ai/code/session_1")).toBe(false);
    expect(isAcceptedSessionUrl("codex://settings")).toBe(false);
    expect(isAcceptedSessionUrl("codex://threads/abc?open=1")).toBe(false);
    expect(isAcceptedSessionUrl("codex://threads/abc/../../x")).toBe(false);
    expect(isAcceptedSessionUrl("codex://threads/abc\n")).toBe(false);
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

  it("warns after two missed heartbeats before declaring a node offline", () => {
    expect(nodeConnectionState(new Date(now - NODE_STABLE_WINDOW_MS).toISOString(), now)).toBe("online");
    expect(nodeConnectionState(new Date(now - NODE_STABLE_WINDOW_MS - 1).toISOString(), now)).toBe("unstable");
    expect(nodeConnectionState(new Date(now - NODE_ONLINE_WINDOW_MS).toISOString(), now)).toBe("unstable");
    expect(nodeConnectionState(new Date(now - NODE_ONLINE_WINDOW_MS - 1).toISOString(), now)).toBe("offline");
    expect(nodeConnectionState(undefined, now)).toBe("offline");
  });
});
