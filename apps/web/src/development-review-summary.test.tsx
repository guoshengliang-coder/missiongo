import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { DevelopmentReviewSummary } from "./development-review-summary";
import { I18nProvider } from "./i18n";
import type { DevelopmentReviewEvidence } from "@missiongo/domain";
it("keeps review evidence separate from execution controls and exposes validation gaps",()=>{
  const render=(records:DevelopmentReviewEvidence[])=>renderToStaticMarkup(<I18nProvider><DevelopmentReviewSummary value={{required:true,records}} /></I18nProvider>);
  expect(render([])).toContain("普通讨论不触发");
  const record:DevelopmentReviewEvidence={version:1,taskId:"task",agentKind:"codex",sessionRef:"native",requestId:"human",scopeDigest:"a".repeat(64),revision:4,generation:2,status:"passed",round:1,base:"b".repeat(40),checksPassed:true,blockingFindings:0,limitations:["Missing browser validation"]};
  const html=render([record]);expect(html).toContain("第 1/3 轮");expect(html).toContain("当前干净提交");
  expect(html).toContain("Missing browser validation");expect(html).not.toContain("<button");expect(html).not.toContain("停止");
  const unavailable=renderToStaticMarkup(<I18nProvider><DevelopmentReviewSummary value={{required:true,unavailable:true,records:[record]}} /></I18nProvider>);
  expect(unavailable).toContain("当前审查证据暂不可用");expect(unavailable).toContain("交付尚未就绪");
});
