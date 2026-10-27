#!/usr/bin/env node
// Publication facts, kept outside tracked files and shared by all worktrees.
import {execFileSync} from "node:child_process";
import {readFileSync,writeFileSync,renameSync} from "node:fs";
import {resolve,join} from "node:path";
import {fileURLToPath} from "node:url";

const SHA = /^[a-f0-9]{40}$/;
const DIGEST = /^[a-f0-9]{64}$/;
export function publicReleaseEvidence(receipt, origin) {
  const base = new URL(origin);
  if (base.protocol !== "https:" || base.username || base.password || base.search || base.hash || base.pathname !== "/") throw new Error("Use an HTTPS publication origin.");
  const releases = [];
  for (const [artifact,current] of Object.entries(receipt.current ?? {})) {
    if (!current || receipt.publicEvidence?.checks?.[artifact] !== true) continue;
    const sourceCommit = artifact === "web" ? current.commit : current.sourceCommit;
    if (!SHA.test(sourceCommit ?? "") || !current.version) continue;
    let proof;
    if (artifact === "web" && current.clean === true && current.ciPassed === true) proof = {kind:"health",url:new URL("/health",base).href};
    if (artifact === "androidApp" && DIGEST.test(current.sha256 ?? "")) proof = {kind:"sha256",url:new URL("/downloads/missiongo-android-latest.apk",base).href,sha256:current.sha256};
    if (artifact === "macosApp" && DIGEST.test(current.sha256 ?? "")) proof = {kind:"sha256",url:new URL("/downloads/missiongo-macos-latest.zip",base).href,sha256:current.sha256};
    if (artifact === "androidSdk" && DIGEST.test(current.pomSha256 ?? "") && /^[0-9A-Za-z][0-9A-Za-z.+_-]*$/.test(current.version)) {
      proof = {kind:"sha256",url:new URL(`/maven/io/missiongo/missiongo-feedback/${current.version}/missiongo-feedback-${current.version}.pom`,base).href,sha256:current.pomSha256};
    }
    if (proof) releases.push({artifact,version:String(current.version),sourceCommit,proof});
  }
  return {schemaVersion:1,releases};
}
export function saveReleaseEvidence(evidence, repo = process.cwd()) {
  if (evidence?.schemaVersion !== 1 || !Array.isArray(evidence.releases) || evidence.releases.length > 20) throw new Error("Invalid release evidence.");
  const seen = new Set();
  for (const release of evidence.releases) {
    const url = new URL(release.proof?.url);
    if (!/^[a-z][A-Za-z0-9_-]{0,49}$/.test(release.artifact ?? "") || seen.has(release.artifact)
      || !SHA.test(release.sourceCommit ?? "") || typeof release.version !== "string" || !release.version || release.version.length > 100
      || url.protocol !== "https:" || url.username || url.password || url.hash
      || !["health","sha256"].includes(release.proof.kind)
      || release.proof.kind === "sha256" && !DIGEST.test(release.proof.sha256 ?? "")) throw new Error("Invalid public release proof.");
    seen.add(release.artifact);
  }
  const common = execFileSync("git",["-C",repo,"rev-parse","--git-common-dir"],{encoding:"utf8"}).trim();
  const destination = join(resolve(repo,common),"missiongo-release-evidence.json");
  const temporary = `${destination}.${process.pid}.tmp`;
  writeFileSync(temporary,`${JSON.stringify(evidence)}\n`,{mode:0o600});
  renameSync(temporary,destination);
  return evidence.releases.length;
}
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    const [file,repo] = process.argv.slice(2);
    if (!file) throw new Error("Usage: handover-evidence.mjs <verified-public-evidence.json> [repository]");
    const count = saveReleaseEvidence(JSON.parse(readFileSync(file,"utf8")),repo);
    process.stdout.write(`${JSON.stringify({saved:true,artifactCount:count})}\n`);
  } catch (error) { console.error(error.message); process.exitCode=1; }
}
