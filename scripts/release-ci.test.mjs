import { test } from "node:test";
import assert from "node:assert/strict";
import { assertReleaseCI } from "./release-ci.mjs";

const good = () => ["web-and-server", "ui", "android", "macos", "linux-node"].map((name) => ({ name, status: "completed", conclusion: "success" }));
test("release needs all five successful jobs, including UI and linux-node", () => {
  assert.doesNotThrow(() => assertReleaseCI(good()));
  assert.throws(() => assertReleaseCI(good().filter((run) => run.name !== "ui")), /ui/);
  assert.throws(() => assertReleaseCI(good().filter((run) => run.name !== "linux-node")), /linux-node/);
  assert.throws(() => assertReleaseCI([...good(), { name: "ci-timing-report", status: "in_progress", conclusion: null }]), /Other CI checks/);
  for (const conclusion of ["skipped", "neutral", "cancelled", "failure"]) {
    const runs = good(); runs[3].conclusion = conclusion;
    assert.throws(() => assertReleaseCI(runs), /macos/);
  }
  const runs = good(); runs[2].status = "in_progress";
  assert.throws(() => assertReleaseCI(runs), /android/);
  const latest = [...good(), { id: 1, name: "macos", status: "completed", conclusion: "failure" }, { id: 2, name: "macos", status: "completed", conclusion: "success" }];
  assert.doesNotThrow(() => assertReleaseCI(latest));
});
