#!/usr/bin/env node
// Install the machine-wide release entry, lock and shared guards from this checkout.
// Private target values (release-local.json, coverage binding) stay outside Git and are never written here.
import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, linkSync, lstatSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { atomicInstallWrite } from "./enable-release-performance.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const TOOLS = [
  "release-lock.py", "release_coverage_options.py", "release-preflight.mjs", "release-receipt.mjs",
  "release-ci.mjs", "release-ci-wait.mjs", "linux-release-tools.mjs", "handover-evidence.mjs",
  "release-coverage.mjs", "release-candidates.mjs", "release-coverage-guard.sh", "release-status.sh", "release-timing.sh", "deploy.sh",
];
const ENTRY = "missiongo-release.py";
const DEFAULT_TOOLS = { ...Object.fromEntries(TOOLS.map(name => [name, name])),
  // Install the implementation, not the repo-relative forwarding module.
  "handover-evidence.mjs": "../apps/web/public/downloads/missiongo-handover.mjs", entry: ENTRY };

export function parseInstallArgs(args) {
  assert.ok(args.length === 0 || (args.length === 1 && args[0] === "--dry-run"), "Usage: install-release-tools.mjs [--dry-run]");
  return args.length === 1;
}

function checkSyntax(targets) {
  const text = name => targets.find(target => target.name === name)?.text;
  for (const name of ["release-lock.py", "release_coverage_options.py"]) {
    const source = text(name);
    if (source !== undefined) execFileSync("python3", ["-c", "import ast,sys; ast.parse(sys.stdin.read())"], { input: source, stdio: ["pipe", "pipe", "pipe"] });
  }
  const entry = text("entry");
  const deploy = text("deploy.sh");
  // Shell helpers that do work during deploy are sourced; syntax-check what deploy actually parses.
  for (const name of ["release-coverage-guard.sh", "release-status.sh", "release-timing.sh"]) {
    const shell = text(name);
    if (shell !== undefined) execFileSync("bash", ["-n"], { input: shell, stdio: ["pipe", "pipe", "pipe"] });
  }
  // The entry owns the lock, the CI checks run under it, and deploy.sh is executed
  // rather than sourced; a Python prefix only parses the module-level path setup.
  if (entry !== undefined) execFileSync("python3", ["-c", "import ast,sys; ast.parse('TOOLS = Path(__file__).resolve().parent\\n' + sys.stdin.read().split('\\n', 2)[2])"], { input: entry, stdio: ["pipe", "pipe", "pipe"] });
  // Every deploy line is a simple command, so appending a no-op keeps bash parsing it as a script without running it.
  if (deploy !== undefined) execFileSync("bash", ["-n"], { input: `${deploy}\n:;\n`, stdio: ["pipe", "pipe", "pipe"] });
}

export function install({ dryRun = false, home = homedir(), configHome = process.env.XDG_CONFIG_HOME ?? join(home, ".config"), source = root, commit = null, tools = DEFAULT_TOOLS } = {}) {
  assert.ok(typeof configHome === "string" && configHome.startsWith("/"), "Configuration root must be absolute");
  const config = join(configHome, "missiongo");
  const directory = join(config, "release-tools");
  const entryPath = join(home, ".local/bin/missiongo-release");
  const targets = Object.keys(tools).map(name => ({ name, path: name === "entry" ? entryPath : join(directory, name), text: readFileSync(join(source, "scripts", tools[name]), "utf8") }));
  const entry = targets.find(target => target.name === "entry")?.text;
  if (entry !== undefined) {
    // The entry owns the lock. deploy.sh runs it under that lock and, with the entry,
    // must name every helper it or an agent relies on: the entry calls the CI checks,
    // deploy the rest. release-ci-wait.mjs only serves agents and is never called by either.
    const deploy = targets.find(target => target.name === "deploy.sh")?.text ?? "";
    const references = (text, name) => new RegExp(`(?<![\\w.-])${name.replace(".", "\\.")}(?![\\w-])`).test(text);
    const helpers = Object.keys(tools).filter(name => !["deploy.sh", "entry", "release-lock.py", "release_coverage_options.py", "release-ci-wait.mjs"].includes(name));
    // A guard may import a helper rather than call it from the coordinator.
    // Follow only references reachable from the entry and deployment script.
    let reachable = entry + "\n" + deploy;
    const included = new Set();
    for (let changed = true; changed;) {
      changed = false;
      for (const target of targets) if (!included.has(target.name) && references(reachable, target.name)) {
        included.add(target.name); reachable += "\n" + target.text; changed = true;
      }
    }
    const missing = [references(entry, "release-lock.py") ? null : "release-lock.py",
      ...helpers.filter(name => !included.has(name))].filter(Boolean);
    if (missing.length) {
      throw new Error(`The release entry or deploy.sh no longer carries the shared lock, CI and coverage guards (missing: ${missing.join(", ")}); the installation was preserved`);
    }
  }
  // Files are only inspected and parsed while a partial set is a test fixture; nothing
  // is written until the real target paths are known to be plain regular files.
  for (const path of targets.map(target => target.path)) {
    if (existsSync(path) && (!lstatSync(path).isFile() || lstatSync(path).isSymbolicLink())) throw new Error(`${path} is not a regular file; the installation was preserved`);
  }
  checkSyntax(targets);
  const digest = value => createHash("sha256").update(value).digest("hex");
  const manifestPath = join(config, "release-tools-manifest.json");
  const previous = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, "utf8")) : {};
  // globalRulesIdentical came from the earlier split install (repo rules identical to the installed copies).
  const { sourceCommit: _commit, tools: _previousTools = {}, globalRulesIdentical: _globalRulesIdentical, ...rest } = previous;
  if (Object.keys(rest).length) throw new Error(`Unknown release-tools manifest fields: ${Object.keys(rest).join(", ")}`);
  const manifest = { sourceCommit: commit, tools: Object.fromEntries(targets.map(target => [target.name, digest(target.text)])) };
  // Compare what is installed now, not what the last run wrote, so a manually reverted tool is reinstalled.
  const changed = targets.filter(target => {
    if (!existsSync(manifestPath) || !existsSync(target.path)) return true;
    return digest(readFileSync(target.path, "utf8")) !== digest(target.text);
  });
  if (!dryRun) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    mkdirSync(dirname(entryPath), { recursive: true });
    for (const target of changed) {
      const backup = `${target.path}.before-release-tools-in-repo`;
      if (existsSync(target.path) && !existsSync(backup)) atomicInstallWrite(backup, readFileSync(target.path), { rename: linkSync });
      atomicInstallWrite(target.path, target.text, { mode: target.path.endsWith(".sh") || target.name === "entry" ? 0o700 : 0o600 });
    }
    atomicInstallWrite(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
  }
  return { installed: !dryRun, sourceCommit: commit, changed: changed.map(target => target.name) };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const dryRun = parseInstallArgs(process.argv.slice(2));
    const configHome = process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config");
    assert.ok(configHome.startsWith("/"), "Configuration root must be absolute");
    const entry = fileURLToPath(import.meta.url);
    if (process.env.MISSIONGO_TOOLS_INSTALL_ENTRY !== entry) {
      const result = spawnSync("python3", [join(root, "scripts/release-lock.py"), "--", process.execPath, entry, ...process.argv.slice(2)],
        { stdio: "inherit", env: { ...process.env, MISSIONGO_TOOLS_INSTALL_ENTRY: entry } });
      if (result.error) throw result.error;
      process.exit(result.status ?? 1);
    }
    const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
    execFileSync("git", ["merge-base", "--is-ancestor", "origin/main", "HEAD"], { cwd: root });
    if (execFileSync("git", ["status", "--porcelain", "--", "scripts", "apps/web/public/downloads/missiongo-handover.mjs"], { cwd: root, encoding: "utf8" }).trim()) {
      throw new Error("Release tools in scripts/ have uncommitted changes; commit them before installing");
    }
    for (const file of Object.values(DEFAULT_TOOLS)) execFileSync("git", ["cat-file", "-e", `${commit}:${relative(root, join(root, "scripts", file))}`], { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
    console.log(JSON.stringify(install({ dryRun, commit, configHome }), null, 2));
  } catch (error) { console.error(`Release tool installation failed: ${error.message}`); process.exitCode = 1; }
}

