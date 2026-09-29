import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { DisplaySettings } from "./display-settings";
import { I18nProvider } from "./i18n";

Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: {
    getItem: () => null,
    setItem: () => undefined,
  },
});

function renderDisplaySettings(user: Parameters<typeof DisplaySettings>[0]["user"]): string {
  return renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <I18nProvider>
        <DisplaySettings user={user} />
      </I18nProvider>
    </QueryClientProvider>,
  );
}

describe("display settings", () => {
  const user = {
    id: "account-1",
    username: "person@example.com",
    displayName: "person",
    fontScale: "medium",
    consoleFontScale: "medium",
    role: "member",
  } as const;

  // AND-254: the chat body's size is a second setting, not a modifier of the
  // console-wide one, so the page must show two groups of three steps.
  it("offers the console-wide size and the chat body's size as two separate settings", () => {
    const html = renderDisplaySettings(user);

    expect(html).toContain('aria-label="字体大小"');
    expect(html).toContain('aria-label="Agent 控制台聊天字号"');
    expect(html.match(/role="radio"/g)).toHaveLength(6);
    // The chat group's preview is drawn at the chat body's own size.
    expect(html).toContain("font-scale-preview console-chat");
  });
});
