import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AgentStopFeedback } from "./agent-stop-feedback.js";
import { I18nProvider } from "./i18n.js";
import type { AgentSessionCommand } from "./types.js";

const stop: AgentSessionCommand = { id: "stop", kind: "interrupt", text: "stop", status: "delivered", stopConfirmed: true, createdAt: "2026-11-04T01:00:00Z" };
const render = (props: Parameters<typeof AgentStopFeedback>[0]) => renderToStaticMarkup(<I18nProvider><AgentStopFeedback {...props} /></I18nProvider>);
describe("stop feedback", () => {
  it("distinguishes stopped foreground from running background work", () => {
    expect(render({ stop, backgroundRunning: true })).toContain("后台任务");
    expect(render({ stop })).toContain("可继续在本会话发消息");
  });
  it("does not upgrade an old node's delivery acknowledgement into stop confirmation", () => {
    expect(render({ stop: { ...stop, stopConfirmed: false } })).toContain("节点尚未确认回合结束");
  });
  it("does not display an old successful stop over a new active turn", () => {
    expect(render({ stop, turnActive: true })).toBe("");
    expect(render({ stop, latestCommand: { ...stop, id: "new", kind: "message", createdAt: "2026-11-04T01:01:00Z" } })).toBe("");
  });
  it("retains unconfirmed stop feedback separately from an older unknown reply", () => {
    expect(render({ stop: { ...stop, status: "failed", error: "停止尚未确认" }, latestCommand: { ...stop, kind: "message", createdAt: "2026-11-04T00:59:00Z", status: "delivery_unknown" } })).toContain("停止尚未确认");
  });
});
