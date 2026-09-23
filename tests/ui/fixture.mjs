// Bring up a MissionGo of this checkout's own, with a console worth measuring.
//
// The UI checks need three things the developer's own instance cannot be asked
// for: a database that starts empty, an account whose password the test knows,
// and the same items every run. So this spawns a server against a throwaway
// data directory, signs in once, seeds the fixture, and hands the session
// cookie to Playwright. Nothing here reads the repository's .env, and the
// generated password never leaves the temporary directory.

import { spawn } from "node:child_process";
import { randomBytes, scryptSync } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { seedFixture } from "../../scripts/seed-ui-fixture.mjs";

const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));

export const SERVER_PORT = Number(process.env.MISSIONGO_UI_SERVER_PORT ?? 8799);
export const WEB_PORT = Number(process.env.MISSIONGO_UI_WEB_PORT ?? 5199);
export const WEB_ORIGIN = `http://127.0.0.1:${WEB_PORT}`;

const USERNAME = "ui-fixture@example.test";

function scryptHash(password) {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, 64);
  return `scrypt:${salt.toString("base64url")}:${hash.toString("base64url")}`;
}

async function waitForHealth(url, child, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Fixture server exited with code ${child.exitCode}.`);
    try {
      const response = await fetch(url);
      if (response.ok) return;
      lastError = new Error(`${url} -> ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`Fixture server never became healthy: ${lastError}`);
}

/**
 * Start the server, sign in, seed. Returns the session cookie and a stop().
 */
export async function startFixtureServer() {
  const dataDirectory = mkdtempSync(join(tmpdir(), "missiongo-ui-"));
  const password = randomBytes(18).toString("base64url");

  const child = spawn("node", ["--import", "tsx", "services/server/src/main.ts"], {
    cwd: repositoryRoot,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      NODE_ENV: "development",
      HTTP_HOST: "127.0.0.1",
      HTTP_PORT: String(SERVER_PORT),
      DATABASE_PATH: join(dataDirectory, "missiongo.sqlite"),
      ATTACHMENTS_PATH: join(dataDirectory, "attachments"),
      ADMIN_ACCOUNT_ID: "ui-fixture",
      ADMIN_USERNAME: USERNAME,
      ADMIN_PASSWORD_SCRYPT: scryptHash(password),
      SESSION_SECRET: randomBytes(32).toString("base64url"),
      ADMIN_API_TOKEN: "",
      MISSIONGO_RELEASE: "ui-fixture",
    },
  });

  const log = [];
  child.stdout.on("data", (chunk) => log.push(String(chunk)));
  child.stderr.on("data", (chunk) => log.push(String(chunk)));

  const stop = () => {
    child.kill("SIGTERM");
    try {
      rmSync(dataDirectory, { recursive: true, force: true });
    } catch {
      // A held file on the way out is not worth failing a test run over.
    }
  };

  try {
    await waitForHealth(`http://127.0.0.1:${SERVER_PORT}/health`, child);

    const login = await fetch(`http://127.0.0.1:${SERVER_PORT}/api/v1/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: USERNAME, password }),
    });
    if (!login.ok) throw new Error(`Fixture login failed: ${login.status} ${await login.text()}`);
    const cookie = (login.headers.getSetCookie?.() ?? [])
      .map((value) => value.split(";")[0])
      .join("; ");
    if (!cookie) throw new Error("Fixture login returned no session cookie.");

    const fixture = await seedFixture({ baseUrl: `http://127.0.0.1:${SERVER_PORT}`, cookie });
    return { cookie, stop, dataDirectory, ...fixture };
  } catch (error) {
    stop();
    throw new Error(`${error.message}\n\nServer output:\n${log.join("")}`, { cause: error });
  }
}

/** The pages worth measuring, as URLs relative to the console's origin. */
export const PAGES = [
  { name: "list", path: (f) => `/?product=${f.productId}&status=all` },
  { name: "detail", path: (f) => `/?product=${f.productId}&status=all&item=${f.detailKey}` },
  { name: "agent-console", path: (f) => `/?product=${f.productId}&agent=1` },
];

/** Widths from docs/design-system.md §5.6, one per shell the layout can take. */
export const VIEWPORTS = [
  { name: "phone", width: 375, height: 812, touch: true },
  { name: "phone-landscape", width: 812, height: 375, touch: true },
  { name: "tablet", width: 768, height: 1024, touch: true },
  { name: "desktop", width: 1440, height: 900, touch: false },
];

export const THEMES = ["light", "dark"];
