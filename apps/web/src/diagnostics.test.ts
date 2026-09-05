import { describe, expect, it } from "vitest";

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
