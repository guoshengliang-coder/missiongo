import { describe, expect, it } from "vitest";
import { CODEX_SESSION_FAILURE_CODES } from "@missiongo/domain";
import { translate } from "./i18n";
import { failureDiagnostic, sessionFailureView } from "./agent-session-failure";

describe("failure card", () => {
  it.each(CODEX_SESSION_FAILURE_CODES)("localizes %s and offers guidance without replaying a message", (code) => {
    const view = sessionFailureView("failed", { code, turnId: "t1", httpStatusCode: 429 })!;
    expect(view.code).toBe(code);
    for (const language of ["en", "zh-CN"] as const) {
      expect(translate(language, view.summary)).not.toBe(view.summary);
      expect(translate(language, view.recovery)).not.toBe(view.recovery);
    }
    expect(translate("en", view.summary)).not.toBe(translate("zh-CN", view.summary));
    expect(failureDiagnostic(view, "No detail")).toContain("turn: t1\nHTTP: 429");
  });
  it("says the reason is missing for old nodes and does not invent a network cause", () => {
    expect(sessionFailureView("failed")).toMatchObject({ code: "codex_failure_detail_unavailable", summary: "agentFailureMissing" });
    const legacy = sessionFailureView("failed", undefined, "upstream unknown token=secret")!;
    expect(legacy.summary).toBe("agentFailureUnknown");
    expect(failureDiagnostic(legacy, "")).not.toContain("secret");
  });
  it("withholds the card after recovery even if a cached list still has an old error", () => {
    for (const status of ["active", "idle", "unavailable"]) expect(sessionFailureView(status, { code: "codex_context_window_exceeded" }, "old error")).toBeUndefined();
  });
});
