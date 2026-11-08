import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ApiError } from "./api";
import { AgentOperationFeedback, operationSuperseded, operationFailureVisible, type OperationFailure, type OperationSnapshot } from "./agent-operation-feedback";
import { I18nProvider } from "./i18n";

Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { getItem: () => null } });
const failure = (kind: OperationFailure["kind"], target: OperationFailure["target"] = { id: "target" }): OperationFailure => ({
  sessionId: "a", kind, target, key: kind, token: 1, startedAt: 100, error: new ApiError(409, "approval_retry_unavailable", "Source conflict"),
});
const snapshot: OperationSnapshot = { sessionId: "a", checkedAt: 101, detail: true };
const command = { id: "new", createdAt: "2026-11-07T00:00:00Z", text: "Continue", kind: "message" as const, status: "delivered" as const };

describe("operation target reconciliation", () => {
  it("requires a successful newer read of the original session", () => {
    expect(operationSuperseded(failure("approval"))).toBe(false);
    expect(operationSuperseded(failure("approval"), { ...snapshot, checkedAt: 100 })).toBe(false);
    expect(operationSuperseded(failure("approval"), { ...snapshot, sessionId: "b" })).toBe(false);
    expect(operationSuperseded(failure("approval"), { ...snapshot, detail: false })).toBe(false);
    expect(operationFailureVisible(failure("archive"), "b")).toBe(false);
  });
  it("does not settle archive, stop or a send merely because chatting continued", () => {
    for (const kind of ["archive", "stop", "send"] as const) {
      expect(operationSuperseded(failure(kind, { id: "target", archived: true }), { ...snapshot, command })).toBe(false);
    }
    expect(operationSuperseded(failure("archive", { archived: true }), { ...snapshot, archivedAt: "now" })).toBe(true);
    expect(operationSuperseded(failure("archive", { archived: false }), { ...snapshot, archivedAt: "now" })).toBe(false);
  });
  it("reconciles the approval itself, including another client's accepted retry", () => {
    const approval = { id: "target", kind: "auto" as const, status: "denied", action: "Action", turnId: "turn", startedAtMs: 1 };
    expect(operationSuperseded(failure("approvalRetry"), { ...snapshot, approval })).toBe(false);
    expect(operationSuperseded(failure("approvalRetry"), { ...snapshot, approval: { ...approval, retryId: "accepted", retryStatus: "delivering" } })).toBe(true);
    expect(operationSuperseded(failure("approvalRetry"), { ...snapshot, approval: { ...approval, id: "replaced" } })).toBe(true);
    expect(operationSuperseded(failure("approvalRetry"), snapshot)).toBe(true);
    expect(operationSuperseded(failure("approval"), { ...snapshot, approval: { ...approval, kind: "manual", status: "pending" } })).toBe(false);
  });
  it("does not claim a delivered message was recalled, and distinguishes a replaced target", () => {
    expect(operationSuperseded(failure("cancel"), { ...snapshot, command: { ...command, id: "target" } })).toBe(false);
    expect(operationSuperseded(failure("cancel"), { ...snapshot, command })).toBe(true);
    expect(operationSuperseded(failure("resolve"), snapshot)).toBe(false);
  });
  it("keeps unknown stop and dispatch outcomes, but recognizes a new accepted stop", () => {
    expect(operationSuperseded(failure("stop"), snapshot)).toBe(false);
    expect(operationSuperseded(failure("stop"), { ...snapshot, stopCommand: { ...command, kind: "interrupt", status: "delivery_unknown" } })).toBe(false);
    expect(operationSuperseded(failure("stop"), { ...snapshot, stopCommand: { ...command, kind: "interrupt", status: "queued" } })).toBe(true);
    expect(operationSuperseded(failure("retry"), { ...snapshot, dispatchId: "target", dispatchStatus: "failed" })).toBe(false);
    expect(operationSuperseded(failure("retry"), { ...snapshot, dispatchId: "other", dispatchStatus: "launched" })).toBe(false);
    expect(operationSuperseded(failure("retry", { id: "target", dispatchStatus: "launched" }), {
      ...snapshot, dispatchId: "target", dispatchStatus: "launched",
    })).toBe(false);
    expect(operationSuperseded(failure("retry", { id: "target", dispatchStatus: "failed" }), {
      ...snapshot, dispatchId: "target", dispatchStatus: "launched",
    })).toBe(true);
  });
  it("binds dismiss-attention failures to the original revision", () => {
    expect(operationSuperseded(failure("dismiss"), { ...snapshot, attention: { state: "needed", revision: "target" } })).toBe(false);
    expect(operationSuperseded(failure("dismiss"), { ...snapshot, attention: { state: "needed", revision: "new" } })).toBe(true);
  });
  it("settles settings failures only for an updated settings target in the same conversation", () => {
    expect(operationSuperseded(failure("settings"), { ...snapshot, settingsIdentity: "target" })).toBe(false);
    expect(operationSuperseded(failure("settings"), { ...snapshot, settingsIdentity: "new" })).toBe(true);
    expect(operationSuperseded(failure("settings"), { ...snapshot, sessionId: "b", settingsIdentity: "new" })).toBe(false);
    expect(operationSuperseded(failure("settings"), snapshot)).toBe(false);
  });
  it("renders obsolete feedback as neutral and diagnostics as escaped text", () => {
    const html = renderToStaticMarkup(<I18nProvider><AgentOperationFeedback sessionId="a" onDismiss={() => {}}
      failures={[{ ...failure("approvalRetry"), superseded: true, error: new Error("<script>secret()</script>") }]} /></I18nProvider>);
    expect(html).toContain('role="status"');
    expect(html).not.toContain('role="alert"');
    expect(html).toContain("旧结果已不适用");
    expect(html).toContain("关闭反馈");
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>");
  });
});
