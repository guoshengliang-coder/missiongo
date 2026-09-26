import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { I18nProvider } from "./i18n";
import { SessionLink } from "./session-link";

// I18nProvider reads the stored locale while rendering; there is no DOM here.
vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => undefined });

const render = (url: string, mobile: boolean) => renderToStaticMarkup(
  <I18nProvider><SessionLink url={url} compact mobile={mobile} /></I18nProvider>,
);

describe("SessionLink", () => {
  const codex = "codex://threads/01a09f35-d6fa-7eb2-9d90-1352cf2fb661";

  it("hands a Codex thread to the desktop app on a Mac and to nothing on a phone (AND-214)", () => {
    expect(render(codex, false)).toContain(`href="${codex}"`);
    const phone = render(codex, true);
    expect(phone).not.toContain("href=");
    expect(phone).toContain("需在 Mac 上打开");
  });

  it("opens a Claude Code session through the mobile app on a phone (AND-214)", () => {
    const html = render("https://claude.ai/code/session_1", true);
    expect(html).toContain('href="claude://code/session_1"');
    expect(html).not.toContain('target="_blank"');
  });

  it("keeps the Claude Code web target on a desktop", () => {
    const html = render("https://claude.ai/code/session_1", false);
    expect(html).toContain('href="https://claude.ai/code/session_1"');
    expect(html).toContain('target="_blank"');
  });
});
