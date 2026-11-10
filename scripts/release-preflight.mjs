#!/usr/bin/env node
// Check the actual files that will be shipped, including ignored build output.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { resolve, join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { properties, readSnapshot } from "./release-receipt.mjs";


// Linux support uses the current worktree, while legacy worktrees keep their original behavior.
const linuxHelperPath = process.cwd() + "/scripts/linux-release-tools.mjs";
const linuxReleaseTools = (await import("node:fs")).existsSync(linuxHelperPath) ? await import((await import("node:url")).pathToFileURL(linuxHelperPath).href) : null;

// Plan-mode version checks reuse the repository's own web-version gate so the
// deploy-time rule and the plan-time gap can never drift apart.
const webVersionHelperPath = process.cwd() + "/scripts/web-version.mjs";
const webVersionTools = existsSync(webVersionHelperPath) ? await import(pathToFileURL(webVersionHelperPath).href) : null;

// Plan-time hint: the same patch bump `npm run release:bump-patch` would raise.
const releaseStateHelperPath = process.cwd() + "/scripts/release-state.mjs";
const releaseStateTools = existsSync(releaseStateHelperPath) ? await import(pathToFileURL(releaseStateHelperPath).href) : null;

import { coverageForCheckout, assertReleaseCoverage } from "./release-coverage.mjs";

const SHA = /^[a-f0-9]{40}$/;
const VERSION = /^[0-9]+(?:\.[0-9]+)*$/;
const git = (root, ...args) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const digest = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");
const present = (path) => existsSync(path) && statSync(path).isFile() && statSync(path).size > 0;

export function checkBuild(root, artifact, { fetch = true } = {}) {
  if (git(root, "status", "--porcelain")) throw new Error("Release build requires a clean worktree; preserve and commit existing changes first.");
  const common = resolve(root, git(root, "rev-parse", "--git-common-dir"));
  if (resolve(root) === dirname(common)) throw new Error("Release builds must use an isolated worktree, not the primary checkout.");
  if (fetch) git(root, "fetch", "--quiet", "origin", "main");
  git(root, "merge-base", "--is-ancestor", "origin/main", "HEAD");
  const mine = JSON.parse(readFileSync(join(root, "released.json"), "utf8")).artifacts?.[artifact];
  const theirs = JSON.parse(git(root, "show", "origin/main:released.json")).artifacts?.[artifact];
  if (!mine || !theirs || mine.version !== theirs.version || mine.commit !== theirs.commit) {
    throw new Error(`${artifact}: release ledger differs from origin/main; synchronize before building.`);
  }
}

export function checkArtifacts(root, live, { publishApk = true } = {}) {
  const ledger = JSON.parse(readFileSync(join(root, "released.json"), "utf8")).artifacts;
  const downloads = join(root, "apps/web/public/downloads");
  const result = [];
  for (const [key, stem, extension, enabled] of [
    ["androidApp", "missiongo-android-latest", "apk", publishApk],
    ["macosApp", "missiongo-macos-latest", "zip", true],
  ]) {
    const record = ledger?.[key];
    if (!record || !VERSION.test(record.version) || !SHA.test(record.commit)) throw new Error(`${key}: invalid release ledger.`);
    const binary = join(downloads, `${stem}.${extension}`);
    if (enabled && present(binary)) {
      const metadata = properties(readFileSync(join(downloads, `${stem}.release`), "utf8"));
      const manifest = JSON.parse(readFileSync(join(downloads, `${stem}.json`), "utf8"));
      const version = key === "androidApp" ? metadata.version_name : metadata.version;
      if (version !== record.version || metadata.source_commit !== record.commit || metadata.source_dirty !== "false") {
        throw new Error(`${key}: local build version/source does not match released.json; use the worktree that built this release.`);
      }
      git(root, "merge-base", "--is-ancestor", record.commit, "HEAD");
      const sha256 = digest(binary);
      if (record.sha256 && record.sha256 !== sha256) throw new Error(`${key}: binary differs from the recorded immutable build.`);
      if (sha256 !== metadata.sha256 || sha256 !== manifest.sha256 || manifest.version !== version || manifest.size !== statSync(binary).size) {
        throw new Error(`${key}: binary, metadata and update manifest disagree.`);
      }
      if (key === "androidApp" && (String(manifest.versionCode) !== metadata.version_code || !/^[1-9][0-9]*$/.test(metadata.version_code ?? ""))) {
        throw new Error("androidApp: versionCode disagrees with build metadata.");
      }
      result.push({ artifact: key, mode: "local", version, sha256, sourceCommit: record.commit });
    } else {
      const inherited = live?.[key];
      if (!inherited || inherited.version !== record.version || inherited.sourceCommit && inherited.sourceCommit !== record.commit || !/^[a-f0-9]{64}$/.test(inherited.sha256 ?? "") || record.sha256 && record.sha256 !== inherited.sha256) {
        throw new Error(`${key}: no matching local build or verified live build for ${record.version}; deployment would inherit the wrong release.`);
      }
      result.push({ artifact: key, mode: "inherit", ...inherited, sourceVerified: inherited.sourceCommit === record.commit });
    }
  }
  const sdk = ledger?.androidSdk;
  if (!sdk || !VERSION.test(sdk.version) || !SHA.test(sdk.commit)) throw new Error("androidSdk: invalid release ledger.");
  const stem = `missiongo-feedback-${sdk.version}`;
  const directory = join(root, "apps/web/public/maven/io/missiongo/missiongo-feedback", sdk.version);
  if (existsSync(directory)) {
    const pom = join(directory, `${stem}.pom`);
    const aar = join(directory, `${stem}.aar`);
    if (!present(pom) || !present(aar) || !readFileSync(pom, "utf8").includes(`<version>${sdk.version}</version>`)) {
      throw new Error(`androidSdk: incomplete Maven publication for ${sdk.version}; both POM and AAR are required.`);
    }
    for (const file of [pom, aar]) {
      if (!present(`${file}.sha256`) || readFileSync(`${file}.sha256`, "utf8").trim() !== digest(file)) {
        throw new Error(`androidSdk: missing or mismatched SHA-256 for ${file.split("/").pop()}.`);
      }
    }
    if (sdk.sha256 && sdk.sha256 !== digest(aar)) throw new Error("androidSdk: AAR differs from the immutable release record.");
    git(root, "merge-base", "--is-ancestor", sdk.commit, "HEAD");
    result.push({ artifact: "androidSdk", mode: "local", version: sdk.version, sourceCommit: sdk.commit, pomSha256: digest(pom), aarSha256: digest(aar) });
  } else if (live?.androidSdk?.version === sdk.version && live.androidSdk.sourceCommit === sdk.commit && live.androidSdk.aarSha256 && (!sdk.sha256 || sdk.sha256 === live.androidSdk.aarSha256)) {
    result.push({ artifact: "androidSdk", mode: "inherit", ...live.androidSdk });
  } else {
    throw new Error(`androidSdk: no complete local or live Maven publication for ${sdk.version}.`);
  }
  if (ledger.linuxCli && !linuxReleaseTools) throw new Error("Current checkout lacks Linux release verification");
  const linux = linuxReleaseTools?.checkLinuxArtifacts(root, live?.linuxCli);
  if (linux) result.push({ artifact: "linuxCli", ...linux });
  return result;
}

export function checkMavenImmutable(root, host, currentLink) {
  const base = "apps/web/public/maven/io/missiongo/missiongo-feedback";
  const directory = join(root, base);
  if (!existsSync(directory)) return;
  const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
  const commands = [];
  for (const version of readdirSync(directory)) {
    const versionDirectory = join(directory, version);
    if (!statSync(versionDirectory).isDirectory()) continue;
    if (!VERSION.test(version)) throw new Error("Unexpected SDK version directory.");
    for (const name of readdirSync(versionDirectory)) {
      const path = join(versionDirectory, name);
      if (!statSync(path).isFile()) throw new Error("Unexpected entry in SDK version directory.");
      const livePath = quote(`${currentLink}/${base}/${version}/${name}`);
      commands.push(`if [ -f ${livePath} ]; then actual=$(sha256sum ${livePath}) || exit 1; [ "\${actual%% *}" = '${digest(path)}' ] || { echo 'Published Maven coordinate differs: ${version}' >&2; exit 1; }; fi`);
    }
  }
  if (commands.length) execFileSync("ssh", ["-o", "BatchMode=yes", "-o", "ConnectTimeout=8", host, commands.join("\n")], { stdio: ["ignore", "pipe", "pipe"], timeout: 30_000 });
}

function declaredLedgerVersion(root, artifact) {
  const source = readFileSync(join(root, artifact.versionFile), "utf8");
  if (artifact.versionJsonPath) return artifact.versionJsonPath.split(".").reduce((value, key) => value[key], JSON.parse(source));
  const match = new RegExp(`^${artifact.versionProperty}=(.+)$`, "m").exec(source);
  if (!match) throw new Error(`${artifact.versionProperty} is not declared in ${artifact.versionFile}`);
  return match[1].trim();
}

function patchRaise(current, published, assertAccepted) {
  const parts = (value) => /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/.test(value ?? "") ? value.split(".").map(Number) : null;
  const now = parts(current), before = parts(published);
  if (!now || !before || now[0] !== before[0] || now[1] !== before[1] || now[2] !== before[2] + 1) return false;
  try { assertAccepted(current, published); return true; } catch { return false; }
}

/** Same verdicts as `npm run release:state`, surfaced during --coverage-plan. */
function planVersionGaps(root, live) {
  const gaps = [];
  const web = live?.web;
  if (web?.commit && !webVersionTools) {
    gaps.push({ artifact: "web", blocking: false, reason: "cannot check the web version gate: scripts/web-version.mjs is missing from this checkout" });
  }
  if (webVersionTools && web?.commit) {
    const current = JSON.parse(readFileSync(join(root, "product.json"), "utf8")).web.version;
    try {
      const { WEB_RELEASE_PATHS, requiresWebVersion, assertWebRelease } = webVersionTools;
      const files = git(root, "diff", "--name-only", web.commit, "--", ...WEB_RELEASE_PATHS).trim().split("\n").filter(Boolean);
      // A numeric patch raise is the expected outcome of `release:bump-patch`; the deploy-time
      // web-version.mjs check accepts any change, so a release must not be blocked while such a
      // merge is in flight. Anything else the gate rejects -- a lower version, a non-patch raise,
      // an unchanged version beside changed files -- still blocks.
      if (!patchRaise(current, web.version, (a, b) => webVersionTools.assertWebRelease(a, b, false))) {
        assertWebRelease(current, web.version, requiresWebVersion(files));
      }
    } catch (error) {
      gaps.push({ artifact: "web", blocking: true, reason: error.message, currentVersion: current, publishedVersion: web.version ?? null });
    }
  }
  const ledger = JSON.parse(readFileSync(join(root, "released.json"), "utf8")).artifacts;
  for (const [name, artifact] of Object.entries(ledger)) {
    if (!artifact?.commit) continue;
    try {
      git(root, "cat-file", "-e", `${artifact.commit}^{commit}`);
      const changed = git(root, "log", "--oneline", `${artifact.commit}..HEAD`, "--", ...artifact.paths).split("\n").filter(Boolean).length > 0;
      const current = declaredLedgerVersion(root, artifact);
      if (changed && current === artifact.version) {
        gaps.push({ artifact: name, blocking: true,
          reason: `${name} changed since ${artifact.version} was published, but its declared version has not moved; bump the version and commit it before publishing`,
          currentVersion: current, publishedVersion: artifact.version });
      } else if (!changed && patchRaise(current, artifact.version, (a, b) => { if (a === b) return; throw new Error("unchanged"); })) {
        gaps.push({ artifact: name, blocking: false,
          reason: `${name} is unchanged since ${artifact.version} but its declared version was raised to ${current}; republishing an unchanged build is refused`,
          currentVersion: current, publishedVersion: artifact.version });
      }
    } catch (error) {
      gaps.push({ artifact: name, blocking: false, reason: `cannot verify changes since ${String(artifact.commit).slice(0, 7)}: ${error.message}` });
    }
  }
  return gaps;
}

/** Attach plan-level version gaps next to missing_artifacts and block ready for in-scope artifacts. */
function mergeVersionGaps(coverage, gaps) {
  coverage.versionGaps = gaps;
  if (!gaps.length) return coverage;
  const scoped = gaps.filter(gap => gap.blocking && (coverage.scope.mode === "selected"
    ? coverage.scope.artifacts.includes(gap.artifact)
    : coverage.requiredArtifacts.includes(gap.artifact) || gap.artifact === "web"));
  if (!scoped.length) return coverage;
  const scopedArtifacts = new Set(scoped.map(gap => gap.artifact));
  for (const item of coverage.items) {
    if (item.status !== "ready" && item.status !== "partial") continue;
    const hits = (item.selectedArtifacts ?? []).filter(a => scopedArtifacts.has(a));
    if (hits.length) { item.status = "needs_version_bump"; item.versionGaps = scoped.filter(gap => hits.includes(gap.artifact)); }
  }
  coverage.ready = false;
  coverage.fullCoverage = false;
  return coverage;
}

function main() {
  const argv = process.argv.slice(2);
  const value = (flag) => { const index = argv.indexOf(flag); return index < 0 ? null : argv[index + 1]; };
  const root = resolve(value("--root") ?? join(dirname(fileURLToPath(import.meta.url)), ".."));
  const artifact = value("--build");
  if (artifact) { checkBuild(root, artifact); console.log(`${artifact}: build preflight passed`); return; }
  const live = value("--snapshot") ? JSON.parse(value("--snapshot")) : readSnapshot({
    host: value("--host"), currentLink: value("--current-link"), downloadsDir: value("--downloads-dir"),
  });
  const report = checkArtifacts(root, live, { publishApk: !argv.includes("--no-publish-apk") });
  if (value("--host") && value("--current-link")) checkMavenImmutable(root, value("--host"), value("--current-link"));
  if (!value("--candidates") || !value("--coverage-config")) throw new Error("Complete release candidates and product/repository coverage binding are required");
  const coverage = coverageForCheckout({ root, live,
    config: JSON.parse(readFileSync(value("--coverage-config"), "utf8")),
    candidates: JSON.parse(readFileSync(value("--candidates"), "utf8")),
    artifacts: [{ artifact: "web", version: JSON.parse(readFileSync(join(root, "product.json"), "utf8")).web.version, sourceCommit: git(root, "rev-parse", "HEAD") }, ...report],
    onlyArtifacts: value("--only-artifacts") ?? undefined, scopeReason: value("--scope-reason") ?? undefined });
  if (argv.includes("--coverage-plan")) {
    const gaps = planVersionGaps(root, live);
    mergeVersionGaps(coverage, gaps);
    // Only a hint: run `npm run release:bump-patch` in the planning checkout, never in this release worktree.
    const patchBumps = releaseStateTools ? releaseStateTools.planPatchVersions("origin/main", root) : [];
    const blocking = gaps.some(gap => gap.blocking);
    const next = blocking && patchBumps.length ? "npm run release:bump-patch, add client release notes, commit and push, then plan again" : undefined;
    console.log(JSON.stringify({ ...(patchBumps.length ? { patchBumps } : {}), ...(next ? { next } : {}) }, null, 2));
  }
  console.log(JSON.stringify({ artifacts: report, coverage }, null, 2));
  if (!argv.includes("--coverage-plan")) assertReleaseCoverage(coverage);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try { main(); } catch (error) { console.error(`Release preflight failed: ${error.message}`); process.exitCode = 1; }
}
