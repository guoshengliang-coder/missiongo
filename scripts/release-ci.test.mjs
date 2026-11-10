import { test } from "node:test";
import assert from "node:assert/strict";
import { assertReleaseCI } from "./release-ci.mjs";

const good = () => ["web-and-server", "ui", "android", "macos"].map((name) => ({ name, status: "completed", conclusion: "success" }));
test("release needs all four successful jobs, including UI", () => {
  assert.doesNotThrow(() => assertReleaseCI(good()));
  assert.throws(() => assertReleaseCI(good().filter((run) => run.name !== "ui")), /ui/);
  for (const conclusion of ["skipped", "neutral", "cancelled", "failure"]) {
    const runs = good(); runs[3].conclusion = conclusion;
    assert.throws(() => assertReleaseCI(runs), /macos/);
  }
  const runs = good(); runs[2].status = "in_progress";
  assert.throws(() => assertReleaseCI(runs), /android/);
});
