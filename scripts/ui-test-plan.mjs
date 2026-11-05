#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isReleaseMetadata, validateReleaseMetadata } from "./check-release-metadata.mjs";
import { auditDurations, balancedAuditShards } from "./ui-shards.mjs";
import { selectPlatforms } from "./ci-platform-plan.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const web = "apps/web/src/";
const ui = "tests/ui/";
const auditName = /^[\w-]+\.audit\.spec\.ts$|^audit\.spec\.ts$/;
const unitName = /\.test\.[cm]?[jt]sx?$/;
const modes = new Set(["full", "targeted", "skip", "visual", "snapshots"]);
const fullShards = Array.from({ length: 8 }, (_, index) => index + 1);

export function auditCatalog(directory = root) {
  return readdirSync(join(directory, ui)).filter(file => auditName.test(file)).map(file => ui + file).sort();
}

export function impactMap(directory = root) {
  const map = JSON.parse(readFileSync(join(directory, ui, "impact-map.json"), "utf8"));
  const catalog = new Set(auditCatalog(directory));
  if (!Array.isArray(map.smoke) || !map.smoke.length || !map.features || typeof map.features !== "object") throw new Error("Invalid UI impact map");
  for (const file of [...map.smoke, ...Object.values(map.features).flatMap(feature => feature.tests ?? [])]) {
    if (!auditName.test(file) || !catalog.has(ui + file)) throw new Error(`Missing mapped UI test: ${file}`);
  }
  const entries = new Set();
  for (const feature of Object.values(map.features)) {
    if (typeof feature.entry !== "string" || !/^[\w-]+\.tsx$/.test(feature.entry) || !existsSync(join(directory, web, feature.entry))
      || !Array.isArray(feature.tests) || !feature.tests.length || entries.has(feature.entry)
      || !Array.isArray(feature.consumers) || !feature.consumers.length || feature.consumers.some(file => !/^[\w-]+\.tsx$/.test(file))) throw new Error("Invalid UI feature boundary");
    entries.add(feature.entry);
  }
  return map;
}

// Follow all importers up to an explicitly reviewed feature boundary. A path
// reaching App, main, configuration, or an unknown consumer requires full UI.
export function affectedFeatures(file, reverse, boundaries) {
  const visited = new Set(), features = new Set();
  let broad = false;
  const visit = current => {
    if (visited.has(current)) return;
    visited.add(current);
    if (boundaries.has(current)) { features.add(boundaries.get(current)); return; }
    const parents = reverse.get(current);
    if (!parents?.size) { broad = true; return; }
    for (const parent of parents) visit(parent);
  };
  visit(file);
  return broad || !features.size ? null : [...features].sort();
}

export function importGraph(directory = root) {
  const { transformSync } = require("esbuild");
  const { initSync, parse } = require("es-module-lexer");
  initSync();
  const reverse = new Map();
  let uncertain = false;
  const packages = new Set(["react/jsx-runtime"]);
  for (const manifest of ["package.json", "apps/web/package.json"]) {
    if (!existsSync(join(directory, manifest))) continue;
    const value = JSON.parse(readFileSync(join(directory, manifest), "utf8"));
    for (const name of Object.keys({ ...value.dependencies, ...value.devDependencies })) packages.add(name);
  }
  for (const config of ["tsconfig.json", "tsconfig.base.json", "apps/web/tsconfig.json", "apps/web/vite.config.ts"]) {
    if (existsSync(join(directory, config)) && /["'](?:paths|baseUrl|rootDirs)["']\s*:|\balias\s*:/.test(readFileSync(join(directory, config), "utf8"))) uncertain = true;
  }
  const walk = dir => readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? walk(path) : /\.[cm]?[jt]sx?$/.test(path) && !unitName.test(path) ? [path] : [];
  });
  const local = path => relative(directory, path).split("\\").join("/");
  const resolveImport = (file, specifier) => {
    if (!specifier.startsWith(".")) {
      const name = specifier.split("/").slice(0, specifier.startsWith("@") ? 2 : 1).join("/");
      if (!specifier.startsWith("node:") && !packages.has(name) && !existsSync(join(directory, "node_modules", name, "package.json"))) uncertain = true;
      return;
    }
    const base = resolve(dirname(file), specifier);
    const stem = base.replace(/\.[cm]?jsx?$/, "");
    const candidates = [base, ...[".ts", ".tsx", ".js", ".jsx", ".mjs", ".json", ".css"].map(extension => stem + extension), join(base, "index.ts"), join(base, "index.tsx")];
    const found = candidates.find(candidate => existsSync(candidate) && statSync(candidate).isFile());
    if (!found) { uncertain = true; return; }
    const dependency = local(found), parent = local(file);
    if (!reverse.has(dependency)) reverse.set(dependency, new Set());
    reverse.get(dependency).add(parent);
  };
  for (const file of [...walk(join(directory, web)), join(directory, "apps/web/vite.config.ts")]) {
    try {
      // Erase TS/JSX before lexing actual ESM dependencies, including re-exports
      // and literal dynamic imports. Unsupported runtime resolution stays broad.
      const extension = extname(file).slice(1);
      const { code } = transformSync(readFileSync(file, "utf8"), { loader: ["ts", "tsx", "jsx"].includes(extension) ? extension : "js", treeShaking: false,
        tsconfigRaw: { compilerOptions: { verbatimModuleSyntax: true } } });
      if (/\brequire\s*\(|import\.meta\.glob/.test(code) || (local(file).startsWith(web) && /import\.meta\.url/.test(code))) uncertain = true;
      for (const dependency of parse(code)[0]) {
        if (dependency.d === -2) continue; // import.meta itself
        if (typeof dependency.n !== "string") uncertain = true;
        else resolveImport(file, dependency.n);
      }
    } catch { uncertain = true; }
  }
  return { reverse, uncertain };
}

function plan(mode, head, reasons, auditFiles, catalog) {
  return { version: 2, head, mode, auditFiles: [...new Set(auditFiles)].sort(), shards: mode === "full" ? [...fullShards] : [1],
    shardFiles: mode === "full" ? balancedAuditShards(catalog, auditDurations()) : [], visual: mode !== "skip", reasons };
}

export function selectUITests({ eventName, snapshotUpdate = false, head, changes, map, catalog, graph, releaseMetadataValidated = false }) {
  const makePlan = (mode, reasons, files = []) => plan(mode, head, reasons, files, catalog);
  if (eventName === "workflow_dispatch" && snapshotUpdate) return makePlan("snapshots", ["Explicit snapshot generation"]);
  if (eventName !== "pull_request") return makePlan("full", ["Main pushes and ordinary manual runs always run full UI"]);
  if (!changes?.length) return makePlan("full", ["Missing or empty change evidence"]);
  const boundaries = new Map(Object.entries(map.features).filter(([, feature]) => {
    // New consumers expand a component's contract; require a map review rather
    // than silently inheriting the old feature's narrower test coverage.
    const actual = [...(graph?.reverse.get(web + feature.entry) ?? [])].sort();
    return JSON.stringify(actual) === JSON.stringify(feature.consumers.map(file => web + file).sort());
  }).map(([name, feature]) => [web + feature.entry, name]));
  const selected = new Set(), reasons = [];
  let visual = false;
  for (const { path, status } of changes) {
    if (typeof path !== "string" || path.startsWith("/") || path.split("/").includes("..") || path.includes("\\")) return makePlan("full", ["Unsupported changed path"]);
    if (isReleaseMetadata(path) && releaseMetadataValidated && ["A", "M"].includes(status)) {
      reasons.push(`Validated release metadata: ${path}`);
      continue;
    }
    // These trees are not inputs to the browser fixture. Everything else is
    // evaluated below or conservatively falls back to the full suite.
    if (/^(apps\/(android|macos|node)\/|sdks\/android-feedback\/)/.test(path)
      || /^(docs\/.*\.md|[^/]+\.md)$/.test(path)) continue;
    if (path.startsWith(web) && unitName.test(path) && !graph?.reverse.has(path) && !graph?.uncertain) continue;
    const readable = status === "A" || status === "M";
    if (/^tests\/ui\/visual\.spec\.ts-snapshots\/[^/]+-linux\.png$/.test(path) && readable) { visual = true; continue; }
    if (path.startsWith(ui) && auditName.test(path.slice(ui.length)) && readable && catalog.includes(path)) {
      selected.add(path); reasons.push(`Changed UI spec: ${path}`); continue;
    }
    if (path.startsWith(web) && readable && graph && !graph.uncertain) {
      const affected = affectedFeatures(path, graph.reverse, boundaries);
      if (affected) {
        for (const name of affected) {
          for (const file of map.features[name].tests) selected.add(ui + file);
          reasons.push(`Feature boundary: ${name}`);
        }
        continue;
      }
    }
    return makePlan("full", [`Shared, unknown, deleted, or unresolved input: ${path}`]);
  }
  if (selected.size) {
    for (const file of map.smoke) selected.add(ui + file);
    // Large combined feature changes are cheaper on the full-suite
    // runners than on one targeted runner, and deserve broader coverage.
    if (selected.size > 12) return makePlan("full", ["Broad feature change"]);
    return makePlan("targeted", [...new Set(reasons)], [...selected]);
  }
  return visual ? makePlan("visual", ["Screenshot baselines only"]) : makePlan("skip", reasons.length ? reasons : ["Documentation, native clients, or unit tests only"]);
}

export function validatePlan(value, { head, catalog = auditCatalog() } = {}) {
  if (value?.version !== 2 || !/^[a-f0-9]{40}$/.test(value.head ?? "") || (head && value.head !== head) || !modes.has(value.mode)) throw new Error("Invalid or stale UI plan");
  if (!Array.isArray(value.auditFiles) || new Set(value.auditFiles).size !== value.auditFiles.length
    || value.auditFiles.some(file => !catalog.includes(file))) throw new Error("Unknown UI test in plan");
  if (value.mode === "targeted") {
    if (!value.auditFiles.length || impactMap().smoke.some(file => !value.auditFiles.includes(ui + file))) throw new Error("Targeted UI must include core smoke coverage");
  } else if (value.auditFiles.length) throw new Error("Unexpected UI file filter");
  if (JSON.stringify(value.shards) !== JSON.stringify(value.mode === "full" ? fullShards : [1]) || value.visual !== (value.mode !== "skip")) throw new Error("Invalid UI plan execution shape");
  if (!Array.isArray(value.shardFiles) || value.shardFiles.length !== (value.mode === "full" ? fullShards.length : 0)) throw new Error("Invalid UI file allocation");
  if (value.mode === "full") {
    if (value.shardFiles.some(files => !Array.isArray(files) || !files.length || files.some(file => typeof file !== "string"))) throw new Error("Invalid UI file allocation");
    const assigned = value.shardFiles.flat();
    if (new Set(assigned).size !== assigned.length || JSON.stringify([...assigned].sort()) !== JSON.stringify([...catalog].sort())) throw new Error("UI shards must cover every file exactly once");
  }
  return value;
}

export function assertUIResults({ value, planResult, auditResult, visualResult, eventName, snapshotUpdate = false }) {
  if (planResult !== "success") throw new Error("UI planning must succeed");
  validatePlan(value);
  const expectedMode = eventName === "workflow_dispatch" && snapshotUpdate ? "snapshots" : eventName !== "pull_request" ? "full" : null;
  if ((expectedMode && value.mode !== expectedMode) || (!expectedMode && value.mode === "snapshots")) throw new Error("UI plan is not permitted for this event");
  const auditExpected = ["full", "targeted"].includes(value.mode) ? "success" : "skipped";
  const visualExpected = value.visual ? "success" : "skipped";
  if (auditResult !== auditExpected || visualResult !== visualExpected) throw new Error(`UI checks must be ${auditExpected}/${visualExpected}, found ${auditResult}/${visualResult}`);
}

export function parseDiff(output) {
  const fields = output.split("\0");
  if (fields.at(-1) === "") fields.pop();
  const changes = [];
  for (let i = 0; i < fields.length;) {
    const status = fields[i++];
    if (!/^(?:[ADMTUXB]|[RC]\d+)$/.test(status) || i >= fields.length) throw new Error("Invalid git diff evidence");
    const old = fields[i++];
    if (/^[RC]/.test(status)) {
      if (i >= fields.length) throw new Error("Incomplete rename evidence");
      changes.push({ path: old, status: "D" }, { path: fields[i++], status: "A" });
    } else changes.push({ path: old, status });
  }
  return changes;
}

export function currentHead() {
  return execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
}

function main() {
  const head = currentHead(), eventName = process.env.GITHUB_EVENT_NAME ?? "manual";
  let changes = null, graph;
  if (eventName === "pull_request") {
    try {
      const base = process.env.UI_BASE_SHA;
      if (!/^[a-f0-9]{40}$/.test(base ?? "")) throw new Error("Missing PR base");
      execFileSync("git", ["merge-base", "--is-ancestor", base, head], { cwd: root, stdio: "pipe" });
      changes = parseDiff(execFileSync("git", ["diff", "--name-status", "--find-renames", "-z", base, head], { cwd: root, encoding: "utf8" }));
      if (changes.some(change => change.path.startsWith(web))) graph = importGraph();
    } catch { changes = null; }
  }
  // Keep validation errors fatal; malformed publication facts cannot earn a
  // successful skip. Missing diff evidence above still falls back to full UI.
  const releaseMetadataValidated = changes?.some(change => isReleaseMetadata(change.path))
    ? validateReleaseMetadata({ root, base: process.env.UI_BASE_SHA, changes }) : false;
  const value = validatePlan(selectUITests({ eventName, snapshotUpdate: process.env.UI_UPDATE_SNAPSHOTS === "true", head, changes,
    map: impactMap(), catalog: auditCatalog(), graph, releaseMetadataValidated }));
  const json = JSON.stringify(value);
  const platforms = selectPlatforms({ head, eventName, changes, releaseMetadataValidated });
  console.log(json);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `plan=${json}\naudit=${["full", "targeted"].includes(value.mode)}\nvisual=${value.visual}\nshards=${JSON.stringify(value.shards)}\nplatform_plan=${JSON.stringify(platforms)}\nandroid_required=${platforms.required.android}\nmacos_required=${platforms.required.macos}\nlinux_required=${platforms.required.linuxNode}\n`);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `## UI test selection\n\nMode: **${value.mode}**\n\n\`\`\`json\n${JSON.stringify(value, null, 2)}\n\`\`\`\n\n## Platform selection\n\n\`\`\`json\n${JSON.stringify(platforms, null, 2)}\n\`\`\`\n`);
}
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) main();
