import { describe, expect, it } from "vitest";

import { EMPTY_CAPTURE_DRAFT, hasCaptureDraftContent, parseCaptureDraft } from "./capture-draft";

describe("capture draft", () => {
  it("restores valid fields and ignores unsupported enum values", () => {
    expect(parseCaptureDraft(JSON.stringify({
      title: "Crash after login",
      description: "Only on Android",
      type: "bug",
      priority: "urgent",
      sourceComponentId: "android-id",
      environment: { platform: "android", appVersion: "2.1.0" },
    }))).toMatchObject({
      title: "Crash after login",
      type: "bug",
      priority: "urgent",
      sourceComponentId: "android-id",
      environment: { platform: "android", appVersion: "2.1.0" },
    });
    expect(parseCaptureDraft('{"type":"unknown","priority":"unknown"}')).toMatchObject({
      type: "idea",
      priority: "normal",
    });
  });

  it("falls back safely and detects meaningful content", () => {
    expect(parseCaptureDraft("not json")).toEqual(EMPTY_CAPTURE_DRAFT);
    expect(hasCaptureDraftContent(EMPTY_CAPTURE_DRAFT)).toBe(false);
    expect(hasCaptureDraftContent({ ...EMPTY_CAPTURE_DRAFT, description: "Remember this" })).toBe(true);
  });
});
