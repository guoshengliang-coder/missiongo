#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
export const WEB_RELEASE_PATHS = ["apps/web", "packages", "deploy", "product.json", "package-lock.json"];
export function requiresWebVersion(files) {
  return files.some(file => !/(?:^|\/)(?:tests?|__tests__)\/|\.test\.|\.spec\.|\.md$/i.test(file));
}
export function versionParts(value) {
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value ?? "")) throw new Error("Web version must be a numeric major.minor.patch version.");
  const parts = value.split(".").map(Number);
  if (!parts.every(Number.isSafeInteger)) throw new Error("Web version components must be safe integers.");
  return parts;
}
export function nextVersion(version, part) {
  const parts = versionParts(version);
  const index = ["major", "minor", "patch"].indexOf(part);
  if (index < 0) throw new Error("Choose major, minor or patch.");
  parts[index] += 1;
  for (let i = index + 1; i < parts.length; i++) parts[i] = 0;
  const next = parts.join(".");
  versionParts(next);
  return next;
}
export function assertWebRelease(current, previous, changed) {
  const next = versionParts(current);
  // The first rollout introduces semantic versions; older releases identify by SHA.
  if (!previous || /^[0-9a-f]{40}$/.test(previous)) return;
  const old = versionParts(previous);
  const first = next.findIndex((part, i) => part !== old[i]);
  if (first >= 0 && next[first] < old[first]) throw new Error(`Web version ${current} is lower than published ${previous}.`);
  if (changed && first === -1) throw new Error(`Web changed since ${previous}. Run npm run version:web -- patch (or minor/major), commit, then deploy.`);
}
function main() {
  const args = process.argv.slice(2);
  const path = new URL("../product.json", import.meta.url);
  const product = JSON.parse(readFileSync(path, "utf8"));
  if (args[0] === "bump") {
    product.web.version = nextVersion(product.web.version, args[1]);
    writeFileSync(path, `${JSON.stringify(product, null, 2)}\n`);
    console.log(`Web ${product.web.version}; commit product.json before deploying.`);
  } else if (args[0] === "check") {
    const index = args.indexOf("--previous-json");
    if (index < 0 || !args[index + 1]) throw new Error("check requires --previous-json <snapshot>");
    const snapshot = JSON.parse(args[index + 1]);
    if (!("web" in snapshot)) throw new Error("Previous release snapshot is missing Web state.");
    const previous = snapshot.web;
    let changed = true;
    if (previous && !/^[0-9a-f]{40}$/.test(previous.commit ?? "")) throw new Error("Previous Web release has no valid source commit.");
    if (previous?.commit) {
      execFileSync("git", ["cat-file", "-e", `${previous.commit}^{commit}`], { cwd: root, stdio: "pipe" });
      const files = execFileSync("git", ["diff", "--name-only", previous.commit, "--", ...WEB_RELEASE_PATHS], { cwd: root, encoding: "utf8" }).trim().split("\n").filter(Boolean);
      changed = requiresWebVersion(files);
      // A semantic-version deployment must not silently become a legacy one
      // when its RELEASE metadata is missing the version.
      const previousProduct = JSON.parse(execFileSync("git", ["show", `${previous.commit}:product.json`], { cwd: root, encoding: "utf8" }));
      if (previousProduct.web?.version && previous.version !== previousProduct.web.version) throw new Error("Previous Web provenance does not match its declared version.");
    }
    assertWebRelease(product.web.version, previous?.version, changed);
    console.log(`Web ${product.web.version}: release version check passed.`);
  } else throw new Error("Usage: web-version.mjs bump major|minor|patch OR check --previous-json <snapshot>");
}
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
