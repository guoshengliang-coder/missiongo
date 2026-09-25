import { defineConfig } from "@playwright/test";

import { WEB_ORIGIN, WEB_PORT, SERVER_PORT } from "./tests/ui/fixture.mjs";

/**
 * The interface checks from docs/ui-ue-review-2026-09.md D1.
 *
 * Two projects, because they answer different questions and cost differently:
 *
 *   - `audit` measures the rendered page -- text size, contrast, touch targets,
 *     horizontal overflow -- and the answer is a number, the same on any
 *     machine. It runs in CI.
 *   - `visual` compares screenshots against committed baselines. CI records and
 *     compares the Linux set (`*-visual-linux.png`) on ubuntu; a developer's
 *     own darwin files stay untracked. Regenerate them deliberately with the
 *     workflow_dispatch input `update_ui_snapshots`, then commit the
 *     `ui-snapshots` artifact it uploads.
 *
 * The server and the console both come up from tests/ui/fixture.mjs against a
 * throwaway database; nothing here touches a developer's own data.
 */
export default defineConfig({
  testDir: "./tests/ui",
  globalSetup: "./tests/ui/global-setup.mjs",
  globalTeardown: "./tests/ui/global-teardown.mjs",
  fullyParallel: false,
  workers: 1,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : [["list"]],
  timeout: 60_000,
  expect: {
    toHaveScreenshot: {
      // Antialiasing differs run to run; a layout change never does. One
      // percent was loose enough to hide a real one: AND-197's status reorder
      // moved only ~0.9% of a page's pixels, so a stale baseline passed until
      // a random product-badge colour nudged it over. The badge is masked in
      // visual.spec.ts, leaving only sub-pixel noise, so the gate can be tight.
      maxDiffPixelRatio: 0.001,
      animations: "disabled",
      caret: "hide",
    },
  },
  use: {
    baseURL: WEB_ORIGIN,
    storageState: "./tests/ui/.auth/state.json",
    trace: "retain-on-failure",
  },
  projects: [
    { name: "audit", testMatch: /audit\.spec\.ts/ },
    { name: "visual", testMatch: /visual\.spec\.ts/ },
  ],
  webServer: {
    command: `npm run dev --workspace @missiongo/web -- --port ${WEB_PORT} --strictPort`,
    url: WEB_ORIGIN,
    reuseExistingServer: false,
    timeout: 120_000,
    env: { MISSIONGO_DEV_SERVER_URL: `http://127.0.0.1:${SERVER_PORT}` },
  },
});
