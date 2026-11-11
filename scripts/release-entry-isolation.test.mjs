import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { closeSync, existsSync, ftruncateSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { fixtureGit } from "../tests/release/fixture-git.mjs";

const cleanEnv = { PATH: process.env.PATH, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
const cleanGit = (root, ...args) => execFileSync("git", args, { cwd: root, env: cleanEnv, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const commitArgs = ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", "commit", "-m", "fixture"];

test("inherited Git repository, index and hooks cannot redirect the installed-entry fixture", () => {
  const dir = mkdtempSync(join(tmpdir(), "and506-git-isolation-"));
  const candidate = join(dir, "candidate"), unrelated = join(dir, "unrelated"), hookDir = join(dir, "hooks"), marker = join(dir, "hook-ran"), globalConfig = join(dir, "global.gitconfig");
  const injected = { GIT_DIR: join(unrelated, ".git"), GIT_WORK_TREE: unrelated, GIT_INDEX_FILE: join(unrelated, ".git/index"),
    GIT_CONFIG_GLOBAL: globalConfig, GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "core.hooksPath", GIT_CONFIG_VALUE_0: hookDir };
  const previous = Object.fromEntries(Object.keys(injected).map(k => [k, process.env[k]]));
  try {
    for (const root of [candidate, unrelated]) {
      mkdirSync(root); cleanGit(root, "init", "-b", "main"); writeFileSync(join(root, "file.txt"), "old"); cleanGit(root, "add", "."); cleanGit(root, ...commitArgs);
    }
    mkdirSync(hookDir); writeFileSync(join(hookDir, "pre-commit"), `#!/bin/sh\nprintf bad > '${marker}'\n`, { mode: 0o700 });
    writeFileSync(globalConfig, `[core]\n hooksPath = ${hookDir}\n`);
    const unrelatedHead = cleanGit(unrelated, "rev-parse", "HEAD"), unrelatedIndex = readFileSync(join(unrelated, ".git/index"));
    writeFileSync(join(candidate, "file.txt"), "candidate change"); writeFileSync(join(unrelated, "file.txt"), "must stay uncommitted");
    Object.assign(process.env, injected);
    fixtureGit(candidate, "add", "."); fixtureGit(candidate, ...commitArgs);
    assert.equal(cleanGit(unrelated, "rev-parse", "HEAD"), unrelatedHead, "Fixture committed outside its own repository");
    assert.deepEqual(readFileSync(join(unrelated, ".git/index")), unrelatedIndex);
    assert.equal(existsSync(marker), false, "Fixture ran an inherited hook");
    assert.equal(cleanGit(candidate, "show", "HEAD:file.txt"), "candidate change");
  } finally {
    for (const [k, v] of Object.entries(previous)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("stage evidence reader rejects symlinks, FIFOs and oversized files without following or waiting", () => {
  const dir = mkdtempSync(join(tmpdir(), "and505-progress-isolation-"));
  const path = join(dir, "progress.json"), external = join(dir, "external");
  const moduleUrl = new URL("./release-performance-stages.mjs", import.meta.url).href;
  const runReader = (url, timeout = 2000) => spawnSync(process.execPath, ["--input-type=module", "-e",
    `import {readStageProgress} from ${JSON.stringify(url)}; if(readStageProgress(${JSON.stringify(dir)})!==null)process.exit(2); console.log('REJECTED');`],
  { timeout, killSignal: "SIGKILL", encoding: "utf8", env: { PATH: process.env.PATH } });
  const rejected = () => {
    const result = runReader(moduleUrl);
    assert.equal(result.error, undefined); assert.equal(result.status, 0, result.stderr); assert.equal(result.stdout.trim(), "REJECTED");
  };
  try {
    writeFileSync(external, "do not read");
    execFileSync("python3", ["-c", "import os,sys;os.symlink(sys.argv[1],sys.argv[2])", external, path]);
    rejected(); rmSync(path);
    execFileSync("python3", ["-c", "import os,sys;os.mkfifo(sys.argv[1])", path]);
    rejected();
    // The negative control really hangs at open(), but cannot hang this test.
    const original = readFileSync(new URL(moduleUrl), "utf8"), needle = " | constants.O_NONBLOCK";
    assert.ok(original.includes(needle));
    const mutant = join(dir, "blocking-reader.mjs"); writeFileSync(mutant, original.replace(needle, ""));
    const blocked = runReader(pathToFileURL(mutant).href, 200);
    assert.equal(blocked.error?.code, "ETIMEDOUT"); assert.equal(blocked.signal, "SIGKILL");
    rmSync(path);
    const fd = openSync(path, "w");
    try { ftruncateSync(fd, 256 * 1024 * 1024); } finally { closeSync(fd); }
    rejected();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
