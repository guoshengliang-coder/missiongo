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
 *   - `visual` compares screenshots against committed baselines, which are
 *     specific to the platform that rendered them: Linux and macOS lay out the
 *     same CSS with different fonts. It runs where the baselines were made
 *     (`npm run test:ui:visual`), and the PR template asks for the screenshots
 *     it produces.
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
      // Antialiasing differs run to run; a layout change never does.
      maxDiffPixelRatio: 0.01,
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
