#!/usr/bin/env node
// Read the live deployment before and after deploy.sh, then describe only what
// actually changed. This command never writes to MissionGo or stores a token.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { basename } from "node:path";
import { fileURLToPath } from "node:url";

const SHA = /^[0-9a-f]{40}$/;
const DIGEST = /^[0-9a-f]{64}$/;
const VERSION = /^[0-9A-Za-z][0-9A-Za-z.+_-]*$/;

export function properties(text = "") {
  return Object.fromEntries(text.split("\n").flatMap((line) => {
    const separator = line.indexOf("=");
    return separator > 0 ? [[line.slice(0, separator), line.slice(separator + 1)]] : [];
  }));
}

function quote(value) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function options(argv) {
  const result = { command: argv[0] };
  for (let i = 1; i < argv.length; i += 2) {
    if (!argv[i]?.startsWith("--") || !argv[i + 1]) throw new Error(`Expected a value after ${argv[i]}`);
    const key = argv[i].slice(2).replace(/-([a-z])/g, (_match, letter) => letter.toUpperCase());
    result[key] = argv[i + 1];
  }
  return result;
}

function remote(host, command) {
  return execFileSync("ssh", [host, command], { encoding: "utf8", timeout: 20_000 }).trim();
}

function maybeRemote(host, command) {
  try { return remote(host, command); } catch { return ""; }
}

function remoteFile(host, path) {
  return maybeRemote(host, `cat ${quote(path)} 2>/dev/null`);
}

function remoteSha(host, path) {
  return maybeRemote(host, `sha256sum ${quote(path)} 2>/dev/null | cut -d ' ' -f 1`);
}

export function parseApkName(path) {
  const match = /^MissionGo-Android-([0-9.]+)-([0-9]+)\.apk$/.exec(basename(path));
  return match ? { version: match[1], build: match[2] } : null;
}

export function readSnapshot({ host, currentLink, downloadsDir }) {
  if (!host || !currentLink?.startsWith("/") || !downloadsDir?.startsWith("/")) {
    throw new Error("snapshot needs --host, --current-link and --downloads-dir");
  }
  const directory = maybeRemote(host, `readlink -f ${quote(currentLink)} 2>/dev/null`);
  if (!directory.startsWith("/")) return { web: null, androidApp: null, androidSdk: null, macosApp: null };

  const release = properties(remoteFile(host, `${directory}/RELEASE`));
  const web = SHA.test(release.commit ?? "")
    ? { version: release.commit, commit: release.commit, clean: release.tree === "clean", ciPassed: release.ci === "passed" }
    : null;

  const apkPath = maybeRemote(host, `readlink -f ${quote(`${downloadsDir}/missiongo-android-latest.apk`)} 2>/dev/null`);
  const apkName = parseApkName(apkPath);
  const apkMeta = properties(remoteFile(host, `${directory}/apps/web/public/downloads/missiongo-android-latest.release`));
  const apkSha = apkName ? remoteSha(host, apkPath) : "";
  const androidApp = apkName && DIGEST.test(apkSha)
    ? {
      ...apkName,
      sha256: apkSha,
      sourceCommit: apkMeta.version_name === apkName.version
        && apkMeta.version_code === apkName.build
        && apkMeta.sha256 === apkSha
        && apkMeta.source_dirty === "false"
        && SHA.test(apkMeta.source_commit ?? "") ? apkMeta.source_commit : null,
    }
    : null;

  const macosPath = `${directory}/apps/web/public/downloads/missiongo-macos-latest.zip`;
  const macosMeta = properties(remoteFile(host, `${directory}/apps/web/public/downloads/missiongo-macos-latest.release`));
  const macosManifestText = remoteFile(host, `${directory}/apps/web/public/downloads/missiongo-macos-latest.json`);
  let macosManifest;
  try { macosManifest = JSON.parse(macosManifestText); } catch { macosManifest = null; }
  const macosSha = remoteSha(host, macosPath);
  const macosApp = VERSION.test(macosMeta.version ?? "")
    && DIGEST.test(macosSha)
    && macosMeta.sha256 === macosSha
    && macosManifest?.version === macosMeta.version
    && macosManifest?.sha256 === macosSha
    ? {
      version: macosMeta.version,
      sha256: macosSha,
      sourceCommit: macosMeta.source_dirty === "false" && SHA.test(macosMeta.source_commit ?? "")
        ? macosMeta.source_commit : null,
    }
    : null;

  let ledger;
  try { ledger = JSON.parse(remoteFile(host, `${directory}/released.json`)); } catch { ledger = null; }
  const sdkRecord = ledger?.artifacts?.androidSdk;
  const sdkVersion = sdkRecord?.version;
  const pomPath = `${directory}/apps/web/public/maven/io/missiongo/missiongo-feedback/${sdkVersion}/missiongo-feedback-${sdkVersion}.pom`;
  const pomSha = VERSION.test(sdkVersion ?? "") ? remoteSha(host, pomPath) : "";
  const androidSdk = DIGEST.test(pomSha)
    ? { version: sdkVersion, pomSha256: pomSha, sourceCommit: SHA.test(sdkRecord.commit ?? "") ? sdkRecord.commit : null }
    : null;

  return { web, androidApp, androidSdk, macosApp };
}

async function readPublic(origin, path, method = "GET") {
  const response = await fetch(new URL(path, origin), { method, signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error(`${path} returned HTTP ${response.status}`);
  return method === "HEAD" ? null : response.text();
}

async function publicSha(origin, path) {
  const response = await fetch(new URL(path, origin), { signal: AbortSignal.timeout(120_000) });
  if (!response.ok || !response.body) throw new Error(`${path} returned HTTP ${response.status}`);
  const hash = createHash("sha256");
  for await (const chunk of response.body) hash.update(chunk);
  return hash.digest("hex");
}

export async function verifyPublic(origin, after) {
  const checks = {};
  const errors = {};
  async function check(name, fn) {
    try { checks[name] = await fn(); } catch (error) { checks[name] = false; errors[name] = String(error); }
  }
  await check("web", async () => {
    if (!after.web) return false;
    const health = JSON.parse(await readPublic(origin, "/health"));
    return health.status === "ok" && health.release === after.web.commit;
  });
  await check("androidApp", async () => {
    if (!after.androidApp) return false;
    return await publicSha(origin, "/downloads/missiongo-android-latest.apk") === after.androidApp.sha256;
  });
  await check("macosApp", async () => {
    if (!after.macosApp) return false;
    const manifest = JSON.parse(await readPublic(origin, "/downloads/missiongo-macos-latest.json"));
    if (manifest.version !== after.macosApp.version || manifest.sha256 !== after.macosApp.sha256) return false;
    return await publicSha(origin, "/downloads/missiongo-macos-latest.zip") === after.macosApp.sha256;
  });
  await check("androidSdk", async () => {
    if (!after.androidSdk) return false;
    const version = after.androidSdk.version;
    const pom = await readPublic(origin, `/maven/io/missiongo/missiongo-feedback/${version}/missiongo-feedback-${version}.pom`);
    return pom.includes(`<version>${version}</version>`)
      && createHash("sha256").update(pom).digest("hex") === after.androidSdk.pomSha256;
  });
  return { checks, errors };
}

export function buildReceipt(before, after, publicEvidence) {
  const artifacts = ["web", "androidApp", "androidSdk", "macosApp"];
  const changes = artifacts.flatMap((artifact) => {
    const old = before[artifact];
    const current = after[artifact];
    if (!current || !old || current.version === old.version && current.sha256 === old.sha256 && current.build === old.build) return [];
    const fromCommit = artifact === "web" ? old.commit : old.sourceCommit;
    const toCommit = artifact === "web" ? current.commit : current.sourceCommit;
    const verified = publicEvidence.checks.web === true
      && publicEvidence.checks[artifact] === true
      && after.web?.clean === true && after.web?.ciPassed === true;
    return [{
      artifact,
      version: current.version,
      ...(current.build ? { build: current.build } : {}),
      fromCommit: SHA.test(fromCommit ?? "") ? fromCommit : null,
      toCommit: SHA.test(toCommit ?? "") ? toCommit : null,
      verified,
      eligibleForMatching: verified && SHA.test(fromCommit ?? "") && SHA.test(toCommit ?? ""),
    }];
  });
  return { schemaVersion: 1, deployedCommit: after.web?.commit ?? null, previous: before, current: after, changes, publicEvidence };
}

async function main() {
  const args = options(process.argv.slice(2));
  if (args.command === "snapshot") {
    process.stdout.write(`${JSON.stringify(readSnapshot(args))}\n`);
    return;
  }
  if (args.command === "compare") {
    if (!args.beforeJson || !args.origin) throw new Error("compare needs --before-json and --origin");
    const before = JSON.parse(args.beforeJson);
    const after = readSnapshot(args);
    const evidence = await verifyPublic(args.origin, after);
    process.stdout.write(`${JSON.stringify(buildReceipt(before, after, evidence))}\n`);
    return;
  }
  throw new Error("Usage: release-receipt.mjs snapshot|compare --host <ssh-host> --current-link <remote-path> --downloads-dir <remote-path> [--before-json <snapshot> --origin <url>]");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => { console.error(error); process.exitCode = 1; });
}
