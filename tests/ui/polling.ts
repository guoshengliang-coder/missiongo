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
