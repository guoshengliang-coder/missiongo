import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * The daemon's local state: where the server is, and the credential that
 * identifies this machine to it.
 *
 * It lives under the user's home directory rather than in the repository,
 * because one machine serves every mapped repository and the token must not
 * end up in a working tree that gets committed or deployed.
 */
export type NodeConfig = {
  serverUrl: string;
  token: string;
  nodeId: string;
  name: string;
};

export const CONFIG_DIR_NAME = ".missiongo-node";

/**
 * Where the daemon keeps its state. MISSIONGO_NODE_HOME overrides it, which is
 * what makes a second instance on one machine — or a run against a test server —
 * possible without touching the real credential.
 */
export function nodeHome(): string {
  return process.env.MISSIONGO_NODE_HOME?.trim() || homedir();
}

export function configDir(home: string = nodeHome()): string {
  return join(home, CONFIG_DIR_NAME);
}

export function configPath(home: string = nodeHome()): string {
  return join(configDir(home), "config.json");
}

export function logsDir(home: string = nodeHome()): string {
  return join(configDir(home), "logs");
}

/**
 * The log of one dispatch, named after the dispatch id.
 *
 * The id arrives over the wire, so anything that could climb out of the log
 * directory is replaced instead of trusted.
 */
export function logPathFor(dispatchId: string, home: string = nodeHome()): string {
  const safeId = dispatchId.replaceAll(/[^A-Za-z0-9_-]/g, "_");
  return join(logsDir(home), `${safeId}.log`);
}

/**
 * Drop a trailing slash from the stored server URL.
 *
 * Every request path already starts with `/api`, so a stored trailing slash
 * would produce `//api/...`, which some proxies answer with a 404 instead of
 * normalising.
 */
export function normalizeServerUrl(value: string): string {
  return value.trim().replaceAll(/\/+$/g, "");
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`配置缺少字段 ${field}，请重新运行 missiongo-node pair。`);
  }
  return value.trim();
}

export function parseConfig(raw: string): NodeConfig {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("配置文件不是合法的 JSON，请删除后重新配对。");
  }
  if (typeof value !== "object" || value === null) {
    throw new Error("配置文件不是合法的 JSON 对象，请删除后重新配对。");
  }
  const record = value as Record<string, unknown>;
  return {
    serverUrl: normalizeServerUrl(requiredString(record.serverUrl, "serverUrl")),
    token: requiredString(record.token, "token"),
    nodeId: requiredString(record.nodeId, "nodeId"),
    name: requiredString(record.name, "name"),
  };
}

/** `undefined` means this machine has not been paired yet, which is not an error. */
export function readConfig(home: string = nodeHome()): NodeConfig | undefined {
  const path = configPath(home);
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    if (error instanceof Error && (error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  return parseConfig(raw);
}

export function writeConfig(config: NodeConfig, home: string = nodeHome()): string {
  const path = configPath(home);
  mkdirSync(configDir(home), { recursive: true, mode: 0o700 });
  const body = JSON.stringify(
    {
      serverUrl: normalizeServerUrl(config.serverUrl),
      token: config.token,
      nodeId: config.nodeId,
      name: config.name,
    },
    null,
    2,
  );
  writeFileSync(path, `${body}\n`, { mode: 0o600 });
  // `mode` in writeFileSync only applies when the file is created, so a second
  // pairing would inherit whatever permissions the previous file carried.
  chmodSync(path, 0o600);
  return path;
}
