import { describe, expect, it } from "vitest";

import { formatFeedbackLog, parseFeedbackLog, parseFeedbackLogLine } from "./feedback-log.js";

describe("feedback log format", () => {
  it("round-trips entries, attributes included", () => {
    const entries = [
      { timestamp: "2026-09-06T13:27:04.123Z", level: "warn" as const, message: "socket reconnect", attributes: { attempt: "3" } },
      { timestamp: "2026-09-06T13:27:05.000Z", level: "info" as const, message: "GET /api/status ok" },
    ];
    expect(parseFeedbackLog(formatFeedbackLog(entries))).toEqual(entries);
  });

  it("keeps a message on one line so a line is always one entry", () => {
    const line = formatFeedbackLog([
      { timestamp: "2026-09-06T13:27:04.123Z", level: "error" as const, message: "boom\nstack frame\there" },
    ]);
    expect(line.trimEnd().split("\n")).toHaveLength(1);
    expect(parseFeedbackLog(line)[0]!.message).toBe("boom stack frame here");
  });

  it("skips a line it did not write instead of failing the file", () => {
    const text = [
      "2026-09-06T13:27:04.123Z\tINFO\tkept",
      "somebody pasted this in by hand",
      "2026-09-06T13:27:06.000Z\tNOPE\tbad level",
      "not-a-date\tINFO\tbad timestamp",
    ].join("\n");
    expect(parseFeedbackLog(text).map((entry) => entry.message)).toEqual(["kept"]);
  });

  it("keeps the message when a trailing field is not the attribute object", () => {
    const entry = parseFeedbackLogLine("2026-09-06T13:27:04.123Z\tINFO\tmessage\tnot json");
    expect(entry).toMatchObject({ level: "info", message: "message" });
    expect(entry?.attributes).toBeUndefined();
  });
});
