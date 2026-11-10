import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { bumpPatchVersions } from "./release-state.mjs";

const git = (root, ...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();

function repository({ android = "0.1.20", macos = "0.4.89", linux = "0.1.24" }) {
  const root = mkdtempSync(join(tmpdir(), "release-state-"));
  const write = (path, text) => { mkdirSync(join(root, path, ".."), { recursive: true }); writeFileSync(join(root, path), text); };
  const ledger = (macosCommit) => JSON.stringify({ artifacts: {
    androidApp: { version: "0.1.20", commit: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", versionFile: "sdks/android-feedback/gradle.properties", versionProperty: "missiongoAndroidVersionName", paths: ["apps/android"] },
    macosApp: { version: "0.4.89", commit: macosCommit, versionFile: "apps/macos/version.properties", versionProperty: "missiongoMacosVersion", paths: ["apps/macos"] },
    linuxCli: { version: "0.1.24", commit: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", versionFile: "product.json", versionJsonPath: "linuxNode.version", paths: ["apps/node"] },
  } }, null, 2);
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.email", "test@example.com");
  git(root, "config", "user.name", "Test");
  write("sdks/android-feedback/gradle.properties", `missiongoAndroidVersionName=${android}\nmissiongoVersion=0.2.8\n`);
  write("apps/macos/version.properties", `missiongoMacosVersion=${macos}\n`);
  write("product.json", JSON.stringify({ web: { version: "1.1.52" }, linuxNode: { version: linux } }, null, 2));
  write("released.json", ledger("cccccccccccccccccccccccccccccccccccccccc"));
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "published");
  git(root, "update-ref", "refs/remotes/origin/main", "HEAD");
  return { root, write };
}

function merged(root, path) {
  mkdirSync(join(root, path), { recursive: true });
  writeFileSync(join(root, path, "change.txt"), `changed ${Date.now()}`);
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "merged work");
}

test("raises only the patch component of artifacts that changed since origin/main", () => {
  const { root } = repository();
  merged(root, "apps/macos");
  assert.deepEqual(bumpPatchVersions("origin/main", root), [{ artifact: "macosApp", from: "0.4.89", to: "0.4.90", file: "apps/macos/version.properties" }]);
  assert.match(readFileSync(join(root, "apps/macos/version.properties"), "utf8"), /^missiongoMacosVersion=0\.4\.90$/m);
  assert.match(readFileSync(join(root, "sdks/android-feedback/gradle.properties"), "utf8"), /missiongoAndroidVersionName=0\.1\.20/);
  assert.equal(JSON.parse(readFileSync(join(root, "product.json"), "utf8")).linuxNode.version, "0.1.24");
  rmSync(root, { recursive: true, force: true });
});

test("leaves a version a single pull request already raised", () => {
  const { root } = repository();
  merged(root, "apps/macos");
  writeFileSync(join(root, "apps/macos/version.properties"), "missiongoMacosVersion=0.4.90\n");
  git(root, "commit", "-qam", "raise macOS for this PR");
  // origin/main gains the same single-PR raise before the batch bumps.
  git(root, "update-ref", "refs/remotes/origin/main", "HEAD");
  assert.deepEqual(bumpPatchVersions("origin/main", root), []);
  assert.match(readFileSync(join(root, "apps/macos/version.properties"), "utf8"), /^missiongoMacosVersion=0\.4\.90$/m);
  rmSync(root, { recursive: true, force: true });
});

test("bumps each artifact independently and keeps other version fields", () => {
  const { root } = repository();
  merged(root, "apps/node");
  merged(root, "sdks/android-feedback/gradle.properties");
  const bumps = bumpPatchVersions("origin/main", root);
  assert.deepEqual(bumps.map(({ artifact, from, to }) => [artifact, from, to]).sort(), [
    ["androidApp", "0.1.20", "0.1.21"],
    ["linuxCli", "0.1.24", "0.1.25"],
  ]);
  const product = JSON.parse(readFileSync(join(root, "product.json"), "utf8"));
  assert.equal(product.linuxNode.version, "0.1.25");
  assert.equal(product.web.version, "1.1.52");
  assert.match(readFileSync(join(root, "sdks/android-feedback/gradle.properties"), "utf8"), /missiongoVersion=0\.2\.8/);
  rmSync(root, { recursive: true, force: true });
});

test("refuses to guess a patch for versions that are not major.minor.patch", () => {
  const { root } = repository({ macos: "0.4.90-beta" });
  merged(root, "apps/macos");
  assert.throws(() => bumpPatchVersions("origin/main", root), /not a numeric major\.minor\.patch version/);
  rmSync(root, { recursive: true, force: true });
});

test("raises an uncommitted raise again instead of shipping it over", () => {
  const { root } = repository();
  merged(root, "apps/macos");
  // origin/main already carries the merged work; the checked-out declaration is behind it.
  git(root, "update-ref", "refs/remotes/origin/main", "HEAD");
  writeFileSync(join(root, "apps/macos/version.properties"), "missiongoMacosVersion=0.4.88\n");
  assert.deepEqual(bumpPatchVersions("origin/main", root), [{ artifact: "macosApp", from: "0.4.88", to: "0.4.89", file: "apps/macos/version.properties" }]);
  assert.match(readFileSync(join(root, "apps/macos/version.properties"), "utf8"), /^missiongoMacosVersion=0\.4\.89$/m);
  rmSync(root, { recursive: true, force: true });
});

test("treats an unresolvable baseline as unknown instead of raising blindly", () => {
  const { root } = repository();
  merged(root, "apps/macos");
  assert.deepEqual(bumpPatchVersions("origin/main", root), []);
  rmSync(root, { recursive: true, force: true });
});
