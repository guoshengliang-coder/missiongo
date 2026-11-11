import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { createReleaseSelection, releaseCandidatesFromPages } from "./release-candidates.mjs";
import { installCoverage, upgradeCoverageTools } from "./enable-release-coverage.mjs";

const scripts = dirname(fileURLToPath(import.meta.url));
const fixture = name => readFileSync(join(scripts, "fixtures", name), "utf8");
const git = (root, ...args) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const commit = root => { git(root, "add", "."); git(root, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", "commit", "-m", "fixture"); return git(root, "rev-parse", "HEAD"); };

// Safe deploy adapter: all production side effects are represented by one marker file.
const deploy = [
  '#!/bin/bash', 'set -euo pipefail', 'cd "$MISSIONGO_RELEASE_ROOT"', 'RELEASE_TOOLS="$MISSIONGO_RELEASE_TOOLS"',
  'host=fixture', 'current_link=/fixture/current', 'downloads_dir=/fixture/downloads', 'notice_origin=https://missiongo.example.com',
  'before_snapshot="$(cat "$COVERAGE_FIXTURE_LIVE")"', 'publish_apk=1', 'artifact_options=()',
  'node "$RELEASE_TOOLS/release-preflight.mjs" --root "$PWD" --snapshot "$before_snapshot" --host "$host" --current-link "$current_link" ${artifact_options[@]+"${artifact_options[@]}"}',
  'echo "==> Pushing"', 'echo production > "$COVERAGE_FIXTURE_PRODUCTION_MARKER"',
  'if [ -n "$notice_origin" ]; then',
  '  node "$RELEASE_TOOLS/release-receipt.mjs" compare \\',
  '    --host "$host" --current-link "$current_link" --downloads-dir "$downloads_dir" \\',
  '    --before-json "$before_snapshot" --origin "$notice_origin" || {',
  '    echo "Deployment finished, but the release receipt is unavailable; do not advance work items." >&2',
  '    exit 1', '  }', 'fi', '',
].join("\n");

test("installer preserves existing guards, rejects unknown/partial entry points and is idempotent", () => {
  const files = { coordinator: fixture("coverage-coordinator.py.txt"), preflight: fixture("coverage-preflight.mjs.txt"), deploy };
  const after = upgradeCoverageTools(files);
  assert.deepEqual(upgradeCoverageTools(after), after);
  assert.throws(() => upgradeCoverageTools({ ...files, coordinator: "unknown" }));
  assert.throws(() => upgradeCoverageTools({ ...after, coordinator: after.coordinator.replace("    preflight.extend(coverage_args)\n", "") }), /Partial/);
  // Parse the actual upgraded programs without executing their external actions.
  execFileSync("python3", ["-c", "import ast,sys; ast.parse(sys.stdin.read())"], { input: after.coordinator });
  execFileSync(process.execPath, ["--input-type=module", "--check"], { input: after.preflight });
  execFileSync("bash", ["-n"], { input: after.deploy });
});

test("installer refuses a busy shared release lock before reading or changing installation files", () => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "mg-coverage-lock-")));
  try {
    const config = join(directory, "missiongo"), tools = join(config, "release-tools");
    mkdirSync(tools, { recursive: true });
    // The installed lock's public protocol, using a real OS file lock.
    writeFileSync(join(tools, "release-lock.py"), [
      "import fcntl,os,sys", 'fd=os.open(os.path.join(os.environ["XDG_CONFIG_HOME"],"missiongo/release.lock"),os.O_CREAT|os.O_RDWR,0o600)',
      "try: fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB)", "except BlockingIOError: sys.exit(75)",
      "os.set_inheritable(fd,True)", "os.execvp(sys.argv[2],sys.argv[2:])", "",
    ].join("\n"));
    const result = spawnSync("python3", ["-c", "import fcntl,subprocess,sys; f=open(sys.argv[1],'w'); fcntl.flock(f,fcntl.LOCK_EX); sys.exit(subprocess.run(sys.argv[2:]).returncode)",
      join(config, "release.lock"), process.execPath, join(scripts, "enable-release-coverage.mjs"), "--product-id", "product", "--candidates", join(directory, "not-read.json")],
    { env: { ...process.env, XDG_CONFIG_HOME: directory, MISSIONGO_COVERAGE_INSTALL_ENTRY: "" }, encoding: "utf8", timeout: 10_000 });
    assert.equal(result.status, 75, result.stderr);
    assert.equal(existsSync(join(config, "release-coverage.json")), false);
    assert.equal(existsSync(join(tools, "release-coverage.mjs")), false);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("installed coordinator and deploy guard reject incomplete coverage before any production write", () => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "mg-coverage-install-")));
  try {
    const primary = join(directory, "primary"); mkdirSync(primary);
    execFileSync("git", ["init", "-b", "main", primary], { stdio: "ignore" });
    writeFileSync(join(primary, "runtime.txt"), "old"); const old = commit(primary);
    writeFileSync(join(primary, "runtime.txt"), "fix"); const merge = commit(primary);
    mkdirSync(join(primary, "scripts")); writeFileSync(join(primary, "scripts/deploy.sh"), "fixture");
    copyFileSync(join(scripts, "linux-release-tools.mjs"), join(primary, "scripts/linux-release-tools.mjs"));
    writeFileSync(join(primary, "product.json"), JSON.stringify({ web: { version: "2.0" } }));
    const hash = "d".repeat(64);
    const ledger = { artifacts: Object.fromEntries(["androidApp", "macosApp", "androidSdk", "linuxCli"].map(a => [a, { version: "1.0", commit: old, sha256: hash }])) };
    writeFileSync(join(primary, "released.json"), JSON.stringify(ledger)); const head = commit(primary);
    git(primary, "remote", "add", "origin", "https://github.com/owner/repo.git"); git(primary, "update-ref", "refs/remotes/origin/main", head);
    const root = join(directory, "worktree"); git(primary, "worktree", "add", "--detach", root);
    const home = join(directory, "home"), configHome = join(home, ".config"), config = join(configHome, "missiongo"), tools = join(config, "release-tools");
    mkdirSync(tools, { recursive: true }); mkdirSync(join(home, ".local/bin"), { recursive: true });
    const coordinator = join(home, ".local/bin/missiongo-release"); writeFileSync(coordinator, fixture("coverage-coordinator.py.txt"), { mode: 0o700 });
    writeFileSync(join(tools, "release-preflight.mjs"), fixture("coverage-preflight.mjs.txt"));
    writeFileSync(join(tools, "deploy.sh"), deploy, { mode: 0o700 });
    copyFileSync(join(scripts, "../apps/web/public/downloads/missiongo-handover.mjs"), join(tools, "handover-evidence.mjs"));
    writeFileSync(join(config, "release-local.json"), JSON.stringify({ host: "fixture", currentLink: "/fixture/current", downloadsDir: "/fixture/downloads", envFile: "/fixture/env", origin: "https://missiongo.example.com" }));
    writeFileSync(join(tools, "release-ci.mjs"), 'import fs from "node:fs"; fs.writeFileSync(process.env.COVERAGE_FIXTURE_CI,"checked");');
    writeFileSync(join(tools, "release-receipt.mjs"), 'import fs from "node:fs"; export const properties=()=>({}); export const readSnapshot=()=>JSON.parse(fs.readFileSync(process.env.COVERAGE_FIXTURE_LIVE,"utf8")); if(process.argv[2]==="compare") console.log(fs.readFileSync(process.env.COVERAGE_FIXTURE_RECEIPT,"utf8"));');
    const candidates = { pages: [{ productId: "product", requestedBeforeSequence: null, coverageVersion: 1, generatedAt: new Date().toISOString(), noReleaseItems: [],
      candidates: ["AND-360", "AND-363"].map(itemKey => ({ itemKey, pullRequestUrl: "https://github.com/owner/repo/pull/42", requiredArtifacts: ["web", "macosApp"] })) }] };
    const candidatesPath = join(directory, "candidates with spaces.json"); writeFileSync(candidatesPath, JSON.stringify(candidates));
    const install = () => installCoverage({ home, configHome, productId: "product", candidates, repositoryRoot: root });
    assert.equal(install().installed, true); assert.equal(install().installed, true);
    assert.equal(readFileSync(`${coordinator}.before-release-coverage`, "utf8"), fixture("coverage-coordinator.py.txt"));
    const bin = join(directory, "bin"); mkdirSync(bin);
    const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
    writeFileSync(join(bin, "git"), `#!${process.execPath}\nconst {spawnSync}=require('node:child_process');const args=process.argv.slice(2);if(args[0]==='fetch')process.exit(0);process.exit(spawnSync(${JSON.stringify(realGit)},args,{stdio:'inherit'}).status??1);`, { mode: 0o700 });
    writeFileSync(join(bin, "gh"), `#!${process.execPath}\nconsole.log(JSON.stringify({state:'MERGED',mergedAt:'2026-01-01T00:00:00Z',mergeCommit:{oid:${JSON.stringify(merge)}}}));`, { mode: 0o700 });
    writeFileSync(join(bin, "ssh"), "#!/bin/sh\nexit 0\n", { mode: 0o700 });
    const livePath = join(directory, "live.json"), receiptPath = join(directory, "receipt.json"), marker = join(directory, "production"), ci = join(directory, "ci");
    const live = { web: { version: "1.0", commit: old, clean: true, ciPassed: true },
      ...Object.fromEntries(["androidApp", "macosApp", "linuxCli"].map(a => [a, { version: "1.0", sourceCommit: old, sha256: hash }])),
      androidSdk: { version: "1.0", sourceCommit: old, pomSha256: hash, aarSha256: hash } };
    const saveLive = currentHead => {
      writeFileSync(livePath, JSON.stringify(live));
      writeFileSync(receiptPath, JSON.stringify({ schemaVersion: 1, deployedCommit: currentHead, previous: live, current: { ...live, web: { version: "2.0", commit: currentHead, clean: true, ciPassed: true } }, publicEvidence: { checks: { web: true, androidApp: true, androidSdk: true, macosApp: true, linuxCli: true } } }));
    };
    saveLive(head);
    const env = { ...process.env, HOME: home, XDG_CONFIG_HOME: configHome, PATH: `${bin}:${process.env.PATH}`, MISSIONGO_COORDINATOR_ENTRY: coordinator,
      COVERAGE_FIXTURE_LIVE: livePath, COVERAGE_FIXTURE_RECEIPT: receiptPath, COVERAGE_FIXTURE_PRODUCTION_MARKER: marker, COVERAGE_FIXTURE_CI: ci };
    const run = (...args) => spawnSync("python3", [coordinator, ...args], { cwd: root, env, encoding: "utf8", timeout: 20_000 });
    const preview = run("plan", "--candidates", candidatesPath);
    assert.equal(preview.status, 0, preview.stderr); assert.equal(existsSync(ci), false, "planning does not require or fake CI");
    assert.equal(JSON.parse(preview.stdout).coverage.ready, false); assert.equal(existsSync(marker), false);
    assert.notEqual(run("deploy").status, 0); assert.equal(existsSync(marker), false);
    assert.notEqual(run("plan", "--candidates", candidatesPath, "--candidates", candidatesPath).status, 0);
    const linuxOnly = run("deploy", "--candidates", candidatesPath, "--only-artifacts", "linuxCli", "--scope-reason", "User selected Linux only");
    assert.notEqual(linuxOnly.status, 0); assert.match(linuxOnly.stderr, /web: deployment would change an artifact outside/); assert.equal(existsSync(marker), false);
    const refused = run("deploy", "--candidates", candidatesPath);
    assert.notEqual(refused.status, 0); assert.match(refused.stderr, /AND-360: macosApp.*AND-363: macosApp/); assert.equal(existsSync(marker), false);
    const direct = spawnSync("bash", [join(tools, "deploy.sh")], { cwd: root, env: { ...env, MISSIONGO_RELEASE_ROOT: root, MISSIONGO_RELEASE_TOOLS: tools,
      MISSIONGO_RELEASE_CANDIDATES: candidatesPath, MISSIONGO_RELEASE_COVERAGE_CONFIG: join(config, "release-coverage.json") }, encoding: "utf8" });
    assert.notEqual(direct.status, 0); assert.equal(existsSync(marker), false, "the deploy script also blocks without relying on the coordinator's earlier result");
    // Full snapshot stays intact: known updates are explicitly deferred by user,
    // one unrelated legacy gap is retained as a warning, and ready Web work proceeds.
    const originalPages=JSON.parse(readFileSync(candidatesPath,"utf8"));
    const withLegacy=structuredClone(originalPages);
    withLegacy.pages[0].candidates.push({itemKey:"AND-451",expectedRevision:1},
      {itemKey:"AND-504",completion:{kind:"commit",commit:merge,targetBranch:"main"},requiredArtifacts:["web"]});
    writeFileSync(candidatesPath,JSON.stringify(withLegacy));
    const selection=createReleaseSelection(releaseCandidatesFromPages(withLegacy,{coverage:true}),"https://github.com/owner/repo",head);
    for(const e of selection.entries) {
      if(e.identity.startsWith("AND-451:")){e.disposition="historical_gap";e.reason="Historical local proof missing; unrelated to this release";}
      else if(!e.identity.startsWith("AND-504:")){e.disposition="deferred";e.reason="User postponed this delivery";e.authorization="User explicitly asked to ship only the new Web delivery";}
    }
    const selectionPath=join(directory,"selection.json");writeFileSync(selectionPath,JSON.stringify(selection));
    const scoped=run("deploy","--candidates",candidatesPath,"--selection",selectionPath);
    assert.equal(scoped.status,0,scoped.stderr);assert.equal(existsSync(marker),true);
    const scopedReport=JSON.parse(scoped.stdout.slice(scoped.stdout.lastIndexOf('\n{\n  "schemaVersion"')));
    assert.equal(scopedReport.selectedScopeReady,true);assert.equal(scopedReport.fullCoverage,false);
    assert.deepEqual(scopedReport.selection.entries.map(e=>e.disposition).sort(),["deferred","deferred","historical_gap","include"]);
    assert.match(scopedReport.receiptDigest,/^[a-f0-9]{64}$/);
    rmSync(marker);
    withLegacy.pages[0].candidates.push({itemKey:"AND-505"});writeFileSync(candidatesPath,JSON.stringify(withLegacy));
    const stale=run("deploy","--candidates",candidatesPath,"--selection",selectionPath);
    assert.notEqual(stale.status,0);assert.match(stale.stderr,/selection changed/);assert.equal(existsSync(marker),false);
    writeFileSync(candidatesPath,JSON.stringify(originalPages));
    const injection = join(directory, "must-not-execute");
    const selectedReason = `User explicitly selected Web only; $(touch ${injection})`;
    const selected = run("deploy", "--candidates", candidatesPath, "--only-artifacts", "web", "--scope-reason", selectedReason);
    assert.equal(selected.status, 0, selected.stderr); assert.equal(existsSync(marker), true);
    const reconciliation = JSON.parse(selected.stdout.slice(selected.stdout.lastIndexOf('\n{\n  "schemaVersion"')));
    assert.equal(reconciliation.fullCoverage, false); assert.equal(reconciliation.selectedScopeReady, true);
    assert.equal(reconciliation.requestedScope.reason, selectedReason); assert.equal(existsSync(injection), false);
    assert.deepEqual(reconciliation.items.map(item => item.missing[0].artifact), ["macosApp", "macosApp"]);
    const replaced = JSON.parse(readFileSync(receiptPath, "utf8")); replaced.current.macosApp.sha256 = "e".repeat(64);
    writeFileSync(receiptPath, JSON.stringify(replaced));
    const changedBytes = spawnSync(process.execPath, [join(tools, "release-coverage.mjs"), "--root", root, "--receipt", receiptPath,
      "--coverage-config", join(config, "release-coverage.json"), "--candidates", candidatesPath, "--only-artifacts", "web", "--scope-reason", selectedReason], { env, encoding: "utf8" });
    assert.notEqual(changedBytes.status, 0); assert.match(changedBytes.stderr, /macosApp: deployment would change an artifact outside/);
    assert.equal(JSON.parse(changedBytes.stdout).selectedScopeReady, false, "same version/source with different bytes still changes an excluded artifact");
    saveLive(head);
    rmSync(marker);
    ledger.artifacts.macosApp = { version: "2.0", commit: head, sha256: hash };
    writeFileSync(join(root, "released.json"), JSON.stringify(ledger)); const published = commit(root); git(root, "update-ref", "refs/remotes/origin/main", published);
    live.macosApp = { version: "2.0", sourceCommit: head, sha256: hash }; saveLive(published);
    const all = run("deploy", "--candidates", candidatesPath);
    assert.equal(all.status, 0, all.stderr); assert.equal(existsSync(marker), true);
    const complete = JSON.parse(all.stdout.slice(all.stdout.lastIndexOf('\n{\n  "schemaVersion"')));
    assert.equal(complete.fullCoverage, true); assert.equal(complete.items.every(item => item.status === "ready"), true);
    writeFileSync(join(tools, "release-coverage.mjs"), "unknown local edit");
    assert.throws(install, /unknown local changes/); assert.equal(readFileSync(join(tools, "release-coverage.mjs"), "utf8"), "unknown local edit");
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
