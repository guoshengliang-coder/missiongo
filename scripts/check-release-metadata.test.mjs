import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { isReleaseMetadata, validateReleaseMetadata } from "./check-release-metadata.mjs";

function fixture(run) {
  const root = mkdtempSync(join(tmpdir(), "missiongo-ci-metadata-"));
  const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  const put = (path, value) => { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), typeof value === "string" ? value : JSON.stringify(value)); };
  try {
    git("init", "-q"); git("config", "user.name", "CI Fixture"); git("config", "user.email", "ci@example.test");
    put("apps/macos/version.properties", "missiongoMacosVersion=1.0.0\n");
    git("add", "."); git("commit", "-qm", "source");
    const record = { version: "1.0.0", commit: git("rev-parse", "HEAD"), versionFile: "apps/macos/version.properties", versionProperty: "missiongoMacosVersion", paths: ["apps/macos"] };
    put("released.json", { artifacts: { macosApp: record } });
    git("add", "."); git("commit", "-qm", "ledger");
    const base = git("rev-parse", "HEAD");
    const check = changes => validateReleaseMetadata({ root, base, changes: changes ?? [{ path: "released.json", status: "M" }] });
    run({ root, git, put, record, base, check });
  } finally { rmSync(root, { recursive: true, force: true }); }
}

test("publication facts validate against real ancestry and the version declaration", () => fixture(({ put, record, base, check }) => {
  put("released.json", { artifacts: { macosApp: { ...record, commit: base, sha256: "a".repeat(64) } } });
  assert.equal(check(), true);
  for (const change of [{ version: "bad" }, { version: "1.0.1" }, { commit: "f".repeat(40) }, { commit: null }, { sha256: "bad" }]) {
    put("released.json", { artifacts: { macosApp: { ...record, ...change } } });
    assert.throws(() => check());
  }
}));

test("artifact inventory and build input changes cannot use the metadata fast path", () => fixture(({ put, record, check }) => {
  for (const change of [{ paths: ["services/server"] }, { versionFile: "other.json" }, { versionProperty: "otherVersion" }]) {
    put("released.json", { artifacts: { macosApp: { ...record, ...change } } });
    assert.equal(check(), false);
  }
  put("released.json", { artifacts: {} }); assert.equal(check(), false);
  put("released.json", { artifacts: { macosApp: record, extra: record } }); assert.equal(check(), false);
  put("released.json", { artifacts: { macosApp: record }, extra: true }); assert.equal(check(), false);
  put("released.json", { artifacts: [] }); assert.throws(() => check());
  put("released.json", "{"); assert.throws(() => check());
}));

test("release notes reuse the publisher's item rules and reject malformed PR identifiers", () => fixture(({ put, check }) => {
  const macos = "release-notes/macos/pr-123.json", android = "release-notes/android/pr-123.json";
  const changed = path => [{ path, status: "A" }];
  put(macos, { pullRequest: 123, items: [{ key: "PR-123", title: "更新说明" }] });
  assert.equal(check(changed(macos)), true);
  put(android, { items: [{ title: "更新说明" }] }); assert.equal(check(changed(android)), true);
  for (const value of ["{", { items: [{}] }, { items: [{ title: "missing key" }] }, { items: [] , pullRequest: -1 }, { items: [], pullRequest: "123" }]) {
    put(macos, value); assert.throws(() => check(changed(macos)));
  }
  for (const status of ["D", "T"]) assert.equal(check([{ path: macos, status }]), false);
  for (const path of ["release-notes/macos/../runtime.json", "release-notes/unknown/note.json", "released.json.js"]) assert.equal(isReleaseMetadata(path), false);
}));

test("an existing but unrelated source commit is refused", () => fixture(({ git, put, record, base, check }) => {
  git("checkout", "--orphan", "unrelated"); git("commit", "--allow-empty", "-qm", "unrelated source");
  const unrelated = git("rev-parse", "HEAD"); git("checkout", "--detach", base);
  put("released.json", { artifacts: { macosApp: { ...record, commit: unrelated } } });
  assert.throws(() => check());
}));
