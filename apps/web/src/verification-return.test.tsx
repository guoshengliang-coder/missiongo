import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import { I18nProvider } from "./i18n";
import { VerificationReturnBadge, VerificationReturnCallout, VerificationReturnSummary } from "./verification-return";

afterEach(() => vi.unstubAllGlobals());

function render(info: { at: string; note?: string }) {
  vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => undefined });
  return renderToStaticMarkup(
    <I18nProvider>
      <VerificationReturnBadge />
      <VerificationReturnSummary info={info} />
      <VerificationReturnCallout info={info} />
    </I18nProvider>,
  );
}

describe("verification return display", () => {
  it("shows an explicit badge, return time, full reason and handling guidance", () => {
    const html = render({ at: "2026-09-18T10:00:00.000Z", note: "导出仍为空，请重试真实数据。" });
    expect(html).toContain("验收打回");
    expect(html).toContain("打回原因：导出仍为空，请重试真实数据。");
    expect(html).toContain("从待验证打回");
    expect(html).toContain("重新处理或派单前");
  });

  it("explains a legacy return without a note", () => {
    const html = render({ at: "2026-09-18T10:00:00.000Z" });
    expect(html).toContain("未记录打回原因，请先查看时间线再处理。");
  });
});
