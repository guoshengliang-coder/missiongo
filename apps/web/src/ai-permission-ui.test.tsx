import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { AgentSessionPanel } from "./agent-session-panel";
import { I18nProvider } from "./i18n";
import { StartWorkDialog } from "./start-work-dialog";
import type { Product, WorkItem } from "./types";

Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: {
    getItem: () => null,
    setItem: () => undefined,
  },
});

const deniedProduct: Product = {
  id: "product-1",
  keyPrefix: "AND",
  name: "Android",
  createdAt: "2026-09-20T00:00:00.000Z",
  updatedAt: "2026-09-20T00:00:00.000Z",
  hasIcon: false,
  access: { canOperate: true, canUseAi: false },
};

const item = {
  id: "item-1",
  key: "AND-1",
  productId: deniedProduct.id,
  status: "ready",
} as WorkItem;

function render(node: ReactNode): string {
  return renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <I18nProvider>{node}</I18nProvider>
    </QueryClientProvider>,
  );
}

describe("AI permission UI", () => {
  it("keeps Start work purely manual when the product denies AI", () => {
    const html = render(
      <StartWorkDialog
        item={item}
        product={deniedProduct}
        onClose={() => undefined}
        onClaimed={() => undefined}
        onDispatch={() => undefined}
        onOpenAgents={() => undefined}
      />,
    );

    expect(html).toContain("人工处理");
    expect(html).not.toContain("派单给 AI Agent");
    expect(html).not.toContain("Agent 管理");
    expect(html).not.toContain("AI 调用");
  });

  it("labels an existing Codex conversation as view-only", () => {
    const html = render(<AgentSessionPanel sessionId="session-1" canReply={false} />);

    expect(html).toContain("在 MissionGo 中查看会话");
    expect(html).not.toContain("在 MissionGo 中查看和回复");
  });
});
