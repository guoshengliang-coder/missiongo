#!/usr/bin/env node
//
// Say which artifacts have changed since they were last published, and whether
// their version number still describes what is in them.
//
//   node scripts/release-state.mjs                  # report on everything
//   node scripts/release-state.mjs --check androidApp
//   node scripts/release-state.mjs --json
//   node scripts/release-state.mjs --record androidApp --commit <sha>
//   node scripts/release-state.mjs --deployed https://<host>   # include the web app
//
// Four artifacts ship from this repository -- the web app, the Android app, the
// Android SDK and the macOS client -- and each used to decide on its own whether it needed
// publishing. The web app is deployed on every deploy whether or not it changed;
// the SDK is published when someone remembers; the Android app is rebuilt and
// republished every time, under a version name that has not moved in fifteen
// commits, so four different builds are all called 0.1.7.
//
// Answering "does this need publishing" needs one fact nobody was recording:
// the commit each artifact was last published from. released.json holds it, and
// this reads it.

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const isMain = process.argv[1] === fileURLToPath(import.meta.url);
const ledger = JSON.parse(readFileSync(join(root, "released.json"), "utf8"));

const args = process.argv.slice(2);
const asJson = args.includes("--json");
const checkIndex = args.indexOf("--check");
const checkArtifact = checkIndex === -1 ? null : args[checkIndex + 1];
const recordIndex = args.indexOf("--record");
const recordArtifact = recordIndex === -1 ? null : args[recordIndex + 1];
const commitIndex = args.indexOf("--commit");
const recordCommit = commitIndex === -1 ? null : args[commitIndex + 1];

if (isMain && recordArtifact && !ledger.artifacts[recordArtifact]) {
  console.error(`Unknown artifact: ${recordArtifact}`);
  process.exit(2);
}

if (isMain && checkArtifact && !ledger.artifacts[checkArtifact]) {
  console.error(`Unknown artifact: ${checkArtifact}`);
  console.error(`Known: ${Object.keys(ledger.artifacts).join(", ")}`);
  process.exit(2);
}

const git = (worktree, ...gitArgs) => execFileSync("git", gitArgs, { cwd: worktree, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

function declaredVersion({ versionFile, versionProperty, versionJsonPath }, worktree = root) {
  const source = readFileSync(join(worktree, versionFile), "utf8");
  if (versionJsonPath) return versionJsonPath.split(".").reduce((value, key) => value[key], JSON.parse(source));
  const match = new RegExp(`^${versionProperty}=(.+)$`, "m").exec(source);
  if (!match) throw new Error(`${versionProperty} is not declared in ${versionFile}`);
  return match[1].trim();
}

// `origin` is what has actually merged; `worktree` holds the version declaration being judged.
function stateOf(name, origin = "HEAD", worktree = root, manifest = ledger, gitRoot = worktree) {
  const artifact = manifest.artifacts[name];
  const current = declaredVersion(artifact, worktree);
  if (artifact.commit === null && artifact.version === null) {
    return { artifact: name, publishedVersion: null, currentVersion: current, publishedFrom: null,
      commitsSince: 0, changed: true, bumped: true, verdict: "ready to publish", note: "No publication recorded yet" };
  }

  // A commit that is no longer reachable -- a rebased or pruned branch -- would
  // make every comparison below meaningless, so say so rather than guess.
  let known = true;
  try {
    git(gitRoot, "cat-file", "-e", `${artifact.commit}^{commit}`);
  } catch {
    known = false;
  }

  const changes = known
    ? git(gitRoot, "log", "--oneline", `${artifact.commit}..${origin}`, "--", ...artifact.paths).split("\n").filter(Boolean)
    : [];
  const changed = changes.length > 0;
  const bumped = current !== artifact.version;

  let verdict;
  if (!known) verdict = "unknown";
  else if (!changed) verdict = "up to date";
  else if (bumped) verdict = "ready to publish";
  else verdict = "needs a version bump";

  return {
    artifact: name,
    publishedVersion: artifact.version,
    currentVersion: current,
    publishedFrom: artifact.commit,
    commitsSince: changes.length,
    changed,
    bumped,
    verdict,
    ...(known ? {} : { note: `${artifact.commit.slice(0, 7)} is not in this repository any more` }),
  };
}

if (isMain && recordArtifact) {
  const artifact = ledger.artifacts[recordArtifact];
  const commit = recordCommit ?? execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  if (!/^[0-9a-f]{40}$/.test(commit)) {
    console.error(`Not a full commit sha: ${commit}`);
    process.exit(2);
  }
  const version = declaredVersion(artifact);
  artifact.version = version;
  artifact.commit = commit;
  writeFileSync(join(root, "released.json"), `${JSON.stringify(ledger, null, 2)}\n`);
  console.log(`Recorded ${recordArtifact} ${version} published from ${commit.slice(0, 7)}.`);
  console.log("released.json is tracked: commit it, or the next publish compares against the wrong commit.");
  process.exit(0);
}

// A patch bump needs a numeric version, and nothing else: major/minor belong to
// a human. There is no automated history for anything else to follow.
function bumpedPatch(version) {
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version) || !version.split(".").every((n) => Number.isSafeInteger(Number(n)))) {
    throw new Error(`${version} is not a numeric major.minor.patch version, so only its patch component could be raised.`);
  }
  const [major, minor, patch] = version.split(".").map(Number);
  return `${major}.${minor}.${patch + 1}`;
}

function raiseVersion({ versionFile, versionProperty, versionJsonPath }, text, next) {
  if (!versionJsonPath) {
    const line = new RegExp(`^${versionProperty}=.*$`, "m");
    if (!line.test(text)) throw new Error(`${versionProperty} is not declared in ${versionFile}`);
    return text.replace(line, `${versionProperty}=${next}`);
  }
  const product = JSON.parse(text);
  const [group, key] = versionJsonPath.split(".");
  if (key) product[group][key] = next; else product[group] = next;
  return `${JSON.stringify(product, null, 2)}\n`;
}

/**
 * One patch bump per release, not per PR. The baseline is origin/main, so a
 * version a single PR already raised is left alone, and an uncommitted raise in
 * this checkout is raised again rather than shipped over. Changing only the
 * declaration leaves the worktree still needing a deliberate commit.
 */
export function planPatchVersions(origin = "origin/main", worktree = root) {
  const manifest = JSON.parse(readFileSync(join(worktree, "released.json"), "utf8"));
  const mirror = mkdtempSync(join(tmpdir(), "release-bump-"));
  try {
    for (const file of new Set(Object.values(manifest.artifacts).map(artifact => artifact.versionFile))) {
      const copy = join(mirror, file);
      mkdirSync(dirname(copy), { recursive: true });
      writeFileSync(copy, git(worktree, "show", `${origin}:${file}`));
    }
    const bumps = [];
    for (const [name, artifact] of Object.entries(manifest.artifacts)) {
      if (stateOf(name, origin, mirror, manifest, worktree).verdict !== "needs a version bump") continue;
      const from = declaredVersion(artifact, mirror);
      if (declaredVersion(artifact, worktree) !== from) {
        throw new Error(`${artifact.versionFile} declares a different version in this worktree than in ${origin}; refresh it before bumping`);
      }
      bumps.push({ artifact: name, from, to: bumpedPatch(from), file: artifact.versionFile });
    }
    return bumps;
  } finally {
    rmSync(mirror, { recursive: true, force: true });
  }
}

export function bumpPatchVersions(origin = "origin/main", worktree = root) {
  if (worktree === root) git(root, "fetch", "--quiet", "origin", "main");
  const manifest = JSON.parse(readFileSync(join(worktree, "released.json"), "utf8"));
  const bumps = planPatchVersions(origin, worktree);
  // Prepare every write before changing any declaration.
  const writes = bumps.map(bump => {
    const path = join(worktree, bump.file);
    return { path, text: raiseVersion(manifest.artifacts[bump.artifact], readFileSync(path, "utf8"), bump.to) };
  });
  for (const { path, text } of writes) writeFileSync(path, text);
  return bumps;
}

if (isMain && args.includes("--bump-patch")) {
  const bumps = bumpPatchVersions();
  for (const { artifact, from, to, file } of bumps) console.log(`${artifact}: ${from} -> ${to} (${file})`);
  console.log(bumps.length
    ? "Version declarations raised. Commit them with client release notes before publishing."
    : "origin/main already declares a new version for every changed artifact; nothing to raise.");
  process.exit(0);
}

const deployedIndex = args.indexOf("--deployed");
const deployedUrl = deployedIndex === -1 ? null : args[deployedIndex + 1];

async function webState(origin) {
  // Fetch both server provenance and the actual frontend build manifest.
  let release;
  try {
    const response = await fetch(`${origin.replace(/\/$/, "")}/health`);
    release = (await response.json()).release;
  } catch {
    return { artifact: "web", verdict: "unreachable", note: `${origin} did not answer` };
  }
  if (!release || release === "unknown") {
    return { artifact: "web", verdict: "unknown", note: "the deployment does not report a commit" };
  }
  let behind = [];
  try {
    behind = git(root, "log", "--oneline", `${release}..HEAD`, "--", "apps/web", "services", "packages", "deploy")
      .split("\n").filter(Boolean);
  } catch {
    return { artifact: "web", publishedFrom: release, verdict: "unknown", note: "that commit is not in this repository" };
  }
  const current = JSON.parse(readFileSync(join(root, "product.json"), "utf8")).web.version;
  let publishedVersion;
  try {
    const response = await fetch(`${origin.replace(/\/$/, "")}/web-version.json`);
    if (!response.ok) throw new Error("Web manifest unavailable");
    const web = await response.json();
    if (web.sourceCommit !== release) throw new Error("Web/server source commits differ");
    publishedVersion = web.version;
  } catch {
    return { artifact: "web", currentVersion: current, publishedFrom: release, verdict: "unknown", note: "the public frontend version could not be verified (possibly a legacy release)" };
  }
  return {
    artifact: "web",
    currentVersion: current,
    publishedVersion,
    publishedFrom: release,
    commitsSince: behind.length,
    changed: behind.length > 0,
    bumped: current !== publishedVersion,
    verdict: behind.length > 0 ? "ready to publish" : "up to date",
  };
}

if (isMain) {
const names = checkArtifact ? [checkArtifact] : Object.keys(ledger.artifacts);
const states = names.map((name) => stateOf(name));
if (!checkArtifact && deployedUrl) states.unshift(await webState(deployedUrl));

if (asJson) {
  console.log(JSON.stringify(states, null, 2));
} else {
  for (const state of states) {
    const version = state.bumped
      ? `${state.publishedVersion} -> ${state.currentVersion}`
      : state.currentVersion;
    console.log(`${state.artifact}`);
    if (version) console.log(`  version         ${version}`);
    if (state.publishedFrom) console.log(`  published from  ${state.publishedFrom.slice(0, 7)}`);
    if (state.commitsSince !== undefined) console.log(`  changes since   ${state.commitsSince}`);
    console.log(`  verdict         ${state.verdict}`);
    if (state.note) console.log(`  note            ${state.note}`);
    console.log();
  }
}

if (!checkArtifact) process.exit(0);

const [state] = states;
if (state.verdict === "needs a version bump") {
  const artifact = ledger.artifacts[checkArtifact];
  console.error(`${checkArtifact} has changed since it was published as ${state.publishedVersion}, but the version has not moved.`);
  const many = state.commitsSince === 1 ? "one commit" : `${state.commitsSince} commits`;
  console.error(`Publishing now would put ${many}' worth of different code under a number that is already out there.`);
  console.error(`Raise ${artifact.versionProperty} in ${artifact.versionFile}, then publish.`);
  process.exit(1);
}
if (state.verdict === "unknown") {
  console.error(`${checkArtifact} records a commit this repository does not have, so nothing can be compared.`);
  process.exit(1);
}
// Republishing something unchanged is not harmless. The version code is a build
// timestamp and the build is not reproducible, so the second attempt produces a
// different file carrying the same version name -- which is the ambiguity this
// ledger exists to remove, arriving by another door.
if (state.verdict === "up to date") {
  console.error(`${checkArtifact} has not changed since ${state.publishedVersion} was published from ${state.publishedFrom.slice(0, 7)}.`);
  console.error("Rebuilding would put a second, different file under that same version name:");
  console.error("the version code is a build timestamp, and the build is not reproducible.");
  process.exit(1);
}
process.exit(0);

}
