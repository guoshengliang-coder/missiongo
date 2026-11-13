import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { advanceSessionDetailPoll } from "./polling";
const fixture = JSON.parse(readFileSync(new URL("./.auth/fixture.json", import.meta.url), "utf8")) as {productId: string};

for (const width of [320, 900, 1440]) for (const colorScheme of ["light", "dark"] as const) {
  test(`old receipt stays before a newer reply ${width} ${colorScheme}`, async ({page}, testInfo) => {
    await page.setViewportSize({width, height: 900});
    await page.emulateMedia({colorScheme});
    await page.clock.install({time: new Date("2026-11-13T03:19:00Z")});
    const id = "message-order";
    const createdAt = "2026-11-12T12:46:00Z";
    const command = {id: "original-command", kind: "message", text: "允许，仅用于标准发布性能门禁", status: "delivered", createdAt};
    let mirrored = false;
    const summary = {id, agentSessionId:id, agentKind:"codex", status:"idle", createdAt,
      updatedAt:"2026-11-12T16:54:00Z", activityAt:"2026-11-12T16:54:00Z", nodeName:"Fixture", nodeConnectionState:"online",
      nodeRevoked:false, mode:"plan", dispatchStatus:"launched", settings:{}, activities:[],
      turnState:{turnActive:false, observedAt:"2026-11-13T03:19:00Z"}, canReply:true, canStop:false,
      canArchive:true, canRetry:false, unread:false, items:[], productId:fixture.productId,
      attention:{state:"not_needed"}, needsAttention:false, waitingForReply:false};
    await page.route("**/api/v1/agent-sessions**", route => {
      const path = new URL(route.request().url()).pathname;
      if (path.endsWith("/read")) return route.fulfill({status:204});
      if (path === "/api/v1/agent-sessions") return route.fulfill({json:{sessions:[{...summary, command}]}});
      return route.fulfill({json:{...summary, command, messages:[
        {id:"before", sourceId:"before", role:"agent", text:"请确认本次范围", occurredAt:"2026-11-12T12:00:00Z"},
        ...(mirrored ? [{id:"source-user",sourceId:command.id,role:"user",text:command.text,occurredAt:createdAt}] : []),
        {id:"after", sourceId:"after", role:"agent", text:"已合并并发布，本轮结束", occurredAt:"2026-11-12T16:54:00Z"},
      ]}});
    });
    await page.goto(`/?product=${fixture.productId}&console=agent&session=${id}`);
    const receipt = page.locator(".agent-console-outgoing");
    const later = page.locator('[data-agent-message-id="agent:after"]');
    await expect(receipt).toContainText("已送达");
    await expect(receipt).not.toContainText("待执行");
    await expect(later).toBeVisible();
    expect((await receipt.boundingBox())!.y).toBeLessThan((await later.boundingBox())!.y);
    await page.screenshot({path:testInfo.outputPath(`message-order-${width}-${colorScheme}.png`)});
    await page.reload();
    await expect(receipt).toBeVisible();
    expect((await receipt.boundingBox())!.y).toBeLessThan((await later.boundingBox())!.y);
    mirrored = true;
    await advanceSessionDetailPoll(page);
    await expect(receipt).toHaveCount(0);
    await expect(page.locator(".agent-console-messages").getByText(command.text, {exact:true})).toHaveCount(1);
  });
}
