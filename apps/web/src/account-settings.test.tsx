import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { AccountManagement, AccountSettings } from "./account-settings";
import { I18nProvider } from "./i18n";

Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: {
    getItem: () => null,
    setItem: () => undefined,
  },
});

function renderAccountUi(node: ReactNode, queryClient = new QueryClient()): string {
  return renderToStaticMarkup(
    <QueryClientProvider client={queryClient}>
      <I18nProvider>{node}</I18nProvider>
    </QueryClientProvider>,
  );
}

describe("account settings view mode", () => {
  it("offers explicit self-service actions without rendering either edit form", () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(["ai-authorizations"], { authorizations: [] });

    const html = renderAccountUi(
      <AccountSettings
        user={{ id: "account-1", username: "person@example.com", displayName: "person", role: "member" }}
        products={[]}
        onLoggedOut={() => undefined}
      />,
      queryClient,
    );

    expect(html).toContain("修改邮箱");
    expect(html).toContain("修改密码");
    expect(html).not.toContain('type="email"');
    expect(html).not.toContain('type="password"');
  });

  it("shows account-management actions without rendering create or edit fields", () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(["accounts"], {
      accounts: [{
        id: "account-1",
        email: "admin@example.com",
        role: "admin",
        createdAt: "2026-09-15T00:00:00.000Z",
        updatedAt: "2026-09-15T00:00:00.000Z",
        permissions: [],
      }],
    });

    const html = renderAccountUi(
      <AccountManagement
        user={{ id: "account-1", username: "admin@example.com", displayName: "admin", role: "admin" }}
        products={[]}
      />,
      queryClient,
    );

    expect(html).toContain("新建账号");
    expect(html).toContain("修改");
    expect(html).not.toContain("<input");
  });
});
