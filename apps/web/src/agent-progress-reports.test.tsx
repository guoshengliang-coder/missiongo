import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { AgentProgressReports } from "./agent-progress-reports";
import { I18nProvider } from "./i18n";
import type { AgentSession } from "./types";

it("expands operational reports without native messages and outside native message identities", () => {
  const session = { progressReports: [{ id: "report", text: "**Build checked**", occurredAt: "2026-11-06T00:00:00Z" }] } as unknown as AgentSession;
  const html = renderToStaticMarkup(<I18nProvider><AgentProgressReports session={session} /></I18nProvider>);
  expect(html).toContain("<summary>MissionGo 进展记录</summary>");
  expect(html).toContain("<strong>Build checked</strong>");
  expect(html).toContain(" open");
  expect(html).not.toContain("data-agent-message-id");
});


it("keeps native conversations compact with a visible latest progress summary", () => {
  const session = { messages: [{role:"agent", text:"Native answer"}], progressReports: [{ id:"report", text:"Build checked", occurredAt:"2026-11-06T00:00:00Z" }] } as unknown as AgentSession;
  const html = renderToStaticMarkup(<I18nProvider><AgentProgressReports session={session} /></I18nProvider>);
  expect(html).not.toContain(" open");
  expect(html).toContain(" · Build checked</summary>");
});
