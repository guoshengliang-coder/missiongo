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
      { id: "gateway-glm", label: "GLM-5.3（公司）", efforts: [] },
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

describe("Claude Code session model choice", () => {
  it("uses the dispatch catalog name without a redundant model-code note", () => {
    const html = render({
      mode: "bypassPermissions", requestedModel: "gateway-glm", model: "gateway-glm", adjustable: true,
    });
    expect(html).toMatch(/<option value="gateway-glm"[^>]*>GLM-5.3（公司）<\/option>/);
    expect(html).not.toContain('<p class="agent-session-settings-note">所选模型代号');
    expect(html).not.toContain('<p class="agent-session-settings-note">');
  });

  it("maps the reported model to a catalog label after a failed switch", () => {
    const html = render({
      mode: "bypassPermissions", requestedModel: "haiku", model: "gateway-glm", error: "切换模型失败", adjustable: true,
    });
    expect(html).toMatch(/<option value="gateway-glm"[^>]*>GLM-5.3（公司）<\/option>/);
    expect(html).toContain("切换模型失败");
  });
  it("labels a pending option and pending status using the dispatch catalog", () => {
    const html = render({
      mode: "bypassPermissions", requestedModel: "haiku", model: "claude-sonnet-4-5-20250929",
      modelEndpoint: "gateway.example", pending: { revision: 2, model: "haiku" }, adjustable: true,
    });
    expect(html).toMatch(/<option value="haiku"[^>]*>DeepSeek \(haiku\)<\/option>/);
    expect(html).not.toContain("所选模型代号");
    expect(html).not.toContain("Mac 报告模型");
    expect(html).toContain("自定义接入点 gateway.example");
    expect(html).toContain("等待 Mac 应用：DeepSeek (haiku)");
  });

  it("keeps the chosen code in the picker after the Mac reports a resolved id", () => {
    const html = render({
      mode: "bypassPermissions", requestedModel: "haiku", model: "claude-haiku-4-5",
      adjustable: true,
    });
    expect(html).toMatch(/<option value="haiku"[^>]*>DeepSeek \(haiku\)<\/option>/);
    expect(html).not.toContain("所选模型代号");
    expect(html).not.toContain("Mac 报告模型");
  });

  it("shows the Mac's previous model after a failed switch, leaving the requested code available to retry", () => {
    const html = render({
      mode: "bypassPermissions", requestedModel: "haiku", model: "claude-sonnet-4-5-20250929",
      error: "切换模型失败", adjustable: true,
    });
    expect(html).toMatch(/<option value="claude-sonnet-4-5-20250929"[^>]*>claude-sonnet-4-5-20250929<\/option>/);
    expect(html).toMatch(/<option value="haiku"[^>]*>DeepSeek \(haiku\)<\/option>/);
    expect(html).not.toContain("所选模型代号");
    expect(html).not.toContain("Mac 报告模型");
    expect(html).toContain("切换模型失败");
  });
});
