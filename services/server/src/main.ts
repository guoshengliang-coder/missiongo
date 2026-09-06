import { loadEnvFile } from "node:process";
import { fileURLToPath } from "node:url";

import { buildApp } from "./app.js";
import { trustProxySetting } from "./config.js";
import { MCP_WRITE_TIERS } from "./mcp.js";

try {
  loadEnvFile(fileURLToPath(new URL("../../../.env", import.meta.url)));
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
}

const host = process.env.HTTP_HOST || "127.0.0.1";
const port = Number(process.env.HTTP_PORT || "8787");
const databasePath = process.env.DATABASE_PATH || "./data/missiongo.sqlite";
const attachmentsPath = process.env.ATTACHMENTS_PATH || "./data/attachments";
const adminToken = process.env.ADMIN_API_TOKEN;
const trustProxy = trustProxySetting(process.env.TRUST_PROXY);
const publicOrigin = process.env.MISSIONGO_PUBLIC_ORIGIN?.trim();
const authorizedProductIdsValue = process.env.ADMIN_AUTHORIZED_PRODUCT_IDS?.trim();
// Stamped by scripts/deploy.sh. A checkout run by hand simply reports "unknown".
const release = process.env.MISSIONGO_RELEASE?.trim();
const writeToolsValue = process.env.MISSIONGO_WRITE_TOOLS?.trim() || "none";
if (!MCP_WRITE_TIERS.includes(writeToolsValue as (typeof MCP_WRITE_TIERS)[number])) {
  throw new Error(`MISSIONGO_WRITE_TOOLS must be one of ${MCP_WRITE_TIERS.join(", ")}.`);
}
const writeTools = writeToolsValue as (typeof MCP_WRITE_TIERS)[number];
const authorizedProductIds = authorizedProductIdsValue
  ? authorizedProductIdsValue.split(",")
  .map((value) => value.trim())
  .filter(Boolean)
  : undefined;
const adminAccountId = process.env.ADMIN_ACCOUNT_ID?.trim();
const adminUsername = process.env.ADMIN_USERNAME?.trim();
const adminPasswordScrypt = process.env.ADMIN_PASSWORD_SCRYPT?.trim();
const sessionSecret = process.env.SESSION_SECRET?.trim();
const adminAccountValues = [adminAccountId, adminUsername, adminPasswordScrypt, sessionSecret];
const hasAnyAdminAccountValue = adminAccountValues.some(Boolean);
const hasCompleteAdminAccount = adminAccountValues.every(Boolean);

if (!Number.isInteger(port) || port < 1 || port > 65_535) {
  throw new Error("HTTP_PORT must be an integer between 1 and 65535.");
}

if (publicOrigin) {
  const parsedPublicOrigin = new URL(publicOrigin);
  if (parsedPublicOrigin.origin !== publicOrigin.replace(/\/$/, "") || !["http:", "https:"].includes(parsedPublicOrigin.protocol)) {
    throw new Error("MISSIONGO_PUBLIC_ORIGIN must be an HTTP(S) origin without a path.");
  }
  if (process.env.NODE_ENV === "production" && parsedPublicOrigin.protocol !== "https:") {
    throw new Error("MISSIONGO_PUBLIC_ORIGIN must use HTTPS in production.");
  }
}

if (hasAnyAdminAccountValue && !hasCompleteAdminAccount) {
  throw new Error("ADMIN_ACCOUNT_ID, ADMIN_USERNAME, ADMIN_PASSWORD_SCRYPT, and SESSION_SECRET must be configured together.");
}

if (!["127.0.0.1", "::1", "localhost"].includes(host) && !adminToken && !hasCompleteAdminAccount) {
  throw new Error("An administrator account or ADMIN_API_TOKEN is required when HTTP_HOST is not a loopback address.");
}

if (!["127.0.0.1", "::1", "localhost"].includes(host) && hasCompleteAdminAccount && !publicOrigin) {
  throw new Error("MISSIONGO_PUBLIC_ORIGIN is required for account-based AI login on a non-loopback address.");
}

const app = buildApp({
  databasePath,
  attachmentsPath,
  logger: true,
  trustProxy,
  ...(publicOrigin ? { publicOrigin } : {}),
  ...(adminToken ? { adminToken } : {}),
  writeTools,
  ...(release ? { release } : {}),
  ...(hasCompleteAdminAccount ? {
    adminAccount: {
      id: adminAccountId!,
      username: adminUsername!,
      passwordScrypt: adminPasswordScrypt!,
      sessionSecret: sessionSecret!,
      cookieSecure: process.env.NODE_ENV === "production",
      ...(authorizedProductIds ? { authorizedProductIds } : {}),
    },
  } : {}),
});

async function shutdown(signal: NodeJS.Signals): Promise<void> {
  app.log.info({ signal }, "Shutting down MissionGo Server");
  await app.close();
}

if (trustProxy === true) {
  app.log.warn(
    "TRUST_PROXY=true trusts X-Forwarded-For from any peer, so a client can spoof its own address. "
    + "Set TRUST_PROXY to the trusted proxy addresses or ranges instead.",
  );
}

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));

try {
  await app.listen({ host, port });
} catch (error) {
  app.log.error(error);
  process.exitCode = 1;
}
