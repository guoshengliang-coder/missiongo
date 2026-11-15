import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { windowsManifest, windowsUpdate, checkWindowsFiles, checkWindowsArtifacts } from "./windows-release-tools.mjs";
import { install } from "./install-release-tools.mjs";
import { RELEASE_TOOL_FILES } from "./release-tool-files.mjs";
import { publicReleaseEvidence } from "./handover-evidence.mjs";

test("Windows provenance, updater hashes and actual bytes must agree before release coverage accepts the package", () => {
  const root = mkdtempSync(join(tmpdir(), "mg-win-release-"));
  try {
    execFileSync("git", ["init", root], { stdio: "ignore" });
    execFileSync("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--allow-empty", "-m", "fixture"], { cwd: root, stdio: "ignore" });
    const sourceCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
    const bytes = Buffer.from("not a real installer; verifier unit fixture");
    const manifest = { version: "0.1.0", sourceCommit, platform: "win32", arch: "x64", signed: true, certificateSha256: "a".repeat(64), filename: "missiongo-windows-0.1.0-x64-setup.exe", size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
    const directory = join(root, "apps/web/public/downloads/windows"); mkdirSync(directory, { recursive: true });
    const record = { version: manifest.version, commit: sourceCommit, sha256: manifest.sha256 };
    writeFileSync(join(root, "released.json"), JSON.stringify({ artifacts: { windowsApp: record } }));
    writeFileSync(join(directory, manifest.filename), bytes); writeFileSync(join(directory, "latest.json"), JSON.stringify(manifest));
    writeFileSync(join(directory, "latest.yml"), windowsUpdate(manifest, bytes));
    assert.equal(checkWindowsFiles(root, record).sourceCommit, sourceCommit);
    assert.throws(() => windowsManifest({ ...manifest, signed: false }));
    assert.throws(() => windowsManifest({ ...manifest, filename: "../../other.exe" }));
    writeFileSync(join(directory, "latest.yml"), "path: https://foreign.example.com/setup.exe");
    assert.throws(() => checkWindowsFiles(root, record), /updater metadata/);
    writeFileSync(join(directory, "latest.yml"), windowsUpdate(manifest, bytes)); writeFileSync(join(directory, manifest.filename), "changed");
    assert.throws(() => checkWindowsFiles(root, record), /disagree|changed/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test("unpublished Windows declaration never becomes public release evidence and unknown inherited packages block", () => {
  const root = mkdtempSync(join(tmpdir(), "mg-win-unpublished-"));
  try {
    writeFileSync(join(root, "released.json"), JSON.stringify({ artifacts: { windowsApp: { version: null, commit: null } } }));
    assert.equal(checkWindowsArtifacts(root, null), undefined);
    assert.throws(() => checkWindowsArtifacts(root, { version: "unknown" }), /Unrecorded/);
    assert.deepEqual(publicReleaseEvidence({ current: { windowsApp: null }, publicEvidence: { checks: { windowsApp: false } } }, "https://missiongo.example.com").releases, []);
    const evidence = publicReleaseEvidence({ current: { windowsApp: { version: "0.1.0", sourceCommit: "a".repeat(40), sha256: "b".repeat(64), filename: "missiongo-windows-0.1.0-x64-setup.exe" } }, publicEvidence: { checks: { windowsApp: true } } }, "https://missiongo.example.com");
    assert.equal(evidence.releases[0].proof.url, "https://missiongo.example.com/downloads/windows/missiongo-windows-0.1.0-x64-setup.exe");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test("current release inventory includes Windows verification without patching installed tools", () => {
  const root = mkdtempSync(join(tmpdir(), "mg-win-install-"));
  try {
    assert.equal(RELEASE_TOOL_FILES["windows-release-tools.mjs"], "windows-release-tools.mjs");
    const result = install({dryRun:true, home:root, configHome:join(root,"config"), source:process.cwd()});
    assert.equal(result.installed,false);
    assert(result.changed.includes("windows-release-tools.mjs"));
    assert.match(readFileSync("scripts/missiongo-release.py","utf8"), /"publish:windows": "windowsApp"/);
  } finally { rmSync(root,{recursive:true,force:true}); }
});

test("updater release notes are plain YAML strings and malformed note catalogs are rejected",()=>{
  const manifest={version:"0.1.0",sourceCommit:"a".repeat(40),platform:"win32",arch:"x64",signed:true,certificateSha256:"b".repeat(64),filename:"fixture-0.1.0-x64-setup.exe",size:1,sha256:"c".repeat(64),releaseNotes:[{items:[{title:'新增 Windows: "原生" 客户端'},{title:"可取消更新"}]}]};
  assert.match(windowsUpdate(windowsManifest(manifest),Buffer.from("x")),/releaseNotes: "新增 Windows/);
  assert.throws(()=>windowsManifest({...manifest,releaseNotes:[{items:[{title:123}]}]}),/notes/);
});
