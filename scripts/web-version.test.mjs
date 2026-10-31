import { test } from "node:test";
import assert from "node:assert/strict";
import { assertWebRelease, nextVersion, requiresWebVersion, versionParts } from "./web-version.mjs";

test("Web releases increment semantically and reset lower components", () => {
  assert.equal(nextVersion("1.9.12", "patch"), "1.9.13");
  assert.equal(nextVersion("1.9.12", "minor"), "1.10.0");
  assert.equal(nextVersion("1.9.12", "major"), "2.0.0");
  for (const invalid of ["01.0.0", "1.0", "v1.0.0", "1.0.0-beta", "9007199254740992.0.0"]) assert.throws(() => versionParts(invalid));
  assert.throws(() => nextVersion("1.0.0", "other"));
});
test("changed Web code requires a strictly newer release, with an explicit legacy bootstrap", () => {
  assert.throws(() => assertWebRelease("1.0.0", "1.0.0", true), /Web changed/);
  assert.throws(() => assertWebRelease("1.9.0", "1.10.0", true), /lower/);
  assert.throws(() => assertWebRelease("1.9.0", "1.10.0", false), /lower/);
  assert.throws(() => assertWebRelease("1.0.0", "garbled", true));
  assert.doesNotThrow(() => assertWebRelease("1.10.0", "1.9.0", true));
  assert.doesNotThrow(() => assertWebRelease("1.0.0", "1.0.0", false));
  assert.doesNotThrow(() => assertWebRelease("1.0.0", "a".repeat(40), true));
  assert.doesNotThrow(() => assertWebRelease("1.0.0", null, true));
});

test("test and documentation-only changes do not consume a Web release number", () => {
  assert.equal(requiresWebVersion(["apps/web/src/example.test.ts", "packages/domain/src/example.spec.ts", "deploy/README.md"]), false);
  assert.equal(requiresWebVersion(["apps/web/src/list-filters.tsx"]), true);
  assert.equal(requiresWebVersion(["apps/web/vite.config.ts", "product.json"]), true);
});
