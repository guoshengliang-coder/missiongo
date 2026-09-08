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
// Three artifacts ship from this repository -- the web app, the Android app and
// the Android SDK -- and each used to decide on its own whether it needed
// publishing. The web app is deployed on every deploy whether or not it changed;
// the SDK is published when someone remembers; the Android app is rebuilt and
// republished every time, under a version name that has not moved in fifteen
// commits, so four different builds are all called 0.1.7.
//
// Answering "does this need publishing" needs one fact nobody was recording:
// the commit each artifact was last published from. released.json holds it, and
// this reads it.

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const ledger = JSON.parse(readFileSync(join(root, "released.json"), "utf8"));

const args = process.argv.slice(2);
const asJson = args.includes("--json");
const checkIndex = args.indexOf("--check");
const checkArtifact = checkIndex === -1 ? null : args[checkIndex + 1];
const recordIndex = args.indexOf("--record");
const recordArtifact = recordIndex === -1 ? null : args[recordIndex + 1];
const commitIndex = args.indexOf("--commit");
const recordCommit = commitIndex === -1 ? null : args[commitIndex + 1];

if (recordArtifact && !ledger.artifacts[recordArtifact]) {
  console.error(`Unknown artifact: ${recordArtifact}`);
  process.exit(2);
}

if (checkArtifact && !ledger.artifacts[checkArtifact]) {
  console.error(`Unknown artifact: ${checkArtifact}`);
  console.error(`Known: ${Object.keys(ledger.artifacts).join(", ")}`);
  process.exit(2);
}

const git = (...gitArgs) => execFileSync("git", gitArgs, { cwd: root, encoding: "utf8" }).trim();

function declaredVersion({ versionFile, versionProperty }) {
  const source = readFileSync(join(root, versionFile), "utf8");
  const match = new RegExp(`^${versionProperty}=(.+)$`, "m").exec(source);
  if (!match) throw new Error(`${versionProperty} is not declared in ${versionFile}`);
  return match[1].trim();
}

function stateOf(name) {
  const artifact = ledger.artifacts[name];
  const current = declaredVersion(artifact);

  // A commit that is no longer reachable -- a rebased or pruned branch -- would
  // make every comparison below meaningless, so say so rather than guess.
  let known = true;
  try {
    git("cat-file", "-e", `${artifact.commit}^{commit}`);
  } catch {
    known = false;
  }

  const changes = known
    ? git("log", "--oneline", `${artifact.commit}..HEAD`, "--", ...artifact.paths).split("\n").filter(Boolean)
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

if (recordArtifact) {
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

const deployedIndex = args.indexOf("--deployed");
const deployedUrl = deployedIndex === -1 ? null : args[deployedIndex + 1];

async function webState(origin) {
  // The web app carries no version number: it is published as a commit, and the
  // running deployment is the only place that records which one.
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
    behind = git("log", "--oneline", `${release}..HEAD`, "--", "apps/web", "services", "packages", "deploy")
      .split("\n").filter(Boolean);
  } catch {
    return { artifact: "web", publishedFrom: release, verdict: "unknown", note: "that commit is not in this repository" };
  }
  // No version line: the web app's identity is its commit, which the two lines
  // below already carry. Printing HEAD as a "version" would read as a release
  // number it does not have.
  return {
    artifact: "web",
    publishedFrom: release,
    commitsSince: behind.length,
    changed: behind.length > 0,
    bumped: false,
    verdict: behind.length > 0 ? "ready to publish" : "up to date",
  };
}

const names = checkArtifact ? [checkArtifact] : Object.keys(ledger.artifacts);
const states = names.map(stateOf);
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
