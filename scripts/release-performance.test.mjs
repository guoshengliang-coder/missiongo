import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "node:test";
import { backupCommand, discoverBackupProgram, fetchBackup, validateManifest } from "./release-backup.mjs";
import { runPerformanceGroup } from "./performance-watchdog.mjs";
import { installPerformance, upgradePerformanceCoordinator } from "./enable-release-performance.mjs";
import { runReleasePerformance } from "./release-performance.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const temp = () => realpathSync(mkdtempSync(join(tmpdir(), "and489-test-")));
const base = () => readFileSync(join(root, "scripts/fixtures/coverage-coordinator.py.txt"), "utf8")
  .replace('    args = sys.argv[2:]', '    args, coverage_args = coverage_options(sys.argv[2:])')
  .replace('    if "--no-publish-apk" in args:', '    preflight.extend(coverage_args)\n    if "--no-publish-apk" in args:')
  .replace('    # Keep the lock', '    os.environ["MISSIONGO_RELEASE_CANDIDATES"] = "fixture"\n    # Keep the lock')
  .replace('def main():', 'def coverage_options(args):\n    return args, []\n\n\ndef main():');
const manifest = bytes => ({ formatVersion: 1, directory: "missiongo-20260101T000000Z", createdAt: "2026-01-01T00:00:00.000Z",
  database: { filename: "missiongo.sqlite", sizeBytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") } });

test("manifest validation rejects unsafe names, invalid digests, size and future dates", () => {
  const valid = manifest(Buffer.from("fixture")); assert.equal(validateManifest(valid), valid);
  for (const edit of [m => m.directory = "../escape", m => m.database.filename = "../data.sqlite", m => m.database.sha256 = "bad",
    m => m.database.sizeBytes = 0, m => m.createdAt = "9999-01-01T00:00:00Z", m => m.formatVersion = 9]) {
    const copy = structuredClone(valid); edit(copy); assert.throws(() => validateManifest(copy));
  }
  assert.ok(backupCommand("program", ["/path with ' quote"]).includes("'\\''"));
});

test("remote discovery reads complete regular backups and orders by creation time", () => {
  const dir = temp();
  try {
    const bytes = Buffer.from("SQLite fixture"), m = manifest(bytes);
    const child = join(dir, m.directory); mkdirSync(child); writeFileSync(join(child, "manifest.json"), JSON.stringify(m)); writeFileSync(join(child, m.database.filename), bytes);
    const latest = { ...m, directory: "missiongo-20260102T000000Z", createdAt: "2026-01-02T00:00:00Z" };
    mkdirSync(join(dir, latest.directory)); writeFileSync(join(dir, latest.directory, "manifest.json"), JSON.stringify(latest)); writeFileSync(join(dir, latest.directory, m.database.filename), bytes);
    assert.equal(JSON.parse(execFileSync("python3", ["-c", discoverBackupProgram, dir], { encoding: "utf8" })).directory, latest.directory);
    // Fake SSH executes neither sudo nor any network: output bytes go directly
    // to a file descriptor, never into an exception or a tool response.
    const ssh = join(dir, "ssh");
    writeFileSync(ssh, `#!/usr/bin/env python3\nimport sys\nif 'MISSIONGO_BACKUP_TRANSFER_V1' in sys.argv[-1]: sys.stdout.buffer.write(${JSON.stringify(bytes.toString())}.encode())\nelse: print(${JSON.stringify(JSON.stringify(m))})\n`, { mode: 0o700 });
    const destination = join(dir, "copy"); mkdirSync(destination);
    const result = fetchBackup({ host: "fixture", backupsDir: dir, directory: destination, ssh });
    assert.equal(readFileSync(result.database, "utf8"), bytes.toString());
    writeFileSync(ssh, readFileSync(ssh, "utf8").replace(JSON.stringify(bytes.toString()), '"CORRUPT"'));
    const bad = join(dir, "bad"); mkdirSync(bad);
    assert.throws(() => fetchBackup({ host: "fixture", backupsDir: dir, directory: bad, ssh }), /size mismatch/);
    const sameSize = Buffer.alloc(bytes.length, "x").toString();
    writeFileSync(ssh, readFileSync(ssh, "utf8").replace('"CORRUPT"', JSON.stringify(sameSize)));
    const tampered = join(dir, "tampered"); mkdirSync(tampered);
    assert.throws(() => fetchBackup({ host: "fixture", backupsDir: dir, directory: tampered, ssh }), /digest mismatch/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("watchdog kills descendants as well as a synchronously stuck worker", async () => {
  const dir = temp();
  try {
    const marker = join(dir, "escaped");
    const code = `require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(`setTimeout(()=>require('node:fs').writeFileSync(${JSON.stringify(marker)},'bad'),600)`)}],{stdio:'ignore'}); while(true){}`;
    const result = await runPerformanceGroup(["-e", code], 150, { stdio: "ignore" });
    assert.equal(result.timedOut, true);
    await new Promise(resolve => setTimeout(resolve, 800));
    assert.equal(existsSync(marker), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("loopback guard rejects outbound fetch, TCP, TLS and datagrams", () => {
  const result = execFileSync(process.execPath, ["--input-type=module", "-e", `
    import assert from 'node:assert/strict'; import net from 'node:net'; import tls from 'node:tls'; import dgram from 'node:dgram';
    import {restrictToLoopback} from './scripts/release-performance-network.mjs'; restrictToLoopback();
    assert.throws(()=>fetch('https://example.invalid')); assert.throws(()=>net.connect({host:'192.0.2.1',port:80}));
    assert.throws(()=>tls.connect({host:'127.0.0.1',port:443})); assert.throws(()=>dgram.createSocket('udp4'));
    console.log('blocked');`], { cwd: root, encoding: "utf8" });
  assert.equal(result.trim(), "blocked");
});

test("supervisor deletes data on success, error and timeout and never accepts missing output", async () => {
  const dir = temp();
  try {
    mkdirSync(join(dir, "tests/performance"), { recursive: true });
    copyFileSync(join(root, "tests/performance/server-budgets.json"), join(dir, "tests/performance/server-budgets.json"));
    const worker = join(dir, "worker.mjs"), seen = join(dir, "seen");
    const prefix = `import fs from 'node:fs'; import path from 'node:path'; const dir=process.argv[2]; fs.writeFileSync(${JSON.stringify(seen)},dir); fs.writeFileSync(path.join(dir,'sensitive.sqlite'),'SENSITIVE');`;
    writeFileSync(worker, prefix + "fs.writeFileSync(path.join(dir,'result.json'),JSON.stringify({status:'passed'}));");
    assert.equal((await runReleasePerformance({ root: dir }, { worker })).status, "passed");
    assert.equal(existsSync(readFileSync(seen, "utf8")), false);
    writeFileSync(worker, prefix + "fs.writeFileSync(path.join(dir,'result.json'),JSON.stringify({status:'passed',experiment:'release-fivefold-claim-next',httpTargets:[{name:'claim-next',status:'passed'}]}));");
    const missed = await runReleasePerformance({ root: dir }, { worker });
    assert.equal(missed.status, "invalid"); assert.equal(missed.diagnosticOutcome, "not_detected");
    assert.equal(missed.measurementStatus, "passed");
    writeFileSync(worker, prefix + "fs.writeFileSync(path.join(dir,'result.json'),JSON.stringify({status:'failed',experiment:'release-fivefold-claim-next',calibration:{valid:false},httpCalibration:{valid:true},httpTargets:[{name:'claim-next',status:'exceeded'}]}));process.exitCode=1;");
    const invalidCalibration = await runReleasePerformance({ root: dir }, { worker });
    assert.equal(invalidCalibration.status, "invalid");
    assert.equal(invalidCalibration.diagnosticOutcome, "not_detected");
    assert.equal(existsSync(readFileSync(seen, "utf8")), false);
    writeFileSync(worker, prefix + "process.exit(1);");
    assert.equal((await runReleasePerformance({ root: dir }, { worker })).status, "failed");
    assert.equal(existsSync(readFileSync(seen, "utf8")), false);
    writeFileSync(worker, prefix + "while(true){}");
    const timeout = await runReleasePerformance({ root: dir }, { worker, runGroup: (args, _, options) => runPerformanceGroup(args, 150, options) });
    assert.equal(timeout.status, "invalid");
    assert.equal(timeout.cleaned, true);
    assert.equal(existsSync(readFileSync(seen, "utf8")), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("installer is idempotent, preserves guards and refuses unknown or partial versions", () => {
  const before = base(), after = upgradePerformanceCoordinator(before);
  assert.equal(upgradePerformanceCoordinator(after), after);
  for (const token of ['"release-lock.py"', '"release-ci.mjs"', 'preflight.extend(coverage_args)', '"MISSIONGO_RELEASE_CANDIDATES"']) assert.ok(after.includes(token));
  assert.throws(() => upgradePerformanceCoordinator("unknown"));
  assert.throws(() => upgradePerformanceCoordinator(after.replace("    run(preflight, root)\n", "")));
  execFileSync("python3", ["-c", "import ast,sys; ast.parse(sys.stdin.read())"], { input: after });
  const dir = temp();
  try {
    const home = join(dir, "home"), configHome = join(home, ".config"), config = join(configHome, "missiongo"), tools = join(config, "release-tools");
    mkdirSync(join(home, ".local/bin"), { recursive: true }); mkdirSync(tools, { recursive: true });
    writeFileSync(join(home, ".local/bin/missiongo-release"), before, { mode: 0o700 });
    writeFileSync(join(config, "release-local.json"), JSON.stringify({ host: "fixture" }));
    writeFileSync(join(config, "release-coverage.json"), JSON.stringify({ productId: "fixture-product" }));
    const options = { home, configHome, backupsDir: "/fixture/backups" };
    assert.equal(installPerformance(options).installed, false);
    assert.equal(readFileSync(join(home, ".local/bin/missiongo-release"), "utf8"), before);
    installPerformance({ ...options, install: true });
    assert.equal(installPerformance(options).changed, false);
    assert.throws(() => installPerformance({ ...options, backupsDir: "/other" }), /differs/);
    assert.equal(existsSync(join(home, ".local/bin/missiongo-release.before-release-performance")), true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("installed coordinator blocks both check and deploy before a production marker", () => {
  const dir = temp();
  try {
    const checkout = join(dir, "checkout"), tools = join(dir, "config/missiongo/release-tools"), bin = join(dir, "bin"), marker = join(dir, "PRODUCTION");
    for (const path of [join(checkout, "scripts"), tools, bin]) mkdirSync(path, { recursive: true });
    writeFileSync(join(checkout, "product.json"), "{}"); writeFileSync(join(checkout, "scripts/deploy.sh"), "fixture");
    const coordinator = join(dir, "coordinator.py");
    const canonical = readFileSync(join(root, "scripts/missiongo-release.py"), "utf8");
    assert.equal(upgradePerformanceCoordinator(canonical), canonical, "repository installs must retain the mandatory gate");
    writeFileSync(coordinator, canonical);
    writeFileSync(join(tools, "release_coverage_options.py"), "def coverage_options(args):\n    return args, ['--candidates', 'fixture']\n");
    const config = dirname(tools);
    writeFileSync(join(config, "release-local.json"), JSON.stringify({ host: "fixture", backupsDir: "/fixture/backups", currentLink: "/fixture/current", downloadsDir: "/fixture/downloads", envFile: "/fixture/env", origin: "http://fixture.invalid" }));
    writeFileSync(join(config, "release-coverage.json"), JSON.stringify({ productId: "fixture" }));
    for (const name of ["release-preflight.mjs", "release-ci.mjs"]) writeFileSync(join(tools, name), "// fixture guard passes\n");
    writeFileSync(join(tools, "deploy.sh"), `#!/bin/sh\necho forbidden > '${marker}'\n`, { mode: 0o700 });
    const smoke = join(checkout, "scripts/release-performance.mjs");
    writeFileSync(smoke, "process.exit(1);\n");
    writeFileSync(join(bin, "git"), `#!/bin/sh\ncase "$*" in\n *--show-toplevel*) echo '${checkout}';;\n *--git-common-dir*) echo '${dir}/primary/.git';;\n *--porcelain*) :;;\n *rev-parse*) echo aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa;;\n *) :;;\nesac\n`, { mode: 0o700 });
    writeFileSync(join(bin, "ssh"), "#!/bin/sh\nexit 0\n", { mode: 0o700 });
    const env = { ...process.env, PATH: bin + ":" + process.env.PATH, XDG_CONFIG_HOME: join(dir, "config"), MISSIONGO_COORDINATOR_ENTRY: coordinator };
    for (const action of ["check", "deploy"]) {
      assert.throws(() => execFileSync("python3", [coordinator, action], { cwd: checkout, env, stdio: "pipe" }));
      assert.equal(existsSync(marker), false);
    }
    writeFileSync(smoke, "process.exit(0);\n");
    execFileSync("python3", [coordinator, "check"], { cwd: checkout, env, stdio: "pipe" });
    assert.equal(existsSync(marker), false);
    execFileSync("python3", [coordinator, "deploy"], { cwd: checkout, env, stdio: "pipe" });
    assert.equal(existsSync(marker), true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("real smoke worker exercises authenticated HTTP on a synthetic backup and removes its copy", { timeout: 60_000 }, async () => {
  const dir = temp(), previousPath = process.env.PATH;
  let fixture;
  try {
    const { serverFixture } = await import("../tests/performance/server-fixture.mjs");
    fixture = await serverFixture({ batches: 5, deliveriesPerBatch: 2, itemsPerDelivery: 10, eventsPerItem: 10, payloadBytes: 128 });
    const db = join(dir, "source.sqlite");
    fixture.store.database.connection.exec(`VACUUM INTO '${db.replaceAll("'", "''")}'`);
    const productId = fixture.store.listProducts()[0].id;
    await fixture.app.close(); fixture = undefined;
    const bytes = readFileSync(db), m = manifest(bytes), ssh = join(dir, "ssh");
    writeFileSync(ssh, `#!/usr/bin/env python3\nimport sys,shutil\nif 'MISSIONGO_BACKUP_TRANSFER_V1' in sys.argv[-1]:\n with open(${JSON.stringify(db)},'rb') as f: shutil.copyfileobj(f,sys.stdout.buffer)\nelse: print(${JSON.stringify(JSON.stringify(m))})\n`, { mode: 0o700 });
    process.env.PATH = dir + ":" + previousPath;
    // Other script tests import the already-built dist concurrently. Keep this
    // HTTP/backup integration child on that build; the actual forced compiler
    // is exercised against poisoned output in release-performance-audit.test.
    const worker = join(dir, "prebuilt-worker.mjs"), loader = join(dir, "prebuilt-loader.mjs");
    writeFileSync(loader, `export async function load(url, context, nextLoad) {
      const loaded=await nextLoad(url, context);
      return url.endsWith('/scripts/release-performance-build.mjs')
        ? {...loaded, source:'export function compilePerformanceCandidate() {}'} : loaded;
    }`);
    // module.register is available in the CI baseline (Node 22.13), whereas
    // synchronous registerHooks only arrived in Node 22.15.
    writeFileSync(worker, `import { register } from 'node:module';
      register(${JSON.stringify(pathToFileURL(loader).href)}, import.meta.url);
      await import(${JSON.stringify(new URL("./release-performance-worker.mjs", import.meta.url).href)});
    `);
    const report = await runReleasePerformance({ root: resolveRoot(), host: "fixture", backupsDir: "/fixture/backups", productId }, { worker });
    assert.equal(report.cleaned, true);
    assert.equal(report.node, process.version);
    assert.equal(report.httpCalibration?.source, "loopback-health");
    assert.equal(report.httpCalibration?.timingUnit, "wall-ms");
    assert.equal(report.httpTargets.find(t => t.name === "claim-next").calibrationKind, "loopback-health-wall");
    assert.equal(report.httpTargets.find(t => t.name === "claim-next-work").calibrationKind, "cpu+loopback-health-wall");
    assert.ok(report.cpuTargets?.length === 3, `Incomplete domain coverage: ${report.status}/${report.stage}/${report.smokeStep}/${report.code}`);
    assert.deepEqual(report.httpTargets.map(t => t.name), ["merge-deliveries", "item-list", "claim-next", "claim-next-work"]);
    assert.ok(report.idleMs >= 1900);
    assert.ok(report.coverage.items >= 100 && report.coverage.batches > 0 && report.coverage.sessionProgress > 0);
    // Timing thresholds are measured on real release hardware separately. This
    // parallel test verifies correctness/coverage and never asserts a CI SLA.
  } finally {
    process.env.PATH = previousPath;
    if (fixture) await fixture.app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
function resolveRoot() { return realpathSync(root); }

test("installer refuses a busy OS lock before reading or changing any files", () => {
  const dir = temp();
  try {
    const config = join(dir, "missiongo"), tools = join(config, "release-tools"); mkdirSync(tools, { recursive: true });
    writeFileSync(join(tools, "release-lock.py"), "import sys; sys.exit(75)\n");
    try {
      execFileSync(process.execPath, [join(root, "scripts/enable-release-performance.mjs"), "--backups-dir", "/fixture/backups", "--install"],
        { env: { ...process.env, XDG_CONFIG_HOME: dir, MISSIONGO_PERFORMANCE_INSTALL_ENTRY: "" }, stdio: "pipe" });
      assert.fail("Busy lock unexpectedly allowed installation");
    } catch (error) { assert.equal(error.status, 75); }
    assert.equal(existsSync(join(config, "release-local.json")), false);
    assert.equal(existsSync(join(tools, "release-performance-installation.json")), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
