#!/usr/bin/env node
import { build } from "esbuild";
import { chmodSync, copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const product = JSON.parse(readFileSync(join(root, "product.json"), "utf8"));
const output = join(root, "apps/node/dist/package");
mkdirSync(output, { recursive: true });
await build({ entryPoints: [join(root, "apps/node/src/cli.ts")], outfile: join(output, "cli.mjs"), bundle: true,
  platform: "node", format: "esm", target: "node22.13", sourcemap: false,
  alias: { "@missiongo/domain": join(root, "packages/domain/src/index.ts") },
  define: { NODE_VERSION: JSON.stringify(product.linuxNode.version), PRODUCT_NAME: JSON.stringify(product.name) },
});
chmodSync(join(output, "cli.mjs"), 0o755);
writeFileSync(join(output, "package.json"), JSON.stringify({ name: product.linuxNode.npmPackage, version: product.linuxNode.version,
  description: `${product.name} headless execution node`, type: "module", license: "Apache-2.0",
  engines: { node: ">=22.13.0" }, os: ["linux"], cpu: ["x64"],
  bin: { [product.linuxNode.command]: "./cli.mjs" }, files: ["cli.mjs", "README.md", "LICENSE"],
}, null, 2) + "\n");
copyFileSync(join(root, "apps/node/README.md"), join(output, "README.md"));
copyFileSync(join(root, "LICENSE"), join(output, "LICENSE"));
console.log(`Built ${product.linuxNode.npmPackage} ${product.linuxNode.version}`);
