import type { Page } from "@playwright/test";
import {
  AGENT_SESSION_DETAIL_REFETCH_MS,
  AGENT_SESSIONS_CONSOLE_REFETCH_MS,
} from "../../apps/web/src/agent-session-view";

// Install page.clock before navigation. Advancing the browser's clock still
// exercises the real polling callback and HTTP read; it avoids sleeping through
// each mock state. Keep real time for tests that measure scrolling/animations.
export async function advanceSessionDetailPoll(page: Page) {
  await page.clock.fastForward(AGENT_SESSION_DETAIL_REFETCH_MS + 100);
}

export async function advanceSessionListPoll(page: Page) {
  await page.clock.fastForward(AGENT_SESSIONS_CONSOLE_REFETCH_MS + 100);
}

// These queries currently poll every five seconds. Observe their actual HTTP
// read as well as advancing time; never replace the callback with a page reload
// or mutate React Query's cache from the test.
async function advanceQueryPoll(page: Page, path: string) {
  const next = page.waitForResponse(response => new URL(response.url()).pathname === path && response.request().method() === "GET");
  await page.clock.fastForward(5_100);
  const response = await next;
  if (!response.ok()) throw new Error(`Polling ${path} failed with ${response.status()}`);
  await response.finished();
}

export async function advanceTimelinePoll(page: Page, itemKey: string) {
  await advanceQueryPoll(page, `/api/v1/items/${itemKey}/timeline`);
}

export async function advanceAttentionPoll(page: Page) {
  await advanceQueryPoll(page, "/api/v1/attention/count");
}

export async function advanceDingTalkBindingsPoll(page: Page) {
  await advanceQueryPoll(page, "/api/v1/dingtalk/bindings");
}
