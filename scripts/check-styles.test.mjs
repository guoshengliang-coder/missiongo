import assert from "node:assert/strict";
import { test } from "node:test";

import { compareBasicBaseline, baselineFrom, baselineGrowth, compareToBaseline, findViolations, parseCss, sourceFiles } from "./check-styles.mjs";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const check = (css, defined = ["--ink", "--warn-bg", "--radius-md", "--text-sm"]) =>
  findViolations([{ file: "test.css", text: css }], new Set(defined));

const rules = (css, defined) => check(css, defined).map((v) => v.rule);

test("reads the selector and at-rules a declaration sits under", () => {
  const { declarations, rules: parsed } = parseCss("@media (max-width: 520px) { .a, .b { color: red; } }");
  assert.equal(declarations.length, 1);
  assert.equal(declarations[0].prop, "color");
  assert.deepEqual(declarations[0].atRules, ["@media (max-width: 520px)"]);
  assert.equal(parsed[0].selector, ".a, .b");
});

test("catches a variable that is used but never defined", () => {
  // The defect: --surface-soft, --mint-soft, --mint-line and --shadow-lg were
  // referenced for months, and the properties naming them did nothing.
  assert.deepEqual(rules(".card { background: var(--surface-soft); }"), ["undefined-variable"]);
  assert.deepEqual(rules(".card { background: var(--ink); }"), []);
});

test("catches a literal colour outside :root, where a theme cannot reach it", () => {
  assert.deepEqual(rules(".nav:hover { background: rgba(255,255,255,0.6); }").filter((r) => r === "literal-colour"), ["literal-colour"]);
  assert.deepEqual(rules(".bar { background: #f3f1eb; }"), ["literal-colour"]);
  assert.deepEqual(rules(".bar { color: white; }"), ["literal-colour"]);
  assert.deepEqual(rules(":root { --canvas: #f3f1eb; }"), []);
  assert.deepEqual(rules(':root[data-appearance="dark"] { --canvas: #10161f; }'), []);
  assert.deepEqual(rules(".bar { background: var(--warn-bg); }"), []);
  assert.deepEqual(rules(".bar { color: currentColor; background: transparent; }"), []);
});

test("holds font sizes to the scale, and lets 16px inputs through", () => {
  assert.deepEqual(rules(".badge { font-size: 8px; }"), ["font-size-off-scale"]);
  assert.deepEqual(rules(".help { font-size: 9px; }"), ["font-size-off-scale"]);
  assert.deepEqual(rules(".title { font-size: var(--text-sm); }"), []);
  assert.deepEqual(rules("input { font-size: 16px; }"), []);
});

test("holds corner radii to the scale, and allows the pill", () => {
  assert.deepEqual(rules(".card { border-radius: 9px; }"), ["radius-off-scale"]);
  assert.deepEqual(rules(".pill { border-radius: 999px; }"), []);
  assert.deepEqual(rules(".card { border-radius: var(--radius-md); }"), []);
  assert.deepEqual(rules(".avatar { border-radius: 50%; }"), []);
});

test("catches a width outside the shell breakpoints", () => {
  // The defect: the console switched at 760 while the shell switched at 1023,
  // and a folding phone landed between them with two navigations.
  assert.deepEqual(rules("@media (max-width: 760px) { .a { gap: 4px; } }"), ["breakpoint-off-system"]);
  assert.deepEqual(rules("@media (max-width: 1023px) { .a { gap: 4px; } }"), []);
  assert.deepEqual(rules("@media (min-width: 1280px) { .a { gap: 4px; } }"), []);
  assert.deepEqual(rules("@container list-pane (max-width: 620px) { .a { gap: 4px; } }"), []);
});

test("catches a hover effect that a touch device cannot undo", () => {
  assert.deepEqual(rules(".row:hover { background: var(--ink); }"), ["hover-not-guarded"]);
  assert.deepEqual(rules("@media (hover: hover) { .row:hover { background: var(--ink); } }"), []);
  assert.deepEqual(rules("@media (pointer: fine) { .row:hover { background: var(--ink); } }"), []);
});

test("requires a plain fallback before a value newer than the build target", () => {
  assert.deepEqual(
    rules(".banner { background: color-mix(in srgb, var(--ink) 10%, var(--warn-bg)); }"),
    ["beyond-baseline-without-fallback"],
  );
  assert.deepEqual(
    rules(".banner { background: var(--warn-bg); background: color-mix(in srgb, var(--ink) 10%, var(--warn-bg)); }"),
    [],
  );
  // A fallback declared after the modern value would be the one that wins.
  assert.deepEqual(
    rules(".banner { background: color-mix(in srgb, var(--ink) 10%, var(--warn-bg)); background: var(--warn-bg); }"),
    ["beyond-baseline-without-fallback"],
  );
});

test("fails on a new violation and on a baseline entry that no longer matches", () => {
  const violations = check(".card { border-radius: 9px; }");
  assert.deepEqual(compareToBaseline(violations, []).added.map((v) => v.rule), ["radius-off-scale"]);
  assert.deepEqual(compareToBaseline(violations, violations.map((v) => v.signature)).added, []);
  assert.deepEqual(compareToBaseline([], ["radius-off-scale | old.css | .gone { border-radius } 9px"]).stale.length, 1);
});

test("automatically discovers nested new CSS files", () => {
  const root = mkdtempSync(join(tmpdir(), "styles-discovery-"));
  try {
    mkdirSync(join(root, "feature"));
    writeFileSync(join(root, "main.css"), ":root { --ink: black; }");
    writeFileSync(join(root, "feature/new.css"), ".new { font-size: 9px; }");
    writeFileSync(join(root, "feature/note.txt"), "not css");
    assert.deepEqual(sourceFiles(root, ".css"), [join(root, "feature/new.css"), join(root, "main.css")]);
  } finally { rmSync(root, { recursive: true }); }
});

test("an existing breakpoint cannot exempt a new selector or extra occurrence", () => {
  const original = check("@media (max-width: 640px) { .old { gap: 4px; } }");
  const baseline = baselineFrom(original);
  const expanded = check("@media (max-width: 640px) { .old { gap: 4px; } .new { gap: 4px; } }");
  assert.equal(compareToBaseline(expanded, baseline).added.length, 1);
  assert.equal(compareToBaseline([...original, ...original], baseline).added.length, 1);
  assert.equal(baselineGrowth(baselineFrom(expanded), baseline).length, 1);
  assert.equal(baselineGrowth(baselineFrom([...original, ...original]), baseline).length, 1);
  assert.equal(baselineGrowth(baselineFrom([]), baseline).length, 0);
});

test("basic gate retains October signatures while strict checks remain opt-in", () => {
  const original = check("@media (max-width: 640px) { .old { gap: 4px; } }");
  const baseline = baselineFrom(original);
  const expanded = check("@media (max-width: 640px) { .old { gap: 4px; } .new { gap: 4px; } }");
  assert.deepEqual(compareBasicBaseline([...expanded, ...original], baseline), { added: [], stale: [] });
  assert.equal(compareToBaseline(expanded, baseline).added.length, 1);
  assert.equal(compareBasicBaseline(check(".bad { font-size: 9px; }"), baseline).added.length, 1);
  assert.equal(compareBasicBaseline([], baseline).stale.length, 1);
  assert.deepEqual(compareBasicBaseline(original, [original[0].legacySignature]), { added: [], stale: [] });
});
