#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { checkLinuxFiles } from "./linux-release-tools.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
if (!process.env.MISSIONGO_COORDINATOR_ENTRY || !process.env.MISSIONGO_RELEASE_LOCK_FD) throw new Error("Use the shared missiongo-release coordinator");
if (git("status", "--porcelain")) throw new Error("Publication requires a clean worktree");
git("merge-base", "--is-ancestor", "origin/main", "HEAD");
execFileSync("node", ["scripts/release-state.mjs", "--check", "linuxCli"], { cwd: root, stdio: "inherit" });
execFileSync("node", ["scripts/build-node.mjs"], { cwd: root, stdio: "inherit" });
const downloads = join(root, "apps/web/public/downloads");
mkdirSync(downloads, { recursive: true });
const scratch = mkdtempSync(join(tmpdir(), "missiongo-linux-publication-"));
try {
  const product = JSON.parse(readFileSync(join(root, "product.json"), "utf8"));
  const packed = JSON.parse(execFileSync("npm", ["pack", join(root, "apps/node/dist/package"), "--json", "--ignore-scripts", "--pack-destination", scratch], { cwd: root, encoding: "utf8" }));
  const bytes = readFileSync(join(scratch, packed[0].filename));
  const sourceCommit = git("rev-parse", "HEAD");
  const manifest = { version: product.linuxNode.version, sourceCommit, sha256: createHash("sha256").update(bytes).digest("hex"),
    size: bytes.length, node: ">=22.13.0", os: "linux", arch: "x64", package: product.linuxNode.npmPackage, publishedAt: new Date().toISOString() };
  copyFileSync(join(scratch, packed[0].filename), join(downloads, "missiongo-linux-latest.tgz"));
  writeFileSync(join(downloads, "missiongo-linux-latest.json"), JSON.stringify(manifest, null, 2) + "\n");
  writeFileSync(join(downloads, "missiongo-linux-latest.release"), `version=${manifest.version}\nsource_commit=${sourceCommit}\nsource_dirty=false\nsha256=${manifest.sha256}\n`);
  const ledger = JSON.parse(readFileSync(join(root, "released.json"), "utf8"));
  ledger.artifacts.linuxCli = { ...ledger.artifacts.linuxCli, version: manifest.version, commit: sourceCommit, sha256: manifest.sha256 };
  checkLinuxFiles(root, ledger.artifacts.linuxCli);
  writeFileSync(join(root, "released.json"), JSON.stringify(ledger, null, 2) + "\n");
  console.log(`Staged Linux CLI ${manifest.version}. Commit released.json; public deployment is a separate step.`);
} finally { rmSync(scratch, { recursive: true, force: true }); }
