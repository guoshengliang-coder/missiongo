import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { checkArtifacts, checkBuild, checkMavenImmutable } from "./release-preflight.mjs";
import { chmodSync } from "node:fs";

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "missiongo-preflight-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  git("init", "--quiet"); git("config", "user.email", "release@example.test"); git("config", "user.name", "Release test");
  git("commit", "--allow-empty", "-m", "source");
  const commit = git("rev-parse", "HEAD");
  const artifacts = Object.fromEntries(["androidApp", "androidSdk", "macosApp"].map((key) => [key, { version: "1.2.3", commit }]));
  writeFileSync(join(root, "released.json"), JSON.stringify({ artifacts }));
  git("add", "released.json"); git("commit", "-m", "ledger"); git("update-ref", "refs/remotes/origin/main", "HEAD");
  const live = {
    androidApp: { version: "1.2.3", sourceCommit: commit, sha256: "a".repeat(64) },
    macosApp: { version: "1.2.3", sourceCommit: commit, sha256: "b".repeat(64) },
    androidSdk: { version: "1.2.3", sourceCommit: commit, aarSha256: "c".repeat(64) },
  };
  const put = (name, text) => { const path = join(root, name); mkdirSync(join(path, ".."), { recursive: true }); writeFileSync(path, text); };
  const zip = Buffer.from("release-build");
  const sha = createHash("sha256").update(zip).digest("hex");
  const localZip = (version = "1.2.3") => {
    const prefix = "apps/web/public/downloads/missiongo-macos-latest";
    put(`${prefix}.zip`, zip);
    put(`${prefix}.release`, `version=${version}\nsource_commit=${commit}\nsource_dirty=false\nsha256=${sha}\n`);
    put(`${prefix}.json`, JSON.stringify({ version, sha256: sha, size: zip.length }));
  };
  return { root, live, commit, localZip, put, git };
}

test("clean checkout can inherit verified live artifacts, but not missing or newer versions", (t) => {
  const f = fixture(t);
  assert.equal(checkArtifacts(f.root, f.live).length, 3);
  f.live.macosApp.version = "1.2.2";
  assert.throws(() => checkArtifacts(f.root, f.live), /wrong release/);
  assert.throws(() => checkArtifacts(f.root, null), /wrong release/);
});
test("local ignored ZIP must match ledger provenance, version and manifest", (t) => {
  const f = fixture(t); f.localZip();
  assert.equal(checkArtifacts(f.root, f.live)[1].mode, "local");
  f.localZip("1.2.2"); assert.throws(() => checkArtifacts(f.root, f.live), /does not match/);
  f.localZip(); f.put("apps/web/public/downloads/missiongo-macos-latest.json", JSON.stringify({ version: "1.2.3", sha256: "a".repeat(64) }));
  assert.throws(() => checkArtifacts(f.root, f.live), /disagree/);
});
test("a partial local Maven repository cannot conceal a missing AAR", (t) => {
  const f = fixture(t); const prefix = "apps/web/public/maven/io/missiongo/missiongo-feedback/1.2.3/missiongo-feedback-1.2.3";
  f.put(`${prefix}.pom`, "<version>1.2.3</version>");
  assert.throws(() => checkArtifacts(f.root, f.live), /incomplete Maven/);
  delete f.live.androidSdk.aarSha256;
  rmSync(join(f.root, "apps"), { recursive: true });
  assert.throws(() => checkArtifacts(f.root, f.live), /no complete/);
});
test("builds reject primary, dirty, stale and divergent worktrees", (t) => {
  const f = fixture(t);
  assert.throws(() => checkBuild(f.root, "macosApp", { fetch: false }), /primary checkout/);
  const worktree = `${f.root}-worktree`; t.after(() => rmSync(worktree, { recursive: true, force: true }));
  f.git("worktree", "add", "--detach", worktree, "HEAD");
  assert.doesNotThrow(() => checkBuild(worktree, "macosApp", { fetch: false }));
  writeFileSync(join(worktree, "stray"), "uncommitted");
  assert.throws(() => checkBuild(worktree, "macosApp", { fetch: false }), /clean worktree/);
  rmSync(join(worktree, "stray"));
  f.git("commit", "--allow-empty", "-m", "main advanced"); f.git("update-ref", "refs/remotes/origin/main", "HEAD");
  assert.throws(() => checkBuild(worktree, "macosApp", { fetch: false }));
});

test("an inherited binary cannot violate an immutable ledger digest", (t) => {
  const f = fixture(t);
  const ledger = { artifacts: Object.fromEntries(Object.entries(f.live).map(([key, value]) => [key, { version: value.version, commit: f.commit }])) };
  ledger.artifacts.macosApp.sha256 = "d".repeat(64);
  writeFileSync(join(f.root, "released.json"), JSON.stringify(ledger));
  assert.throws(() => checkArtifacts(f.root, f.live), /wrong release/);
});
test("a Maven coordinate cannot overwrite different bytes already online", (t) => {
  const f = fixture(t);
  const relative = "apps/web/public/maven/io/missiongo/missiongo-feedback/1.2.3/missiongo-feedback-1.2.3.aar";
  f.put(relative, "new-bytes");
  const remote = join(f.root, "remote");
  mkdirSync(join(remote, relative, ".."), { recursive: true }); writeFileSync(join(remote, relative), "old-bytes");
  const bin = join(f.root, "bin"); mkdirSync(bin);
  writeFileSync(join(bin, "ssh"), '#!/bin/sh\nshift 5\nexec sh -c "$1"\n'); chmodSync(join(bin, "ssh"), 0o755);
  const prior = process.env.PATH; process.env.PATH = `${bin}:${prior}`;
  t.after(() => { process.env.PATH = prior; });
  assert.throws(() => checkMavenImmutable(f.root, "fake", remote));
  writeFileSync(join(remote, relative), "new-bytes");
  assert.doesNotThrow(() => checkMavenImmutable(f.root, "fake", remote));
});
