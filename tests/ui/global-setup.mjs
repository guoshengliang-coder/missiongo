// Start the fixture server before Playwright's own web server, and leave behind
// the two things the specs need: a signed-in storage state and the item keys.

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { startFixtureServer, WEB_ORIGIN } from "./fixture.mjs";

const here = dirname(fileURLToPath(import.meta.url));

export default async function globalSetup() {
  const fixture = await startFixtureServer();

  // The session cookie was issued for the API's own origin; the console is
  // served from Vite, which proxies /api to it, so the browser has to hold the
  // cookie against the console's origin instead.
  const origin = new URL(WEB_ORIGIN);
  const cookies = fixture.cookie.split("; ").filter(Boolean).map((pair) => {
    const at = pair.indexOf("=");
    return {
      name: pair.slice(0, at),
      value: pair.slice(at + 1),
      domain: origin.hostname,
      path: "/",
      expires: -1,
      httpOnly: true,
      secure: false,
      sameSite: "Lax",
    };
  });

  mkdirSync(`${here}/.auth`, { recursive: true });
  writeFileSync(`${here}/.auth/state.json`, JSON.stringify({ cookies, origins: [] }, null, 2));
  writeFileSync(`${here}/.auth/fixture.json`, JSON.stringify({ productId: fixture.productId, keys: fixture.keys, detailKey: fixture.detailKey }, null, 2));

  globalThis.missiongoFixtureStop = fixture.stop;
  process.env.MISSIONGO_UI_FIXTURE_DATA = fixture.dataDirectory;
}
