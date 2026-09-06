import { describe, expect, it } from "vitest";

import { groupTimeline } from "./timeline";
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
