import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { DispatchDialog } from "./dispatch-dialog";
import { I18nProvider } from "./i18n";
import type { DispatchNode, Product, WorkItem, RedispatchEligibility } from "./types";
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: {
    getItem: () => null,
    setItem: () => undefined,
  },
});
Object.defineProperty(globalThis, "window", {
  configurable: true,
  value: { location: { href: "https://example.test/" } },
});

const product: Product = {
  id: "product-1",
  keyPrefix: "AND",
  name: "Mission GO",
  createdAt: "2026-09-20T00:00:00.000Z",
  updatedAt: "2026-09-20T00:00:00.000Z",
  hasIcon: false,
  releaseArtifacts: ["web", "androidApp", "androidSdk", "macosApp"],
  access: { canOperate: true, canUseAi: true },
};

const item = {
  id: "item-1",
  key: "AND-1",
  productId: product.id,
  status: "ready",
} as WorkItem;

function renderWithNodes(nodes: DispatchNode[], eligibility?:RedispatchEligibility): string {
  const queryClient = new QueryClient();
  queryClient.setQueryData(["nodes"], { nodes });
  queryClient.setQueryData(["dispatch-defaults"], { agents: {} });
  if (eligibility) queryClient.setQueryData(["dispatches","active","eligibility",item.key],eligibility);
  return renderToStaticMarkup(
    <QueryClientProvider client={queryClient}>
      <I18nProvider>
        <DispatchDialog
          items={[item]}
          products={[product]}
          onDispatched={() => undefined}
          onClose={() => undefined}
        />
      </I18nProvider>
    </QueryClientProvider>,
  );
}

describe("DispatchDialog machine list (AND-224)", () => {
  const node:DispatchNode={id:"node-1",name:"M4",deviceName:"M4",agents:[],repos:[],repoCandidates:[],online:true,createdAt:"2026-10-31T01:00:00Z"};
  const conflict={dispatchId:"existing",itemKey:item.key,nodeName:"M4",agentKind:"codex" as const,status:"launched" as const,createdAt:node.createdAt};
  it("does not offer a misleading force checkbox for a launched conversation",()=>{
    const html=renderWithNodes([node],{allowed:false,reason:"started",requiresConfirmation:false,conflicts:[{...conflict,agentSessionId:"owned-session"}]});
    expect(html).toContain("旧派单已送达节点");
    expect(html).not.toContain("取消原排队派单，并重新派单");
    expect(html).toContain("owned-session");
  });
  it("offers the cancellation checkbox for a replaceable queued batch only",()=>{
    const html=renderWithNodes([node],{allowed:true,reason:null,requiresConfirmation:true,conflicts:[{...conflict,status:"queued"}]});
    expect(html).toContain("取消原排队派单，并重新派单");
  });
  it("still says no devices when the list loaded empty", () => {
    const html = renderWithNodes([]);
    expect(html).toContain("还没有接入任何设备");
  });

  it("renders a machine option once the list loads", () => {
    const html = renderWithNodes([{
      id: "node-1",
      name: "M4",
      deviceName: "M4",
      agents: [],
      repos: [],
      repoCandidates: [],
      lastSeenAt: "2026-09-26T00:00:00.000Z",
      online: true,
      createdAt: "2026-09-20T00:00:00.000Z",
    }]);
    expect(html).toContain("M4");
    expect(html).not.toContain("还没有接入任何设备");
  });
});
