import { constants, closeSync, existsSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { randomUUID } from "node:crypto";
import type { Config } from "./types.js";

/** Installed by a native entrypoint before any Windows state is accessed. */
export interface NativeFileSecurity {
  directory(path: string): void;
  file(path: string): void;
  protect(value: string): string;
  unprotect(value: string): string;
}
let nativeSecurity: NativeFileSecurity | undefined;
export function installFileSecurity(security: NativeFileSecurity): void { nativeSecurity = security; }
function windowsSecurity(): NativeFileSecurity {
  if (!nativeSecurity) throw new Error("Windows native file security is not initialized");
  return nativeSecurity;
}
export function verifyNativePrivateFile(path: string): void { windowsSecurity().file(path); }

export function stateRoot(env = process.env): string {
  const root = env.MISSIONGO_NODE_HOME ?? join(env.XDG_STATE_HOME ?? join(homedir(), ".local/state"), "missiongo");
  if (!isAbsolute(root)) throw new Error("Node state directory must be absolute");
  return root;
}
export function privateDir(path: string): void {
  if (process.platform === "win32") { windowsSecurity().directory(path); return; }
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || (stat.mode & 0o077)) {
    throw new Error("Node directory must be owned by this user with mode 0700");
  }
}
export function readPrivate<T>(path: string): T | undefined {
  if (process.platform === "win32") {
    if (!existsSync(path)) return undefined;
    windowsSecurity().file(path);
  }
  let fd: number;
  try { fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || (process.platform !== "win32" && (stat.uid !== process.getuid?.() || (stat.mode & 0o077))) || stat.size > 16 * 1024 * 1024) {
      throw new Error("Node file must be a private regular file owned by this user (0600)");
    }
    return JSON.parse(readFileSync(fd, "utf8")) as T;
  } finally { closeSync(fd); }
}
export function savePrivate(path: string, value: unknown): void {
  privateDir(dirname(path));
  if (existsSync(path)) readPrivate(path);
  const temporary = `${path}.${randomUUID()}.tmp`;
  const fd = openSync(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  try { writeFileSync(fd, JSON.stringify(value)); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(temporary, path);
  if (process.platform !== "win32") {
    const parent = openSync(dirname(path), constants.O_RDONLY);
    try { fsyncSync(parent); } finally { closeSync(parent); }
  }
}
export function loadConfig(root: string): Config {
  privateDir(root);
  const value = readPrivate<Config & { protectedToken?: string }>(join(root, "config.json")) ?? { installationId: randomUUID(), agents: {} };
  if (process.platform === "win32") {
    if (value.token) throw new Error("Windows node credential must be protected with DPAPI");
    if (value.protectedToken) { value.token = windowsSecurity().unprotect(value.protectedToken); delete value.protectedToken; }
  }
  return value;
}
export function saveConfig(root: string, config: Config): void {
  const value: Config & { protectedToken?: string } = { ...config };
  if (process.platform === "win32" && value.token) {
    value.protectedToken = windowsSecurity().protect(value.token); delete value.token;
  }
  savePrivate(join(root, "config.json"), value);
}
export function directories(root: string): string[] {
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory() && !entry.isSymbolicLink()).map((entry) => entry.name);
}
export function safeError(error: unknown): string {
  const value = error instanceof Error ? error.message : String(error);
  return value.replace(/(?:Bearer\s+|(?:token|password|api[_-]?key)[=:]\s*)\S+/gi, "[redacted]")
    .replace(/https?:\/\/[^\s]+/g, "[URL]").replace(/\/(?:Users|home)\/[^\s"']+/g, "[private path]")
    .replace(/[A-Z]:[\\/][^\s"']+/gi, "[private path]").slice(0, 1000);
}
