import { describe, expect, it } from "vitest";
import { parseCodexSessionFailure, redactSessionDiagnostic, sessionErrorFields, storedSessionError } from "./codex-session-failure.js";

describe("Codex failure diagnostics", () => {
  it("redacts credentials and private addresses before storage and display", () => {
    const input = 'token="secret-value" password=hidden api_key=sk-test-key\nAuthorization: Bearer session-secret\nCookie: one=secret; two=secret\nhttps://example.invalid/reply?token=secret\n/Users/fixture/private.log user@example.invalid 192.0.2.1';
    const safe = redactSessionDiagnostic(input);
    for (const secret of ["secret-value", "hidden", "sk-test-key", "session-secret", "one=", "two=", "example.invalid", "/Users/", "192.0.2.1"]) expect(safe).not.toContain(secret);
    expect(safe).toContain("[redacted]");
    expect(redactSessionDiagnostic('"Cookie":"session=fixture-secret"')).not.toContain("fixture-secret");
    expect(redactSessionDiagnostic("a\u0000b\u007fc\nd\te")).toBe("abc\nd\te");
  });
  it("accepts only bounded allowlisted metadata, dropping arbitrary upstream fields", () => {
    expect(parseCodexSessionFailure({ code: "future-type", detail: "x" })).toBeUndefined();
    expect(parseCodexSessionFailure({ code: "codex_turn_failed", detail: 1 })).toBeUndefined();
    expect(parseCodexSessionFailure({ code: "codex_turn_failed", detail: "x".repeat(3000), turnId: "/private/path", httpStatusCode: 999, rawResponse: "secret" }))
      .toEqual({ code: "codex_turn_failed", detail: "x".repeat(2000) });
  });
  it("round trips structured failures and reads old errors without a database migration", () => {
    const failure = { code: "codex_context_window_exceeded" as const, detail: "Context limit", turnId: "turn-1" };
    expect(sessionErrorFields(storedSessionError(undefined, failure))).toEqual({ failure, lastError: "Context limit" });
    expect(sessionErrorFields("Old error token=secret")).toEqual({ lastError: "Old error [redacted]" });
    expect(sessionErrorFields(storedSessionError())).toEqual({});
  });
});
