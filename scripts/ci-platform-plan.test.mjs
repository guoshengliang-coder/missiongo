import assert from "node:assert/strict";
import { test } from "node:test";
import { assertPlatformResult, selectPlatforms } from "./ci-platform-plan.mjs";

const head = "a".repeat(40);
const choose = (paths, overrides = {}) => selectPlatforms({ head, eventName: "pull_request",
  changes: paths?.map(path => typeof path === "string" ? { path, status: "M" } : path), ...overrides });
const all = { android: true, macos: true, linuxNode: true }, none = { android: false, macos: false, linuxNode: false };

test("PR native sources select their own platform and mixed changes select the union", () => {
  assert.deepEqual(choose(["apps/macos/Sources/App.swift"]).required, { ...none, macos: true });
  for (const path of ["apps/android/build.gradle.kts", "sdks/android-feedback/gradle.properties"]) assert.deepEqual(choose([path]).required, { ...none, android: true });
  assert.deepEqual(choose(["apps/node/src/cli.ts"]).required, { ...none, linuxNode: true });
  assert.deepEqual(choose(["apps/macos/Package.swift", "apps/android/src/Main.kt"]).required, { ...all, linuxNode: false });
});

test("web, UI tests, documentation and validated publication facts skip unrelated PR builds", () => {
  for (const path of ["apps/web/src/App.tsx", "apps/web/package.json", "tests/ui/polling.ts", "docs/release-coverage.md", "README.md"]) {
    assert.deepEqual(choose([path]).required, none, path);
  }
  for (const path of ["released.json", "release-notes/macos/pr-123.json"]) {
    assert.deepEqual(choose([path]).required, all);
    assert.deepEqual(choose([path], { releaseMetadataValidated: true }).required, none);
  }
});

test("shared, unknown, destructive or missing evidence always requires all platforms", () => {
  for (const path of ["packages/contracts/src/mcp-tools.ts", "packages/domain/src/item.ts", "services/server/src/app.ts", "product.json",
    "package.json", "package-lock.json", ".github/workflows/ci.yml", "scripts/build-macos-app.sh", "unknown/config.json", "../apps/web/app.ts"]) assert.deepEqual(choose([path]).required, all, path);
  for (const paths of [null, [], [{ path: "apps/web/src/App.tsx", status: "D" }], [{ path: "docs/old.md", status: "D" }]]) assert.deepEqual(choose(paths).required, all);
  for (const eventName of ["push", "workflow_dispatch", "unknown", undefined]) assert.deepEqual(choose(["README.md"], { eventName }).required, all);
});

test("platform summaries accept only the exact expected build outcome and successful planning", () => {
  for (const required of [true, false]) {
    const plan = choose(required ? ["product.json"] : ["README.md"]);
    for (const platform of Object.keys(all)) for (const planResult of ["success", "failure", "cancelled", "skipped", undefined]) {
      for (const buildResult of ["success", "failure", "cancelled", "skipped", undefined]) {
        const run = () => assertPlatformResult({ plan, platform, head, eventName: "pull_request", planResult, buildResult });
        if (planResult === "success" && buildResult === (required ? "success" : "skipped")) assert.doesNotThrow(run); else assert.throws(run);
      }
    }
  }
});

test("main cannot use a narrow plan, and stale or malformed plans cannot grant success", () => {
  const plan = choose(["README.md"]);
  const check = (changes = {}) => assertPlatformResult({ plan, platform: "macos", head, eventName: "pull_request", planResult: "success", buildResult: "skipped", ...changes });
  for (const eventName of ["push", "workflow_dispatch", undefined]) assert.throws(() => check({ eventName }));
  assert.throws(() => check({ head: "b".repeat(40) }));
  assert.throws(() => check({ platform: "unknown" }));
  for (const invalid of [null, { ...plan, version: 2 }, { ...plan, required: { ...plan.required, macos: "false" } }, { ...plan, required: { android: false } }]) assert.throws(() => check({ plan: invalid }));
});
