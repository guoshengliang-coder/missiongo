import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { affectedFeatures, assertUIResults, auditCatalog, impactMap, importGraph, parseDiff, selectUITests, validatePlan } from "./ui-test-plan.mjs";
import { playwrightArguments } from "./run-ui-tests.mjs";

const head = "a".repeat(40), map = impactMap(), catalog = auditCatalog();
// Contract tests use a controlled graph. A future unsupported dependency may
// legitimately make the repository's real graph fall back to full UI.
const graph = { uncertain: false, reverse: new Map(Object.values(map.features).map(feature =>
  [`apps/web/src/${feature.entry}`, new Set(feature.consumers.map(file => `apps/web/src/${file}`))])) };
for (const [file, parent] of [["statistics-batches.tsx", "statistics-center.tsx"], ["managed-decision.css", "managed-decision-page.tsx"],
  ["agent-artifact-preview.ts", "agent-artifact-viewer.tsx"]]) graph.reverse.set(`apps/web/src/${file}`, new Set([`apps/web/src/${parent}`]));
const base = { eventName: "pull_request", head, map, catalog, graph };
const choose = (paths, overrides = {}) => selectUITests({ ...base, changes: paths?.map(path => typeof path === "string" ? { path, status: "M" } : path), ...overrides });
const smoke = map.smoke.map(file => `tests/ui/${file}`);

test("PR documentation/native-only changes skip UI, while main and manual runs stay full", () => {
  for (const paths of [["docs/design-system.md"], ["README.md"], ["AGENTS.md"], ["apps/android/src/App.kt"],
    ["apps/macos/Sources/App.swift"], ["sdks/android-feedback/gradle.properties"], ["apps/node/src/runner.ts"],
    ["apps/web/src/statistics-state.test.ts"]]) {
    assert.equal(choose(paths).mode, "skip", paths.join(","));
    for (const eventName of ["push", "workflow_dispatch", "unknown"]) assert.equal(choose(paths, { eventName }).mode, "full");
  }
});

test("only validated publication facts skip PR UI; runtime changes and main stay full", () => {
  const paths = ["released.json", "release-notes/macos/pr-123.json"];
  assert.equal(choose(paths).mode, "full");
  assert.equal(choose(paths, { releaseMetadataValidated: true }).mode, "skip");
  assert.equal(choose([...paths, "apps/web/src/App.tsx"], { releaseMetadataValidated: true }).mode, "full");
  assert.equal(choose(paths, { releaseMetadataValidated: true, eventName: "push" }).mode, "full");
  assert.equal(choose([{ path: paths[0], status: "D" }], { releaseMetadataValidated: true }).mode, "full");
});

test("reviewed feature boundaries and private dependencies include the entire smoke matrix", () => {
  for (const feature of Object.values(map.features)) {
    const value = validatePlan(choose([`apps/web/src/${feature.entry}`]), { head });
    assert.equal(value.mode, "targeted", feature.entry);
    for (const file of [...smoke, ...feature.tests.map(file => `tests/ui/${file}`)]) assert(value.auditFiles.includes(file), file);
    assert.deepEqual(value.shards, [1]);
    assert.equal(value.visual, true);
  }
  for (const file of ["statistics-batches.tsx", "managed-decision.css", "agent-artifact-preview.ts"]) {
    assert.equal(choose([`apps/web/src/${file}`]).mode, "targeted", file);
  }
});

test("repository imports produce scoped or conservative full plans, never a skip for runtime changes", () => {
  const actual = importGraph();
  for (const feature of Object.values(map.features)) {
    const value = choose([`apps/web/src/${feature.entry}`], { graph: actual });
    assert(["full", "targeted"].includes(value.mode));
    if (value.mode === "targeted") for (const file of [...smoke, ...feature.tests.map(file => `tests/ui/${file}`)]) assert(value.auditFiles.includes(file));
  }
});

test("shared inputs, permission changes, missing graph evidence and unknown paths run full UI", () => {
  for (const path of ["apps/web/src/App.tsx", "apps/web/src/main.tsx", "apps/web/src/styles.css", "apps/web/src/api.ts",
    "apps/web/src/product-permissions.ts", "apps/web/src/project-administrators-settings.tsx", "apps/web/src/overlay.tsx",
    "apps/web/src/types.ts", "apps/web/src/i18n.tsx", "apps/web/src/statistics-state.ts", "apps/web/vite.config.ts", "services/server/src/app.ts", "packages/domain/src/work-item.ts",
    "package-lock.json", "package.json", ".github/workflows/ci.yml", "scripts/ui-test-plan.mjs", "tests/ui/impact-map.json",
    "tests/ui/fixture.mjs", "tests/ui/audit-page.mjs", "tests/ui/audit-colour.mjs", "tests/ui/select-helpers.ts", "tests/ui/visual.spec.ts", "unknown/config.yml", "docs/runtime.js"]) {
    assert.equal(choose([path]).mode, "full", path);
  }
  for (const changes of [null, []]) assert.equal(choose(changes).mode, "full");
  assert.equal(choose(["apps/web/src/statistics-batches.tsx"], { graph: undefined }).mode, "full");
  assert.equal(choose(["apps/web/src/statistics-batches.tsx"], { graph: { ...graph, uncertain: true } }).mode, "full");
});

test("a feature used by a new consumer loses its narrow boundary", () => {
  const reverse = new Map(graph.reverse);
  reverse.set("apps/web/src/statistics-center.tsx", new Set(["apps/web/src/App.tsx", "apps/web/src/main.tsx"]));
  assert.equal(choose(["apps/web/src/statistics-center.tsx"], { graph: { reverse, uncertain: false } }).mode, "full");
});

test("one shared path takes precedence over a union of otherwise narrow changes", () => {
  const paths = ["docs/design-system.md", "apps/web/src/statistics-batches.tsx", "tests/ui/linux-download.audit.spec.ts"];
  const value = choose(paths);
  assert.equal(value.mode, "targeted");
  assert(value.auditFiles.includes("tests/ui/statistics.audit.spec.ts"));
  assert(value.auditFiles.includes("tests/ui/linux-download.audit.spec.ts"));
  assert.equal(choose([...paths, "apps/web/src/api.ts"]).mode, "full");
  const allSpecs = choose(catalog);
  assert.equal(allSpecs.mode, "full");
});

test("snapshot-only changes compare images; only explicit manual requests rewrite them", () => {
  const image = "tests/ui/visual.spec.ts-snapshots/list-phone-light-visual-linux.png";
  assert.equal(choose([image]).mode, "visual");
  assert.equal(choose([image], { snapshotUpdate: true }).mode, "visual");
  const value = choose([image], { eventName: "workflow_dispatch", snapshotUpdate: true });
  assert.equal(value.mode, "snapshots");
  assert(playwrightArguments(value, "visual").includes("--update-snapshots=all"));
  assert(!playwrightArguments(choose([image]), "visual").some(arg => arg.startsWith("--update-snapshots")));
  assert.equal(choose([{ path: image, status: "D" }]).mode, "full");
});

test("changed UI specs select their file, deleted specs or source files run full UI", () => {
  const value = choose(["tests/ui/transfer.audit.spec.ts"]);
  assert.equal(value.mode, "targeted");
  assert(value.auditFiles.includes("tests/ui/transfer.audit.spec.ts"));
  for (const path of ["tests/ui/transfer.audit.spec.ts", "apps/web/src/statistics-center.tsx"]) {
    assert.equal(choose([{ path, status: "D" }]).mode, "full");
    assert.equal(choose([{ path, status: "T" }]).mode, "full");
  }
});

test("NUL-separated diff evidence preserves renames, copies and unusual path characters", () => {
  const result = parseDiff("R100\0apps/web/src/statistics-center.tsx\0apps/macos/Stats.swift\0M\0docs/with space\nand-newline.md\0");
  assert.deepEqual(result, [{ path: "apps/web/src/statistics-center.tsx", status: "D" }, { path: "apps/macos/Stats.swift", status: "A" }, { path: "docs/with space\nand-newline.md", status: "M" }]);
  assert.equal(selectUITests({ ...base, changes: result }).mode, "full");
  assert.deepEqual(parseDiff("C098\0old\0new\0"), [{ path: "old", status: "D" }, { path: "new", status: "A" }]);
  for (const malformed of ["M\0", "R100\0old\0", "unknown\0file\0"]) assert.throws(() => parseDiff(malformed));
});

test("dependency traversal unions branches, handles cycles and rejects an unowned consumer", () => {
  const boundaries = new Map([["feature-a", "a"], ["feature-b", "b"]]);
  const reverse = new Map([["leaf", new Set(["feature-a", "via"])], ["via", new Set(["feature-b", "cycle"])], ["cycle", new Set(["via"])]]);
  assert.deepEqual(affectedFeatures("leaf", reverse, boundaries), ["a", "b"]);
  reverse.get("leaf").add("unknown");
  assert.equal(affectedFeatures("leaf", reverse, boundaries), null);
});

test("import parsing follows TS, JSX, re-exports, CSS and literal dynamic imports, not strings/comments", () => {
  const directory = mkdtempSync(join(tmpdir(), "missiongo-ui-imports-"));
  const put = (file, source) => { const path = join(directory, file); mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, source); };
  try {
    put("apps/web/vite.config.ts", "export default {};");
    put("apps/web/src/leaf.ts", "export const value: number = 1;");
    put("apps/web/src/middle.ts", 'export {value} from "./leaf";');
    put("apps/web/src/theme.css", "body {}");
    put("apps/web/src/Page.tsx", 'import "./theme.css"; export const page = () => <div/>; export const load = () => import("./middle"); const example = "import(\\\"./missing\\\")"; /* import("./missing") */');
    let result = importGraph(directory);
    assert.equal(result.uncertain, false);
    assert(result.reverse.get("apps/web/src/middle.ts").has("apps/web/src/Page.tsx"));
    assert(result.reverse.get("apps/web/src/leaf.ts").has("apps/web/src/middle.ts"));
    assert(result.reverse.get("apps/web/src/theme.css").has("apps/web/src/Page.tsx"));
    put("apps/web/src/dynamic.ts", "export const load = path => import(path);");
    assert.equal(importGraph(directory).uncertain, true);
    put("apps/web/src/dynamic.ts", 'import "./unresolved";');
    assert.equal(importGraph(directory).uncertain, true);
    put("apps/web/src/dynamic.ts", "this is invalid typescript@@");
    assert.equal(importGraph(directory).uncertain, true);
    put("apps/web/src/dynamic.ts", 'const value = require("./leaf");');
    assert.equal(importGraph(directory).uncertain, true);
    put("apps/web/src/dynamic.ts", 'import value from "@local/leaf";');
    assert.equal(importGraph(directory).uncertain, true);
    put("apps/web/src/dynamic.ts", 'const worker = new URL("./leaf", import.meta.url);');
    assert.equal(importGraph(directory).uncertain, true);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("plan validation rejects stale revisions, missing smoke tests and unknown execution shapes", () => {
  const value = choose(["apps/web/src/statistics-batches.tsx"]);
  for (const invalid of [{ ...value, head: "bad" }, { ...value, mode: "maybe" }, { ...value, auditFiles: [] },
    { ...value, auditFiles: [...value.auditFiles, "tests/ui/missing.audit.spec.ts"] }, { ...value, shards: [1, 2] },
    { ...value, visual: false }, { ...value, auditFiles: [...value.auditFiles, value.auditFiles[0]] }]) assert.throws(() => validatePlan(invalid));
  assert.throws(() => validatePlan(value, { head: "b".repeat(40) }));
  assert.throws(() => playwrightArguments(value, "audit", 2));
  assert.throws(() => playwrightArguments(choose(["README.md"]), "audit"));
  const args = playwrightArguments(value, "audit");
  assert(args.includes("--shard=1/1"));
  assert(args.includes("tests/ui/statistics\\.audit\\.spec\\.ts$"));
  const full = choose(["apps/web/src/App.tsx"]);
  const fullArgs = playwrightArguments(full, "audit", 8);
  assert.deepEqual(fullArgs.slice(0, 3), ["test", "--project=audit", "--shard=1/1"]);
  assert.equal(fullArgs.length, full.shardFiles[7].length + 3);
  for (const file of full.shardFiles[7]) assert(fullArgs.includes(file.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "$"));
});

test("full plans reject missing, duplicated, unknown files and obsolete allocation formats", () => {
  const full = choose(["apps/web/src/App.tsx"]);
  const copy = () => structuredClone(full);
  const missing = copy(); missing.shardFiles[0].pop();
  const duplicate = copy(); duplicate.shardFiles[0].push(duplicate.shardFiles[1][0]);
  const unknown = copy(); unknown.shardFiles[0][0] = "tests/ui/unknown.audit.spec.ts";
  const empty = copy(); empty.shardFiles[0] = [];
  for (const value of [missing, duplicate, unknown, empty, { ...full, version: 1 }, { ...full, shardFiles: undefined }]) assert.throws(() => validatePlan(value));
});

test("UI gate accepts only the exact successes/skips required by each permitted plan", () => {
  const states = ["success", "failure", "cancelled", "skipped", undefined];
  const samples = [choose(["apps/web/src/App.tsx"]), choose(["apps/web/src/statistics-batches.tsx"]), choose(["README.md"]),
    choose(["tests/ui/visual.spec.ts-snapshots/list-phone-light-visual-linux.png"]), choose([], { eventName: "workflow_dispatch", snapshotUpdate: true })];
  for (const value of samples) for (const auditResult of states) for (const visualResult of states) for (const planResult of states) {
    const eventName = value.mode === "snapshots" ? "workflow_dispatch" : "pull_request";
    const expected = planResult === "success" && auditResult === (["full", "targeted"].includes(value.mode) ? "success" : "skipped")
      && visualResult === (value.visual ? "success" : "skipped");
    const run = () => assertUIResults({ value, eventName, planResult, auditResult, visualResult, snapshotUpdate: value.mode === "snapshots" });
    if (expected) assert.doesNotThrow(run); else assert.throws(run);
  }
  for (const value of samples.filter(v => v.mode !== "full")) assert.throws(() => assertUIResults({ value, eventName: "push", planResult: "success", auditResult: "skipped", visualResult: "skipped" }));
});

test("CLI plans from real commits and validates the skip gate without installed npm dependencies", () => {
  const directory = mkdtempSync(join(tmpdir(), "missiongo-ui-plan-cli-"));
  const put = (file, source) => { const path = join(directory, file); mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, source); };
  const git = (...args) => execFileSync("git", args, { cwd: directory, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  try {
    put("package.json", '{"type":"module"}');
    put("tests/ui/impact-map.json", JSON.stringify(map));
    for (const file of catalog) put(file, "// fixture");
    for (const feature of Object.values(map.features)) put(`apps/web/src/${feature.entry}`, "// fixture");
    put("scripts/.keep", "");
    for (const file of ["ui-test-plan.mjs", "run-ui-tests.mjs", "check-release-metadata.mjs", "release-notes.mjs", "ui-shards.mjs", "ci-platform-plan.mjs"]) copyFileSync(new URL(`./${file}`, import.meta.url), join(directory, "scripts", file));
    copyFileSync(new URL("../tests/ui/audit-durations.json", import.meta.url), join(directory, "tests/ui/audit-durations.json"));
    put("README.md", "before");
    git("init"); git("add", "."); git("-c", "user.name=UI Fixture", "-c", "user.email=ui@example.test", "commit", "-m", "base");
    const baseSha = git("rev-parse", "HEAD");
    put("README.md", "after"); git("add", "."); git("-c", "user.name=UI Fixture", "-c", "user.email=ui@example.test", "commit", "-m", "docs");
    const output = join(directory, "gha-output");
    const environment = { ...process.env, GITHUB_EVENT_NAME: "pull_request", UI_BASE_SHA: baseSha, GITHUB_OUTPUT: output, GITHUB_STEP_SUMMARY: "" };
    const value = JSON.parse(execFileSync(process.execPath, ["scripts/ui-test-plan.mjs"], { cwd: directory, env: environment, encoding: "utf8" }));
    assert.equal(value.mode, "skip"); assert.equal(value.head, git("rev-parse", "HEAD"));
    assert.match(readFileSync(output, "utf8"), /audit=false\nvisual=false/);
    const outputs = readFileSync(output, "utf8");
    assert.match(outputs, /android_required=false\nmacos_required=false\nlinux_required=false/);
    const platformPlan = outputs.split("\n").find(line => line.startsWith("platform_plan=")).slice("platform_plan=".length);
    const platformGate = (platform, overrides = {}) => spawnSync(process.execPath, ["scripts/ci-platform-plan.mjs", platform], {
      cwd: directory, env: { ...environment, CI_PLATFORM_PLAN: platformPlan, CI_PLAN_RESULT: "success", CI_BUILD_RESULT: "skipped", ...overrides }, encoding: "utf8",
    });
    for (const platform of ["android", "macos", "linuxNode"]) {
      assert.equal(platformGate(platform).status, 0);
      assert.notEqual(platformGate(platform, { GITHUB_EVENT_NAME: "push" }).status, 0);
      assert.notEqual(platformGate(platform, { CI_BUILD_RESULT: "failure" }).status, 0);
    }
    const gateEnv = { ...environment, UI_TEST_PLAN: JSON.stringify(value), UI_PLAN_RESULT: "success", UI_AUDIT_RESULT: "skipped", UI_VISUAL_RESULT: "skipped" };
    const gate = env => spawnSync(process.execPath, ["scripts/run-ui-tests.mjs", "--kind=check"], { cwd: directory, env, encoding: "utf8" });
    assert.equal(gate(gateEnv).status, 0);
    assert.notEqual(gate({ ...gateEnv, UI_AUDIT_RESULT: "success" }).status, 0);
    assert.notEqual(gate({ ...gateEnv, GITHUB_EVENT_NAME: "push" }).status, 0);
    for (const UI_BASE_SHA of ["", "not-a-sha", "b".repeat(40)]) {
      const full = JSON.parse(execFileSync(process.execPath, ["scripts/ui-test-plan.mjs"], { cwd: directory, env: { ...environment, UI_BASE_SHA }, encoding: "utf8" }));
      assert.equal(full.mode, "full");
    }
    // Reproduce Actions' depth-1 checkout: fetching the base object does not
    // reconnect HEAD. The workflow's full fetch must restore selective plans.
    const shallow = join(directory, "shallow");
    git("clone", "--quiet", "--depth=1", `file://${directory}`, shallow);
    const shallowGit = (...args) => execFileSync("git", args, { cwd: shallow, stdio: ["ignore", "pipe", "pipe"] });
    shallowGit("fetch", "--no-tags", "origin", baseSha);
    const inShallow = () => JSON.parse(execFileSync(process.execPath, ["scripts/ui-test-plan.mjs"], { cwd: shallow, env: { ...environment, GITHUB_OUTPUT: "" }, encoding: "utf8" }));
    assert.equal(inShallow().mode, "full");
    shallowGit("fetch", "--unshallow", "origin");
    assert.equal(inShallow().mode, "skip");

    put("release-notes/macos/pr-123.json", JSON.stringify({ pullRequest: 123, items: [{ key: "PR-123", title: "更新说明" }] }));
    const metadataEnv = { ...environment, GITHUB_OUTPUT: "", UI_BASE_SHA: git("rev-parse", "HEAD") };
    git("add", "release-notes"); git("-c", "user.name=UI Fixture", "-c", "user.email=ui@example.test", "commit", "-m", "release note");
    const runMetadata = () => spawnSync(process.execPath, ["scripts/ui-test-plan.mjs"], { cwd: directory, env: metadataEnv, encoding: "utf8" });
    const valid = runMetadata(); assert.equal(valid.status, 0, valid.stderr); assert.equal(JSON.parse(valid.stdout).mode, "skip");
    put("release-notes/macos/pr-123.json", "{invalid");
    assert.notEqual(runMetadata().status, 0);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
