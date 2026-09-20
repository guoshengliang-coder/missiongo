import { describe, expect, it } from "vitest";

import { isAgentSessionUnread, markAgentSessionRead, parseAgentSessionReadState } from "./agent-session-unread";

describe("Agent console unread state", () => {
  const session = { id: "dispatch-1", activityKey: "launched:active:m1" };

  it("treats new activity as unread and the exact opened activity as read", () => {
    expect(isAgentSessionUnread(session, {})).toBe(true);
    const read = markAgentSessionRead(session, {});
    expect(isAgentSessionUnread(session, read)).toBe(false);
    expect(isAgentSessionUnread({ ...session, activityKey: "launched:idle:m2" }, read)).toBe(true);
  });

  it("ignores malformed and non-string persisted values", () => {
    expect(parseAgentSessionReadState("not json")).toEqual({});
    expect(parseAgentSessionReadState('{"ok":"v1","bad":4}')).toEqual({ ok: "v1" });
  });
});
