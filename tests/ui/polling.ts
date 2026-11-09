import type { Page } from "@playwright/test";

/** Legacy helper names are retained by the existing behavioral audits. They now
 * exercise an SSE reset and the real HTTP snapshot reads, never polling timers,
 * page reloads or direct React Query cache writes. The upstream stream stays open. */
export async function refreshFromConsoleStream(page: Page) {
  await page.evaluate(() => {
    const original = window.fetch;
    window.fetch = async (input, init) => {
      if (!String(input).startsWith("/api/v1/console/events")) return original(input, init);
      window.fetch = original;
      const response = await original(input, init);
      const reader = response.body!.getReader();
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('event: reset\ndata: {}\n\n'));
          void (async () => {
            try { while (true) { const chunk = await reader.read(); if (chunk.done) break; controller.enqueue(chunk.value); } controller.close(); }
            catch (error) { controller.error(error); }
            finally { reader.releaseLock(); }
          })();
        },
        cancel: reason => reader.cancel(reason),
      });
      return new Response(body, {status: response.status, headers: response.headers});
    };
    window.dispatchEvent(new Event("online"));
  });
}
export async function advanceSessionDetailPoll(page: Page) {
  const next=page.waitForResponse(response=>/\/api\/v1\/agent-sessions\/[^/]+$/.test(new URL(response.url()).pathname)&&response.request().method()==="GET");
  await refreshFromConsoleStream(page);
  await page.clock.fastForward(2_100);
  await next;
}
export async function advanceSessionListPoll(page: Page) {
  const next=page.waitForResponse(response=>new URL(response.url()).pathname==="/api/v1/agent-sessions"&&response.request().method()==="GET");
  await refreshFromConsoleStream(page);await page.clock.fastForward(5_100);await next;
}
async function advanceQueryPoll(page: Page, path: string) {
  const next=page.waitForResponse(response=>new URL(response.url()).pathname===path&&response.request().method()==="GET");
  await refreshFromConsoleStream(page);await page.clock.fastForward(5_100);
  const response=await next;
  if(!response.ok())throw new Error(`SSE refresh ${path} failed with ${response.status()}`);
  await response.finished();
}
export async function advanceTimelinePoll(page: Page,itemKey:string){await advanceQueryPoll(page,`/api/v1/items/${itemKey}/timeline`);}
export async function advanceAttentionPoll(page: Page){await advanceQueryPoll(page,"/api/v1/attention/count");}
export async function advanceDingTalkBindingsPoll(page: Page){await advanceQueryPoll(page,"/api/v1/dingtalk/bindings");}

/** The console event stream stays open, so networkidle never fires. Wait
 * instead until the count of non-stream resources has been quiet across
 * consecutive polls. Polling runs in Node; the page clock may be frozen. */
export async function waitForNetworkQuiet(page: Page, stable = 3) {
  const { expect } = await import("@playwright/test");
  await expect.poll(() => page.evaluate(() => {
    const quiet = performance.getEntriesByType("resource")
      .filter(entry => !entry.name.includes("/api/v1/console/events")).length;
    const tracker = window as unknown as { mgLastQuietResources?: number; mgQuietPolls?: number };
    if (quiet === tracker.mgLastQuietResources) tracker.mgQuietPolls = (tracker.mgQuietPolls ?? 0) + 1;
    else { tracker.mgLastQuietResources = quiet; tracker.mgQuietPolls = 0; }
    return tracker.mgQuietPolls ?? 0;
  }), { timeout: 15_000 }).toBeGreaterThanOrEqual(stable);
}
