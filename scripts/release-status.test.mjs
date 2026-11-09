import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, rmSync, realpathSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer } from "node:net";
import { previousReleaseStatusBlock, releaseStatusBlock, upgradeReleaseStatusDeploy } from "./enable-release-status.mjs";
const root = resolve(import.meta.dirname, "..");
const script = readFileSync(join(root, "scripts/deploy.sh"), "utf8");
test("shared installer is idempotent and preserves coverage, timing and the original exit status", () => {
  const installed = upgradeReleaseStatusDeploy(script);
  assert.equal(installed, script);
  assert.equal(upgradeReleaseStatusDeploy(script.replace(releaseStatusBlock, previousReleaseStatusBlock)), script);
  const old = script.replace(/# BEGIN RELEASE STATUS[\s\S]*?# END RELEASE STATUS/, 'release_timing_stage build_and_restart\necho "==> Rebuilding and restarting"\nremote "cd \'${target}/deploy\' && sudo env MISSIONGO_RELEASE=\'${commit}\' docker compose --env-file \'${env_file}\' up -d --build"');
  assert.equal(upgradeReleaseStatusDeploy(old), script);
  assert.throws(() => upgradeReleaseStatusDeploy(old.replace("check_release_coverage", "no_coverage")), /guards/);
  assert.throws(() => upgradeReleaseStatusDeploy(script.replace("# END RELEASE STATUS", "# missing")), /Partial/);
  assert.ok(script.indexOf('docker compose --env-file \'${env_file}\' build') < script.indexOf("release_status_begin"));
  assert.ok(script.indexOf("release_status_begin") < script.indexOf("up -d --no-build --wait"));
});
test("status lifecycle refuses missing routes and bounds success, failure and interrupted states", () => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "mg-status-")));
  try {
    const bin = join(directory, "bin"); mkdirSync(bin);
    writeFileSync(join(bin, "sudo"), '#!/bin/sh\nexec "$@"\n', { mode: 0o700 });
    const setup = `set -eu\ncommit=abc123\nnotice_origin=https://fixture.invalid\nsource '${root}/scripts/release-status.sh'\nremote() { bash -c "$1"; }\nsleep() { :; }\ncurl() { case "$*" in */health*) printf '{"status":"ok","release":"abc123"}';; *) cat "$release_status_directory/status.json";; esac; }\n`;
    const run = body => spawnSync("bash", ["-c", setup + body], { encoding: "utf8", env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, MISSIONGO_RELEASE_STATUS_DIRECTORY: directory } });
    let result = run('release_status_begin\ncat "$release_status_directory/status.json"\nrelease_status_complete\ncat "$release_status_directory/status.json"');
    assert.equal(result.status, 0, result.stderr);
    const [active, idle] = result.stdout.trim().split("\n").map(JSON.parse);
    assert.equal(active.phase, "upgrading"); assert.ok(active.expiresAt > Date.now()); assert.ok(active.expiresAt <= Date.now() + 600_000);
    assert.equal(idle.phase, "idle");
    result = run('release_status_begin\nfinish() { local code="$1"; release_status_finish "$code"; }\ntrap \'finish "$?"\' EXIT\nexit 17');
    assert.equal(result.status, 17); assert.equal(JSON.parse(readFileSync(join(directory, "status.json"))).phase, "failed");
    result = run('curl() { printf \'{"version":1,"phase":"idle","release":"wrong-cache"}\'; }\nrelease_status_begin\necho switched');
    assert.notEqual(result.status, 0); assert.ok(!result.stdout.includes("switched"));
    result = run('release_status_begin\ncurl() { printf \'{"status":"ok","release":"old"}\'; }\nrelease_status_complete');
    assert.notEqual(result.status, 0);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
async function port() {
  const server = createServer(); await new Promise((yes, no) => { server.once("error", no); server.listen(0, "127.0.0.1", yes); });
  const n = server.address().port; await new Promise(yes => server.close(yes)); return n;
}
test("host nginx serves status and first-load fallback with the application upstream down", async t => {
  const nginx = spawnSync("nginx", ["-v"], { encoding: "utf8" });
  if (nginx.error?.code === "ENOENT") return t.skip("nginx is not installed");
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "mg-status-nginx-")));
  let child;
  try {
    const listen = await port(), upstream = await port();
    for (const file of ["wait.html", "wait.js", "wait.css"]) writeFileSync(join(directory, file), readFileSync(join(root, "deploy/release-status", file)));
    writeFileSync(join(directory, "status.json"), JSON.stringify({ version: 1, phase: "upgrading", expiresAt: Date.now() + 600_000, release: "fixture" }));
    const routes = readFileSync(join(root, "deploy/nginx-release-status.conf"), "utf8").replaceAll("<RELEASE_STATUS_DIRECTORY>", directory);
    writeFileSync(join(directory, "nginx.conf"), `pid ${directory}/pid; error_log ${directory}/error.log; events {} http { access_log off; include mime.types; server { listen 127.0.0.1:${listen}; ${routes} location / { proxy_intercept_errors on; proxy_pass http://127.0.0.1:${upstream}; } } }` .replace("include mime.types;", "types { text/html html; application/javascript js; text/css css; }"));
    child = spawn("nginx", ["-p", directory, "-c", join(directory, "nginx.conf"), "-g", "daemon off;"], { stdio: "ignore" });
    const origin = `http://127.0.0.1:${listen}`;
    let response;
    for (let i = 0; i < 40; i++) {
      try { response = await fetch(`${origin}/release-status.json`); break; } catch { await new Promise(yes => setTimeout(yes, 50)); }
    }
    assert.equal(response?.status, 200, readFileSync(join(directory, "error.log"), "utf8"));
    assert.equal((await response.json()).phase, "upgrading"); assert.equal(response.headers.get("cache-control"), "no-store");
    response = await fetch(origin); assert.equal(response.status, 503); assert.match(await response.text(), /release-wait\/wait.js/);
    for (const file of ["wait.js", "wait.css"]) assert.equal((await fetch(`${origin}/release-wait/${file}`)).status, 200);
  } finally {
    if (child) { const ended = new Promise(yes => child.once("exit", yes)); child.kill("SIGTERM"); await ended; }
    rmSync(directory, { recursive: true, force: true });
  }
});


test("one installer composes missing timing and status, preserves guards, and rejects unknown scripts before writes", () => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "mg-status-install-")));
  const tools = join(directory,"missiongo/release-tools"); mkdirSync(tools,{recursive:true});
  const path = join(tools,"deploy.sh");
  // A legacy shared entry has target/CI/coverage guards, but neither timing nor status.
  const old = script.replace(/# BEGIN RELEASE STATUS[\s\S]*?# END RELEASE STATUS/,
    'echo "==> Rebuilding and restarting"\nremote "cd \'${target}/deploy\' && sudo env MISSIONGO_RELEASE=\'${commit}\' docker compose --env-file \'${env_file}\' up -d --build"')
    .replace(/\n# BEGIN RELEASE TIMING[\s\S]*?# END RELEASE TIMING\n/, "")
    .replace(/^.*release_timing_(?:stage|skip).*\n/gm, "")
    + '\n# release-lock.py MISSIONGO_RELEASE_ROOT\n# node "$RELEASE_TOOLS/release-ci.mjs"\n';
  const run = (...args) => spawnSync(process.execPath,[join(root,"scripts/enable-release-status.mjs"),...args],{
    encoding:"utf8",env:{...process.env,XDG_CONFIG_HOME:directory,MISSIONGO_RELEASE_STATUS_INSTALL_LOCK:"held"}});
  try {
    writeFileSync(path,old,{mode:0o700});
    let result=run();assert.equal(result.status,0,result.stderr);assert.equal(readFileSync(path,"utf8"),old);
    assert.equal(existsSync(join(tools,"release-timing.sh")),false);
    result=run("--apply");assert.equal(result.status,0,result.stderr);
    const installed=readFileSync(path,"utf8");
    assert.match(installed,/# BEGIN RELEASE STATUS/);assert.match(installed,/# BEGIN RELEASE TIMING/);
    for(const guard of ['check_release_coverage','reconcile_release_coverage','release-lock.py','MISSIONGO_RELEASE_ROOT','release-ci.mjs'])assert.ok(installed.includes(guard));
    assert.equal(readFileSync(join(tools,"release-timing.sh"),"utf8"),readFileSync(join(root,"scripts/release-timing.sh"),"utf8"));
    result=run("--apply");assert.equal(result.status,0,result.stderr);assert.equal(readFileSync(path,"utf8"),installed);
    const unknown=old.replace('echo "==> Rebuilding and restarting"','echo "different switch"');writeFileSync(path,unknown);
    result=run("--apply");assert.notEqual(result.status,0);assert.equal(readFileSync(path,"utf8"),unknown);
  } finally {rmSync(directory,{recursive:true,force:true});}
});

test("failure diagnostics distinguish evidence and never include raw command output", () => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "mg-status-reasons-")));
  try {
    const bin = join(directory, "bin"); mkdirSync(bin);
    writeFileSync(join(bin, "sudo"), '#!/bin/sh\nexec "$@"\n', { mode: 0o700 });
    const setup = `set -eu\ncommit=abc123\nnotice_origin=https://fixture.invalid\nsource '${root}/scripts/release-status.sh'\nremote() { bash -c "$1"; }\nsleep() { :; }\ncurl() { cat "$release_status_directory/status.json"; }\nrelease_status_begin\ntrap 'release_status_finish "$?"' EXIT\n`;
    for (const [body, reason, stage] of [
      ['release_failure_stage=restart; release_failure_reason=restart_check_failed; exit 17', 'restart_check_failed', 'restart'],
      ['curl() { return 28; }; release_status_complete', 'health_timeout', 'health'],
      ['curl() { return 7; }; release_status_complete', 'health_unavailable', 'health'],
      ["curl() { printf '%s' 'invalid-private-text'; }; release_status_complete", 'health_invalid', 'health'],
      ["curl() { printf '%s' '{\"status\":\"ok\",\"release\":\"old\"}'; }; release_status_complete", 'health_mismatch', 'health'],
    ]) {
      const result = spawnSync("bash", ["-c", setup + body], { encoding: "utf8", env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, MISSIONGO_RELEASE_STATUS_DIRECTORY: directory } });
      assert.notEqual(result.status, 0);
      const text = readFileSync(join(directory, "status.json"), "utf8");
      const status = JSON.parse(text);
      assert.equal(status.phase, "failed"); assert.equal(status.failure.reason, reason); assert.equal(status.failure.stage, stage);
      assert.ok(status.failure.occurredAt <= Date.now());
      assert.doesNotMatch(text, /invalid-private-text|fixture.invalid/);
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
