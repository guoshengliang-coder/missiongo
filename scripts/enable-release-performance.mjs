#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { closeSync, existsSync, fsyncSync, linkSync, lstatSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const hash = value => createHash("sha256").update(value).digest("hex");
const anchor = '    run(preflight, root)\n    if action == "check":';
const hook = [
  '    # BEGIN RELEASE PERFORMANCE V1',
  '    performance_settings = json.loads((CONFIG / "release-coverage.json").read_text())',
  '    if not settings.get("backupsDir"):',
  '        raise ValueError("Install the release performance backup-directory setting first.")',
  '    smoke = root / "scripts/release-performance.mjs"',
  '    if not smoke.is_file():',
  '        raise ValueError("Candidate checkout lacks mandatory release performance support.")',
  '    run(["node", str(smoke), "--root", str(root), "--host", settings["host"], "--backups-dir", settings["backupsDir"], "--product-id", performance_settings["productId"]], root)',
  '    # END RELEASE PERFORMANCE V1',
].join("\n");
export function upgradePerformanceCoordinator(source) {
  for (const guard of ['"release-lock.py"', 'coverage_options(sys.argv[2:])', 'git(root, "fetch", "--quiet", "origin", "main")', '"HEAD must equal the latest origin/main."', '"release-ci.mjs"', 'preflight.extend(coverage_args)', '"MISSIONGO_RELEASE_CANDIDATES"']) {
    assert.ok(source.includes(guard), "Unsupported coordinator; existing guards preserved");
  }
  const after = '    run(preflight, root)\n' + hook + '\n    if action == "check":';
  if (source.includes("RELEASE PERFORMANCE")) {
    assert.equal(source.split(after).length, 2, "Unknown or partial performance installation");
    return source;
  }
  assert.equal(source.split(anchor).length, 2, "Unknown coordinator preflight boundary");
  return source.replace(anchor, after);
}
function regular(path) { assert.ok(!lstatSync(path).isSymbolicLink() && lstatSync(path).isFile(), "Expected regular installation file"); }
// Write failures affect only a private sibling; the live file is replaced
// after a complete write. Tests inject partial writes/rename failures here.
export function atomicInstallWrite(path, text, { mode = 0o600, write = writeFileSync, rename = renameSync } = {}) {
  const temporary = `${path}.performance-${process.pid}-${randomUUID()}`;
  // Open outside the cleanup block: EEXIST must preserve a file we do not own.
  const descriptor = openSync(temporary, "wx", mode);
  try {
    try { write(descriptor, text); fsyncSync(descriptor); }
    finally { closeSync(descriptor); }
    rename(temporary, path);
  } finally { rmSync(temporary, { force: true }); }
}
export function installPerformance({ home = homedir(), configHome = process.env.XDG_CONFIG_HOME ?? join(home, ".config"), backupsDir, install = false } = {}) {
  assert.ok(typeof backupsDir === "string" && backupsDir.startsWith("/") && !backupsDir.includes("\0"), "Provide the private backup directory");
  const config = join(configHome, "missiongo"), tools = join(config, "release-tools");
  const entry = join(home, ".local/bin/missiongo-release"), local = join(config, "release-local.json"), manifest = join(tools, "release-performance-installation.json");
  for (const path of [entry, local, join(config, "release-coverage.json")]) regular(path);
  for (const path of [manifest, `${entry}.before-release-performance`, `${local}.before-release-performance`]) if (existsSync(path)) regular(path);
  const before = readFileSync(entry, "utf8"), after = upgradePerformanceCoordinator(before);
  const settingsBefore = readFileSync(local, "utf8"), settings = JSON.parse(settingsBefore);
  if (settings.backupsDir && settings.backupsDir !== backupsDir) throw new Error("Existing backup target differs; preserved");
  settings.backupsDir = backupsDir;
  const settingsAfter = JSON.stringify(settings, null, 2) + "\n";
  execFileSync("python3", ["-c", "import ast,sys; ast.parse(sys.stdin.read())"], { input: after, stdio: "pipe" });
  if (install) {
    for (const [path, old] of [[entry, before], [local, settingsBefore]]) if (!existsSync(`${path}.before-release-performance`)) atomicInstallWrite(`${path}.before-release-performance`, old, { rename: linkSync });
    // Dependencies/settings become visible before the entry point, under the
    // same machine-wide lock as every existing installer and publication.
    atomicInstallWrite(local, settingsAfter);
    if (after !== before) {
      atomicInstallWrite(entry, after, { mode: lstatSync(entry).mode & 0o777 });
    }
    atomicInstallWrite(manifest, JSON.stringify({ version: 1, coordinatorSha256: hash(after) }) + "\n");
  }
  return { installed: install, changed: after !== before || settingsBefore !== settingsAfter, coordinatorSha256: hash(after) };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2), index = args.indexOf("--backups-dir"), directory = args[index + 1];
    assert.ok(index === 0 && args.length === 3 && ["--install", "--dry-run"].includes(args[2]), "Usage: enable-release-performance.mjs --backups-dir <private-directory> --dry-run|--install");
    const entry = fileURLToPath(import.meta.url);
    if (process.env.MISSIONGO_PERFORMANCE_INSTALL_ENTRY !== entry) {
      const lock = join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "missiongo/release-tools/release-lock.py");
      const result = spawnSync("python3", [lock, "--", process.execPath, entry, ...args], { stdio: "inherit", env: { ...process.env, MISSIONGO_PERFORMANCE_INSTALL_ENTRY: entry } });
      if (result.error) throw result.error;
      process.exit(result.status ?? 1);
    }
    console.log(JSON.stringify(installPerformance({ backupsDir: directory, install: args[2] === "--install" }), null, 2));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
