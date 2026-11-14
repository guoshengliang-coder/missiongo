import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync, copyFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { collectReadiness, inspectInstalledTools, parseReadOnlyArgs, classifyReadiness } from "./release-readiness.mjs";
import { RELEASE_TOOL_FILES } from "./release-tool-files.mjs";
import { install } from "./install-release-tools.mjs";
const repository = "https://github.com/example/project", head = "a".repeat(40), now = Date.parse("2026-01-01T00:00:00Z");
function setup() {
  const candidates = { pages: [{ requestedBeforeSequence: null, productId: "product", coverageVersion: 2, generatedAt: new Date(now).toISOString(),
    candidates: [{ itemKey: "AND-1", developmentEventId: "first", requiredArtifacts: null }], noReleaseItems: [{ itemKey: "AND-2", noReleaseReason: "Local tools" }], noReleaseDeliveries: [] }] };
  const input = { root: ".", config: { schemaVersion: 1, productId: "product", repository }, candidates, now,
    batch: { id: "batch", productId: "product", integration: { revision: 7 }, deliveries: ["delivery"], entries: [{ id: "delivery", head, repository, requiredArtifacts: ["web"], pullRequest: 1, targetBranch: "main" }] } };
  const operations = { repository: () => repository, head: () => head, originMain: () => head, remoteMain: () => head, ancestor: () => true,
    tools: () => ({ status: "review_required" }), live: () => ({}), artifact: name => name === "androidApp" ? (() => { throw new Error("old APK"); })() : [{ artifact: name }],
    coverage: records => ({ ready: false, observedArtifacts: records.length }), versions: () => [{ artifact: "web", blocking: true }], patchBumps: () => [{ artifact: "web", from: "1.0.0", to: "1.0.1" }],
    notes: artifact => ({ artifact, missing: ["PR 1"] }), prospective: entry => ({ head: entry.head, prospective: true }) };
  return { input, operations };
}
test("one artifact failure cannot mask historical gaps, old tools, version bumps, notes or no-release work", () => {
  const { input, operations } = setup(), before = JSON.stringify(input);
  const report = collectReadiness(input, operations);
  assert.equal(JSON.stringify(input), before);
  assert.equal(report.historicalGaps[0].identity, "AND-1:first");
  assert.deepEqual(report.historicalGaps[0].missing, ["integration", "release_scope"]);
  assert.equal(report.noReleaseItems[0].itemKey, "AND-2");
  assert.equal(report.checks.find(c => c.name === "artifact:androidApp").status, "unverified");
  assert.equal(report.checks.find(c => c.name === "patch_bumps").value[0].to, "1.0.1");
  assert.equal(report.checks.find(c => c.name === "coverage").value.observedArtifacts, 3);
  assert.equal(report.checks.find(c => c.name === "release_notes:macosApp").value.missing[0], "PR 1");
  assert.deepEqual(report.decisions, []);
  assert.equal(report.batchRevision, 7);
});
test("invalid scope, incomplete pagination and cross-product batches fail before any observation", () => {
  for (const mutate of [f => f.input.candidates.pages[0].nextBeforeSequence = 9, f => f.input.config.productId = "other", f => f.input.batch.productId = "other",
    f => f.input.batch.entries = [], f => f.input.batch.entries.push(f.input.batch.entries[0]), f => f.input.batch.entries[0].repository = "https://github.com/other/project"]) {
    const f = setup(); mutate(f); let calls = 0; f.operations.live = () => { calls++; };
    assert.throws(() => collectReadiness(f.input, f.operations)); assert.equal(calls, 0);
  }
});
test("head, batch and candidate revisions bind investigation; stale main remains visible", () => {
  const f = setup(), first = collectReadiness(f.input, f.operations);
  f.input.batch.entries[0].head = "b".repeat(40);
  f.input.candidates.pages[0].candidates[0].expectedRevision = 2;
  f.operations.remoteMain = () => "c".repeat(40);
  const next = collectReadiness(f.input, f.operations);
  assert.notEqual(first.batchDigest, next.batchDigest); assert.notEqual(first.candidatesDigest, next.candidatesDigest);
  assert.equal(next.checks.find(c => c.name === "main").status, "unverified");
  assert.ok(next.checks.find(c => c.name === "versions"));
});
test("a checkout moving during independent checks invalidates the investigation", () => {
  const f = setup(); let reads = 0;
  f.operations.head = () => ++reads === 1 ? head : "e".repeat(40);
  const report = collectReadiness(f.input, f.operations);
  assert.equal(report.needsFollowUp, true);
  assert.equal(report.checks.find(c => c.name === "checkout_consistency").status, "unverified");
  assert.ok(report.checks.find(c => c.name === "patch_bumps"));
});
test("fixed inventory detects a stale, tampered or unsafe installed file without writing", t => {
  const directory = mkdtempSync(join(tmpdir(), "readiness-inventory-")); t.after(() => rmSync(directory, { recursive: true, force: true }));
  const home = join(directory, "home"), root = process.cwd(), configHome = join(home, ".config");
  install({ source: root, home, configHome, commit: head });
  assert.equal(inspectInstalledTools(root, { home, configHome }).status, "matching");
  const manifest = join(configHome, "missiongo/release-tools-manifest.json"), before = readFileSync(manifest, "utf8");
  const installed = join(configHome, "missiongo/release-tools/release-ci.mjs");
  writeFileSync(installed, "changed");
  assert.equal(inspectInstalledTools(root, { home, configHome }).files.find(f => f.name === "release-ci.mjs").status, "manifest_mismatch");
  rmSync(installed); symlinkSync(join(root, "scripts/release-ci.mjs"), installed);
  assert.equal(inspectInstalledTools(root, { home, configHome }).files.find(f => f.name === "release-ci.mjs").status, "missing_or_unsafe");
  assert.equal(readFileSync(manifest, "utf8"), before);
  const fakeSource = join(directory, "source"); mkdirSync(join(fakeSource, "scripts"), { recursive: true });
  for (const [name] of Object.entries(RELEASE_TOOL_FILES)) if (name !== "entry") writeFileSync(join(fakeSource, "scripts", name), "old source");
  assert.equal(inspectInstalledTools(fakeSource, { home, configHome }).files.find(f => f.name === "deploy.sh").status, "source_differs");
});
test("read-only CLI rejects typo, duplicate, missing values and deploy overrides", () => {
  assert.deepEqual(parseReadOnlyArgs(["--batch", "batch.json"], ["--batch"]), { "--batch": "batch.json" });
  for (const args of [["--batch"], ["--batch", "a", "--batch", "b"], ["--host", "other"], ["--batch=a"]]) assert.throws(() => parseReadOnlyArgs(args, ["--batch"]));
});

test("an inventory listing cannot conceal a removed executable CI guard", t => {
  const directory = mkdtempSync(join(tmpdir(), "readiness-guard-")); t.after(() => rmSync(directory, { recursive: true, force: true }));
  const source = join(directory, "source"), home = join(directory, "home");
  for (const name of Object.values(RELEASE_TOOL_FILES)) {
    const target = join(source, "scripts", name); mkdirSync(dirname(target), { recursive: true });
    copyFileSync(join(process.cwd(), "scripts", name), target);
  }
  const entry = join(source, "scripts/missiongo-release.py");
  writeFileSync(entry, readFileSync(entry, "utf8").replaceAll("release-ci.mjs", "disabled-ci.mjs"));
  assert.throws(() => install({ source, home, configHome: join(home, ".config"), dryRun: true }), /missing: release-ci.mjs/);
});

test("a nonblocking version provenance warning still needs investigation", () => {
  const f = setup(); f.input.candidates.pages[0].candidates = [];
  f.operations.tools = () => ({ status: "matching" }); f.operations.artifact = () => [];
  f.operations.coverage = () => ({ ready: true }); f.operations.patchBumps = () => [];
  f.operations.notes = () => ({ missing: [] });
  f.operations.versions = () => [{ artifact: "androidSdk", blocking: false, reason: "cannot verify source" }];
  assert.equal(collectReadiness(f.input, f.operations).needsFollowUp, true);
});

test("AND-521 separates ordinary tool drift, damaged installation and necessary capabilities", t => {
  const directory=mkdtempSync(join(tmpdir(),"and521-tools-"));t.after(()=>rmSync(directory,{recursive:true,force:true}));
  const home=join(directory,"home"),configHome=join(home,".config"),root=process.cwd();
  install({source:root,home,configHome,commit:head});
  const inspect=()=>inspectInstalledTools(root,{home,configHome});
  assert.equal(inspect().integrity,"verified");assert.equal(inspect().capabilities.status,"verified");
  const target=join(configHome,"missiongo/release-tools/release-readiness.mjs");
  writeFileSync(target,readFileSync(target,"utf8")+"\n// unrelated change\n");
  assert.equal(inspect().integrity,"damaged");
  const manifest=join(configHome,"missiongo/release-tools-manifest.json"),data=JSON.parse(readFileSync(manifest,"utf8"));
  // A trusted, self-consistent old installation may differ from current source.
  data.tools["release-readiness.mjs"]=inspect().files.find(f=>f.name==="release-readiness.mjs").installedSha256;
  writeFileSync(manifest,JSON.stringify(data));
  const drift=inspect();assert.equal(drift.integrity,"verified");assert.equal(drift.status,"review_required");
  const c=classifyReadiness([{name:"tools",status:"observed",value:drift,nextOwner:"Maintainer"}],[],setup().input.batch);
  assert.equal(c.find(c=>c.id==="installation_integrity").state,"satisfied");
  assert.equal(c.find(c=>c.id==="tool_difference").required,false);
  const entry=join(home,".local/bin/missiongo-release");
  writeFileSync(entry,readFileSync(entry,"utf8").replaceAll("release-ci.mjs","removed-ci.mjs"));
  assert.ok(inspect().capabilities.missing.includes("entry"));
  rmSync(target);assert.equal(inspect().integrity,"damaged");
  writeFileSync(manifest,"bad JSON");assert.equal(inspect().integrity,"unverified");
});

test("AND-521 keeps post-merge work and unrelated artifacts out of the first-merge gate",()=>{
  const f=setup(),r=collectReadiness(f.input,f.operations);
  assert.equal(r.needsFollowUp,true);
  assert.equal(r.conditions.find(c=>c.id==="patch_bumps").stage,"post_merge");
  assert.equal(r.conditions.find(c=>c.id==="artifact:androidApp").required,false);
  assert.equal(r.conditions.filter(c=>c.kind==="main").length,1);
  assert.match(r.evidenceContext.tools,/^[a-f0-9]{64}$/);
  const b={...f.input.batch,entries:f.input.batch.entries.map(e=>({...e,requiredArtifacts:[],noReleaseReason:"Internal tool"}))};
  assert.ok(classifyReadiness(r.checks,r.historicalGaps,b).every(c=>!c.required));
});
test("empty batches, duplicate artifacts and unexplained no-release scope are refused", () => {
  for (const change of [f => { f.input.batch.deliveries = []; f.input.batch.entries = []; },
    f => f.input.batch.entries[0].requiredArtifacts.push("web"), f => f.input.batch.entries[0].requiredArtifacts = []]) {
    const f = setup(); change(f); assert.throws(() => collectReadiness(f.input, f.operations));
  }
});

test("coordinator rejects zero-exit helpers without complete output and preserves nonzero reports", t => {
  const directory = mkdtempSync(join(tmpdir(), "readiness-output-")); t.after(() => rmSync(directory, { recursive: true, force: true }));
  const home = join(directory, "home"), configHome = join(home, ".config");
  install({ source: process.cwd(), home, configHome, commit: head });
  const entry = join(home, ".local/bin/missiongo-release");
  const program = "import runpy,sys,json; module=runpy.run_path(sys.argv[1]); module['run_readonly'](json.loads(sys.argv[2]),sys.argv[3],sys.argv[4],json.loads(sys.argv[5]))";
  const run = (script, action = "readiness", options = []) => spawnSync("python3", ["-c", program, entry, JSON.stringify([process.execPath, "-e", script]), directory, action, JSON.stringify(options)],
    { encoding: "utf8", env: { PATH: process.env.PATH, HOME: home, XDG_CONFIG_HOME: configHome } });
  for (const script of ["process.exit(0)", "console.log('{}')", "console.log('unexpected banner')"]) {
    const result = run(script); assert.notEqual(result.status, 0); assert.match(result.stderr, /incomplete read-only report/i);
  }
  const payload = { schemaVersion: 1, kind: "integration_readiness", checks: [{ name: "test" }] };
  const expected = JSON.stringify(payload) + "\n";
  const result = run(`console.log(${JSON.stringify(JSON.stringify(payload))});process.exit(1)`);
  assert.equal(result.stdout, expected); assert.notEqual(result.status, 0);
  const valid = run(`console.log(${JSON.stringify(JSON.stringify(payload))})`); assert.equal(valid.status, 0); assert.equal(valid.stdout, expected);
  const markdown = "逐项交付结果\n\n| 对象 | 结果 | 缺口 | 责任 |\n|---|---|---|---|\n| test | test | test | test |\n";
  const ordered = run(`process.stdout.write(${JSON.stringify(markdown)})`, "report", ["--format", "markdown", "--input", "file.json"]);
  assert.equal(ordered.status, 0, ordered.stderr); assert.equal(ordered.stdout, markdown);
});
