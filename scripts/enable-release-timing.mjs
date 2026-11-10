#!/usr/bin/env node
import { installedBlock, upgradeReleaseStatusDeploy, withoutReleaseStatus } from "./enable-release-status.mjs";
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const scripts = dirname(fileURLToPath(import.meta.url));
const setup = '\n# BEGIN RELEASE TIMING\nsource "${MISSIONGO_RELEASE_TOOLS}/release-timing.sh"\nrelease_timing_start\nrelease_timing_stage preflight\n# END RELEASE TIMING\n';
const restart = ['echo "==> Rebuilding and restarting"', 'release_timing_stage build_and_restart\n'];
const conditional = (condition, phase) => `if ${condition}; then release_timing_stage ${phase}; else release_timing_skip ${phase}; fi\n`;
const tools = 'command -v git >/dev/null || { echo "git is required." >&2; exit 1; }\n';
// The setup block sits between the tool checks and whatever follows them.
const hooks = [
  ['echo "==> Pushing ${release}"', 'release_timing_stage upload\n'],
  ['# Carry the published SDK artifacts over', 'release_timing_stage inheritance\n'],
  ['# Preserve all historical Maven versions', 'release_timing_stage inheritance\n'],
  ['if [ "$skip_backup" -eq 1 ]; then', conditional('[ "$skip_backup" -eq 0 ]', 'backup')],
  ['echo "==> Pointing ${current_link} at the new release"', 'release_timing_stage activate\n'],
  ['  release_apk="${downloads_dir}/${apk_name}"', '  release_timing_stage publish_downloads\n'],
  ['if [ "$keep" -gt 0 ]; then', conditional('[ "$keep" -gt 0 ]', 'prune')],
  ['if [ "$verify" -eq 1 ]; then', conditional('[ "$verify" -eq 1 ]', 'security_verification')],
  ['if [ -n "$notice_origin" ]; then', conditional('[ -n "$notice_origin" ]', 'public_verification')],
];

// The restart is the status block's switch when there is one, so an entry without
// that block has it timed in front; a replayed timestamp can leave a copy behind.
const remote = 'remote "cd \'${target}/deploy\'';
const untimed = (text) => text.split(restart[1] + restart[0]).join(restart[0]).split(restart[1] + remote).join(restart[0] + remote);

function unlink(source) {
  let text = source;
  for (const [anchor, addition] of hooks) text = text.split(addition + anchor).join(anchor);
  return text;
}

// Hooks go in front of their anchors; a hook left behind makes two anchors and
// is refused, as is a setup block still there and a second one after the checks.
function install(source) {
  let result = unlink(untimed(source)), inheritance = 0;
  for (const [anchor, addition] of hooks) {
    if (anchor.startsWith("# Carry the published SDK") || anchor.startsWith("# Preserve all historical Maven")) {
      if (!result.includes(anchor)) continue;
      inheritance++;
    }
    if (result.split(anchor).length !== 2) throw new Error(`Unknown deploy version near ${anchor.slice(0, 65)}`);
    result = result.split(anchor).join(addition + anchor);
  }
  if (inheritance !== 1) throw new Error("Partial or unknown timing installation; preserved existing script");
  if (result.split(tools).length !== 2 || untimed(source).includes(tools + setup)) throw new Error("Partial timing installation; preserved existing deploy script");
  result = result.split(tools).join(tools + setup);
  return source.includes("deploy_finish() {") ? result : result.replace(restart[0], restart[1] + restart[0]);
}

// Removes what this installer wrote, leaving a stray stage for the caller to
// refuse. Without the setup block there are only hooks to take out.
function take(source) {
  if (source.split(restart[0]).length !== 2) throw new Error(`Unknown deploy version near ${restart[0].slice(0, 65)}`);
  if (!source.includes("# BEGIN RELEASE TIMING")) {
    if (source.includes(tools + setup)) throw new Error("Partial timing installation; preserved existing deploy script");
    const plain = unlink(source);
    // The restart copy is the status switch's, and is timed inside its block.
    if (!source.includes("# BEGIN RELEASE STATUS") ? plain.includes("release_timing_") : untimed(plain).includes("release_timing_")) throw new Error("Partial timing installation; preserved existing deploy script");
    return plain;
  }
  // The markers start and end a line, and the block holds the setup as written.
  if (!source.includes(setup)) throw new Error("Partial timing installation; preserved existing deploy script");
  return unlink(untimed(source.replace("\n" + setup, "\n")));
}

export function instrumentDeploy(source) {
  // A reviewed release-status block composes both EXIT handlers. Validate it
  // exactly, then retain all existing timing/unknown-trap checks on the rest. A
  // half-written block is reported as that rather than as an unknown switch.
  installedBlock(source);
  return source.includes("deploy_finish() {") ? upgradeReleaseStatusDeploy(instrumentDeploy(withoutReleaseStatus(source))) : instrumentTimed(source);
}

function instrumentTimed(source) {
  // Use the production script byte for byte once our insertions are removed;
  // reject partial installs and unknown anchors or traps.
  const unwrapped = take(source);
  if (source.includes("# BEGIN RELEASE TIMING") && unwrapped.includes("release_timing_")) throw new Error("Partial timing installation; preserved existing deploy script");
  if (/^\s*trap\b/m.test(unwrapped)) throw new Error("Existing deploy traps require review; preserved existing deploy script");
  const result = install(unwrapped);
  // An installation must come back unchanged; a partial one is refused, not repaired.
  if (source.includes("# BEGIN RELEASE TIMING") && result !== source) throw new Error("Partial or unknown timing installation; preserved existing script");
  return result;
}

const hash = text => createHash("sha256").update(text).digest("hex");
export function installTiming({ configHome = process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), install = false } = {}) {
  const directory = join(configHome, "missiongo/release-tools"), deploy = join(directory, "deploy.sh");
  const helper = join(directory, "release-timing.sh"), manifest = join(directory, "release-timing-installation.json");
  for (const path of [deploy, helper, manifest]) if (existsSync(path) && (!lstatSync(path).isFile() || lstatSync(path).isSymbolicLink())) throw new Error("Release timing files must be regular files; existing paths preserved");
  const before = readFileSync(deploy, "utf8");
  for (const guard of ["release-lock.py", "MISSIONGO_RELEASE_ROOT", 'node "$RELEASE_TOOLS/release-ci.mjs"', "check_release_coverage", 'reconcile_release_coverage "$release_receipt"']) {
    if (!before.includes(guard)) throw new Error("Install timing only on the guarded shared release entry point");
  }
  const after = instrumentDeploy(before), source = readFileSync(join(scripts, "release-timing.sh"), "utf8");
  const previous = existsSync(manifest) ? JSON.parse(readFileSync(manifest, "utf8")) : {};
  if (existsSync(helper) && readFileSync(helper, "utf8") !== source && previous.helper !== hash(readFileSync(helper, "utf8"))) throw new Error("Timing helper has unknown local changes; preserved");
  for (const text of [after, source]) execFileSync("bash", ["-n"], { input: text, stdio: "pipe" });
  if (install) {
    // Write the dependency before switching the deploy program, under the shared lock.
    if (before !== after && !existsSync(`${deploy}.before-release-timing`)) writeFileSync(`${deploy}.before-release-timing`, before, { flag: "wx", mode: 0o600 });
    if (!existsSync(helper) || readFileSync(helper, "utf8") !== source) writeFileSync(helper, source, { mode: 0o600 });
    if (before !== after) {
      const temporary = `${deploy}.timing-${process.pid}`;
      writeFileSync(temporary, after, { flag: "wx", mode: lstatSync(deploy).mode & 0o777 });
      renameSync(temporary, deploy);
    }
    writeFileSync(manifest, JSON.stringify({ version: 1, helper: hash(source) }) + "\n", { mode: 0o600 });
  }
  return { installed: install, changed: before !== after, deploySha256: hash(after), helperSha256: hash(source) };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    const args = process.argv.slice(2);
    if (args.some(arg => !["--install", "--dry-run"].includes(arg)) || (args.includes("--install") && args.includes("--dry-run"))) throw new Error("Usage: enable-release-timing.mjs [--dry-run|--install]");
    const entry = fileURLToPath(import.meta.url);
    if (process.env.MISSIONGO_TIMING_INSTALL_ENTRY !== entry) {
      const lock = join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "missiongo/release-tools/release-lock.py");
      const result = spawnSync("python3", [lock, "--", process.execPath, entry, ...args], { stdio: "inherit", env: { ...process.env, MISSIONGO_TIMING_INSTALL_ENTRY: entry } });
      if (result.error) throw result.error;
      process.exit(result.status ?? 1);
    }
    console.log(JSON.stringify(installTiming({ install: args.includes("--install") }), null, 2));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
