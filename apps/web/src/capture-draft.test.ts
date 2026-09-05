import { describe, expect, it } from "vitest";

import { EMPTY_CAPTURE_DRAFT, hasCaptureDraftContent, parseCaptureDraft, workItemReportPayload } from "./capture-draft";

describe("capture draft", () => {
  it("restores valid fields and ignores unsupported enum values", () => {
    expect(parseCaptureDraft(JSON.stringify({
      title: "Crash after login",
      description: "Only on Android",
      reproductionSteps: "Open the app twice",
      expectedOutcome: "The app remains open",
      impact: "Blocks sign-in",
      occurrenceFrequency: "always",
      diagnosticLog: "Fatal exception",
      type: "bug",
      priority: "urgent",
      sourceComponentId: "android-id",
      environment: { platform: "android", appVersion: "2.1.0" },
    }))).toMatchObject({
      title: "Crash after login",
      type: "bug",
      priority: "urgent",
      sourceComponentId: "android-id",
      reproductionSteps: "Open the app twice",
      occurrenceFrequency: "always",
      environment: { platform: "android", appVersion: "2.1.0" },
    });
    expect(parseCaptureDraft('{"type":"unknown","priority":"unknown"}')).toMatchObject({
      type: "bug",
      priority: "normal",
    });
  });

  it("falls back safely and detects meaningful content", () => {
    expect(parseCaptureDraft("not json")).toEqual(EMPTY_CAPTURE_DRAFT);
    expect(EMPTY_CAPTURE_DRAFT.type).toBe("bug");
    expect(hasCaptureDraftContent(EMPTY_CAPTURE_DRAFT)).toBe(false);
    expect(hasCaptureDraftContent({ ...EMPTY_CAPTURE_DRAFT, description: "Remember this" })).toBe(true);
    expect(hasCaptureDraftContent({ ...EMPTY_CAPTURE_DRAFT, diagnosticLog: "Error: timeout" })).toBe(true);
    expect(hasCaptureDraftContent({ ...EMPTY_CAPTURE_DRAFT, expectedOutcome: "Keep the selected tab" })).toBe(true);
  });

  it("keeps bug-only fields out of other record types", () => {
    const details = {
      ...EMPTY_CAPTURE_DRAFT,
      description: "Remember a faster capture flow",
      reproductionSteps: "Open the current form",
      expectedOutcome: "The form feels faster",
      impact: "Everyone",
      occurrenceFrequency: "always" as const,
    };
    expect(workItemReportPayload({ ...details, type: "idea" })).toEqual({
      overview: "Remember a faster capture flow",
    });
    expect(workItemReportPayload({ ...details, type: "bug" })).toEqual({
      overview: "Remember a faster capture flow",
      reproductionSteps: "Open the current form",
      expectedOutcome: "The form feels faster",
      impact: "Everyone",
      occurrenceFrequency: "always",
    });
  });
});
