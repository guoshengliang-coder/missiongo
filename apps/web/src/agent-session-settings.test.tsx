import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { AgentSessionQuickSettings } from "./agent-session-settings";
import { I18nProvider } from "./i18n";
import type { AgentSessionSettings, AgentSessionSummary, DispatchNode } from "./types";

Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: { getItem: () => null, setItem: () => undefined },
});

const node = {
  id: "node-1",
  name: "M4", deviceName: "M4", repos: [], repoCandidates: [], online: true, createdAt: "",
  agents: [{
    kind: "claude_code",
    models: [
      { id: "sonnet", label: "DeepSeek", efforts: [] },
      { id: "haiku", label: "DeepSeek", efforts: [] },
    ],
  }],
} satisfies DispatchNode;

function render(settings: AgentSessionSettings): string {
  const queryClient = new QueryClient();
  queryClient.setQueryData(["nodes"], { nodes: [node] });
  const session = {
    agentSessionId: "session-1", agentKind: "claude_code", nodeId: node.id, settings,
  } as AgentSessionSummary;
  return renderToStaticMarkup(
    <QueryClientProvider client={queryClient}>
      <I18nProvider><AgentSessionQuickSettings session={session} /></I18nProvider>
    </QueryClientProvider>,
  );
}

describe("Claude Code session model choice (AND-264)", () => {
  it("labels a pending option with its own code while showing the Mac's previous report separately", () => {
    const html = render({
      mode: "bypassPermissions", requestedModel: "haiku", model: "claude-sonnet-4-5-20250929",
      modelEndpoint: "gateway.example", pending: { revision: 2, model: "haiku" }, adjustable: true,
    });
    expect(html).toMatch(/<option value="haiku"[^>]*>DeepSeek \(haiku\)<\/option>/);
    expect(html).toContain("所选模型代号: haiku");
    expect(html).toContain("Mac 报告模型: claude-sonnet-4-5-20250929");
    expect(html).toContain("自定义接入点 gateway.example");
    expect(html).toContain("等待 Mac 应用：haiku");
  });

  it("keeps the chosen code in the picker after the Mac reports a resolved id", () => {
    const html = render({
      mode: "bypassPermissions", requestedModel: "haiku", model: "claude-haiku-4-5",
      adjustable: true,
    });
    expect(html).toMatch(/<option value="haiku"[^>]*>DeepSeek \(haiku\)<\/option>/);
    expect(html).toContain("所选模型代号: haiku");
    expect(html).toContain("Mac 报告模型: claude-haiku-4-5");
  });

  it("shows the Mac's previous model after a failed switch, leaving the requested code available to retry", () => {
    const html = render({
      mode: "bypassPermissions", requestedModel: "haiku", model: "claude-sonnet-4-5-20250929",
      error: "切换模型失败", adjustable: true,
    });
    expect(html).toMatch(/<option value="claude-sonnet-4-5-20250929"[^>]*>claude-sonnet-4-5-20250929<\/option>/);
    expect(html).toMatch(/<option value="haiku"[^>]*>DeepSeek \(haiku\)<\/option>/);
    expect(html).toContain("所选模型代号: haiku");
    expect(html).toContain("Mac 报告模型: claude-sonnet-4-5-20250929");
    expect(html).toContain("切换模型失败");
  });
});
