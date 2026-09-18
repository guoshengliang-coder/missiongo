import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { buildReceipt, parseApkName, properties, readSnapshot } from "./release-receipt.mjs";

const oldCommit = "a".repeat(40);
const newCommit = "b".repeat(40);

test("parses the deployed APK name without treating metadata as executable code", () => {
  assert.deepEqual(parseApkName("/srv/releases/MissionGo-Android-0.1.12-123456.apk"), { version: "0.1.12", build: "123456" });
  assert.equal(parseApkName("/srv/releases/unversioned.apk"), null);
  assert.deepEqual(properties("version=0.1.12\nsha256=abc=def\ninvalid\n"), { version: "0.1.12", sha256: "abc=def" });
});

test("receipt includes only changed, publicly verified artifacts with known source ranges", () => {
  const before = {
    web: { version: oldCommit, commit: oldCommit },
    androidApp: { version: "0.1.11", build: "111", sha256: "1", sourceCommit: oldCommit },
    androidSdk: { version: "0.2.5", sourceCommit: oldCommit },
    macosApp: { version: "0.4.1", sha256: "2", sourceCommit: oldCommit },
  };
  const after = {
    web: { version: newCommit, commit: newCommit, clean: true, ciPassed: true },
    androidApp: { version: "0.1.12", build: "222", sha256: "3", sourceCommit: newCommit },
    androidSdk: before.androidSdk,
    macosApp: { version: "0.4.2", sha256: "4", sourceCommit: null },
  };
  const receipt = buildReceipt(before, after, { checks: { web: true, androidApp: true, androidSdk: true, macosApp: false }, errors: {} });
  assert.deepEqual(receipt.changes.map((change) => change.artifact), ["web", "androidApp", "macosApp"]);
  assert.equal(receipt.changes[0].eligibleForMatching, true);
  assert.equal(receipt.changes[1].eligibleForMatching, true);
  assert.equal(receipt.changes[2].eligibleForMatching, false);
  assert.equal(receipt.changes[2].toCommit, null);
});

test("a dirty or unconfirmed deployment produces no eligible release notice", () => {
  const before = { web: { version: oldCommit, commit: oldCommit } };
  const after = { web: { version: newCommit, commit: newCommit, clean: false, ciPassed: false } };
  const receipt = buildReceipt(before, after, { checks: { web: true }, errors: {} });
  assert.equal(receipt.changes[0].verified, false);
  assert.equal(receipt.changes[0].eligibleForMatching, false);
});

test("reads versions and source commits from the live release and the published APK", () => {
  const root = mkdtempSync(join(tmpdir(), "missiongo-receipt-"));
  const priorPath = process.env.PATH;
  const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
  const put = (path, contents) => {
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, contents);
  };
  try {
    const bin = join(root, "bin");
    mkdirSync(bin);
    put(join(bin, "ssh"), "#!/bin/sh\nshift\nexec sh -c \"$1\"\n");
    chmodSync(join(bin, "ssh"), 0o755);
    process.env.PATH = `${bin}:${priorPath}`;

    const release = join(root, "releases", "current-build");
    const current = join(root, "current");
    const downloads = join(root, "downloads");
    mkdirSync(downloads, { recursive: true });
    put(join(release, "RELEASE"), `commit=${newCommit}\ntree=clean\nci=passed\n`);
    symlinkSync(release, current);

    const apk = Buffer.from("apk-build");
    const apkPath = join(downloads, "MissionGo-Android-0.1.12-222.apk");
    put(apkPath, apk);
    symlinkSync(apkPath, join(downloads, "missiongo-android-latest.apk"));
    put(join(release, "apps/web/public/downloads/missiongo-android-latest.release"),
      `version_name=0.1.12\nversion_code=222\nsha256=${sha(apk)}\nsource_commit=${newCommit}\nsource_dirty=false\n`);

    const zip = Buffer.from("macos-build");
    put(join(release, "apps/web/public/downloads/missiongo-macos-latest.zip"), zip);
    put(join(release, "apps/web/public/downloads/missiongo-macos-latest.release"),
      `version=0.4.2\nsha256=${sha(zip)}\nsource_commit=${newCommit}\nsource_dirty=false\n`);
    put(join(release, "apps/web/public/downloads/missiongo-macos-latest.json"),
      JSON.stringify({ version: "0.4.2", sha256: sha(zip) }));

    const pom = "<project><version>0.2.6</version></project>";
    put(join(release, "apps/web/public/maven/io/missiongo/missiongo-feedback/0.2.6/missiongo-feedback-0.2.6.pom"), pom);
    put(join(release, "released.json"), JSON.stringify({ artifacts: { androidSdk: { version: "0.2.6", commit: newCommit } } }));

    const snapshot = readSnapshot({ host: "fake", currentLink: current, downloadsDir: downloads });
    assert.equal(snapshot.web?.commit, newCommit);
    assert.equal(snapshot.androidApp?.sourceCommit, newCommit);
    assert.equal(snapshot.androidApp?.version, "0.1.12");
    assert.equal(snapshot.macosApp?.sourceCommit, newCommit);
    assert.equal(snapshot.androidSdk?.sourceCommit, newCommit);
  } finally {
    process.env.PATH = priorPath;
    rmSync(root, { recursive: true, force: true });
  }
});
