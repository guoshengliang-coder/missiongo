import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DetailStatusList, detailStatusItems } from "./detail-status";
import { I18nProvider } from "./i18n";

afterEach(() => vi.unstubAllGlobals());

describe("detail status ordering", () => {
  it("puts actionable warnings above quiet status", () => {
    const items = detailStatusItems({
      status: "ready",
      canVerify: true,
      executionDisposition: "keep_running",
      progressKeys: ["itemDeliveryBlocked", "itemClaimed"],
    });
    expect(items.map(item => item.messageKey)).toEqual(["itemDeliveryBlocked", "executionKeepRunning", "itemClaimed"]);
    expect(items.map(item => item.tone)).toEqual(["danger", "info", "info"]);
  });

  it("keeps the stop request and delivery review together", () => {
    const items = detailStatusItems({
      status: "ready",
      canVerify: true,
      executionDisposition: "stop_requested",
      progressKeys: ["itemDeliveryReview"],
    });
    expect(items.map(item => item.messageKey)).toEqual(["executionStopRequested", "itemDeliveryReview"]);
    expect(items.every(item => item.tone === "warning")).toBe(true);
  });

  it("explains a missing verification permission only when it applies", () => {
    expect(detailStatusItems({ status: "pending_verification", canVerify: false, executionDisposition: undefined, progressKeys: [] }))
      .toEqual([{ key: "verification", messageKey: "verificationNotPermitted", tone: "warning" }]);
    expect(detailStatusItems({ status: "pending_verification", canVerify: true, executionDisposition: undefined, progressKeys: [] }))
      .toEqual([]);
  });
});

describe("detail status rendering", () => {
  it("renders every message with an icon and its severity class", () => {
    vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => undefined });
    const items = detailStatusItems({
      status: "ready",
      canVerify: true,
      executionDisposition: "stop_requested",
      progressKeys: ["itemDeliveryReview", "itemClaimed"],
    });
    const html = renderToStaticMarkup(<I18nProvider><DetailStatusList items={items} /></I18nProvider>);
    expect(html).toContain("条目状态提示");
    expect(html).toContain("停止待确认，请在原会话停止并核实");
    expect(html).toContain("交付关联待复核");
    expect(html).toContain("tone-warning");
    expect(html).toContain("tone-info");
    expect(html.match(/<svg/g)?.length).toBe(items.length);
  });

  it("renders nothing when the item has no top-level state message", () => {
    vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => undefined });
    expect(renderToStaticMarkup(<I18nProvider><DetailStatusList items={[]} /></I18nProvider>)).toBe("");
  });
});
