// Builds the single file a machine downloads: the daemon and @missiongo/domain
// in one ESM script with no node_modules. The operator installs it with one curl
// command, so it must run with nothing beside it but Node itself.
import { build } from "esbuild";
import { chmodSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outfile = resolve(root, "dist/missiongo-node.mjs");

await build({
  entryPoints: [resolve(root, "src/cli.ts")],
  outfile,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  // Node builtins stay imports; everything else, the workspace domain package
  // included, is inlined.
  packages: "bundle",
  legalComments: "none",
  logLevel: "warning",
});

chmodSync(outfile, 0o755);
console.log(`bundled ${outfile}`);
