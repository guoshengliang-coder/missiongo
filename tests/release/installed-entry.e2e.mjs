import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { backupCommand, discoverBackupProgram, transferProgram } from "../../scripts/release-backup.mjs";
import { createReleaseSelection, releaseCandidatesFromPages } from "../../scripts/release-candidates.mjs";
import { serverFixture } from "../performance/server-fixture.mjs";
import { fixtureGit as git } from "./fixture-git.mjs";

// Serialized after the script suite: execute the real compiler and performance
// worker, without racing the other tests that import generated dist files.
const source = realpathSync(fileURLToPath(new URL("../../", import.meta.url)));
const commit = root => {
  git(root, "add", "."); git(root, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", "commit", "-m", "fixture");
  return git(root, "rev-parse", "HEAD");
};
const save = (path, value) => writeFileSync(path, JSON.stringify(value));
const digest = value => createHash("sha256").update(value).digest("hex");
const quote = text => `'${text.replaceAll("'", "'\\''")}'`;
const completePlan = result => {
  assert.equal(result.status, 0, result.stderr);
  const index = result.stdout.indexOf('{\n  "artifacts"');
  assert.ok(index >= 0, "Plan returned without its complete coverage output");
  const plan = JSON.parse(result.stdout.slice(index));
  assert.equal(typeof plan.coverage.ready, "boolean");
  return plan;
};

async function syntheticBackup(directory, name, shape) {
  const backups = join(directory, name), backupName = "missiongo-20260101T000000Z", backupDir = join(backups, backupName);
  mkdirSync(backupDir, { recursive: true });
  const synthetic = await serverFixture(shape);
  const db = join(backupDir, "missiongo.sqlite");
  let productId;
  try {
    synthetic.store.database.connection.exec(`VACUUM INTO '${db.replaceAll("'", "''")}'`);
    productId = synthetic.store.listProducts()[0].id;
  } finally { await synthetic.app.close(); }
  const bytes = readFileSync(db), metadata = { formatVersion: 1, directory: backupName, createdAt: "2026-01-01T00:00:00Z",
    database: { filename: "missiongo.sqlite", sizeBytes: bytes.length, sha256: digest(bytes) } };
  save(join(backupDir, "manifest.json"), metadata);
  return { backups, productId, metadata };
}

async function fixture() {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "and506-installed-")));
  const primary = join(directory, "primary"), checkout = join(directory, "candidate checkout"), home = join(directory, "home");
  mkdirSync(primary);
  // Copy tracked sources plus this task's new script helpers; never copy .git,
  // production config, credentials, ignored application data or another dist tree.
  const files = git(source, "ls-files", "-z").split("\0").filter(Boolean);
  for (const name of files) {
    const path = join(source, name);
    if (!lstatSync(path).isFile()) continue;
    mkdirSync(dirname(join(primary, name)), { recursive: true }); copyFileSync(path, join(primary, name));
  }
  for (const name of readdirSync(join(source, "scripts"))) if (/\.(mjs|py|sh)$/.test(name)) copyFileSync(join(source, "scripts", name), join(primary, "scripts", name));
  const product = JSON.parse(readFileSync(join(primary, "product.json"))); product.web.version = "1.0.0"; save(join(primary, "product.json"), product);
  git(primary, "init", "-b", "main"); const old = commit(primary);
  const hash = digest("fixture archive");
  const ledger = { artifacts: Object.fromEntries(["androidApp", "macosApp", "androidSdk"].map(a => [a, {
    version: "1.0.0", commit: old, sha256: hash, paths: ["fixture-artifact.txt"], versionFile: "fixture-versions.json", versionJsonPath: a,
  }])) };
  save(join(primary, "fixture-versions.json"), Object.fromEntries(Object.keys(ledger.artifacts).map(a => [a, "1.0.0"])));
  save(join(primary, "released.json"), ledger); product.web.version = "1.0.1"; save(join(primary, "product.json"), product);
  const head = commit(primary);
  git(primary, "remote", "add", "origin", "https://github.com/fixture/missiongo.git"); git(primary, "update-ref", "refs/remotes/origin/main", head);
  git(primary, "worktree", "add", "--detach", checkout, head);
  // External dependencies may be shared read-only; workspace resolution must
  // point at this candidate's own freshly compiled packages.
  mkdirSync(join(checkout, "node_modules"));
  for (const name of readdirSync(join(source, "node_modules"))) {
    if (name === "@missiongo") continue;
    symlinkSync(join(source, "node_modules", name), join(checkout, "node_modules", name));
  }
  mkdirSync(join(checkout, "node_modules/@missiongo"));
  for (const name of readdirSync(join(source, "node_modules/@missiongo"))) {
    symlinkSync(join(checkout, relative(source, realpathSync(join(source, "node_modules/@missiongo", name)))), join(checkout, "node_modules/@missiongo", name));
  }
  const maven = join(checkout, "apps/web/public/maven/io/missiongo/missiongo-feedback/1.0.0"); mkdirSync(maven, { recursive: true });
  for (const [ext, bytes] of [["pom", "<version>1.0.0</version>"], ["aar", "fixture archive"]]) {
    const path = join(maven, `missiongo-feedback-1.0.0.${ext}`); writeFileSync(path, bytes); writeFileSync(path + ".sha256", digest(bytes));
  }
  // Functional installation coverage needs a full page and real associated
  // history, not a hardware SLA. Keep the large regression corpus separate.
  const normal = await syntheticBackup(directory, "functional-backups", { batches: 5, deliveriesPerBatch: 2, itemsPerDelivery: 10, eventsPerItem: 10, payloadBytes: 128 });
  const regression = await syntheticBackup(directory, "regression-backups", { batches: 20, deliveriesPerBatch: 2, itemsPerDelivery: 10, eventsPerItem: 200, payloadBytes: 1024 });
  const { backups, productId } = normal;
  const configHome = join(home, ".config"), config = join(configHome, "missiongo"), tools = join(config, "release-tools");
  const installed = spawnSync(process.execPath, [join(checkout, "scripts/install-release-tools.mjs")], {
    cwd: checkout, env: { PATH: process.env.PATH, HOME: home, XDG_CONFIG_HOME: configHome }, encoding: "utf8",
  });
  assert.equal(installed.status, 0, installed.stdout + installed.stderr);
  save(join(config, "release-local.json"), { host: "fixture", currentLink: "/fixture/current", downloadsDir: "/fixture/downloads", backupsDir: backups, envFile: "/fixture/env", origin: "https://fixture.invalid" });
  save(join(config, "release-coverage.json"), { schemaVersion: 1, productId, repository: "https://github.com/fixture/missiongo" });
  const candidatesPath = join(directory, "all candidates.json"), selectionPath = join(directory, "selection with spaces.json");
  const candidates = { pages: [{ requestedBeforeSequence: null, productId, coverageVersion: 2, generatedAt: new Date().toISOString(), noReleaseItems: [], noReleaseDeliveries: [],
    candidates: [{ itemKey: "AND-506", expectedRevision: 1, completion: { kind: "commit", commit: head, targetBranch: "main" }, requiredArtifacts: ["web"] }] }] };
  save(candidatesPath, candidates);
  save(selectionPath, createReleaseSelection(releaseCandidatesFromPages(candidates, { coverage: true }), "https://github.com/fixture/missiongo", head));
  const bin = join(directory, "bin"); mkdirSync(bin);
  const statePath = join(directory, "state.json"), tracePath = join(directory, "commands.jsonl"), boundary = join(directory, "first-write-attempt"); save(statePath, {});
  const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
  const header = `#!${process.execPath}\nconst fs=require('node:fs'),cp=require('node:child_process');const args=process.argv.slice(2);const state=JSON.parse(fs.readFileSync(${JSON.stringify(statePath)}));fs.appendFileSync(${JSON.stringify(tracePath)},JSON.stringify({tool:require('node:path').basename(process.argv[1]),args,cwd:process.cwd()})+'\\n');\n`;
  writeFileSync(join(bin, "git"), header + `if(args.includes('fetch'))process.exit(0); if(args.includes('ls-remote')){console.log(${JSON.stringify(head + ' refs/heads/main')});process.exit(0);} if(args.includes('push'))process.exit(92);process.exit(cp.spawnSync(${JSON.stringify(realGit)},args,{stdio:'inherit'}).status??1);`, { mode: 0o700 });
  writeFileSync(join(bin, "gh"), header + `if(args[0]==='pr'&&args[1]==='view'&&args[2]==='https://github.com/fixture/missiongo/pull/1'){console.log(JSON.stringify({state:'OPEN',headRefOid:${JSON.stringify(head)},baseRefName:'main'}));process.exit(0);} if(args[0]!=='api'||!args.some(a=>a.includes('/check-runs')))process.exit(92);const runs=['web-and-server','ui','android','macos','linux-node'].map((name,id)=>({id,name,status:'completed',conclusion:state.ciFailure?'failure':'success'}));console.log(args.includes('--jq')?runs.map(r=>r.status+'/'+r.conclusion).join(' '):JSON.stringify([{check_runs:runs}]));`, { mode: 0o700 });
  // Emulate only read-only remote responses. No command is sent to a shell or
  // an actual host. Unknown commands are refused and remain visible in the trace.
  const remoteFiles = {
    "/fixture/live/RELEASE": `commit=${old}\nweb_version=1.0.0\ntree=clean\nci=passed\n`,
    "/fixture/live/released.json": JSON.stringify(ledger),
    "/fixture/live/apps/web/public/downloads/missiongo-android-latest.release": `version_name=1.0.0\nversion_code=1\nsha256=${hash}\nsource_dirty=false\nsource_commit=${old}\n`,
    "/fixture/live/apps/web/public/downloads/missiongo-macos-latest.release": `version=1.0.0\nsha256=${hash}\nsource_dirty=false\nsource_commit=${old}\n`,
    "/fixture/live/apps/web/public/downloads/missiongo-macos-latest.json": JSON.stringify({ version: "1.0.0", sha256: hash }),
  };
  const backupCommands = Object.fromEntries([normal, regression].flatMap(({ backups, metadata }) => [
    [backupCommand(discoverBackupProgram, [backups]), { kind: "discovery", args: ["-c", discoverBackupProgram, backups] }],
    [backupCommand(transferProgram, [backups, metadata.directory, metadata.database.filename, String(metadata.database.sizeBytes)]),
      { kind: "transfer", args: ["-c", transferProgram, backups, metadata.directory, metadata.database.filename, String(metadata.database.sizeBytes)] }],
  ]));
  const exact = {
    "true": "", "date +%Y%m%d-%H%M%S": "20260101-000000",
    "if [ -e '/fixture/current' ]; then readlink -f '/fixture/current'; fi": "/fixture/live",
    "readlink -f '/fixture/downloads/missiongo-android-latest.apk' 2>/dev/null": "/fixture/downloads/MissionGo-Android-1.0.0-1.apk",
    ...Object.fromEntries(Object.entries(remoteFiles).map(([path, content]) => [`cat ${quote(path)} 2>/dev/null`, content])),
    ...Object.fromEntries(["/fixture/downloads/MissionGo-Android-1.0.0-1.apk", "/fixture/live/apps/web/public/downloads/missiongo-macos-latest.zip", "/fixture/live/apps/web/public/maven/io/missiongo/missiongo-feedback/1.0.0/missiongo-feedback-1.0.0.pom"].map(path => [`sha256sum ${quote(path)} 2>/dev/null | cut -d ' ' -f 1`, path.endsWith(".pom") ? digest("<version>1.0.0</version>") : hash])),
  };
  writeFileSync(join(bin, "ssh"), header + `const command=args.at(-2)==='date'&&args.at(-1)==='+%Y%m%d-%H%M%S'?'date +%Y%m%d-%H%M%S':args.at(-1);if(!args.includes('fixture'))process.exit(92);const exact=${JSON.stringify(exact)};
const backupCommands=${JSON.stringify(backupCommands)};
if(Object.hasOwn(backupCommands,command)){const job=backupCommands[command];if(job.kind==='discovery'&&state.backupFailure)process.exit(93);const r=cp.spawnSync('python3',job.args,{stdio:'inherit'});process.exit(r.status??1);}
if(Object.hasOwn(exact,command)){process.stdout.write(exact[command]);process.exit(0);}
if(command.startsWith("if [ -s '/fixture/current/apps/web/public/downloads/missiongo-linux-latest.tgz' ]; then cat "))process.exit(0);
if(command.startsWith("if [ -f '/fixture/current/apps/web/public/maven/")&&command.includes('Published Maven coordinate differs:'))process.exit(0);
console.error('UNEXPECTED_REMOTE_COMMAND');process.exit(92);`, { mode: 0o700 });
  writeFileSync(join(bin, "rsync"), header + `fs.writeFileSync(${JSON.stringify(boundary)},'write refused');process.exit(94);`, { mode: 0o700 });
  // A fresh explicit environment prevents inherited credentials, skip flags,
  // native loaders or real release configuration from entering the rehearsal.
  const env = { PATH: `${bin}:${process.env.PATH}`, HOME: home, XDG_CONFIG_HOME: configHome, TMPDIR: directory, LANG: "en_US.UTF-8" };
  const entry = join(home, ".local/bin/missiongo-release");
  const run = (action, ...args) => spawnSync("python3", [entry, action, "--candidates", candidatesPath, ...args], { cwd: join(checkout, "scripts"), env, encoding: "utf8", timeout: 250_000, maxBuffer: 4 * 1024 * 1024 });
  return { directory, checkout, entry, tools, env, head, old, statePath, candidatesPath, candidates, selectionPath, boundary, tracePath, run, productId, backups, regression, done: () => rmSync(directory, { recursive: true, force: true }) };
}

test("installed real entry plans read-only, retains gates, detects historical mutations and rehearses to first write", { timeout: 240_000 }, async t => {
  const f = await fixture();
  try {
    const before = ["product.json", "released.json", "fixture-versions.json"].map(p => readFileSync(join(f.checkout, p), "utf8"));
    const status = spawnSync("python3", [f.entry, "status"], { cwd: join(f.checkout, "scripts"), env: f.env, encoding: "utf8" });
    assert.equal(status.status, 0, status.stderr); assert.ok(status.stdout.includes(f.checkout));
    const plan = completePlan(f.run("plan")); assert.equal(plan.coverage.ready, true);
    assert.deepEqual(["product.json", "released.json", "fixture-versions.json"].map(p => readFileSync(join(f.checkout, p), "utf8")), before);
    assert.equal(existsSync(f.boundary), false);
    // Exercise new installed read-only actions from the same nested checkout.
    const batchPath = join(f.directory, "batch.json");
    save(batchPath, { batch: { id: "fixture-batch", productId: f.productId, deliveries: ["readiness-fixture"], entries: [{ id: "readiness-fixture", repository: "https://github.com/fixture/missiongo", head: f.head, requiredArtifacts: ["web"], pullRequest: 1, targetBranch: "main" }] } });
    const readiness = f.run("readiness", "--batch", batchPath);
    const investigation = JSON.parse(readiness.stdout);
    assert.equal(investigation.kind, "integration_readiness");
    assert.equal(investigation.head, f.head);
    assert.equal(investigation.checks.find(c => c.name === "main").status, "observed");
    assert.equal(investigation.checks.find(c => c.name === "checkout_consistency").status, "observed");
    assert.equal(investigation.checks.find(c => c.name === "prospective:readiness-fixture").status, "observed");
    assert.ok(investigation.checks.some(c => c.name === "tools" && c.value.status === "matching"));
    assert.ok(investigation.checks.some(c => c.name === "versions"));
    assert.ok(investigation.checks.some(c => c.name === "coverage"));
    assert.equal(existsSync(f.boundary), false);
    const reportPath = join(f.directory, "report.json");
    save(reportPath, { schemaVersion: 1, productId: f.productId, repository: "https://github.com/fixture/missiongo", head: f.head,
      scope: ["AND-508:fixture"], items: [{ identity: "AND-508:fixture", productId: f.productId, requiredArtifacts: [],
        noReleaseReason: "Fixture tool change", completion: { kind: "commit", commit: f.head, targetBranch: "main" }, itemStatus: "pending_verification" }] });
    const report = spawnSync("python3", [f.entry, "report", "--input", reportPath, "--format", "markdown"], { cwd: join(f.checkout, "scripts"), env: f.env, encoding: "utf8" });
    assert.equal(report.status, 0, report.stdout + report.stderr);
    assert.match(report.stdout, /AND-508:fixture/);
    assert.match(report.stdout, /无需产品发布/);
    assert.match(report.stdout, /人工验收人/);
    assert.equal(existsSync(f.boundary), false);
    assert.deepEqual(["product.json", "released.json", "fixture-versions.json"].map(p => readFileSync(join(f.checkout, p), "utf8")), before);
    const scoped = completePlan(f.run("plan", "--selection", f.selectionPath, "--only-artifacts", "web,androidSdk", "--scope-reason", "User chose Web and SDK"));
    const pin = scoped.coverage.selection.digest;
    assert.match(pin, /^[a-f0-9]{64}$/);
    // Negative control 1: a missing transitive module must fail in the installed graph.
    const helper = join(f.tools, "handover-evidence.mjs"); renameSync(helper, helper + ".held");
    assert.notEqual(f.run("plan").status, 0); renameSync(helper + ".held", helper);
    // Negative control 2: historical import-time exit has status zero, so require
    // complete semantic output as well as an exit code.
    const stateModule = join(f.checkout, "scripts/release-state.mjs"), originalState = readFileSync(stateModule);
    writeFileSync(stateModule, Buffer.concat([originalState, Buffer.from("\nprocess.exit(0);\n")]));
    assert.throws(() => completePlan(f.run("plan")), /complete coverage output/); writeFileSync(stateModule, originalState);
    // Real OS lock, not a fake lock implementation.
    const busy = spawnSync("python3", ["-c", "import fcntl,subprocess,sys; f=open(sys.argv[1],'w'); fcntl.flock(f,fcntl.LOCK_EX); sys.exit(subprocess.run(sys.argv[2:]).returncode)", join(f.env.XDG_CONFIG_HOME, "missiongo/release.lock"), "python3", f.entry, "check", "--candidates", f.candidatesPath], { cwd: f.checkout, env: f.env, encoding: "utf8" });
    assert.equal(busy.status, 75, busy.stderr);
    for (const action of ["check", "deploy"]) {
      save(f.statePath, { ciFailure: true }); const ci = f.run(action); assert.notEqual(ci.status, 0); assert.match(ci.stderr, /CI web-and-server/);
      save(f.statePath, {});
      const stale = structuredClone(f.candidates); stale.pages[0].generatedAt = "2020-01-01T00:00:00Z"; save(f.candidatesPath, stale);
      const coverage = f.run(action); assert.notEqual(coverage.status, 0); assert.match(coverage.stderr, /stale|old|expired/i); save(f.candidatesPath, f.candidates);
      const selection = f.run(action, "--selection", f.selectionPath, "--selection-digest", "0".repeat(64)); assert.notEqual(selection.status, 0); assert.match(selection.stderr, /digest changed/);
      assert.equal(existsSync(f.boundary), false);
    }
    save(f.statePath, { backupFailure: true });
    const badSmoke = f.run("deploy"); assert.notEqual(badSmoke.status, 0); assert.match(badSmoke.stdout, /Environment preparation failed/); assert.equal(existsSync(f.boundary), false);
    save(f.statePath, {});
    for (const flag of ["--skip-backup", "--skip-ci-check", "--allow-dirty", "--backups-dir", "--data-dir"]) {
      const bypass = f.run("deploy", flag); assert.notEqual(bypass.status, 0); assert.match(bypass.stderr, /overrides are not accepted/);
      assert.equal(existsSync(f.boundary), false);
    }
    const checked = f.run("check", "--selection", f.selectionPath, "--selection-digest", pin, "--only-artifacts", "web,androidSdk", "--scope-reason", "User chose Web and SDK");
    assert.equal(checked.status, 0, checked.stdout + checked.stderr); assert.equal(existsSync(f.boundary), false);
    // Exercise the real version guard on a clean fixture commit; the source
    // checkout and its history remain untouched.
    const originalProduct = readFileSync(join(f.checkout, "product.json"));
    const noBump = JSON.parse(originalProduct); noBump.web.version = "1.0.0";
    save(join(f.checkout, "product.json"), noBump);
    writeFileSync(join(f.checkout, "apps/web/fixture-runtime.txt"), "changed runtime");
    const versionHead = commit(f.checkout); git(f.checkout, "update-ref", "refs/remotes/origin/main", versionHead);
    const versionFailure = f.run("deploy"); assert.notEqual(versionFailure.status, 0); assert.match(versionFailure.stderr, /Web changed since/, versionFailure.stdout + versionFailure.stderr);
    assert.equal(existsSync(f.boundary), false);
    git(f.checkout, "switch", "--detach", f.head); git(f.checkout, "update-ref", "refs/remotes/origin/main", f.head);
    // Negative control 3: reproduce the installed-directory-as-root defect.
    const deployPath = join(f.tools, "deploy.sh"), originalDeploy = readFileSync(deployPath, "utf8");
    assert.ok(originalDeploy.includes('cd "${MISSIONGO_RELEASE_ROOT:'));
    writeFileSync(deployPath, originalDeploy.replace(/^cd "\$\{MISSIONGO_RELEASE_ROOT[^\n]+$/m, `cd '${f.tools}'`));
    const wrongRoot = f.run("deploy"); assert.notEqual(wrongRoot.status, 0); assert.match(wrongRoot.stderr, /MissionGo checkout/, wrongRoot.stdout + wrongRoot.stderr); assert.equal(existsSync(f.boundary), false);
    writeFileSync(deployPath, originalDeploy);
    const rehearsal = f.run("deploy", "--selection", f.selectionPath, "--selection-digest", pin, "--only-artifacts", "web,androidSdk", "--scope-reason", "User chose Web and SDK");
    assert.notEqual(rehearsal.status, 0); assert.match(rehearsal.stdout, /Pushing/, rehearsal.stderr); assert.equal(readFileSync(f.boundary, "utf8"), "write refused");
    const trace = readFileSync(f.tracePath, "utf8").trim().split("\n").map(JSON.parse);
    assert.equal(trace.filter(t => t.tool === "rsync").length, 1);
    assert.ok(trace.some(t => t.tool === "gh"));
    assert.ok(trace.some(t => t.tool === "ssh" && t.args.at(-1).includes("MISSIONGO_BACKUP_TRANSFER_V2")));
    assert.ok(trace.some(t => t.tool === "git" && t.args.includes("--porcelain") && t.cwd === f.checkout));
    assert.equal(trace.some(t => t.tool === "ssh" && /docker|sudo mkdir|VACUUM/.test(t.args.at(-1))), false);
    assert.equal(readdirSync(f.directory).some(n => n.startsWith("missiongo-perf-")), false);
    assert.equal(git(f.checkout, "status", "--porcelain"), "");
    const runLargeSmoke = target => spawnSync(process.execPath, [
      ...(target ? ["--import", join(f.checkout, "tests/performance/mutation-loader.mjs")] : []),
      join(f.checkout, "scripts/release-performance.mjs"), "--root", f.checkout, "--host", "fixture",
      "--backups-dir", f.regression.backups, "--product-id", f.regression.productId], {
      cwd: f.checkout, env: target ? { ...f.env, PERFORMANCE_MUTATION: "release-fivefold-" + target } : f.env,
      encoding: "utf8", timeout: 245_000,
    });
    // Observe the large corpus without making its hardware-dependent absolute
    // timings an extra CI blocking policy. The actual release CLI must still
    // return nonzero for every exceeded/invalid measurement. Setup/contract/
    // cleanup failures remain test failures, never advisory observations.
    const baselineRun = runLargeSmoke(), baseline = JSON.parse(baselineRun.stdout);
    assert.equal(baseline.cleaned, true);
    assert.equal(baseline.cpuTargets?.length, 3); assert.equal(baseline.httpTargets?.length, 4);
    assert.equal(baseline.coverage?.items, 400);
    assert.ok(baseline.status === "passed" || baseline.failureKind === "regression" || baseline.failureKind === "measurement", JSON.stringify(baseline));
    const passed = baseline.calibration?.valid === true && baseline.httpCalibration?.valid === true
      && [...baseline.cpuTargets, ...baseline.httpTargets].every(target => target.status === "passed");
    assert.equal(baseline.status, passed ? "passed" : "failed", "A passed label cannot hide an exceeded target or invalid calibration");
    assert.equal(baselineRun.status, passed ? 0 : 1, "The real release CLI must reject a failed measurement");
    const ciPolicy = JSON.parse(readFileSync(join(f.checkout, "tests/performance/server-budgets.json"))).ciMode;
    if (ciPolicy === "blocking") assert.ok(passed, JSON.stringify(baseline));
    t.diagnostic(JSON.stringify({ observation: "large-unmutated-corpus", ciPolicy, measurement: baseline.status,
      releaseGate: baselineRun.status === 0 ? "passed" : "rejected", cleaned: baseline.cleaned,
      targets: [...baseline.cpuTargets, ...baseline.httpTargets].map(({ name, status, medianMs, effectiveBudgetMs }) => ({ name, status, medianMs, effectiveBudgetMs })) }));
    for (const target of ["merge-deliveries", "item-list", "claim-next"]) {
      const diagnostic = runLargeSmoke(target);
      assert.equal(diagnostic.status, 1, diagnostic.stderr);
      const report = JSON.parse(diagnostic.stdout);
      assert.equal(report.diagnosticOutcome, "detected", JSON.stringify({target,status:report.status,reason:report.reason,calibration:report.calibration,httpCalibration:report.httpCalibration,cpuTargets:report.cpuTargets,httpTargets:report.httpTargets}));
      assert.equal(report.cleaned, true);
      assert.equal(report.measurementStatus, "failed", "The ordinary measurement must reject the regression before the diagnostic publication guard");
      assert.equal(report.failureKind, "regression");
      t.diagnostic(JSON.stringify({ target, outcome: report.diagnosticOutcome, measurementStatus: report.measurementStatus, cleaned: report.cleaned,
        results: [...report.cpuTargets, ...report.httpTargets].filter(row => row.name === target)
          .map(({ name, status, medianMs, effectiveBudgetMs, normalizedMs }) => ({ name, status, medianMs, effectiveBudgetMs, normalizedMs })) }));
      assert.ok([...report.cpuTargets, ...report.httpTargets].some(row => row.name === target && row.status === "exceeded"));
    }
    assert.equal(readdirSync(f.directory).some(n => n.startsWith("missiongo-perf-")), false);
  } finally { f.done(); }
});
