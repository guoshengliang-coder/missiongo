#!/usr/bin/env node
// Offline, narrowly scoped upgrade of the shared guarded deploy entry point.
import { installTiming, instrumentDeploy } from "./enable-release-timing.mjs";
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, renameSync, lstatSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const releaseStatusBlock = readFileSync(join(root, "scripts/deploy.sh"), "utf8").match(/# BEGIN RELEASE STATUS[\s\S]*?# END RELEASE STATUS/)[0];
export const previousReleaseStatusBlock = readFileSync(join(root, "scripts/release-status-v1.block.sh"), "utf8").trimEnd();
export const priorDeploySwitch = `release_timing_stage build_and_restart
echo "==> Rebuilding and restarting"
# sudo drops the environment, so the value is handed over explicitly. The
# server reports it on /health, which is how a running deployment names itself.
remote "cd '\${target}/deploy' && sudo env MISSIONGO_RELEASE='\${commit}' docker compose --env-file '\${env_file}' up -d --no-build --wait --wait-timeout 180"`;
const begin = "# BEGIN RELEASE STATUS", end = "# END RELEASE STATUS";
const different = "Partial or different release status installation; preserved existing tools.";
// The two markers of one installed block, refused when there is only one of them,
// repeated, nested or belonging to no version this knows.
export function installedBlock(source) {
  const cut = source.indexOf(begin);
  if (cut < 0) {
    if (source.includes(end)) throw new Error(different);
    return null;
  }
  const close = source.indexOf(end, cut + begin.length);
  const block = close < 0 ? null : source.slice(cut, close + end.length);
  const known = [releaseStatusBlock, previousReleaseStatusBlock].find(known => known === block);
  if (!known || source.split(begin).length !== 2 || source.split(end).length !== 2) throw new Error(different);
  return known;
}
export function withoutReleaseStatus(source) {
  const known = installedBlock(source);
  // Both read back as the switch did before: one was running without timing, the
  // other has its restart inside the block.
  return known ? source.replace(known, priorDeploySwitch) : source;
}
export function upgradeReleaseStatusDeploy(source) {
  if (!source.includes("check_release_coverage") || !source.includes("release_timing_start")) throw new Error("Install existing coverage and timing guards first.");
  const known = installedBlock(source);
  if (known) return known === previousReleaseStatusBlock ? source.replace(known, releaseStatusBlock) : source;
  // The restart is matched as the lines it actually occupy: its echo, the
  // free-text comment and the line that starts the containers. The timed entry
  // carries one more line in front, the stage that was removed from this one.
  const restart = 'echo "==> Rebuilding and restarting"\n', runs = ["up -d --build", "up -d --no-build --wait --wait-timeout 180"];
  if (source.split(restart).length !== 2) throw new Error("Unknown deploy switch; preserved existing tools.");
  const position = source.indexOf(restart) + restart.length, lines = source.slice(position).split("\n");
  const run = line => line.startsWith("remote ") && runs.some(command => line.includes(" " + command + '"'));
  const end = lines.findIndex(run);
  if (end < 0 || lines.slice(0, end).some(line => !line.startsWith("#"))) throw new Error("Unknown deploy switch; preserved existing tools.");
  // The blank line the old switch may have had after it belongs to the code that
  // follows; the block takes the statement's place and keeps that separation.
  const stop = position + lines.slice(0, end + 1).join("\n").length + 1, between = lines[end + 1] === "" ? "\n" : "\n\n", stage = "release_timing_stage build_and_restart\n";
  const from = source.slice(0, source.indexOf(restart)).endsWith(stage) ? source.indexOf(restart) - stage.length : source.indexOf(restart);
  const result = source.slice(0, from) + releaseStatusBlock + between + source.slice(Math.min(stop, source.length));
  execFileSync("bash", ["-n"], { input: result });
  return result;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const config = join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "missiongo");
    const tools = join(config, "release-tools");
    const apply = process.argv.slice(2).includes("--apply");
    if (process.argv.slice(2).some(arg => arg !== "--apply")) throw new Error("Usage: enable-release-status.mjs [--apply]");
    if (apply && process.env.MISSIONGO_RELEASE_STATUS_INSTALL_LOCK !== "held") {
      const child = spawnSync("python3", [join(tools, "release-lock.py"), "--", process.execPath, fileURLToPath(import.meta.url), "--apply"], {
        stdio: "inherit", env: { ...process.env, MISSIONGO_RELEASE_STATUS_INSTALL_LOCK: "held" },
      });
      process.exit(child.status ?? 1);
    }
    const path = join(tools, "deploy.sh");
    if (!lstatSync(path).isFile() || lstatSync(path).isSymbolicLink()) throw new Error("Expected a regular shared deploy script.");
    // Validate the complete composed upgrade before writing either dependency.
    // Older shared entries may have coverage but no timing hooks yet.
    installTiming({ install: false });
    const before = readFileSync(path, "utf8"), after = upgradeReleaseStatusDeploy(instrumentDeploy(before));
    if (apply) installTiming({ install: true });
    if (apply && before !== after) {
      writeFileSync(`${path}.before-release-status-${Date.now()}`, before, { mode: 0o700, flag: "wx" });
      writeFileSync(`${path}.release-status-next`, after, { mode: 0o700, flag: "wx" });
      renameSync(`${path}.release-status-next`, path);
    }
    console.log(before === after ? "Release status integration already installed." : apply ? "Installed guarded release status integration." : "Reviewed patch is ready; --apply installs it under the shared release lock.");
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
