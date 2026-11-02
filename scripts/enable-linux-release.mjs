#!/usr/bin/env node
// Narrow, idempotent upgrade of the existing machine-wide release coordinator.
// It preserves installed deployment, signing, locking and CI guards. No build
// or deployment is performed. Unknown installed versions are rejected.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
function replaceOnce(source, before, after) {
  if (source.split(before).length !== 2) throw new Error(`Unknown installed release-tool version: expected unique ${before.slice(0, 80)}`);
  return source.replace(before, after);
}
export function upgradeReleaseTools(files, fragment) {
  const result = { ...files };
  if (!result.coordinator.includes('"publish:linux"')) {
    result.coordinator = replaceOnce(result.coordinator, '"publish:android-sdk"}', '"publish:android-sdk", "publish:linux"}');
    result.coordinator = replaceOnce(result.coordinator, '"publish:android-sdk": "androidSdk"}', '"publish:android-sdk": "androidSdk", "publish:linux": "linuxCli"}');
    result.coordinator = replaceOnce(result.coordinator, 'if artifact != "androidSdk":', 'if artifact not in {"androidSdk", "linuxCli"}:');
  }
  const loader = '\n// Linux support uses the current worktree, while legacy worktrees keep their original behavior.\nconst linuxHelperPath = process.cwd() + "/scripts/linux-release-tools.mjs";\nconst linuxReleaseTools = (await import("node:fs")).existsSync(linuxHelperPath) ? await import((await import("node:url")).pathToFileURL(linuxHelperPath).href) : null;\n';
  if (!result.preflight.includes("linuxReleaseTools")) {
    result.preflight = replaceOnce(result.preflight, 'const SHA =', loader + '\nconst SHA =');
    result.preflight = replaceOnce(result.preflight, '  return result;\n}', '  if (ledger.linuxCli && !linuxReleaseTools) throw new Error("Current checkout lacks Linux release verification");\n  linuxReleaseTools?.checkLinuxArtifacts(root, live?.linuxCli);\n  return result;\n}');
  }
  if (!result.receipt.includes("linuxReleaseTools")) {
    result.receipt = replaceOnce(result.receipt, 'const SHA =', loader + '\nconst SHA =');
    result.receipt = replaceOnce(result.receipt, 'return { web, androidApp, androidSdk, macosApp };', 'return { web, androidApp, androidSdk, macosApp, linuxCli: linuxReleaseTools?.readLinuxSnapshot({ host, currentLink }) ?? null };');
    result.receipt = replaceOnce(result.receipt, '  return { checks, errors };', '  if (linuxReleaseTools) await check("linuxCli", () => linuxReleaseTools.verifyLinuxPublic(origin, after.linuxCli));\n  return { checks, errors };');
    result.receipt = replaceOnce(result.receipt, '["web", "androidApp", "androidSdk", "macosApp"]', '["web", "androidApp", "androidSdk", "macosApp", "linuxCli"]');
  }
  if (!result.deploy.includes("BEGIN LINUX CLI INHERITANCE")) result.deploy = replaceOnce(result.deploy,
    '# The Android update manifest rides with the APK that is actually being served,', fragment + '\n# The Android update manifest rides with the APK that is actually being served,');
  if (!result.handover.includes('artifact === "linuxCli"')) result.handover = replaceOnce(result.handover,
    '    if (artifact === "androidSdk"', '    if (artifact === "linuxCli" && DIGEST.test(current.sha256 ?? "")) proof = {kind:"sha256",url:new URL("/downloads/missiongo-linux-latest.tgz",base).href,sha256:current.sha256};\n    if (artifact === "androidSdk"');
  return result;
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const directory = join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "missiongo/release-tools");
  const paths = { coordinator: join(homedir(), ".local/bin/missiongo-release"), preflight: join(directory, "release-preflight.mjs"),
    receipt: join(directory, "release-receipt.mjs"), deploy: join(directory, "deploy.sh"), handover: join(directory, "handover-evidence.mjs") };
  const before = Object.fromEntries(Object.entries(paths).map(([key, path]) => [key, readFileSync(path, "utf8")]));
  const fragment = readFileSync(join(root, "scripts/deploy.sh"), "utf8").match(/# BEGIN LINUX CLI INHERITANCE[\s\S]+?# END LINUX CLI INHERITANCE/)?.[0];
  if (!fragment) throw new Error("Linux deployment fragment is missing");
  const after = upgradeReleaseTools(before, fragment);
  for (const [key, path] of Object.entries(paths)) {
    if (before[key] === after[key]) continue;
    const backup = `${path}.before-linux-cli`;
    if (!existsSync(backup)) writeFileSync(backup, before[key], { flag: "wx", mode: 0o600 });
    writeFileSync(path, after[key]);
  }
  console.log("Linux support installed in the shared coordinator; no build or deployment performed.");
}
