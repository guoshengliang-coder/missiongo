import { describe, expect, it } from "vitest";

import { dispatchedEvent, groupTimeline, statusChangeNote } from "./timeline";
import type { WorkItemEvent } from "./types";

const event = (
  id: string,
  eventType: string,
  createdAt: string,
  payload: Record<string, unknown> = {},
  actorKind: WorkItemEvent["actorKind"] = "human",
): WorkItemEvent => ({ id, itemKey: "HG-1", eventType, actorKind, payload, createdAt });

describe("groupTimeline", () => {
  it("puts the newest entry first", () => {
    const entries = groupTimeline([
      event("1", "item_created", "2026-09-06T10:00:00Z"),
      event("2", "status_changed", "2026-09-06T10:05:00Z"),
    ]);
    expect(entries.map((entry) => entry.event.id)).toEqual(["2", "1"]);
  });

  it("folds a run of attachment uploads into one entry that names the files", () => {
    const entries = groupTimeline([
      event("1", "item_created", "2026-09-06T10:00:00Z"),
      event("2", "attachment_added", "2026-09-06T10:01:00Z", { filename: "screen-1.png" }),
      event("3", "attachment_added", "2026-09-06T10:01:10Z", { filename: "screen-2.png" }),
      event("4", "attachment_added", "2026-09-06T10:01:20Z", { filename: "sign-off.log" }),
    ]);
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({ count: 3, filenames: ["sign-off.log", "screen-2.png", "screen-1.png"] });
    expect(entries[1]?.event.eventType).toBe("item_created");
  });

  it("keeps runs apart when a different event interrupts them", () => {
    const entries = groupTimeline([
      event("1", "attachment_added", "2026-09-06T10:00:00Z", { filename: "a.png" }),
      event("2", "status_changed", "2026-09-06T10:01:00Z"),
      event("3", "attachment_added", "2026-09-06T10:02:00Z", { filename: "b.png" }),
    ]);
    expect(entries.map((entry) => entry.count)).toEqual([1, 1, 1]);
    expect(entries.map((entry) => entry.event.eventType)).toEqual([
      "attachment_added",
      "status_changed",
      "attachment_added",
    ]);
  });

  it("does not merge across actors, so an agent upload stays visible", () => {
    const entries = groupTimeline([
      event("1", "attachment_added", "2026-09-06T10:00:00Z", { filename: "a.png" }, "human"),
      event("2", "attachment_added", "2026-09-06T10:01:00Z", { filename: "b.png" }, "agent"),
    ]);
    expect(entries).toHaveLength(2);
    expect(entries[0]?.event.actorKind).toBe("agent");
  });

  it("never merges status changes, which are the point of the timeline", () => {
    const entries = groupTimeline([
      event("1", "status_changed", "2026-09-06T10:00:00Z"),
      event("2", "status_changed", "2026-09-06T10:01:00Z"),
    ]);
    expect(entries).toHaveLength(2);
  });

  it("tolerates an attachment event with no filename in its payload", () => {
    const entries = groupTimeline([
      event("1", "attachment_added", "2026-09-06T10:00:00Z", {}),
      event("2", "attachment_added", "2026-09-06T10:01:00Z", { filename: "b.png" }),
    ]);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ count: 2, filenames: ["b.png"] });
  });

  it("keeps every dispatch of the same item apart", () => {
    // Two dispatches are two hand-offs, and the second one usually exists
    // because the first came to nothing.
    const entries = groupTimeline([
      event("1", "dispatched", "2026-09-13T10:00:00Z", { nodeName: "MacBook" }, "system"),
      event("2", "dispatched", "2026-09-13T11:00:00Z", { nodeName: "Mac mini" }, "system"),
    ]);
    expect(entries).toHaveLength(2);
    expect(entries.map((entry) => entry.count)).toEqual([1, 1]);
  });

  it("never folds comments together, however fast they arrive", () => {
    // Attachment uploads fold because four identical lines carry nothing. Two
    // comments are two different things somebody said.
    const entries = groupTimeline([
      event("1", "comment_added", "2026-09-06T10:00:00Z", { bodyKind: "free", body: { text: "First." } }),
      event("2", "comment_added", "2026-09-06T10:00:01Z", { bodyKind: "free", body: { text: "Second." } }, "agent"),
    ]);
    expect(entries).toHaveLength(2);
    expect(entries.map((entry) => entry.count)).toEqual([1, 1]);
    expect(entries.map((entry) => entry.event.actorKind)).toEqual(["agent", "human"]);
  });
});

describe("the dispatched line", () => {
  it("reads the machine, the agent, the mode and the batch", () => {
    expect(dispatchedEvent({
      dispatchId: "d1",
      nodeName: "MacBook",
      agentKind: "claude_code",
      mode: "plan",
      itemKeys: ["AND-37", "AND-38"],
    })).toEqual({
      nodeName: "MacBook",
      agentKind: "claude_code",
      mode: "plan",
      itemKeys: ["AND-37", "AND-38"],
    });
  });

  it("says nothing without a machine name, so the plain event label stands", () => {
    expect(dispatchedEvent({})).toBeNull();
    expect(dispatchedEvent({ nodeName: "   " })).toBeNull();
    expect(dispatchedEvent({ nodeName: 7, agentKind: "claude_code" })).toBeNull();
  });

  it("survives a payload written by another version of the server", () => {
    expect(dispatchedEvent({ nodeName: "MacBook", agentKind: 3, mode: null, itemKeys: "AND-37" })).toEqual({
      nodeName: "MacBook",
      agentKind: "",
      mode: "",
      itemKeys: [],
    });
    expect(dispatchedEvent({ nodeName: "MacBook", itemKeys: ["AND-37", 9] })?.itemKeys).toEqual(["AND-37"]);
  });
});

describe("statusChangeNote", () => {
  it("returns the reason a person typed, trimmed", () => {
    expect(statusChangeNote({ reason: "released", note: "  Wrong branch got merged.\n" }))
      .toBe("Wrong branch got merged.");
  });

  it("has nothing to show for a move that carried no reason", () => {
    // Every status change written before the reason was required is in this
    // position, and so is triage, which never needs one.
    expect(statusChangeNote({ reason: "triaged" })).toBeNull();
    expect(statusChangeNote({})).toBeNull();
    expect(statusChangeNote({ note: "   " })).toBeNull();
  });

  it("ignores a payload that is not what this build expects", () => {
    // Payloads are stored JSON. One written by another build must not take the
    // pane down.
    expect(statusChangeNote({ note: 12 })).toBeNull();
    expect(statusChangeNote({ note: null })).toBeNull();
    expect(statusChangeNote({ note: ["why"] })).toBeNull();
  });
});
