import { describe, expect, it } from "vitest";

import {
  activityLabelKey,
  changedMessageIds,
  DEFAULT_AGENT_SESSION_FILTER,
  isNearMessageBottom,
  messageLabelKey,
} from "./agent-session-view";

describe("agent session message view", () => {
  it("opens on all conversations by default", () => {
    expect(DEFAULT_AGENT_SESSION_FILTER).toBe("all");
  });

  it("keeps following within the bottom tolerance", () => {
    expect(isNearMessageBottom({ scrollHeight: 1_000, scrollTop: 452, clientHeight: 500 })).toBe(true);
    expect(isNearMessageBottom({ scrollHeight: 1_000, scrollTop: 451, clientHeight: 500 })).toBe(false);
  });

  it("finds new and streamed messages without treating reordering as new", () => {
    const a = { id: "a", text: "first" };
    const b = { id: "b", text: "second" };
    expect(changedMessageIds([a, b], [a, b, { id: "c", text: "third" }])).toEqual(["c"]);
    expect(changedMessageIds([a, b], [b, a])).toEqual([]);
    expect(changedMessageIds([a], [{ id: "a", text: "first, still streaming" }])).toEqual(["a"]);
  });

  it("omits the redundant identity label only for the user's messages", () => {
    expect(messageLabelKey("user")).toBeNull();
    expect(messageLabelKey("agent")).toBe("agentSessionCodex");
    expect(messageLabelKey("plan")).toBe("agentSessionPlan");
  });

  it("has a bottom-of-conversation label for every session state", () => {
    expect(activityLabelKey("active")).toBe("agentSessionActivityActive");
    expect(activityLabelKey("idle")).toBe("agentSessionActivityIdle");
    expect(activityLabelKey("unavailable")).toBe("agentSessionActivityUnavailable");
    expect(activityLabelKey("unavailable", true)).toBe("agentSessionActivityUnavailableQueued");
    expect(activityLabelKey("failed")).toBe("agentSessionActivityFailed");
  });
});
