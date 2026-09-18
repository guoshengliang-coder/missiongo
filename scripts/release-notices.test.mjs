import assert from "node:assert/strict";
import { test } from "node:test";

import { affectsArtifact, inReleasedRange, matchCandidates } from "./release-notices.mjs";

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
});

test("proposes one stable comment only for a merged PR touching the released artifact", () => {
  const receipt = {
    changes: [
      { artifact: "web", version: c, fromCommit: a, toCommit: c, eligibleForMatching: true },
      { artifact: "androidSdk", version: "0.2.6", fromCommit: a, toCommit: c, eligibleForMatching: false },
    ],
  };
  const candidates = [{ itemKey: "AND-75", pullRequestUrl: "https://github.com/owner/repo/pull/42" }];
  const resolve = () => ({ mergeCommit: b, files: ["services/server/src/app.ts"] });
  const ancestor = (older, newer) => [a, b, c].indexOf(older) <= [a, b, c].indexOf(newer);
  const first = matchCandidates(receipt, candidates, resolve, ancestor);
  const second = matchCandidates(receipt, candidates, resolve, ancestor);
  assert.equal(first.comments.length, 1);
  assert.equal(first.comments[0].bodyKind, "free");
  assert.match(first.comments[0].text, /已正式发布/);
  assert.equal(first.comments[0].idempotencyKey, second.comments[0].idempotencyKey);
  assert.deepEqual(first.skipped, []);
});

test("reports a merged but unrelated PR without proposing a publication comment", () => {
  const receipt = { changes: [{ artifact: "web", version: c, fromCommit: a, toCommit: c, eligibleForMatching: true }] };
  const candidates = [{ itemKey: "AND-75", pullRequestUrl: "https://github.com/owner/repo/pull/42" }];
  const ancestor = (older, newer) => [a, b, c].indexOf(older) <= [a, b, c].indexOf(newer);
  const result = matchCandidates(receipt, candidates, () => ({ mergeCommit: b, files: ["apps/macos/Sources/App.swift"] }), ancestor);
  assert.deepEqual(result.comments, []);
  assert.match(result.skipped[0].reason, /no verified published artifact/);
});
