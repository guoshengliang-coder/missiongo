import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { install } from "./install-release-tools.mjs";

const tools = {
  "release-lock.py": "release-lock.py",
  "release_coverage_options.py": "release_coverage_options.py",
  "release-preflight.mjs": "release-preflight.mjs",
  "release-receipt.mjs": "release-receipt.mjs",
  "release-ci.mjs": "release-ci.mjs",
  "release-ci-wait.mjs": "release-ci-wait.mjs",
  "release-coverage-guard.sh": "release-coverage-guard.sh",
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
  "deploy.sh": "#!/usr/bin/env bash\nexec python3 release-lock.py -- bash deploy.sh \"$@\"\n"
    + "source release-timing.sh\nsource release-coverage-guard.sh\n"
    + "node release-preflight.mjs\nnode release-receipt.mjs\nnode release-ci-wait.mjs\nnode release-ci.mjs\n",
  "missiongo-release.py": 'from release_coverage_options import coverage_options  # run under release-lock.py\nprint(coverage_options)\n',
};

function setup({ previous = {}, stale = {} } = {}) {
  const source = mkdtempSync(join(tmpdir(), "release-tools-source-"));
  const home = mkdtempSync(join(tmpdir(), "release-tools-home-"));
  const directory = join(home, ".config/missiongo/release-tools");
  mkdirSync(join(source, "scripts"), { recursive: true });
  mkdirSync(directory, { recursive: true });
  mkdirSync(join(home, ".local/bin"), { recursive: true });
  for (const [name, text] of Object.entries(sources)) writeFileSync(join(source, "scripts", name), text);
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

test("refuses a deploy.sh or entry that lost the shared guards", () => {
  for (const [file, text] of [["deploy.sh", "#!/usr/bin/env bash\necho deploy\n"], ["missiongo-release.py", "print('no guards')\n"]]) {
    const { source, home, done } = setup();
    try {
      writeFileSync(join(source, "scripts", file), text);
      assert.throws(() => install({ source, home, commit: "c".repeat(40), tools, dryRun: true }), /no longer carries the shared/);
    } finally { done(); }
  }
});

test("refuses a manifest with fields it does not understand", () => {
  const { source, home, done } = setup({ previous: { tools: {}, pinned: true } });
  try {
    assert.throws(() => install({ source, home, commit: "d".repeat(40), tools, dryRun: true }), /Unknown release-tools manifest fields: pinned/);
  } finally { done(); }
});
