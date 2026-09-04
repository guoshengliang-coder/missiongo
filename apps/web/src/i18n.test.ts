import { describe, expect, it } from "vitest";

import { resolveLocale, translate } from "./i18n";

describe("MissionGo interface language", () => {
  it("defaults to Simplified Chinese", () => {
    expect(resolveLocale(null)).toBe("zh-CN");
    expect(resolveLocale("unknown")).toBe("zh-CN");
  });

  it("restores an explicit English preference", () => {
    expect(resolveLocale("en")).toBe("en");
  });

  it("translates and interpolates interface copy", () => {
    expect(translate("zh-CN", "capturedInInbox", { key: "HG-8" })).toBe("HG-8 已记录到待整理。");
    expect(translate("en", "capturedInInbox", { key: "HG-8" })).toBe("HG-8 captured in Inbox.");
  });
});
