import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { releaseStatusBlock, withoutReleaseStatus } from "./enable-release-status.mjs";
import { installTiming, instrumentDeploy } from "./enable-release-timing.mjs";

const scripts = dirname(fileURLToPath(import.meta.url));
function temporary(t) {
  const root = mkdtempSync(join(tmpdir(), "mg-release-timing-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}
function run(root, body) {
  return spawnSync("/bin/bash", ["-c", 'set -euo pipefail; source "$1"; release_timing_start; ' + body, "fixture", join(scripts, "release-timing.sh")], {
    env: { ...process.env, MISSIONGO_RELEASE_TIMING_DIR: root, PRIVATE_TOKEN: "must-not-appear", SECRET_HOST: "private.invalid" }, encoding: "utf8", timeout: 10_000,
  });
}
const report = root => JSON.parse(readFileSync(join(root, readdirSync(root).find(f => f.endsWith(".json"))), "utf8"));

test("Bash timing preserves receipt stdout, records phases/skips and excludes private inputs", t => {
  const root = temporary(t);
  const r = run(root, 'commit=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa; release_timing_stage preflight; SECONDS=$((SECONDS+2)); release_timing_stage upload; (release_timing_stage child); value=$(printf child); release_timing_skip backup; release_timing_stage public_verification; printf \'{"receipt":true}\\n\'');
  assert.equal(r.status, 0, r.stderr); assert.equal(r.stdout, '{"receipt":true}\n');
  const data = report(root);
  assert.equal(data.exitCode, 0); assert.equal(data.commit, "a".repeat(40)); assert(data.durationSeconds >= 2);
  assert.deepEqual(data.stages.map(s => [s.name, s.status]), [["preflight", "passed"], ["upload", "passed"], ["backup", "skipped"], ["public_verification", "passed"]]);
  assert(data.stages[0].durationSeconds >= 2);
  assert(!JSON.stringify(data).includes("must-not-appear")); assert(!JSON.stringify(data).includes("private.invalid"));
});

test("failed commands and TERM retain exit codes and stop subsequent work", t => {
  for (const [command, code] of [["(exit 42)", 42], ["kill -TERM $$", 143]]) {
    const root = join(temporary(t), String(code)); mkdirSync(root);
    const r = run(root, `release_timing_stage upload; ${command}; echo should-not-run`);
    assert.equal(r.status, code, r.stderr); assert.equal(r.stdout, "");
    assert.equal(report(root).exitCode, code); assert.equal(report(root).stages[0].status, "failed");
  }
});

test("empty timings and unavailable/report-write-failed destinations do not change deployment outcome", t => {
  const root = temporary(t);
  assert.equal(run(root, "true").status, 0); assert.deepEqual(report(root).stages, []);
  const file = join(root, "not-a-directory"); writeFileSync(file, "preserved");
  const unavailable = run(file, "release_timing_stage upload; printf receipt");
  assert.equal(unavailable.status, 0); assert.equal(unavailable.stdout, "receipt"); assert.match(unavailable.stderr, /Warning/);
  assert.equal(readFileSync(file, "utf8"), "preserved");
  const writeFailure = run(root, 'release_timing_stage upload; rm "$RELEASE_TIMING_OUTPUT"; mkdir "$RELEASE_TIMING_OUTPUT"; printf receipt');
  assert.equal(writeFailure.status, 0); assert.equal(writeFailure.stdout, "receipt"); assert.match(writeFailure.stderr, /Warning/);
});

const actualDeploy = readFileSync(join(scripts, "deploy.sh"), "utf8");
const currentDeploy = withoutReleaseStatus(actualDeploy);
const original = currentDeploy.replace(/\n# BEGIN RELEASE TIMING[\s\S]*?# END RELEASE TIMING\n/, "")
  .replace(/^.*release_timing_(?:stage|skip).*\n/gm, "");
const instrumented = instrumentDeploy(original);
// An installed entry has additional guards and intentionally different Maven behavior.
const installed = original.replace('cd "$(dirname "$0")/.."', 'cd "${MISSIONGO_RELEASE_ROOT:-$(dirname "$0")/..}"\nRELEASE_TOOLS="${MISSIONGO_RELEASE_TOOLS:-$PWD/scripts}"')
  .replace('# Carry the published SDK artifacts over', '# Preserve all historical Maven versions')
  .replace('  command -v gh', '  node "$RELEASE_TOOLS/release-ci.mjs" # release-lock.py\n  command -v gh')
  .replace("# checkout has none of its own.", "# checkout has none of its own.\n# preserve cp -an historical versions");

test("instrumentation is idempotent, makes only additive hooks, and refuses unknown/partial/trapped scripts", () => {
  assert.equal(instrumentDeploy(actualDeploy), actualDeploy);
  assert.equal(instrumentDeploy(instrumented), instrumented);
  assert.equal(instrumented, currentDeploy);
  const added = instrumented.split("\n").filter(line => !original.split("\n").includes(line));
  assert(added.every(line => (line = line.trimStart(), line.startsWith("release_timing_") || line.startsWith("if ") || line.startsWith("# ") || line.startsWith("source "))));
  assert.equal(instrumentDeploy(installed).includes("# preserve cp -an historical versions"), true);
  for (const source of [original.replace('echo "==> Pushing ${release}"', "unknown"), 'trap true EXIT\n' + original,
    instrumented.replace("release_timing_start\n", ""), original + "\nrelease_timing_stage upload\n"]) assert.throws(() => instrumentDeploy(source));
  execFileSync("bash", ["-n"], { input: instrumented });
});

test("a status switch without a recognisable block, or an unrecognised one, is refused rather than erased", () => {
  // The switch as an entry that never had a timing stage ran it.
  const switchless = 'echo "==> Rebuilding and restarting"\nremote "cd \'${target}/deploy\' && sudo env MISSIONGO_RELEASE=\'${commit}\' docker compose --env-file \'${env_file}\' up -d --build"';
  const legacy = original.replace('release_timing_stage build_and_restart\necho "==> Rebuilding and restarting"', switchless);
  // It is recognized as this entry's switch and the timing stage is put back.
  assert.equal(instrumentDeploy(legacy), instrumentDeploy(original));
  // An installation that was left half written or edited locally is not erased;
  // a block that was never installed leaves the untimed switch as it is.
  const head = "# BEGIN RELEASE STATUS\n", tail = "# END RELEASE STATUS";
  for (const [name, source] of [
    ["head only", actualDeploy.replace(releaseStatusBlock, head)],
    ["tail only", actualDeploy.replace(releaseStatusBlock, tail)],
    ["edited", actualDeploy.replace("release_status_begin", "release_status_begin # local edit")],
    ["repeated", actualDeploy.replace(releaseStatusBlock, releaseStatusBlock + "\n" + releaseStatusBlock)],
  ]) {
    assert.throws(() => withoutReleaseStatus(source), /Partial/, name);
    assert.throws(() => instrumentDeploy(source), /Partial/, name);
  }
  assert.equal(withoutReleaseStatus(legacy), legacy);
});

test("shared installer previews without writes, retains guards/customizations, backs up once and preserves unknown helper edits", t => {
  const root = temporary(t), tools = join(root, "missiongo/release-tools"); mkdirSync(tools, { recursive: true });
  const path = join(tools, "deploy.sh"); writeFileSync(path, installed, { mode: 0o700 });
  assert.equal(installTiming({ configHome: root }).changed, true); assert.deepEqual(readdirSync(tools), ["deploy.sh"]);
  assert.equal(installTiming({ configHome: root, install: true }).changed, true);
  assert.equal(readFileSync(`${path}.before-release-timing`, "utf8"), installed);
  assert.equal(readFileSync(path, "utf8"), instrumentDeploy(installed));
  assert.equal(installTiming({ configHome: root, install: true }).changed, false);
  writeFileSync(join(tools, "release-timing.sh"), "local changes");
  assert.throws(() => installTiming({ configHome: root, install: true }), /unknown local changes/);
  assert.equal(readFileSync(join(tools, "release-timing.sh"), "utf8"), "local changes");
});

test("installer stops at a busy OS release lock without reading or changing deploy files", t => {
  const root = temporary(t), tools = join(root, "missiongo/release-tools"); mkdirSync(tools, { recursive: true });
  writeFileSync(join(tools, "release-lock.py"), [
    "import fcntl,os,sys", 'fd=os.open(os.path.join(os.environ["XDG_CONFIG_HOME"],"missiongo/release.lock"),os.O_CREAT|os.O_RDWR,0o600)',
    "try: fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB)", "except BlockingIOError: sys.exit(75)",
    "os.set_inheritable(fd,True)", "os.execvp(sys.argv[2],sys.argv[2:])", "",
  ].join("\n"));
  const r = spawnSync("python3", ["-c", "import fcntl,subprocess,sys; f=open(sys.argv[1],'w'); fcntl.flock(f,fcntl.LOCK_EX); sys.exit(subprocess.run(sys.argv[2:]).returncode)",
    join(root, "missiongo/release.lock"), process.execPath, join(scripts, "enable-release-timing.mjs"), "--install"],
  { env: { ...process.env, XDG_CONFIG_HOME: root, MISSIONGO_TIMING_INSTALL_ENTRY: "" }, encoding: "utf8", timeout: 10_000 });
  assert.equal(r.status, 75, r.stderr); assert.equal(existsSync(join(tools, "release-timing.sh")), false);
});

test("the instrumented deploy refuses a failed preflight before any remote action", t => {
  const root = temporary(t), tools = join(root, "scripts"), bin = join(root, "bin"), timings = join(root, "timings");
  mkdirSync(tools); mkdirSync(bin); mkdirSync(join(root, "deploy"));
  writeFileSync(join(root, "deploy/docker-compose.yml"), "fixture");
  writeFileSync(join(tools, "deploy.sh"), instrumented);
  writeFileSync(join(tools, "release-timing.sh"), readFileSync(join(scripts, "release-timing.sh")));
  writeFileSync(join(bin, "git"), "#!/bin/sh\nexit 37\n", { mode: 0o700 });
  const marker = join(root, "remote-write");
  for (const name of ["ssh", "rsync"]) writeFileSync(join(bin, name), '#!/bin/sh\ntouch "$TIMING_REMOTE_MARKER"\n', { mode: 0o700 });
  const r = spawnSync("/bin/bash", [join(tools, "deploy.sh"), "--host", "fixture", "--env-file", "/fixture/env"], {
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, MISSIONGO_RELEASE_ROOT: root, MISSIONGO_RELEASE_TOOLS: tools, MISSIONGO_RELEASE_TIMING_DIR: timings, TIMING_REMOTE_MARKER: marker }, encoding: "utf8", timeout: 10_000,
  });
  assert.equal(r.status, 1, r.stderr); assert.equal(existsSync(marker), false);
  assert.equal(report(timings).stages[0].name, "preflight"); assert.equal(report(timings).stages[0].status, "failed");
});
