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
export const priorDeploySwitch = `release_timing_stage build_and_restart
echo "==> Rebuilding and restarting"
# sudo drops the environment, so the value is handed over explicitly. The
# server reports it on /health, which is how a running deployment names itself.
remote "cd '\${target}/deploy' && sudo env MISSIONGO_RELEASE='\${commit}' docker compose --env-file '\${env_file}' up -d --build"`;
export function withoutReleaseStatus(source) {
  if (!source.includes(releaseStatusBlock)) throw new Error("Partial or different release status installation; preserved existing tools.");
  return source.replace(releaseStatusBlock, priorDeploySwitch);
}
export function upgradeReleaseStatusDeploy(source) {
  if (!source.includes("check_release_coverage") || !source.includes("release_timing_start")) throw new Error("Install existing coverage and timing guards first.");
  if (source.includes("# BEGIN RELEASE STATUS")) {
    if (source.match(/# BEGIN RELEASE STATUS[\s\S]*?# END RELEASE STATUS/g)?.length !== 1
      || !source.includes(releaseStatusBlock)) throw new Error("Partial or different release status installation; preserved existing tools.");
    return source;
  }
  const before = /release_timing_stage build_and_restart\necho "==> Rebuilding and restarting"[\s\S]*?remote "cd '\$\{target\}\/deploy' && sudo env MISSIONGO_RELEASE='\$\{commit\}' docker compose --env-file '\$\{env_file\}' up -d --build"/g;
  if ([...source.matchAll(before)].length !== 1) throw new Error("Unknown deploy switch; preserved existing tools.");
  const result = source.replace(before, releaseStatusBlock);
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
