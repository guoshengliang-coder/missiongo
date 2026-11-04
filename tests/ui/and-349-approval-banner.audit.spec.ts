import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { advanceSessionDetailPoll, advanceSessionListPoll } from "./polling";

const fixture = JSON.parse(readFileSync(fileURLToPath(new URL("./.auth/fixture.json", import.meta.url)), "utf8")) as { productId: string };
const id = "and-349-approval-banner";
const stamp = "2026-10-31T11:00:00.000Z";
const summary = {
  id, agentSessionId: id, dispatchId: "and-349-dispatch", agentKind: "codex", status: "idle",
  updatedAt: stamp, activityAt: stamp, nodeName: "Fixture", nodeConnectionState: "online", nodeRevoked: false,
  mode: "plan", dispatchStatus: "launched", createdAt: stamp, nodeId: "fixture-node", settings: {}, unread: false,
  items: [{ key: "AND-349", title: "控制台待批准条排版异常", productId: fixture.productId }],
  activities: [], turnState: { turnActive: false }, canReply: true, canRetry: false, canStop: false, canArchive: true,
  attention: { state: "needed", kind: "approval", reason: "方案待批准", revision: "attention-revision" },
  needsAttention: true, waitingForReply: true,
};
const detail = {
  ...summary,
  messages: [{ id: "plan", sourceId: "plan", role: "agent", text: "计划：调整待批准条的布局。", occurredAt: stamp }],
  planApprovalStatus: { code: "reply_pending" },
};

// Polling through blocked/ready states must not change the collapsed banner height.
for (const width of [353, 812, 1440]) for(const theme of ["light","dark"] as const) {
  test.describe(`${width}px ${theme} approval`,()=>{
  test.use({hasTouch:width<1440});
  test(`approval banner stays stable through loading and state updates at ${width}px ${theme}`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    await page.emulateMedia({colorScheme:theme});
    let code="reply_pending";
    let stalled=false;
    let release!:()=>void;
    const held=new Promise<void>(resolve=>{release=resolve;});
    let hold=true;
    await page.route("**/api/v1/agent-sessions**", async route => {
      if (route.request().method() !== "GET") return route.fulfill({ status: 204 });
      const path = new URL(route.request().url()).pathname;
      if(path !== "/api/v1/agent-sessions" && hold) await held;
      const row=stalled?{...summary,status:"stalled",attention:{...summary.attention,revision:undefined}}:summary;
      const current={...detail,...row,planApprovalStatus:{code},...(code==="ready"?{planApproval:{revision:"ready-plan",reason:"方案待批准"}}:{})};
      return route.fulfill({status:200,json:path === "/api/v1/agent-sessions"?{sessions:[row]}:current});
    });
    await page.clock.install();
    await page.goto(`/?product=${fixture.productId}&console=agent&session=${id}`);
    const banner=page.locator(".agent-console-attention-banner"),label=banner.locator("summary");
    const approve=banner.getByRole("button",{name:"批准",exact:true}),dismiss=banner.getByRole("button",{name:"无需处理",exact:true});
    const reason=banner.locator(".agent-console-approve-reason");
    // AND-375: the loading boundary now includes the approval banner. Once
    // detail arrives, keep the existing height/interaction contract below.
    await expect(page.locator(".agent-console-messages .spin")).toBeVisible();
    await expect(banner).toHaveCount(0);
    hold=false;release();
    await expect(approve).toBeDisabled();await expect(dismiss).toBeVisible();await expect(reason).toBeHidden();
    const height=(await banner.boundingBox())!.height;
    await label.click();
    await expect(reason).toContainText("你的回复还在发送");
    await label.click();await expect(reason).toBeHidden();
    for(const [state,text] of [["running","会话仍在执行"],["reply_unavailable","当前无法向这个会话发送消息"],["connection_unavailable","会话连接当前不可用"],["permission_required","当前有工具权限请求"],["awaiting_source","回复已送达"],["ready",""]] as const){
      code=state;
      await advanceSessionDetailPoll(page);
      if(state==="ready"){await expect(approve).toBeEnabled();await expect(reason).toHaveCount(0);}
      else {await expect(reason).toContainText(text);await expect(approve).toBeDisabled();await expect(reason).toBeHidden();}
      expect((await banner.boundingBox())!.height).toBeCloseTo(height,0);
    }
    const labelBox=(await label.boundingBox())!,approveBox=(await approve.boundingBox())!,dismissBox=(await dismiss.boundingBox())!;
    expect(labelBox.height).toBeLessThanOrEqual(width<1440?44:36);
    expect(Math.abs(approveBox.y-dismissBox.y)).toBeLessThan(2);expect(approveBox.width).toBeLessThan(120);
    expect(Math.abs(labelBox.y+labelBox.height/2-approveBox.y-approveBox.height/2)).toBeLessThan(2);
    if(width<1440){expect(approveBox.height).toBeGreaterThanOrEqual(44);expect(dismissBox.height).toBeGreaterThanOrEqual(44);}
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
    const path=testInfo.outputPath(`banner-${width}-${theme}.png`);await page.screenshot({path,animations:"disabled"});await testInfo.attach("stable-banner",{path,contentType:"image/png"});
    code="reply_pending";await advanceSessionDetailPoll(page);await expect(approve).toBeDisabled();await label.click();await expect(reason).toBeVisible();
    expect((await reason.boundingBox())!.width).toBeGreaterThan((await banner.boundingBox())!.width*0.6);
    expect((await reason.boundingBox())!.height).toBeLessThan(120);
    await page.screenshot({path:testInfo.outputPath(`banner-expanded-${width}-${theme}.png`)});
    if(width===353 && theme==="light"){
      await label.click();stalled=true;await advanceSessionListPoll(page);
      await expect(dismiss).toBeDisabled({timeout:10000});await expect(approve).toBeDisabled();
      expect((await banner.boundingBox())!.height).toBeCloseTo(height,0);
    }
  });
  });
}
