#!/usr/bin/env node
import { readFile, writeFile, mkdir, rename, lstat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";

const quote = (value) => "'" + value.replaceAll("'", "'\\''") + "'";
const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
async function existing(path) {
  try {
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Integration target must be a regular file");
    return await readFile(path, "utf8");
  } catch (error) { if (error.code === "ENOENT") return undefined; throw error; }
}
async function save(path, content) {
  const old = await existing(path);
  if (old === content) return;
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  if (old !== undefined) await writeFile(path + ".missiongo-backup-" + randomUUID(), old, { flag: "wx", mode: 0o600 });
  const temporary = path + ".missiongo-new-" + randomUUID();
  await writeFile(temporary, content, { flag: "wx", mode: 0o600 });
  await rename(temporary, path);
}

// Paths are supplied by the caller; no settings, credentials, or models leave
// this machine. Existing unrelated hooks and all provider options are retained.
export async function install({ claudeDirectory, opencodeDirectory, assets, nodePath = process.execPath }) {
  const plans = [];
  if (claudeDirectory) {
    const settingsPath = join(claudeDirectory, "settings.json");
    const original = await existing(settingsPath);
    const settings = original === undefined ? {} : JSON.parse(original);
    if (!object(settings) || (settings.hooks !== undefined && !object(settings.hooks))) throw new Error("Claude settings/hooks must be JSON objects; settings were not changed");
    settings.hooks ??= {};
    const starts = settings.hooks.SessionStart ?? [];
    if (!Array.isArray(starts)) throw new Error("Claude SessionStart must be an array; settings were not changed");
    const helper = join(claudeDirectory, "missiongo-session.cjs");
    const command = quote(nodePath) + " " + quote(helper);
    if (!starts.some((entry) => Array.isArray(entry?.hooks) && entry.hooks.some((hook) => hook.type === "command" && hook.command === command))) {
      settings.hooks.SessionStart = [...starts, { hooks: [{ type: "command", command, timeout: 5 }] }];
    }
    plans.push([helper, assets.claude], [settingsPath, JSON.stringify(settings, null, 2) + "\n"]);
  }
  if (opencodeDirectory) {
    // V2 discovers immediate package directories, with package.json resolving
    // index.js as ESM. A loose .mjs file is not an auto-discovery target.
    const plugin = join(opencodeDirectory, "plugins", "missiongo-session");
    plans.push([join(plugin, "package.json"), JSON.stringify({ name: "missiongo-session", private: true, type: "module", main: "./index.js" }, null, 2) + "\n"], [join(plugin, "index.js"), assets.opencode]);
  }
  if (plans.some(([, content]) => typeof content !== "string" || !content.trim())) throw new Error("Missing integration assets");
  for (const [path] of plans) await existing(path);
  for (const [path, content] of plans) await save(path, content);
  return plans.map(([path]) => path);
}

async function main() {
  const args = process.argv.slice(2);
  let origin;
  if (args.length) {
    if (args.length !== 2 || args[0] !== "--origin") throw new Error("Usage: node install.mjs [--origin <MissionGo HTTPS origin>]");
    const url = new URL(args[1]);
    if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash) throw new Error("Use a plain HTTPS origin without credentials");
    origin = url.origin;
  }
  const load = async (name) => {
    if (!origin) return readFile(new URL(name, import.meta.url), "utf8");
    const response = await fetch(origin + "/downloads/missiongo-agent-integration/" + name, { redirect: "error", signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw new Error("Integration download failed: HTTP " + response.status);
    return response.text();
  };
  const [claude, opencode] = await Promise.all([load("claude-session.cjs"), load("opencode-session.mjs")]);
  const version = spawnSync("opencode", ["--version"], { encoding: "utf8", timeout: 5000, maxBuffer: 65536 });
  const openCodeV2 = version.status === 0 && /^v?2\./.test(version.stdout.trim());
  const paths = await install({
    claudeDirectory: resolve(process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude")),
    opencodeDirectory: openCodeV2 ? join(resolve(process.env.XDG_CONFIG_HOME || join(homedir(), ".config")), "opencode") : undefined,
    assets: { claude, opencode },
  });
  if (!openCodeV2) process.stdout.write("OpenCode V2 was not detected; its plugin was not installed. Upgrade to V2 and rerun setup.\n");
  for (const path of paths) process.stdout.write("Configured: " + path + "\n");
  process.stdout.write("Restart Claude Code/OpenCode to load session identity. Codex uses CODEX_THREAD_ID with MissionGo Skill 5.21+.\nEnable these Agents in the updated MissionGo Mac node. Plain Claude TUI needs an explicit local bridge handoff for Web replies. Existing model/provider configuration is retained.\n");
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch(() => { process.stderr.write("MissionGo setup failed. Check the HTTPS origin, download access and local JSON settings; no provider configuration is sent.\n"); process.exitCode = 1; });
}
