// Compatibility entry: install the current reviewed inventory, never patch installed tools.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const result = spawnSync(process.execPath, [fileURLToPath(new URL("./install-release-tools.mjs", import.meta.url)), ...process.argv.slice(2)], {stdio:"inherit"});
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
}
