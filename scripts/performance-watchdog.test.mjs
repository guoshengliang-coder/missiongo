import assert from "node:assert/strict";
import { test } from "node:test";
import { runPerformanceChild } from "./performance-watchdog.mjs";

test("a synchronous infinite child cannot defeat the parent deadline", () => {
  const result = runPerformanceChild(["-e", "while(true) {}"], 100, { stdio: "ignore" });
  assert.equal(result.timedOut, true);
  assert.equal(result.signal, "SIGKILL");
  assert.equal(result.status, null);
});
test("normal exit and correctness failure retain their exact result", () => {
  assert.equal(runPerformanceChild(["-e", "process.exit(0)"], 5000, { stdio: "ignore" }).status, 0);
  const result = runPerformanceChild(["-e", "process.exit(7)"], 5000, { stdio: "ignore" });
  assert.equal(result.status, 7); assert.equal(result.timedOut, false);
});
