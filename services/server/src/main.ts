import { loadEnvFile } from "node:process";

import { buildApp } from "./app.js";

try {
  loadEnvFile();
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
}

const host = process.env.HTTP_HOST || "127.0.0.1";
const port = Number(process.env.HTTP_PORT || "8787");
const databasePath = process.env.DATABASE_PATH || "./data/missiongo.sqlite";
const attachmentsPath = process.env.ATTACHMENTS_PATH || "./data/attachments";
const adminToken = process.env.ADMIN_API_TOKEN;

if (!Number.isInteger(port) || port < 1 || port > 65_535) {
  throw new Error("HTTP_PORT must be an integer between 1 and 65535.");
}

if (!["127.0.0.1", "::1", "localhost"].includes(host) && !adminToken) {
  throw new Error("ADMIN_API_TOKEN is required when HTTP_HOST is not a loopback address.");
}

const app = buildApp({ databasePath, attachmentsPath, logger: true, ...(adminToken ? { adminToken } : {}) });

async function shutdown(signal: NodeJS.Signals): Promise<void> {
  app.log.info({ signal }, "Shutting down MissionGo Server");
  await app.close();
}

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));

try {
  await app.listen({ host, port });
} catch (error) {
  app.log.error(error);
  process.exitCode = 1;
}
