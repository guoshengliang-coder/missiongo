#!/usr/bin/env node
// Install the machine-wide release entry, lock and shared guards from this checkout.
// Private target values (release-local.json, coverage binding) stay outside Git and are never written here.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const TOOLS = [
  "release-lock.py", "release_coverage_options.py", "release-preflight.mjs", "release-receipt.mjs",
  "release-ci.mjs", "release-ci-wait.mjs", "release-coverage-guard.sh", "release-status.sh", "release-timing.sh", "deploy.sh",
];
const ENTRY = "missiongo-release.py";

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

export function install({ dryRun = false, home = homedir(), source = root, commit = null, tools = TOOLS } = {}) {
  const config = join(home, ".config/missiongo");
  const directory = join(config, "release-tools");
  const entryPath = join(home, ".local/bin/missiongo-release");
  const targets = Object.keys(tools).map(name => ({ name, path: name === "entry" ? entryPath : join(directory, name), text: readFileSync(join(source, "scripts", tools[name]), "utf8") }));
  const entry = targets.find(target => target.name === "entry")?.text;
  if (entry !== undefined) {
    // The entry owns the lock. deploy.sh runs it under that lock and, with the entry,
    // must name every other helper: the entry calls the CI checks, deploy the rest.
    const deploy = targets.find(target => target.name === "deploy.sh")?.text ?? "";
    const references = (text, name) => new RegExp(`(?<![\\w.-])${name.replace(".", "\\.")}(?![\\w-])`).test(text);
    const helpers = Object.keys(tools).filter(name => !["deploy.sh", "entry", "release-lock.py", "release_coverage_options.py"].includes(name));
    const missing = [references(entry, "release-lock.py") ? null : "release-lock.py",
      ...helpers.filter(name => !references(entry, name) && !references(deploy, name))].filter(Boolean);
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
  const { sourceCommit: _commit, tools: previousTools = {}, globalRulesIdentical: _globalRulesIdentical, ...rest } = previous;
  if (Object.keys(rest).length) throw new Error(`Unknown release-tools manifest fields: ${Object.keys(rest).join(", ")}`);
  const manifest = { sourceCommit: commit, tools: Object.fromEntries(targets.map(target => [target.name, digest(target.text)])) };
  // Compare what is installed now, not what the last run wrote, so a manually reverted tool is reinstalled.
  const changed = targets.filter(target => {
    if (!existsSync(manifestPath) || !existsSync(target.path)) return true;
    return digest(readFileSync(target.path, "utf8")) !== previousTools[target.name];
  });
  if (!dryRun) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    mkdirSync(dirname(entryPath), { recursive: true });
    for (const target of changed) {
      const backup = `${target.path}.before-release-tools-in-repo`;
      if (existsSync(target.path) && !existsSync(backup)) writeFileSync(backup, readFileSync(target.path), { flag: "wx", mode: 0o600 });
      writeFileSync(target.path, target.text, { mode: target.path.endsWith(".sh") || target.name === "entry" ? 0o700 : 0o600 });
    }
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n", { mode: 0o600 });
  }
  return { installed: !dryRun, sourceCommit: commit, changed: changed.map(target => target.name) };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const dryRun = process.argv.includes("--dry-run");
    const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
    execFileSync("git", ["merge-base", "--is-ancestor", "origin/main", "HEAD"], { cwd: root });
    if (execFileSync("git", ["status", "--porcelain", "--", "scripts"], { cwd: root, encoding: "utf8" }).trim()) {
      throw new Error("Release tools in scripts/ have uncommitted changes; commit them before installing");
    }
    for (const file of [...TOOLS, ENTRY]) execFileSync("git", ["cat-file", "-e", `${commit}:scripts/${file}`], { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
    const tools = { ...Object.fromEntries(TOOLS.map(name => [name, name])), entry: ENTRY };
    console.log(JSON.stringify(install({ dryRun, commit, tools }), null, 2));
  } catch (error) { console.error(`Release tool installation failed: ${error.message}`); process.exitCode = 1; }
}

