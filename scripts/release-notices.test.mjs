import assert from "node:assert/strict";
import { test } from "node:test";

import { withVerifiedEvidence, affectsArtifact, releaseBatches, inReleasedRange, matchCandidates, releaseCandidatesFromPages, requiredArtifactsForFiles } from "./release-notices.mjs";

const a = "a".repeat(40);
const b = "b".repeat(40);
const c = "c".repeat(40);

test("requires the PR merge inside the published source range", () => {
  const order = [a, b, c];
  const ancestor = (older, newer) => order.indexOf(older) <= order.indexOf(newer);
  assert.equal(inReleasedRange(b, a, c, ancestor), true);
  assert.equal(inReleasedRange(a, a, c, ancestor), false);
  assert.equal(inReleasedRange(c, a, b, ancestor), false);
});

test("matches affected artifact paths without accepting test-only changes", () => {
  assert.equal(affectsArtifact("services/server/src/app.ts", "web"), true);
  assert.equal(affectsArtifact("apps/macos/Tests/FooTests.swift", "macosApp"), false);
  assert.equal(affectsArtifact("apps/android/src/main/Foo.kt", "androidSdk"), false);
  assert.equal(affectsArtifact("sdks/android-feedback/missiongo-feedback/src/main/Foo.kt", "androidSdk"), true);
  assert.deepEqual(requiredArtifactsForFiles(["services/server/src/app.ts", "apps/macos/Sources/App.swift"]), ["macosApp", "web"]);
});

test("proposes one stable comment only for a merged PR touching the released artifact", () => {
  const receipt = {
    schemaVersion: 1,
    deployedCommit: c,
    current: { web: { version: c, commit: c, clean: true, ciPassed: true } },
    publicEvidence: { checks: { web: true } },
    changes: [
      { artifact: "web", version: c, fromCommit: a, toCommit: c, eligibleForMatching: true },
      { artifact: "androidSdk", version: "0.2.6", fromCommit: a, toCommit: c, eligibleForMatching: false },
    ],
  };
  const candidates = [{ itemKey: "AND-75", pullRequestUrl: "https://github.com/owner/repo/pull/42", requiredArtifacts: ["web"] }];
  const resolve = () => ({ mergeCommit: b, files: ["services/server/src/app.ts"] });
  const ancestor = (older, newer) => [a, b, c].indexOf(older) <= [a, b, c].indexOf(newer);
  const first = matchCandidates(receipt, candidates, resolve, ancestor);
  const second = matchCandidates(receipt, candidates, resolve, ancestor);
  assert.equal(first.comments.length, 1);
  assert.equal(first.comments[0].bodyKind, "free");
  assert.match(first.comments[0].text, /已正式发布/);
  assert.equal(first.comments[0].idempotencyKey, second.comments[0].idempotencyKey);
  assert.equal(first.comments[0].transitionIdempotencyKey, second.comments[0].transitionIdempotencyKey);
  assert.deepEqual(first.comments[0].releases, [{ artifact: "web", version: c, sourceCommit: c }]);
  assert.deepEqual(first.skipped, []);
});

test("accepts explicit scope when file path suggestions differ", () => {
  const receipt = { deployedCommit:c,current:{web:{version:c,commit:c,clean:true,ciPassed:true}},publicEvidence:{checks:{web:true}},changes:[] };
  const candidates = [{ itemKey: "AND-75", pullRequestUrl: "https://github.com/owner/repo/pull/42", requiredArtifacts: ["web"] }];
  const ancestor = (older, newer) => [a, b, c].indexOf(older) <= [a, b, c].indexOf(newer);
  const result = matchCandidates(receipt, candidates, () => ({ mergeCommit: b, files: ["apps/macos/Sources/App.swift"] }), ancestor);
  assert.equal(result.comments.length, 1);
  assert.equal(result.skipped.length, 0);
});

test("waits for every related artifact across separate release batches", () => {
  const candidate = [{ itemKey: "AND-75", pullRequestUrl: "https://github.com/owner/repo/pull/42", requiredArtifacts: ["web", "macosApp"] }];
  const resolve = () => ({ mergeCommit: b, files: ["services/server/src/app.ts", "apps/macos/Sources/App.swift"] });
  const ancestor = (older, newer) => [a, b, c].indexOf(older) <= [a, b, c].indexOf(newer);
  const receipt = {
    schemaVersion: 1, deployedCommit: c,
    current: {
      web: { version: c, commit: c, clean: true, ciPassed: true },
      macosApp: { version: "1.2", sourceCommit: a },
    },
    publicEvidence: { checks: { web: true, macosApp: true } },
    changes: [{ artifact: "web", version: c, fromCommit: a, toCommit: c, eligibleForMatching: true }],
  };
  assert.deepEqual(matchCandidates(receipt, candidate, resolve, ancestor).comments, []);
  receipt.current.macosApp.sourceCommit = c;
  receipt.changes = [{ artifact: "macosApp", version: "1.2", fromCommit: a, toCommit: c, eligibleForMatching: true }];
  assert.deepEqual(matchCandidates(receipt, candidate, resolve, ancestor).comments[0].releases.map((release) => release.artifact), ["macosApp", "web"]);
  receipt.publicEvidence.checks.macosApp = false;
  assert.deepEqual(matchCandidates(receipt, candidate, resolve, ancestor).comments, []);
});

test("collects every candidate page, including an empty page with a continuation", () => {
  const page = (requestedBeforeSequence, candidates, nextBeforeSequence) => ({
    requestedBeforeSequence, productId: "mission-go", candidates,
    ...(nextBeforeSequence ? { nextBeforeSequence } : {}),
  });
  const first = { itemKey: "AND-75" };
  const last = { itemKey: "AND-76" };
  const pages = [page(null, [first], 100), page(100, [], 50), page(50, [last])];
  assert.deepEqual(releaseCandidatesFromPages({ pages }).candidates, [first, last]);
  assert.throws(() => releaseCandidatesFromPages({ pages: pages.slice(0, 2) }), /final page/);
  assert.throws(() => releaseCandidatesFromPages({ pages: [pages[0], pages[2]] }), /cursor/);
  assert.throws(() => releaseCandidatesFromPages({ pages: [pages[0], { ...pages[1], productId: "other" }, pages[2]] }), /products/);
});

test("proposes a separate handoff for every eligible item in the release", () => {
  const receipt = {
    schemaVersion: 1, deployedCommit: c,
    current: { web: { version: c, commit: c, clean: true, ciPassed: true } },
    publicEvidence: { checks: { web: true } },
    changes: [{ artifact: "web", fromCommit: a, toCommit: c, eligibleForMatching: true }],
  };
  const candidates = ["AND-75", "AND-76"].map((itemKey) => ({
    itemKey, pullRequestUrl: "https://github.com/owner/repo/pull/42", requiredArtifacts: ["web"],
  }));
  const ancestor = (older, newer) => [a, b, c].indexOf(older) <= [a, b, c].indexOf(newer);
  const result = matchCandidates(receipt, candidates, () => ({ mergeCommit: b, files: ["services/server/src/app.ts"] }), ancestor);
  assert.deepEqual(result.comments.map((comment) => comment.itemKey), ["AND-75", "AND-76"]);
  assert.notEqual(result.comments[0].idempotencyKey, result.comments[1].idempotencyKey);
});


test("release batch requests bind verified candidates, split at 100, and reject missing snapshots", () => {
  const candidates = Array.from({ length: 102 }, (_, i) => ({ itemKey: `AND-${i + 1}`,
    pullRequestUrl: "https://github.com/owner/repo/pull/42", requiredArtifacts: ["web"],
    expectedRevision: 4, developmentEventId: "11111111-1111-4111-8111-111111111111", roundKey: "22222222-2222-4222-8222-222222222222" }));
  delete candidates[101].roundKey;
  const receipt = { deployedCommit: c, current: { web: { version: "1.0", commit: c, clean: true, ciPassed: true } }, publicEvidence: { checks: { web: true } } };
  const matched = matchCandidates(receipt, candidates, () => ({ mergeCommit: b }), () => true);
  const result = releaseBatches("product", candidates, matched);
  assert.deepEqual(result.batches.map(row => row.items.length), [100, 1]);
  assert.equal(result.skipped[0].itemKey, "AND-102");
  assert.deepEqual(result, releaseBatches("product", candidates, matched));
  assert.equal(result.batches[0].items[0].expectedRevision, 4);
  candidates[0].expectedRevision++;
  assert.notEqual(releaseBatches("product", candidates, matched).batches[0].idempotencyKey, result.batches[0].idempotencyKey);
  assert.deepEqual(releaseBatches("product", [], { comments: [], skipped: [] }), { batches: [], skipped: [] });
});


test("explicit evidence supplements preserve service pages, bind snapshots and retain artifact checks", () => {
  const candidates=[{itemKey:"AND-417",expectedRevision:4,developmentEventId:"11111111-1111-4111-8111-111111111111",roundKey:"22222222-2222-4222-8222-222222222222"}];
  const evidence={productId:"product",items:[{...candidates[0],completion:{kind:"github",url:"https://github.com/owner/repo/pull/42"},requiredArtifacts:["web","androidApp"],verification:"Verified merged source and complete scope; host preconditions checked."}]};
  const combined=withVerifiedEvidence("product",candidates,evidence);
  assert.equal(candidates[0].completion,undefined);
  assert.deepEqual(combined[0].requiredArtifacts,["web","androidApp"]);
  for(const changes of [{expectedRevision:5},{roundKey:"changed"},{itemKey:"AND-999"},{verification:""},{requiredArtifacts:[]}]) {
    assert.throws(()=>withVerifiedEvidence("product",candidates,{...evidence,items:[{...evidence.items[0],...changes}]}));
  }
  assert.throws(()=>withVerifiedEvidence("other",candidates,evidence));
  assert.throws(()=>withVerifiedEvidence("product",[{...candidates[0],requiredArtifacts:["web"]}],evidence),/conflicts/);
  const receipt={deployedCommit:c,current:{web:{version:"1.0",commit:c,clean:true,ciPassed:true}},publicEvidence:{checks:{web:true}}};
  assert.equal(matchCandidates(receipt,combined,()=>({mergeCommit:b}),()=>true).comments.length,0);
});

test("keeps two deliveries of one item separate in comments and batch handover",()=>{
 const receipt={deployedCommit:c,current:{web:{version:c,commit:c,clean:true,ciPassed:true}},publicEvidence:{checks:{web:true}}};
 const base={itemKey:"AND-471",expectedRevision:10,roundKey:"00000000-0000-4000-8000-000000000001",requiredArtifacts:["web"]};
 const candidates=[1,2].map(n=>({...base,developmentEventId:`00000000-0000-4000-8000-00000000000${n+1}`,pullRequestUrl:`https://github.com/owner/repo/pull/${n}`}));
 const matched=matchCandidates(receipt,candidates,()=>({mergeCommit:b}),()=>true);
 assert.equal(matched.comments.length,2);
 assert.notEqual(matched.comments[0].idempotencyKey,matched.comments[1].idempotencyKey);
 assert.deepEqual(releaseBatches("product",candidates,matched).batches[0].items.map(row=>row.developmentEventId),candidates.map(row=>row.developmentEventId));
});

test("matches a commit delivery only when the public artifact contains its commit",()=>{
 const receipt={deployedCommit:c,current:{web:{version:c,commit:c,clean:true,ciPassed:true}},publicEvidence:{checks:{web:true}}};
 const candidate={itemKey:"AND-471",completion:{kind:"commit",commit:b,targetBranch:"main"},requiredArtifacts:["web"]};
 const resolve=()=>{throw new Error("Commit evidence must not resolve an invented PR");};
 assert.equal(matchCandidates(receipt,[candidate],resolve,()=>true).comments.length,1);
 assert.equal(matchCandidates(receipt,[candidate],resolve,()=>false).comments.length,0);
});

test("standalone release handover generates delivery receipts without work-item comments",()=>{
  const candidate={kind:"delivery",deliveryId:"12345678-1234-4234-8234-123456789abc",expectedRevision:"a".repeat(64),pullRequestUrl:"https://github.com/example/repo/pull/12",requiredArtifacts:["web","macosApp"]};
  const source="c".repeat(40),merge="b".repeat(40);
  const receipt={schemaVersion:1,deployedCommit:source,current:{web:{version:"1",commit:source,clean:true,ciPassed:true},macosApp:{version:"2",sourceCommit:source}},publicEvidence:{checks:{web:true,macosApp:true}}};
  const matched=matchCandidates(receipt,[candidate],()=>({mergeCommit:merge}),()=>true);
  assert.deepEqual(matched.comments,[]);assert.deepEqual(matched.skipped,[]);assert.equal(matched.deliveries.length,1);
  const result=releaseBatches("product",[candidate],matched);
  assert.equal(result.batches.length,1);assert.deepEqual(result.batches[0].items,[]);
  assert.deepEqual(result.batches[0].deliveries,[{deliveryId:candidate.deliveryId,expectedRevision:candidate.expectedRevision,releases:matched.deliveries[0].releases}]);
  const missing=matchCandidates({...receipt,publicEvidence:{checks:{web:true,macosApp:false}}},[candidate],()=>({mergeCommit:merge}),()=>true);
  assert.equal(missing.deliveries,undefined);assert.equal(missing.skipped[0].deliveryId,candidate.deliveryId);
});


test("AND-503 post-release handover keeps exclusions and cannot reuse a changed selection", async()=>{
  const {createReleaseSelection,releaseCandidatesFromPages}=await import("./release-candidates.mjs");
  const {matchReleaseSelection}=await import("./release-notices.mjs");
  const commit="a".repeat(40),repository="https://github.com/owner/repo";
  const rows=[{itemKey:"AND-1",completion:{kind:"commit",commit,targetBranch:"main"},requiredArtifacts:["web"]},
    {itemKey:"AND-451"},{itemKey:"AND-2",completion:{kind:"commit",commit,targetBranch:"main"},requiredArtifacts:["web"]}];
  const snapshot=releaseCandidatesFromPages({pages:[{requestedBeforeSequence:null,productId:"product",coverageVersion:2,generatedAt:new Date().toISOString(),candidates:rows,noReleaseItems:[],noReleaseDeliveries:[]}]},{coverage:true});
  const selection=createReleaseSelection(snapshot,repository,commit);
  selection.entries[1]={...selection.entries[1],disposition:"historical_gap",reason:"Unrelated local tool needs proof"};
  selection.entries[2]={...selection.entries[2],disposition:"deferred",reason:"User postponed",authorization:"User said defer AND-2"};
  const receipt={schemaVersion:1,deployedCommit:commit,current:{web:{version:"1",commit,clean:true,ciPassed:true}},publicEvidence:{checks:{web:true}}};
  const report=matchReleaseSelection(receipt,snapshot,selection,repository,()=>{throw Error("commit needs no PR lookup");},()=>true);
  const pin=report.selection.digest;
  const changed=structuredClone(selection);changed.entries[0]={...changed.entries[0],disposition:"deferred",reason:"Changed",authorization:"Synthetic instruction"};
  assert.throws(()=>matchReleaseSelection(receipt,snapshot,changed,repository,()=>null,()=>true,pin),/selection digest changed/);
  assert.throws(()=>matchReleaseSelection(receipt,snapshot,null,repository,()=>null),/Invalid release selection object/);
  assert.deepEqual(report.comments.map(c=>c.itemKey),["AND-1"]);assert.equal(report.selection.entries.length,3);
  assert.equal(report.selection.entries.find(e=>e.identity.startsWith("AND-451:")).disposition,"historical_gap");
  assert.throws(()=>matchReleaseSelection({...receipt,deployedCommit:"b".repeat(40)},snapshot,selection,repository,()=>null),/selection changed/);
  assert.throws(()=>matchReleaseSelection(receipt,{...snapshot,candidates:[...rows,{itemKey:"AND-3"}]},selection,repository,()=>null),/selection changed/);
});
