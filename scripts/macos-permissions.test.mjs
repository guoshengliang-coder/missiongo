import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = fileURLToPath(new URL("../", import.meta.url));
const script = join(root, "scripts/sign-macos-app.sh");

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "missiongo-signing-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const log = join(dir, "commands.log");
  for (const tool of ["codesign", "ditto", "spctl", "xcrun"]) {
    writeFileSync(join(dir, tool), `#!/bin/sh
printf '%s' '${tool}' >> "$TEST_SIGN_LOG"
for arg in "$@"; do printf ' [%s]' "$arg" >> "$TEST_SIGN_LOG"; done
printf '\\n' >> "$TEST_SIGN_LOG"
if [ '${tool}' = xcrun ] && [ "$1" = notarytool ]; then
  printf '{"status":"%s"}\\n' "$TEST_NOTARY_STATUS"
fi
if [ '${tool}' = spctl ]; then exit "$TEST_SPCTL_EXIT"; fi
`, { mode: 0o755 });
  }
  const env = {
    ...process.env,
    PATH: `${dir}:${dirname(process.execPath)}:${process.env.PATH}`,
    MISSIONGO_MACOS_SIGNING_IDENTITY: "",
    MISSIONGO_MACOS_NOTARY_PROFILE: "",
    MISSIONGO_MACOS_RELEASE: "0",
    MISSIONGO_MACOS_ALLOW_AD_HOC: "0",
    TEST_SIGN_LOG: log,
    TEST_NOTARY_STATUS: "Accepted",
    TEST_SPCTL_EXIT: "0",
  };
  return {
    run: (overrides = {}, args = ["Test App.app", "Test App.zip"]) => spawnSync("sh", [script, ...args], { env: { ...env, ...overrides }, encoding: "utf8" }),
    log: () => { try { return readFileSync(log, "utf8"); } catch { return ""; } },
  };
}

const release = {
  MISSIONGO_MACOS_RELEASE: "1",
  MISSIONGO_MACOS_SIGNING_IDENTITY: "Developer ID Application: Test Team (TEST123)",
  MISSIONGO_MACOS_NOTARY_PROFILE: "test-notary-profile",
};

test("release refuses missing credentials before signing or packaging", (t) => {
  const f = fixture(t);
  for (const env of [
    { MISSIONGO_MACOS_RELEASE: "1" },
    { ...release, MISSIONGO_MACOS_SIGNING_IDENTITY: "-" },
    { ...release, MISSIONGO_MACOS_NOTARY_PROFILE: "" },
  ]) assert.notEqual(f.run(env).status, 0);
  assert.equal(f.log(), "");
  assert.notEqual(f.run({}, ["--check-release-config"]).status, 0);
});

test("development build remains available without release credentials", (t) => {
  const f = fixture(t);
  assert.equal(f.run().status, 0);
  assert.match(f.log(), /codesign \[--force\] \[--sign\] \[-\]/);
  assert.doesNotMatch(f.log(), /notarytool|stapler/);
});

test("explicit ad-hoc release does not require certificates or notarization", (t) => {
  const f = fixture(t);
  const result = f.run({ MISSIONGO_MACOS_RELEASE: "1", MISSIONGO_MACOS_ALLOW_AD_HOC: "1" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /explicitly publishing without Developer ID/);
  assert.match(f.log(), /codesign \[--force\] \[--sign\] \[-\]/);
  assert.match(f.log(), /codesign \[--verify\] \[--deep\] \[--strict\]/);
  assert.doesNotMatch(f.log(), /notarytool|stapler|spctl/);
});

test("release signs, notarizes, staples, assesses and repackages in order", (t) => {
  const f = fixture(t);
  const result = f.run(release);
  assert.equal(result.status, 0, result.stderr);
  const lines = f.log().trim().split("\n");
  assert.equal(lines.length, 8);
  assert.match(lines[0], /\[Developer ID Application: Test Team \(TEST123\)\] \[--options\] \[runtime\] \[--timestamp\]/);
  assert.match(lines[1], /codesign \[--verify\]/);
  assert.match(lines[2], /ditto.*\[Test App.app\] \[Test App.zip\]/);
  assert.match(lines[3], /notarytool.*\[--keychain-profile\] \[test-notary-profile\].*\[--wait\]/);
  assert.match(lines[4], /stapler\] \[staple\]/);
  assert.match(lines[5], /stapler\] \[validate\]/);
  assert.match(lines[6], /spctl \[--assess\]/);
  assert.match(lines[7], /^ditto/);
});

test("notarization rejection cannot proceed to stapling or a successful release", (t) => {
  const f = fixture(t);
  assert.notEqual(f.run({ ...release, TEST_NOTARY_STATUS: "Invalid" }).status, 0);
  assert.doesNotMatch(f.log(), /stapler|spctl/);
});

test("Gatekeeper rejection fails the release", (t) => {
  const f = fixture(t);
  assert.notEqual(f.run({ ...release, TEST_SPCTL_EXIT: "1" }).status, 0);
  assert.equal(f.log().match(/^ditto/gm)?.length, 1);
});

test("publisher cannot bypass release signing with allow-republish", () => {
  const source = readFileSync(join(root, "scripts/publish-macos.sh"), "utf8");
  assert.match(source, /export MISSIONGO_MACOS_RELEASE=1/);
  assert.match(source, /export MISSIONGO_MACOS_ALLOW_AD_HOC="\$allow_ad_hoc"/);
  assert.match(source, /--allow-ad-hoc\) allow_ad_hoc=1/);
  assert.ok(source.indexOf("--check-release-config") < source.indexOf('if [ "$allow_republish"'));
});

test("application background paths do not invoke history scans or login/skill timers", () => {
  const source = readFileSync(join(root, "apps/macos/Sources/MissionGo/AppModel.swift"), "utf8");
  assert.doesNotMatch(source, /RepoCandidates\.detect|startClaudeTimer|startSkillTimer|ClaudeJson\.read|enableLaunchAtLoginAfterFirstLogin/);
  assert.match(source, /loadCredential\(allowInteraction: false\)/);
  assert.match(source, /ConsentedAgentAdapter\(agent: \.claudeCode/);
  assert.match(source, /ConsentedAgentAdapter\(agent: \.codex/);
  const updater = readFileSync(join(root, "apps/macos/Sources/MissionGoNodeCore/AppUpdater.swift"), "utf8");
  assert.doesNotMatch(updater, /\/usr\/bin\/xattr/);
});
