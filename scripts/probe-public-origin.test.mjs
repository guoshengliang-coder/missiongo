import assert from "node:assert/strict";
import test from "node:test";

import { percentile } from "./probe-public-origin.mjs";

test("percentile uses nearest-rank values without mutating input", () => {
  const values = [40, 10, 30, 20];
  assert.equal(percentile(values, 0.5), 20);
  assert.equal(percentile(values, 0.95), 40);
  assert.deepEqual(values, [40, 10, 30, 20]);
});

test("percentile reports no value for an empty sample", () => {
  assert.equal(percentile([], 0.95), null);
});
