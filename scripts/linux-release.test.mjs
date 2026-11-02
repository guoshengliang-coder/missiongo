import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { checkLinuxFiles, checkLinuxArtifacts, verifyLinuxPublic } from "./linux-release-tools.mjs";
import { upgradeReleaseTools } from "./enable-linux-release.mjs";
import { publicReleaseEvidence } from "./handover-evidence.mjs";

test("Linux artifacts require a matching ledger, provenance and actual package hash", () => {
  const root = mkdtempSync(join(tmpdir(), "mg-release-"));
  try {
    execFileSync("git", ["init", root], { stdio: "ignore" });
    execFileSync("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--allow-empty", "-m", "fixture"], { cwd: root, stdio: "ignore" });
    const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
    const directory = join(root, "apps/web/public/downloads"); mkdirSync(directory, { recursive: true });
    const bytes = Buffer.from("test npm package"); const sha256 = createHash("sha256").update(bytes).digest("hex");
    const record = { version: "0.1.0", commit, sha256 };
    writeFileSync(join(root, "released.json"), JSON.stringify({ artifacts: { linuxCli: record } }));
    assert.throws(() => checkLinuxArtifacts(root, { version: "0.1.0", sourceCommit: "b".repeat(40), sha256 }), /matching/);
    writeFileSync(join(directory, "missiongo-linux-latest.tgz"), bytes);
    writeFileSync(join(directory, "missiongo-linux-latest.json"), JSON.stringify({ version: "0.1.0", sourceCommit: commit, sha256, size: bytes.length }));
    writeFileSync(join(directory, "missiongo-linux-latest.release"), `version=0.1.0\nsource_commit=${commit}\nsource_dirty=false\nsha256=${sha256}\n`);
    assert.equal(checkLinuxFiles(root, record).sourceCommit, commit);
    writeFileSync(join(directory, "missiongo-linux-latest.tgz"), "tampered");
    assert.throws(() => checkLinuxFiles(root, record), /must agree/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("unpublished Linux declaration is not mistaken for a published artifact", () => {
  const root = mkdtempSync(join(tmpdir(), "mg-unpublished-"));
  try {
    writeFileSync(join(root, "released.json"), JSON.stringify({ artifacts: { linuxCli: { version: null, commit: null } } }));
    assert.equal(checkLinuxArtifacts(root, null), undefined);
    const proof = publicReleaseEvidence({ current: { linuxCli: { version: "0.1.0", sourceCommit: "a".repeat(40), sha256: "b".repeat(64) } }, publicEvidence: { checks: { linuxCli: true } } }, "https://missiongo.example.com");
    assert.equal(proof.releases[0].artifact, "linuxCli");
    assert.equal(proof.releases[0].proof.url, "https://missiongo.example.com/downloads/missiongo-linux-latest.tgz");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("public verification rejects a matching version with the wrong source commit", async () => {
  const previous = globalThis.fetch;
  globalThis.fetch = async () => Response.json({ version: "0.1.0", sourceCommit: "b".repeat(40), sha256: "c".repeat(64) });
  try { assert.equal(await verifyLinuxPublic("https://missiongo.example.com", { version: "0.1.0", sourceCommit: "a".repeat(40), sha256: "c".repeat(64) }), false); }
  finally { globalThis.fetch = previous; }
});

test("shared-tool upgrade is idempotent, keeps existing guards, and rejects unknown versions", () => {
  const files = {
    coordinator: 'check_lock_and_clean_tree()\nallowed={"publish:android-sdk"}\nartifacts={"publish:android-sdk": "androidSdk"}\nif artifact != "androidSdk":\n    release_notes()\n',
    preflight: 'const SHA = /commit/;\nfunction checkArtifacts() {\n  assert_ci_and_clean();\n  return result;\n}',
    receipt: 'const SHA = /commit/;\nfunction snapshot() { return { web, androidApp, androidSdk, macosApp }; }\nfunction check(){\n  return { checks, errors };\n}\nconst artifacts=["web", "androidApp", "androidSdk", "macosApp"];',
    deploy: '# The Android update manifest rides with the APK that is actually being served,\nbackup_and_check_ci\n',
    handover: '    if (artifact === "androidSdk" && valid) {}',
  };
  const fragment = readFileSync(new URL("./deploy.sh", import.meta.url), "utf8").match(/# BEGIN LINUX CLI INHERITANCE[\s\S]+?# END LINUX CLI INHERITANCE/)[0];
  const upgraded = upgradeReleaseTools(files, fragment);
  assert.match(upgraded.coordinator, /check_lock_and_clean_tree/); assert.match(upgraded.preflight, /assert_ci_and_clean/); assert.match(upgraded.deploy, /backup_and_check_ci/);
  assert.deepEqual(upgradeReleaseTools(upgraded, fragment), upgraded);
  assert.throws(() => upgradeReleaseTools({ ...files, coordinator: "unknown" }, fragment), /Unknown installed/);
});
