import assert from "node:assert/strict";
import { test } from "node:test";
import { releaseCandidatesFromPages } from "./release-candidates.mjs";
import { assertReleaseCoverage, planReleaseCoverage, receiptArtifacts, releaseScope } from "./release-coverage.mjs";

const old = "a".repeat(40), merge = "b".repeat(40), head = "c".repeat(40);
const now = Date.now();
const candidate = (itemKey, artifacts = ["web", "macosApp"]) => ({ itemKey, pullRequestUrl: "https://github.com/owner/repo/pull/42", requiredArtifacts: artifacts });
const page = (candidates, extra = {}) => ({ requestedBeforeSequence: null, productId: "product", coverageVersion: 1, generatedAt: new Date(now).toISOString(), candidates, noReleaseItems: [], ...extra });
const input = (candidates, extra) => ({ pages: [page(candidates, extra)] });
const artifacts = [{ artifact: "web", version: "1.2", sourceCommit: head }, { artifact: "macosApp", version: "0.4.63", sourceCommit: old }];
const options = { productId: "product", repository: "https://github.com/owner/repo", head, artifacts, now };
const ancestor = (older, newer) => [old, merge, head].indexOf(older) <= [old, merge, head].indexOf(newer);
const resolve = () => ({ state: "merged", mergeCommit: merge });
const plan = (snapshot, changes = {}, resolver = resolve) => planReleaseCoverage(snapshot, { ...options, ...changes }, resolver, ancestor);

test("blocks the incident: a valid old macOS package cannot satisfy either merged item", () => {
  const report = plan(input([candidate("AND-360"), candidate("AND-363")]));
  assert.equal(report.ready, false); assert.equal(report.fullCoverage, false);
  assert.deepEqual(report.requiredArtifacts, ["macosApp", "web"]);
  assert.deepEqual(report.items.map(item => [item.itemKey, item.status, item.missing.map(m => m.artifact)]), [
    ["AND-360", "missing_artifacts", ["macosApp"]], ["AND-363", "missing_artifacts", ["macosApp"]],
  ]);
  assert.throws(() => assertReleaseCoverage(report), /AND-360: macosApp.*AND-363: macosApp/);
  const complete = plan(input([candidate("AND-360"), candidate("AND-363")]), { artifacts: artifacts.map(a => ({ ...a, sourceCommit: head })) });
  assert.equal(complete.ready, true); assert.equal(complete.fullCoverage, true); assert.doesNotThrow(() => assertReleaseCoverage(complete));
});

test("explicit partial scope never hides excluded items or missing parts", () => {
  assert.throws(() => releaseScope("linuxCli"), /explicit scope/);
  assert.throws(() => releaseScope(undefined, "reason"), /requires/);
  for (const value of ["", "unknown", "web,web"]) assert.throws(() => releaseScope(value, "user selected"));
  const report = plan(input([candidate("AND-1"), candidate("AND-2", ["linuxCli"])]), { scope: releaseScope("web", "User requested Web only") });
  assert.equal(report.ready, true); assert.equal(report.fullCoverage, false);
  assert.equal(report.items[0].status, "partial"); assert.deepEqual(report.items[0].excludedArtifacts, ["macosApp"]);
  assert.equal(report.items[1].status, "excluded"); assert.deepEqual(report.items[1].excludedArtifacts, ["linuxCli"]);
  assert.equal(report.scope.reason, "User requested Web only");
  assert.throws(() => assertReleaseCoverage(plan(input([candidate("AND-1")]), { scope: releaseScope("macosApp", "User requested macOS") })), /macosApp/);
});

test("unknown scopes and unverifiable integration block, confirmed unmerged work is reported separately", () => {
  for (const requiredArtifacts of [undefined, [], ["web", "web"]]) {
    const report = plan(input([{ ...candidate("AND-1"), requiredArtifacts }]));
    assert.equal(report.items[0].status, "scope_unknown"); assert.throws(() => assertReleaseCoverage(report));
  }
  const unverifiable = plan(input([candidate("AND-1")]), {}, () => { throw new Error("Cannot verify integration"); });
  assert.equal(unverifiable.ready, false);
  const open = plan(input([candidate("AND-1")]), {}, () => ({ state: "unmerged" }));
  assert.equal(open.items[0].status, "waiting_merge"); assert.equal(open.ready, true); assert.deepEqual(open.requiredArtifacts, []);
  assert.equal(plan(input([candidate("AND-1")]), { head: old }).items[0].status, "integration_unverified");
});

test("full pagination includes unknown work and explicit no-release exclusions", () => {
  const pages = [page([], { nextBeforeSequence: 100, noReleaseItems: [{ itemKey: "AND-9", noReleaseReason: "Tests only" }] }),
    page([], { requestedBeforeSequence: 100, nextBeforeSequence: 50 }), page([candidate("AND-1")], { requestedBeforeSequence: 50 })];
  assert.deepEqual(releaseCandidatesFromPages({ pages }, { coverage: true, now }).noReleaseItems, [{ itemKey: "AND-9", noReleaseReason: "Tests only" }]);
  assert.throws(() => releaseCandidatesFromPages({ pages: pages.slice(0, 2) }, { coverage: true, now }), /final page/);
  assert.throws(() => releaseCandidatesFromPages({ pages: [pages[0], pages[2]] }, { coverage: true, now }), /cursor/);
  assert.throws(() => releaseCandidatesFromPages({ pages: [page([]), page([candidate("AND-1")])] }), /after the final/);
  assert.throws(() => plan(input([candidate("AND-1")], { coverageVersion: undefined })), /includeUnscoped/);
  assert.throws(() => plan(input([candidate("AND-1")], { generatedAt: new Date(now - 16 * 60_000).toISOString() })), /stale/);
  assert.throws(() => plan(input([candidate("AND-1")], { generatedAt: new Date(now + 120_000).toISOString() })), /invalid/);
  assert.throws(() => plan(input([candidate("AND-1")]), { productId: "other" }), /product/);
});

test("missing provenance and public verification cannot be borrowed from release ledgers", () => {
  const values = receiptArtifacts({ current: { web: { version: "1", commit: head, clean: true, ciPassed: true }, macosApp: { version: "2", sourceCommit: head } }, publicEvidence: { checks: { web: true, macosApp: false } } });
  const report = plan(input([candidate("AND-1")]), { artifacts: values });
  assert.equal(report.ready, false); assert.equal(report.items[0].missing[0].reason, "verified artifact provenance is missing");
  const expired = input([candidate("AND-1", ["web"])], { generatedAt: new Date(now - 60 * 60_000).toISOString() });
  assert.equal(plan(expired, { receipt: true, artifacts: values }).ready, true, "post-release accounting can evaluate the original cutoff without authorizing a stale deployment");
});

test("standalone deliveries share full coverage and cannot disappear through old or truncated pages",()=>{
  const standalone={kind:"delivery",deliveryId:"12345678-1234-4234-8234-123456789abc",expectedRevision:"a".repeat(64),title:"Connection repair",pullRequestUrl:"https://github.com/owner/repo/pull/43",requiredArtifacts:["web","macosApp"]};
  const data=input([candidate("AND-1"),standalone],{coverageVersion:2,noReleaseDeliveries:[]});
  const report=plan(data);
  assert.equal(report.ready,false);assert.equal(report.items[1].deliveryId,standalone.deliveryId);
  assert.equal(report.items[1].itemKey,undefined);assert.deepEqual(report.items[1].missing.map(r=>r.artifact),["macosApp"]);
  assert.throws(()=>assertReleaseCoverage(report),/pull\/43: macosApp/);
  assert.equal(plan(data,{artifacts:artifacts.map(a=>({...a,sourceCommit:head}))}).ready,true);
  const partial=plan(data,{scope:releaseScope("web","User selected Web only")});
  assert.equal(partial.ready,true);assert.equal(partial.fullCoverage,false);assert.deepEqual(partial.items[1].excludedArtifacts,["macosApp"]);
  assert.throws(()=>plan(input([standalone])),/coverageVersion=2/);
  assert.throws(()=>plan({...data,pages:[{...data.pages[0],nextBeforeSequence:4}]}),/final page/);
  assert.throws(()=>plan(input([standalone,standalone],{coverageVersion:2,noReleaseDeliveries:[]})),/repeat/);
});
