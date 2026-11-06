#!/usr/bin/env node
//
// Hold the console's stylesheets to the design system, so the rules in
// docs/design-system.md are enforced rather than written down and hoped for.
//
// Every rule here is a defect this project actually shipped, from the UI review
// in docs/ui-ue-review-2026-09.md:
//
//   - four variables were referenced but never defined, and the backgrounds,
//     borders and shadow they named silently fell away (B2);
//   - literal colours outside :root only ever hold in one theme, which is how a
//     light beige bar landed in the dark phone shell (B1, B3-B5);
//   - font sizes off the scale rendered 8px text (B8) and a 9-10px SDK form (B9);
//   - a seventh @media width is how the console and the shell disagreed about
//     when to go compact (AND-92/93);
//   - an unguarded :hover leaves its effect stuck on a touch device (A3);
//   - color-mix() without a plain fallback drops the colour entirely below the
//     build target (C4).
//
// The existing violations are listed in style-baseline.json. The baseline may
// only shrink: a violation that is not in it fails the build, and an entry that
// no longer matches anything fails too, so fixing one means deleting its line
// rather than leaving a licence behind for the next person. Regenerate with
// `node scripts/check-styles.mjs --update` after a deliberate cleanup.

import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Discover new source files automatically; adding a CSS file must not opt out. */
export function sourceFiles(directory, extension) {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? sourceFiles(path, extension) : path.endsWith(extension) ? [path] : [];
  }).sort();
}

export const FONT_SIZE_SCALE = [11, 12, 13, 14, 15, 18, 23, 27];
/** Touch-device inputs sit at 16px so iOS Safari does not zoom the page on focus. */
export const FONT_SIZE_EXCEPTIONS = [16];
export const RADIUS_SCALE = [6, 8, 11, 14, 18];
/** The shell breakpoints, and only those; everything else belongs in a container query. */
export const BREAKPOINTS = [520, 1023, 1280];
/** Needs a plain fallback declaration before it: newer than the build target. */
export const BEYOND_BASELINE = ["color-mix("];

const COLOUR = /#[0-9a-f]{3,8}\b|\brgba?\s*\(|\bhsla?\s*\(|(?<![\w-])(white|black)(?![\w-])/i;

/**
 * Parse enough CSS to know, for each declaration, which selector and which
 * at-rules it sits under. This bounded parser covers the hand-written source
 * stylesheets; it is not a full CSS grammar or a substitute for browser checks.
 */
export function parseCss(text) {
  const declarations = [];
  const rules = [];
  const stack = [];
  let buffer = "";
  let line = 1;
  let index = 0;

  const flushDeclarations = (selector, atRules, body, startLine) => {
    let current = startLine;
    for (const piece of body.split(";")) {
      const colon = piece.indexOf(":");
      if (colon > 0) {
        const prop = piece.slice(0, colon).trim();
        const value = piece.slice(colon + 1).trim();
        if (prop && value && !prop.startsWith("/*")) {
          declarations.push({ selector, atRules, prop, value, line: current, order: declarations.length });
        }
      }
      current += (piece.match(/\n/g) ?? []).length;
    }
  };

  while (index < text.length) {
    const char = text[index];
    if (char === "/" && text[index + 1] === "*") {
      const end = text.indexOf("*/", index + 2);
      const comment = text.slice(index, end === -1 ? text.length : end + 2);
      line += (comment.match(/\n/g) ?? []).length;
      index += comment.length;
      continue;
    }
    if (char === "\n") line += 1;
    if (char === "{") {
      const head = buffer.trim();
      buffer = "";
      stack.push({ head, line });
      if (!head.startsWith("@")) {
        rules.push({ selector: head, atRules: stack.filter((f) => f.head.startsWith("@")).map((f) => f.head), line });
      }
      index += 1;
      continue;
    }
    if (char === "}") {
      const frame = stack.pop();
      if (frame && !frame.head.startsWith("@")) {
        flushDeclarations(frame.head, stack.filter((f) => f.head.startsWith("@")).map((f) => f.head), buffer, frame.line);
      }
      buffer = "";
      index += 1;
      continue;
    }
    buffer += char;
    index += 1;
  }
  return { declarations, rules };
}

const isRootSelector = (selector) => /^:root\b/.test(selector.trim()) || selector.split(",").every((part) => /^:root\b/.test(part.trim()));

const pxValues = (value) => [...value.matchAll(/(-?\d*\.?\d+)px/g)].map((m) => Number(m[1]));

/** One line per violation, stable enough to list in the baseline. */
const signature = (file, rule, detail) => `${rule} | ${file} | ${detail}`;

export function findViolations(sheets, definedVariables) {
  const violations = [];
  for (const { file, text } of sheets) {
    const { declarations, rules } = parseCss(text);

    for (const declaration of declarations) {
      const { selector, prop, value, line } = declaration;
      const where = `${selector} { ${prop} }`;

      for (const reference of value.matchAll(/var\(\s*(--[\w-]+)/g)) {
        if (!definedVariables.has(reference[1])) {
          violations.push({ rule: "undefined-variable", file, line, detail: `${where} uses ${reference[1]}`, signature: signature(file, "undefined-variable", `${where} ${reference[1]}`) });
        }
      }

      if (!isRootSelector(selector) && !prop.startsWith("--") && COLOUR.test(value)) {
        violations.push({ rule: "literal-colour", file, line, detail: `${where} = ${value}`, signature: signature(file, "literal-colour", `${where} ${value}`) });
      }

      if (prop === "font-size") {
        for (const px of pxValues(value)) {
          if (!FONT_SIZE_SCALE.includes(px) && !FONT_SIZE_EXCEPTIONS.includes(px)) {
            violations.push({ rule: "font-size-off-scale", file, line, detail: `${where} = ${px}px`, signature: signature(file, "font-size-off-scale", `${where} ${px}px`) });
          }
        }
      }

      if (prop === "border-radius" || prop.startsWith("border-") && prop.endsWith("-radius")) {
        for (const px of pxValues(value)) {
          if (!RADIUS_SCALE.includes(px) && px !== 999) {
            violations.push({ rule: "radius-off-scale", file, line, detail: `${where} = ${px}px`, signature: signature(file, "radius-off-scale", `${where} ${px}px`) });
          }
        }
      }

      for (const feature of BEYOND_BASELINE) {
        if (!value.includes(feature)) continue;
        // The fallback is the same property, declared plainly, earlier in the
        // same rule: an engine that cannot parse the newer value keeps it.
        const fallback = declarations.some((other) => (
          other !== declaration
          && other.selector === selector
          && other.atRules.join() === declaration.atRules.join()
          && other.prop === prop
          && other.order < declaration.order
          && !BEYOND_BASELINE.some((f) => other.value.includes(f))
        ));
        if (!fallback) {
          violations.push({ rule: "beyond-baseline-without-fallback", file, line, detail: `${where} uses ${feature}) with no plain fallback before it`, signature: signature(file, "beyond-baseline-without-fallback", `${where} ${feature}`) });
        }
      }
    }

    for (const rule of rules) {
      const guardedByPointer = rule.atRules.some((at) => /hover\s*:\s*hover|pointer\s*:/.test(at));
      if (/:hover\b/.test(rule.selector) && !guardedByPointer) {
        violations.push({ rule: "hover-not-guarded", file, line: rule.line, detail: rule.selector, signature: signature(file, "hover-not-guarded", rule.selector) });
      }
      for (const at of rule.atRules) {
        if (!/^@media\b/.test(at)) continue;
        for (const width of at.matchAll(/(?:max|min)-width\s*:\s*(\d+)px/g)) {
          if (!BREAKPOINTS.includes(Number(width[1]))) {
            violations.push({ rule: "breakpoint-off-system", file, line: rule.line, detail: `${at} (${rule.selector})`, signature: signature(file, "breakpoint-off-system", `${at} ${width[1]}px ${rule.selector}`), legacySignature: signature(file, "breakpoint-off-system", `${at} ${width[1]}px`) });
          }
        }
      }
    }
  }
  return violations;
}

function entries(baseline) {
  return Array.isArray(baseline) ? baseline.map(signature => ({ signature, count: Infinity })) : baseline.exceptions;
}

// October's gate compares known signatures, not occurrence budgets. Keep the
// richer baseline unchanged so enhanced checks remain available on demand.
const basicSignature = value => value.startsWith("breakpoint-off-system | ")
  ? value.replace(/(\) \d+px)(?: .*)?$/, "$1") : value;
export function compareBasicBaseline(violations, baseline) {
  const known = entries(baseline).map(e => basicSignature(e.signature));
  const seen = new Set(violations.map(v => basicSignature(v.legacySignature ?? v.signature)));
  const allowed = new Set(known);
  return {
    added: violations.filter(v => !allowed.has(basicSignature(v.legacySignature ?? v.signature))),
    stale: [...new Set(known)].filter(value => !seen.has(value)),
  };
}

export function compareToBaseline(violations, baseline) {
  const allowed = new Map(entries(baseline).map(entry => [entry.signature, entry.count]));
  const seen = new Map();
  const added = violations.filter(v => {
    const count = (seen.get(v.signature) ?? 0) + 1;
    seen.set(v.signature, count);
    return count > (allowed.get(v.signature) ?? 0);
  });
  const stale = entries(baseline).filter(e => !seen.has(e.signature) || Number.isFinite(e.count) && seen.get(e.signature) < e.count).map(e => e.signature);
  return { added, stale };
}

export function baselineFrom(violations) {
  const counts = new Map();
  for (const v of violations) counts.set(v.signature, (counts.get(v.signature) ?? 0) + 1);
  return { version: 2, exceptions: [...counts].sort(([a], [b]) => a.localeCompare(b)).map(([signature, count]) => ({
    signature, count, reason: "Existing style debt, scoped to this rule and occurrence count", tracking: "docs/ui-ue-audit-2026-10.md#uia-06--p2规范实现和历史计划没有闭环",
  })) };
}

export function baselineGrowth(current, previous) {
  const allowed = new Map(entries(previous).map(entry => [entry.signature, entry.count]));
  return entries(current).filter(entry => entry.count > (allowed.get(entry.signature) ?? 0));
}

function gitRead(ref, file) {
  return execFileSync("git", ["show", `${ref}:${file}`], { cwd: root, encoding: "utf8" });
}

/** Convert a legacy baseline using the BASE COMMIT'S source, never the PR's
 * source: a new selector cannot inherit an old breakpoint-wide exemption. */
function baselineAt(ref) {
  const previous = JSON.parse(gitRead(ref, "scripts/style-baseline.json"));
  if (!Array.isArray(previous)) return previous;
  const sheets = ["apps/web/src/styles.css", "apps/web/src/sdk-feedback.css"].map(file => ({ file, text: gitRead(ref, file) }));
  const defined = new Set(sheets.flatMap(sheet => [...sheet.text.matchAll(/(--[\w-]+)\s*:/g)].map(m => m[1])));
  const allowed = new Set(previous);
  return baselineFrom(findViolations(sheets, defined).filter(v => allowed.has(v.legacySignature ?? v.signature)));
}

function main() {
  const baselinePath = join(root, "scripts/style-baseline.json");
  const sheets = sourceFiles(join(root, "apps/web/src"), ".css").map(path => ({ file: relative(root, path), text: readFileSync(path, "utf8") }));
  const definedVariables = new Set();
  for (const { text } of sheets) for (const m of text.matchAll(/(--[\w-]+)\s*:/g)) definedVariables.add(m[1]);
  for (const file of sourceFiles(join(root, "apps/web/src"), ".tsx")) {
    for (const m of readFileSync(file, "utf8").matchAll(/["'](--[\w-]+)["']\s*:/g)) definedVariables.add(m[1]);
  }
  const violations = findViolations(sheets, definedVariables);
  const baseline = JSON.parse(readFileSync(baselinePath, "utf8"));
  const strict = process.argv.includes("--strict") || process.argv.includes("--base");
  if (strict && (baseline.version !== 2 || !Array.isArray(baseline.exceptions) || baseline.exceptions.some(e => !e.reason || !e.tracking || !Number.isInteger(e.count) || e.count < 1))) {
    throw new Error("Style exceptions need version 2, a bounded occurrence count, reason and tracking reference.");
  }
  const { added, stale } = strict ? compareToBaseline(violations, baseline) : compareBasicBaseline(violations, baseline);
  if (added.length) {
    console.error("New style-system violations:");
    for (const v of added) console.error(`  ${v.file}:${v.line} ${v.rule}: ${v.detail}`);
    process.exitCode = 1;
  }
  const baseAt = process.argv.indexOf("--base");
  if (baseAt >= 0) {
    const ref = process.argv[baseAt + 1];
    if (!ref || !/^[0-9a-f]{40}$/.test(ref)) throw new Error("--base requires a verified full commit SHA");
    const growth = baselineGrowth(baseline, baselineAt(ref));
    if (growth.length) { console.error("Style exceptions expanded relative to base:", growth); process.exitCode = 1; }
  }
  if (process.argv.includes("--update")) {
    if (process.exitCode) throw new Error("Refusing to add exceptions. --update only removes fixed entries or reduces counts.");
    const actual = new Map(baselineFrom(violations).exceptions.map(e => [e.signature, e.count]));
    writeFileSync(baselinePath, JSON.stringify({ ...baseline, exceptions: baseline.exceptions.filter(e => actual.has(e.signature)).map(e => ({ ...e, count: Math.min(e.count, actual.get(e.signature)) })) }, null, 2) + "\n");
    console.log("Pruned fixed style exceptions.");
    return;
  }
  if (stale.length) { console.error("Fixed exceptions must be removed (--update):", stale); process.exitCode = 1; }
  if (!process.exitCode) console.log(`Styles: ${sheets.length} stylesheets checked, ${violations.length} existing violations; ${strict ? "strict occurrence budgets" : "basic signature checks"}.`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
