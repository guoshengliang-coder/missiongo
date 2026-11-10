import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

test("importing release state returns to its caller without running the CLI", () => {
  const url = new URL("./release-state.mjs", import.meta.url).href;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", `await import(${JSON.stringify(url)}); console.log("IMPORT_RETURNED");`], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), "IMPORT_RETURNED");
});
