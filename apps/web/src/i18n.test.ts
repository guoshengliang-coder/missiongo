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
    expect(translate("zh-CN", "capturedInInbox", { key: "HG-8" })).toBe("HG-8 已保存到草稿。");
    expect(translate("en", "capturedInInbox", { key: "HG-8" })).toBe("HG-8 saved as a draft.");
    expect(translate("zh-CN", "submittedForProcessing", { key: "HG-9" })).toBe("HG-9 已提交到待处理。");
    expect(translate("zh-CN", "requiredField")).toBe("必填");
    expect(translate("zh-CN", "bugDetailsHelp")).toContain("都可以不填");
    expect(translate("zh-CN", "add")).toBe("添加");
    expect(translate("zh-CN", "uploadLog")).toBe("上传日志");
    expect(translate("zh-CN", "notAvailableYet")).toBe("暂时还没有");
  });
});
