#!/usr/bin/env node
import { readFile, writeFile, mkdir, rename, lstat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { realpathSync } from "node:fs";
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
export async function install({ claudeDirectory, opencodeDirectory, codexDirectory, assets, reviewAssets, nodePath = process.execPath }) {
  const plans = [];
  const reviewFiles = directory => {
    if (!reviewAssets) return;
    for (const name of ["review-workflow.mjs", "review-native.mjs", "review-cli.mjs"]) plans.push([join(directory, "missiongo-review", name), reviewAssets[name]]);
  };
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
    reviewFiles(claudeDirectory);
  }
  if (opencodeDirectory) {
    // V2 discovers immediate package directories, with package.json resolving
    // index.js as ESM. A loose .mjs file is not an auto-discovery target.
    const plugin = join(opencodeDirectory, "plugins", "missiongo-session");
    plans.push([join(plugin, "package.json"), JSON.stringify({ name: "missiongo-session", private: true, type: "module", main: "./index.js" }, null, 2) + "\n"], [join(plugin, "index.js"), assets.opencode]);
    reviewFiles(plugin);
  }
  if (codexDirectory && reviewAssets) {
    const path = join(codexDirectory, "hooks.json"); const original = await existing(path);
    const hooks = original === undefined ? { hooks: {} } : JSON.parse(original);
    if (!object(hooks) || !object(hooks.hooks)) throw new Error("Codex hooks must be an object; existing settings were preserved");
    const helper = join(codexDirectory, "missiongo-review-context.cjs"); const command = quote(nodePath) + " " + quote(helper);
    for (const event of ["SessionStart", "UserPromptSubmit"]) {
      const prior = hooks.hooks[event] ?? [];
      if (!Array.isArray(prior)) throw new Error("Codex hook entries must be arrays");
      if (!prior.some(entry => entry.hooks?.some(hook => hook.command === command))) hooks.hooks[event] = [...prior, { hooks: [{ type: "command", command, timeout: 5 }] }];
    }
    plans.push([helper, reviewAssets["codex-review.cjs"]], [path, JSON.stringify(hooks, null, 2) + "\n"]); reviewFiles(codexDirectory);
  }
  if (plans.some(([, content]) => typeof content !== "string" || !content.trim())) throw new Error("Missing integration assets");
  for (const [path] of plans) await existing(path);
  for (const [path, content] of plans) await save(path, content);
  return plans.map(([path]) => path);
}

async function main() {
  const args = process.argv.slice(2);
  let origin, reviewRepository;
  for (let offset = 0; offset < args.length; offset += 2) {
    if (!args[offset + 1] || !["--origin", "--enable-review"].includes(args[offset])) throw new Error("Usage: node install.mjs [--origin <HTTPS origin>] [--enable-review <repository>]");
    if (args[offset] === "--enable-review") { reviewRepository = realpathSync(args[offset + 1]); continue; }
    const url = new URL(args[offset + 1]);
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
  const reviewAssets = reviewRepository ? Object.fromEntries(await Promise.all(["review-workflow.mjs", "review-native.mjs", "review-cli.mjs", "codex-review.cjs"].map(async name => [name, await load(name)]))) : undefined;
  const version = spawnSync("opencode", ["--version"], { encoding: "utf8", timeout: 5000, maxBuffer: 65536 });
  const openCodeV2 = version.status === 0 && /^(?:opencode\s+)?v?2\./i.test(version.stdout.trim());
  const paths = await install({
    claudeDirectory: resolve(process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude")),
    opencodeDirectory: openCodeV2 ? join(resolve(process.env.XDG_CONFIG_HOME || join(homedir(), ".config")), "opencode") : undefined,
    ...(reviewAssets ? { codexDirectory: resolve(process.env.CODEX_HOME || join(homedir(), ".codex")), reviewAssets } : {}),
    assets: { claude, opencode },
  });
  if (!openCodeV2) process.stdout.write("OpenCode V2 was not detected; its plugin was not installed. Upgrade to V2 and rerun setup.\n");
  for (const path of paths) process.stdout.write("Configured: " + path + "\n");
  if (reviewRepository) {
    const { pathToFileURL } = await import("node:url");
    const helper = join(resolve(process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude")), "missiongo-review", "review-cli.mjs");
    const { reviewAction } = await import(pathToFileURL(helper).href);
    await reviewAction("enable", { repository: reviewRepository });
    process.stdout.write("Review policy enabled only for the selected repository. Trust the new Codex hooks through the native /hooks flow; no Stop hook or bypass is installed.\n");
  }
  process.stdout.write("Restart Claude Code/OpenCode to load session identity. Codex uses CODEX_THREAD_ID with MissionGo Skill 5.21+.\nEnable these Agents in the updated MissionGo Mac node. Plain Claude TUI needs an explicit local bridge handoff for Web replies. Existing model/provider configuration is retained.\n");
}
function isMain() {
  try { return Boolean(process.argv[1]) && realpathSync(process.argv[1]) === realpathSync(new URL(import.meta.url)); }
  catch { return false; }
}
if (isMain()) {
  main().catch(() => { process.stderr.write("MissionGo setup failed. Check the HTTPS origin, download access and local JSON settings; no provider configuration is sent.\n"); process.exitCode = 1; });
}
