import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import { BuilderHandoverNotice } from "./item-delivery";
import type { ItemDelivery } from "./api";
import { I18nProvider } from "./i18n";

function render(status: "stopping"|"blocked"|"completed", manager=true, takeover=false) {
  const delivery: ItemDelivery = {builderAccountId:"old",builderName:"New Builder",builderNeedsReassignment:false,
    canManage:manager,canManageBuilder:manager,currentAccountId:"viewer",candidates:[],performers:[],executions:[],
    canTakeOver:takeover,builderHandover:{id:"handover",status,reason:status === "blocked" ? "节点离线，请手动重试" : "",targetAccountId:"new",canTakeOver:takeover}};
  return renderToStaticMarkup(<QueryClientProvider client={new QueryClient()}><I18nProvider><BuilderHandoverNotice itemKey="TEST-1" delivery={delivery} onTakeOver={()=>{}} /></I18nProvider></QueryClientProvider>);
}
describe("Builder handover controls",()=>{
  it("shows the stop barrier without offering another execution",()=>{
    const html=render("stopping");
    expect(html).toContain("交接中");expect(html).toContain("等待旧执行停止确认");
    expect(html).not.toContain("重试交接</button>");expect(html).not.toContain("Agent 接手</button>");
  });
  it("explains blocked handovers and limits retry to managers",()=>{
    expect(render("blocked")).toContain("重试交接</button>");
    expect(render("blocked",false)).not.toContain("重试交接</button>");
    expect(render("blocked",false)).toContain("节点离线，请手动重试");
    expect(render("blocked")).toContain("重试会在本次交接内重新核对当前证据");
  });
  it("offers explicit takeover only when the server authorizes this viewer",()=>{
    expect(render("completed",false,true)).toContain("选择机器和 Agent 接手</button>");
    expect(render("completed",true,false)).not.toContain("Agent 接手</button>");
    expect(render("completed",true,false)).toContain("不表示旧设备进程已停止");
  });
});
