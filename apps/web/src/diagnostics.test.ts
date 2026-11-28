import { describe, expect, it, vi } from "vitest";

import { clearConsoleReadDiagnostics, consoleReadDiagnostics, observeConsoleRead, recordConsoleReadEvent } from "./console-read-recovery";
import { diagnosticLogBytes, diagnosticLogFile } from "./diagnostics";

describe("diagnostic logs", () => {
  it("counts UTF-8 bytes instead of JavaScript characters", () => {
    expect(diagnosticLogBytes("日志")).toBe(6);
  });

  it("keeps internal diagnostic content unchanged", async () => {
    const content = "Authorization: Bearer internal-value\ntoken=raw-value";
    const file = diagnosticLogFile(content, new Date("2026-09-04T12:00:00.000Z"));
    expect(file?.name).toBe("diagnostic-2026-09-04T12-00-00-000Z.log");
    expect(await file?.text()).toBe(content);
  });
});

it("retains only bounded request diagnostics and omits raw error text", async () => {
  vi.stubGlobal("document", { visibilityState: "visible" });
  try {
    for (let i = 0; i < 18; i++) recordConsoleReadEvent("visible");
    const failure = new DOMException("private request URL", "TimeoutError");
    await expect(observeConsoleRead("session_list", async () => { throw failure; })).rejects.toBe(failure);
    await observeConsoleRead("session_list", async () => "private response");
    const diagnostics = consoleReadDiagnostics()!;
    expect(diagnostics.length).toBeLessThanOrEqual(2000);
    expect(diagnostics).not.toContain("private");
    const entries = JSON.parse(diagnostics);
    expect(entries).toHaveLength(16);
    expect(entries.slice(-2)).toMatchObject([
      { read: "session_list", result: "timeout", visibility: "visible" },
      { read: "session_list", result: "success", visibility: "visible" },
    ]);
  } finally {
    clearConsoleReadDiagnostics();
    vi.unstubAllGlobals();
  }
});
