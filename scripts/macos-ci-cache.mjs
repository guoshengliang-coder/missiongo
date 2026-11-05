#!/usr/bin/env node
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, lstatSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const stateFile = "apps/macos/.build/ci-input-mtimes.json";
const hash = value => createHash("sha256").update(value).digest("hex");

export function inputs(root) {
  return execFileSync("git", ["ls-files", "-z", "--", "apps/macos/", "product.json", "scripts/build-macos-app.sh", "scripts/sign-macos-app.sh"], { cwd: root, encoding: "utf8" })
    .split("\0").filter(Boolean).sort().filter(file => existsSync(resolve(root, file)) && lstatSync(resolve(root, file)).isFile())
    .map(file => {
      const path = resolve(root, file), stat = lstatSync(path);
      return { file, hash: hash(readFileSync(path)), mode: stat.mode & 0o777, mtime: stat.mtimeMs };
    });
}

export function cacheIdentity(files, toolchain) {
  // Build products contain absolute paths. Different checkouts/toolchains must
  // never share the incremental build database, even on the same runner label.
  const prefix = `macos-build-v1-${hash(JSON.stringify(toolchain))}-`;
  return { prefix, key: prefix + hash(JSON.stringify(files.map(({ file, hash, mode }) => ({ file, hash, mode })))) };
}

export function snapshot(root) {
  const path = resolve(root, stateFile);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ version: 1, files: inputs(root) }) + "\n");
}

export function restoreInputTimes(root) {
  const path = resolve(root, stateFile);
  let state;
  try { state = JSON.parse(readFileSync(path, "utf8")); } catch { /* cold or damaged cache */ }
  const previous = new Map((state?.version === 1 && Array.isArray(state.files) ? state.files : [])
    .filter(row => row && typeof row.file === "string").map(row => [row.file, row]));
  let restored = 0;
  // Only current tracked inputs can be touched. Never follow paths supplied by
  // the cache, and never give changed source the timestamp of an old object.
  for (const row of inputs(root)) {
    const saved = previous.get(row.file);
    const unchanged = saved?.hash === row.hash && saved.mode === row.mode && Number.isFinite(saved.mtime) && saved.mtime >= 0;
    const file = resolve(root, row.file);
    // Normalize even cold inputs before compiling: whole seconds survive the
    // filesystem/tar/Node timestamp round trip without sub-millisecond drift.
    utimesSync(file, lstatSync(file).atime, new Date(unchanged ? saved.mtime : Math.floor(Date.now() / 1000) * 1000));
    if (unchanged) restored++;
  }
  return restored;
}

function main() {
  const root = process.cwd();
  if (process.argv[2] === "snapshot") snapshot(root);
  else if (process.argv[2] === "restore") console.log(`Restored timestamps for ${restoreInputTimes(root)} unchanged build inputs`);
  else if (process.argv[2] === "key") {
    const run = (command, args) => execFileSync(command, args, { encoding: "utf8" }).trim();
    const identity = cacheIdentity(inputs(root), {
      checkout: root, architecture: run("uname", ["-m"]), os: run("sw_vers", ["-productVersion"]),
      swift: run("swift", ["--version"]), xcode: run("xcodebuild", ["-version"]),
      sdk: run("xcrun", ["--sdk", "macosx", "--show-sdk-build-version"]),
      developer: run("xcode-select", ["-p"]), configurations: ["debug", "release-arm64-x86_64"],
    });
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `key=${identity.key}\nprefix=${identity.prefix}\n`);
    console.log(JSON.stringify(identity));
  } else throw new Error("Expected key, restore or snapshot");
}
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) main();
