// Stop the fixture server and take its temporary database with it.

import { rmSync } from "node:fs";

export default async function globalTeardown() {
  globalThis.missiongoFixtureStop?.();
  const dataDirectory = process.env.MISSIONGO_UI_FIXTURE_DATA;
  if (dataDirectory) rmSync(dataDirectory, { recursive: true, force: true });
}
