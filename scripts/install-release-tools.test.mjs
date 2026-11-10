import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { install, parseInstallArgs } from "./install-release-tools.mjs";

const tools = {
  "release-lock.py": "release-lock.py",
  "release_coverage_options.py": "release_coverage_options.py",
  "release-preflight.mjs": "release-preflight.mjs",
  "release-receipt.mjs": "release-receipt.mjs",
  "release-ci.mjs": "release-ci.mjs",
  "release-ci-wait.mjs": "release-ci-wait.mjs",
  "release-coverage-guard.sh": "release-coverage-guard.sh",
  "release-status.sh": "release-status.sh",
  "release-timing.sh": "release-timing.sh",
  "deploy.sh": "deploy.sh",
  entry: "missiongo-release.py",
};
const sources = {
  "release-lock.py": 'value = "release-lock.py"\n',
  "release_coverage_options.py": 'value = "release_coverage_options.py"\n',
  "release-preflight.mjs": 'syntax = "preflight"\n',
  "release-receipt.mjs": 'syntax = "receipt"\n',
  "release-ci.mjs": 'syntax = "ci"\n',
  "release-ci-wait.mjs": "",
  "release-coverage-guard.sh": "check_release_coverage() { :; }\n",
  "release-timing.sh": "release_timing() { :; }\n",
  "release-status.sh": "release_status_begin() { :; }\n",
  "deploy.sh": "#!/usr/bin/env bash\nexec python3 release-lock.py -- bash deploy.sh \"$@\"\n"
    + "source release-timing.sh\nsource release-coverage-guard.sh\nsource release-status.sh\n"
    + "node release-preflight.mjs\nnode release-receipt.mjs\n",
  "missiongo-release.py": '"""Runs under release-lock.py; node release-ci.mjs runs the CI checks."""\nfrom release_coverage_options import coverage_options\n',
};

const repositoryScripts = join(dirname(fileURLToPath(import.meta.url)));
const repositoryEntry = readFileSync(join(repositoryScripts, "missiongo-release.py"), "utf8");
const real = { ...sources, "missiongo-release.py": repositoryEntry };

function setup({ previous = {}, stale = {}, files = sources } = {}) {
  const source = mkdtempSync(join(tmpdir(), "release-tools-source-"));
  const home = mkdtempSync(join(tmpdir(), "release-tools-home-"));
  const directory = join(home, ".config/missiongo/release-tools");
  mkdirSync(join(source, "scripts"), { recursive: true });
  mkdirSync(directory, { recursive: true });
  mkdirSync(join(home, ".local/bin"), { recursive: true });
  for (const [name, text] of Object.entries(files)) writeFileSync(join(source, "scripts", name), text);
  const target = name => name === "entry" ? join(home, ".local/bin/missiongo-release") : join(directory, name);
  for (const [name, text] of Object.entries(stale)) writeFileSync(target(name), text);
  if (Object.keys(previous).length) writeFileSync(join(home, ".config/missiongo/release-tools-manifest.json"), JSON.stringify(previous));
  const done = () => [source, home].forEach(path => rmSync(path, { recursive: true, force: true }));
  return { source, home, done, target };
}

test("a first install writes every tool, the entry and their digests", () => {
  const { source, home, done, target } = setup();
  try {
    const result = install({ source, home, commit: "a".repeat(40), tools });
    assert.deepEqual(result.changed.sort(), Object.keys(tools).sort());
    for (const [name, file] of Object.entries(tools)) assert.equal(readFileSync(target(name), "utf8"), sources[file]);
    const manifest = JSON.parse(readFileSync(join(home, ".config/missiongo/release-tools-manifest.json"), "utf8"));
    assert.equal(manifest.sourceCommit, "a".repeat(40));
    assert.deepEqual(Object.keys(manifest.tools).sort(), Object.keys(tools).sort());
    assert.ok(Object.values(manifest.tools).every(digest => /^[a-f0-9]{64}$/.test(digest)));
  } finally { done(); }
});

test("custom config roots receive tools and manifests together, preserving the default root", () => {
  const { source, home, done, target } = setup();
  const configHome = join(home, "custom-config");
  try {
    install({ source, home, configHome, tools });
    assert.equal(readFileSync(join(configHome, "missiongo/release-tools/release-ci.mjs"), "utf8"), sources["release-ci.mjs"]);
    assert.ok(existsSync(join(configHome, "missiongo/release-tools-manifest.json")));
    assert.equal(existsSync(target("release-ci.mjs")), false);
    assert.equal(existsSync(join(home, ".config/missiongo/release-tools-manifest.json")), false);
    assert.equal(readFileSync(target("entry"), "utf8"), sources["missiongo-release.py"]);
  } finally { done(); }
});

test("installer arguments reject typos and duplicates instead of enabling writes", () => {
  assert.equal(parseInstallArgs([]), false);
  assert.equal(parseInstallArgs(["--dry-run"]), true);
  for (const args of [["--dryrun"], ["--dry-run", "--dry-run"], ["--install"], ["unexpected"]]) {
    assert.throws(() => parseInstallArgs(args), /Usage:/);
  }
});

test("the public default tool set resolves real repository filenames", () => {
  const { home, done } = setup();
  try {
    const result = install({ home, dryRun: true });
    assert.deepEqual(result.changed.sort(), Object.keys(tools).sort());
  } finally { done(); }
});

test("installs only tools whose digest changed and backs up each replaced file once", () => {
  const { source, home, done, target } = setup({ stale: { "release-ci.mjs": "old cii", entry: "old entry" } });
  try {
    const unchanged = Object.fromEntries(Object.keys(tools).filter(name => !["release-ci.mjs", "entry"].includes(name)).map(name => [name, "f".repeat(64)]));
    writeFileSync(join(home, ".config/missiongo/release-tools-manifest.json"), JSON.stringify({ sourceCommit: "b".repeat(40), tools: { ...unchanged, entry: "f".repeat(64) } }));
    const first = install({ source, home, commit: "c".repeat(40), tools });
    assert.equal(first.changed.includes("deploy.sh"), true);
    writeFileSync(target("release-ci.mjs"), "old cii");
    rmSync(`${target("release-ci.mjs")}.before-release-tools-in-repo`);
    assert.equal(readFileSync(target("release-ci.mjs"), "utf8"), "old cii");
    const result = install({ source, home, commit: "c".repeat(40), tools });
    assert.deepEqual(result.changed, ["release-ci.mjs"]);
    assert.equal(readFileSync(target("release-ci.mjs"), "utf8"), sources["release-ci.mjs"]);
    assert.equal(readFileSync(`${target("release-ci.mjs")}.before-release-tools-in-repo`, "utf8"), "old cii");
    assert.equal(readFileSync(target("entry"), "utf8"), sources["missiongo-release.py"]);
    assert.equal(readFileSync(`${target("entry")}.before-release-tools-in-repo`, "utf8"), "old entry");
  } finally { done(); }
});

test("a dry run reports changes without writing anything", () => {
  const { source, home, done, target } = setup();
  try {
    assert.deepEqual(install({ source, home, commit: "b".repeat(40), tools, dryRun: true }).changed.sort(), Object.keys(tools).sort());
    assert.equal(existsSync(target("deploy.sh")), false);
    assert.equal(existsSync(join(home, ".config/missiongo/release-tools-manifest.json")), false);
  } finally { done(); }
});

test("an unchanged installed digest does not hide a newer source entry", () => {
  const { source, home, done, target } = setup();
  try {
    install({ source, home, commit: "a".repeat(40), tools });
    const updated = sources["missiongo-release.py"] + "# new mandatory gate\n";
    writeFileSync(join(source, "scripts/missiongo-release.py"), updated);
    assert.deepEqual(install({ source, home, commit: "b".repeat(40), tools, dryRun: true }).changed, ["entry"]);
    assert.notEqual(readFileSync(target("entry"), "utf8"), updated);
    assert.deepEqual(install({ source, home, commit: "b".repeat(40), tools }).changed, ["entry"]);
    assert.equal(readFileSync(target("entry"), "utf8"), updated);
    assert.deepEqual(install({ source, home, commit: "b".repeat(40), tools }).changed, []);
  } finally { done(); }
});

test("the repository's own entry and deploy.sh pass the lock and guard checks", () => {
  const { source, home, done } = setup({ files: real });
  try {
    assert.doesNotThrow(() => install({ source, home, commit: "c".repeat(40), tools, dryRun: true }));
  } finally { done(); }
});

test("refuses a deploy.sh or entry that lost the shared guards", () => {
  for (const [file, text] of [["deploy.sh", "#!/usr/bin/env bash\necho deploy\n"], ["missiongo-release.py", "print('no guards')\n"]]) {
    const { source, home, done } = setup();
    try {
      writeFileSync(join(source, "scripts", file), text);
      assert.throws(() => install({ source, home, commit: "c".repeat(40), tools, dryRun: true }), /no longer carries the shared/);
    } finally { done(); }
  }
});

test("accepts the earlier manifest that also recorded identical repository rules", () => {
  const { source, home, done } = setup({ previous: { sourceCommit: "e".repeat(40), tools: {}, globalRulesIdentical: true } });
  try {
    assert.doesNotThrow(() => install({ source, home, commit: "d".repeat(40), tools, dryRun: true }));
    const manifest = JSON.parse(readFileSync(join(home, ".config/missiongo/release-tools-manifest.json"), "utf8"));
    assert.equal(manifest.globalRulesIdentical, true);
  } finally { done(); }
});

test("names which item no longer references a shared guard", () => {
  const { source, home, done } = setup();
  try {
    for (const [file, text, name] of [
      ["deploy.sh", sources["deploy.sh"].replace("source release-coverage-guard.sh\n", ""), "release-coverage-guard.sh"],
      ["deploy.sh", sources["deploy.sh"].replace("node release-receipt.mjs\n", ""), "release-receipt.mjs"],
      ["missiongo-release.py", sources["missiongo-release.py"].replace("release-lock.py", ""), "release-lock.py"],
    ]) {
      writeFileSync(join(source, "scripts", file), text);
      assert.throws(() => install({ source, home, commit: "c".repeat(40), tools, dryRun: true }), new RegExp(`missing: ${name.replace(".", "\\.")}`));
      writeFileSync(join(source, "scripts", file), sources[file]);
    }
    // The CI wait script only serves agents, so neither file has to name it.
    assert.doesNotThrow(() => install({ source, home, commit: "c".repeat(40), tools, dryRun: true }));
  } finally { done(); }
});

test("refuses a manifest with fields it does not understand", () => {
  const { source, home, done } = setup({ previous: { tools: {}, pinned: true } });
  try {
    assert.throws(() => install({ source, home, commit: "d".repeat(40), tools, dryRun: true }), /Unknown release-tools manifest fields: pinned/);
  } finally { done(); }
});

test("the unified installer refuses the actual busy release lock before preflight or writes", async () => {
  const directory = mkdtempSync(join(tmpdir(), "release-install-lock-"));
  const env = { ...process.env, XDG_CONFIG_HOME: directory, MISSIONGO_TOOLS_INSTALL_ENTRY: "" };
  delete env.MISSIONGO_RELEASE_LOCK_FD;
  const holder = spawn("python3", [join(repositoryScripts, "release-lock.py"), "--", process.execPath, "-e", "console.log('locked'); setInterval(()=>{},1000)"],
    { env, stdio: ["ignore", "pipe", "pipe"] });
  try {
    await once(holder.stdout, "data");
    const result = spawnSync(process.execPath, [join(repositoryScripts, "install-release-tools.mjs")], { env, encoding: "utf8", timeout: 5000 });
    assert.equal(result.status, 75); assert.match(result.stderr, /already locked/);
    assert.equal(existsSync(join(directory, "missiongo/release-tools-manifest.json")), false);
  } finally {
    const stopped = once(holder, "exit"); holder.kill(); await stopped;
    rmSync(directory, { recursive: true, force: true });
  }
});
