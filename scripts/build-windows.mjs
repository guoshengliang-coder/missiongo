#!/usr/bin/env node
import { build } from "esbuild";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import sharp from "sharp";
import { releaseNotesFor, releaseNotesStart } from "./release-notes.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const product = JSON.parse(readFileSync(join(root, "product.json"), "utf8"));
const windows = product.windows.app;
const directory = join(root, windows.path, "dist");
const app = join(directory, "app"); const runtime = join(directory, "runtime");
mkdirSync(app, { recursive: true }); mkdirSync(runtime, { recursive: true });
const define = { PRODUCT_NAME: JSON.stringify(product.name), NODE_VERSION: JSON.stringify(windows.version),
  WINDOWS_UNSIGNED_RELEASE: JSON.stringify(windows.releaseSigning === "temporary-unsigned"), WINDOWS_APP_ID: JSON.stringify(windows.id), WINDOWS_PUBLISHER: JSON.stringify(process.env.MISSIONGO_WINDOWS_PUBLISHER ?? "") };
const alias = { "@missiongo/domain": join(root, "packages/domain/src/index.ts"), "@missiongo/contracts": join(root, "packages/contracts/src/index.ts") };
await build({ entryPoints: [join(root, windows.path, "src/main.ts")], outfile: join(app, "main.cjs"), bundle: true,
  platform: "node", target: "node22.13", format: "cjs", external: ["electron"], define, alias });
await build({ entryPoints: [join(root, windows.path, "src/preload.ts")], outfile: join(app, "preload.cjs"), bundle: true,
  platform: "node", target: "node22.13", format: "cjs", external: ["electron"] });
await build({ entryPoints: [join(root, windows.path, "src/worker.ts")], outfile: join(runtime, "worker.mjs"), bundle: true,
  platform: "node", target: "node22.13", format: "esm", define, alias,
  banner: { js: 'import { createRequire as __createRequire } from "node:module"; const require = __createRequire(import.meta.url);' } });
await build({ entryPoints: [join(root, windows.path, "src/renderer.tsx")], outfile: join(app, "renderer.js"), bundle: true,
  platform: "browser", target: "chrome140", format: "iife", jsx: "automatic", define, alias });
writeFileSync(join(app, "index.html"), readFileSync(join(root, windows.path, "index.html"), "utf8").replace("__PRODUCT_NAME__", product.name.replaceAll("&", "&amp;").replaceAll("<", "&lt;")));
copyFileSync(join(root, product.iconSource), join(app, "icon.svg"));
const icons = await Promise.all([32, 256].map((size) => sharp(join(root, product.iconSource)).resize(size, size).png().toBuffer()));
writeFileSync(join(app, "icon.png"), icons[0]);
const header = Buffer.alloc(6 + 16 * icons.length); header.writeUInt16LE(1, 2); header.writeUInt16LE(icons.length, 4);
let offset = header.length;
for (const [index, image] of icons.entries()) {
  const p = 6 + index * 16; header[p] = header[p + 1] = index === 0 ? 32 : 0;
  header.writeUInt16LE(1, p + 4); header.writeUInt16LE(32, p + 6); header.writeUInt32LE(image.length, p + 8); header.writeUInt32LE(offset, p + 12); offset += image.length;
}
writeFileSync(join(directory, "icon.ico"), Buffer.concat([header, ...icons]));
writeFileSync(join(app, "package.json"), JSON.stringify({ name: windows.packageName, productName: product.name, version: windows.version,
  description: product.taglines["zh-CN"], main: "main.cjs", license: "Apache-2.0", author: product.name }, null, 2));
// CI builds on Windows with the same pinned Node used for tests. The runtime
// is bundled; the installed app does not depend on the user's global Node.
const nodeFile = process.platform === "win32" ? "node.exe" : "node";
copyFileSync(process.execPath, join(runtime, nodeFile)); chmodSync(join(runtime, nodeFile), 0o755);
const files = Object.fromEntries([nodeFile, "worker.mjs"].map((name) => [name, createHash("sha256").update(readFileSync(join(runtime, name))).digest("hex")]));
writeFileSync(join(runtime, "runtime.json"), JSON.stringify({ nodeVersion: process.version, platform: process.platform, arch: process.arch, files }, null, 2));
if (process.argv.includes("--package")) {
  if (process.platform !== "win32" || process.arch !== "x64") throw new Error("Windows x64 packages must be built and tested on Windows x64");
  const unsignedRelease = process.argv.includes("--unsigned-release");
  if (unsignedRelease && windows.releaseSigning !== "temporary-unsigned") throw new Error("Temporary unsigned publication is not enabled in product.json");
  const unsigned = process.argv.includes("--unsigned") || unsignedRelease;
  if (unsigned) {
    process.env.CSC_IDENTITY_AUTO_DISCOVERY = "false";
    delete process.env.CSC_LINK; delete process.env.CSC_KEY_PASSWORD;
  }
  if (!unsigned && !process.env.MISSIONGO_WINDOWS_PUBLISHER) throw new Error("Set the local signing certificate and MISSIONGO_WINDOWS_PUBLISHER for production packages");
  const config = { appId: windows.id, productName: product.name, asar: true, npmRebuild: false,
    directories: { app, output: join(directory, "installer") }, files: ["**/*"],
    extraResources: [{ from: runtime, to: "runtime" }], forceCodeSigning: !unsigned,
    win: { target: [{ target: "nsis", arch: ["x64"] }], icon: join(directory, "icon.ico"), ...(unsigned ? {} : { publisherName: process.env.MISSIONGO_WINDOWS_PUBLISHER }) },
    nsis: { oneClick: false, perMachine: false, allowElevation: false, allowToChangeInstallationDirectory: true, deleteAppDataOnUninstall: false },
    artifactName: `${windows.artifactStem}-${windows.version}-x64-setup.exe`,
    publish: { provider: "generic", url: "https://updates.example.invalid/windows/" },
  };
  const path = join(directory, "builder.json"); writeFileSync(path, JSON.stringify(config, null, 2));
  execFileSync(process.execPath, [join(root, "node_modules/electron-builder/out/cli/cli.js"), "--config", path, "--win", "--publish", "never"], { cwd: root, stdio: "inherit" });
  if (!unsigned || unsignedRelease) {
    const filename = `${windows.artifactStem}-${windows.version}-x64-setup.exe`;
    const installer = join(directory, "installer", filename);
    const program = "$ErrorActionPreference='Stop'; [Console]::InputEncoding=[Text.UTF8Encoding]::new($false); [Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); $r=[Console]::In.ReadLine() | ConvertFrom-Json; $s=Get-AuthenticodeSignature -LiteralPath $r.path; if ($r.unsigned) { if ($s.Status -ne 'NotSigned') { exit 1 }; exit 0 }; if ($s.Status -ne 'Valid' -or $s.SignerCertificate.GetNameInfo('SimpleName',$false) -ne $r.publisher) { exit 1 }; $h=[Security.Cryptography.SHA256]::Create(); [Console]::Out.WriteLine(([BitConverter]::ToString($h.ComputeHash($s.SignerCertificate.RawData))).Replace('-','').ToLowerInvariant())";
    const certificateHash = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(program, "utf16le").toString("base64")], { input: JSON.stringify({ path: installer, unsigned, publisher: process.env.MISSIONGO_WINDOWS_PUBLISHER }) + "\n", encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], timeout: 30_000 }).trim();
    const sourceCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
    if (execFileSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" }).trim()) throw new Error("Publication manifest requires a clean source checkout");
    const bytes = readFileSync(installer);
    const ledger = JSON.parse(readFileSync(join(root,"released.json"),"utf8"));
    const releaseNotes = releaseNotesFor({artifact:"windowsApp",from:releaseNotesStart(root,"windowsApp",ledger),to:sourceCommit});
    writeFileSync(join(directory, "installer", "latest.json"), JSON.stringify({ version: windows.version, sourceCommit, filename,
      platform: "win32", arch: "x64", signed: !unsigned, ...(unsigned ? { releaseSigning: "temporary-unsigned" } : {}), certificateSha256: unsigned ? null : certificateHash, releaseNotes, size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") }, null, 2) + "\n");
  }
}
console.log(`Built ${product.name} Windows ${windows.version}; installer publication is a separate operation.`);
