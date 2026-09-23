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

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

/** The stylesheets the console ships. Both are authored by hand. */
const SHEETS = ["apps/web/src/styles.css", "apps/web/src/sdk-feedback.css"];

/** Files that may also define a custom property, via an inline style. */
const INLINE_STYLE_SOURCES = ["apps/web/src/App.tsx"];

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
 * at-rules it sits under. A real parser would be a dependency; this file only
 * ever reads two hand-written stylesheets.
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
            violations.push({ rule: "breakpoint-off-system", file, line: rule.line, detail: `${at} (${rule.selector})`, signature: signature(file, "breakpoint-off-system", `${at} ${width[1]}px`) });
          }
        }
      }
    }
  }
  return violations;
}

export function compareToBaseline(violations, baseline) {
  const seen = new Set(violations.map((v) => v.signature));
  const allowed = new Set(baseline);
  return {
    added: violations.filter((v) => !allowed.has(v.signature)),
    stale: baseline.filter((entry) => !seen.has(entry)),
  };
}

function main() {
  const baselinePath = join(root, "scripts/style-baseline.json");
  const sheets = SHEETS.map((file) => ({ file, text: readFileSync(join(root, file), "utf8") }));

  const definedVariables = new Set();
  for (const { text } of sheets) for (const m of text.matchAll(/(--[\w-]+)\s*:/g)) definedVariables.add(m[1]);
  for (const file of INLINE_STYLE_SOURCES) {
    const text = readFileSync(join(root, file), "utf8");
    for (const m of text.matchAll(/["'](--[\w-]+)["']\s*:/g)) definedVariables.add(m[1]);
  }

  const violations = findViolations(sheets, definedVariables);

  if (process.argv.includes("--update")) {
    const entries = [...new Set(violations.map((v) => v.signature))].sort();
    writeFileSync(baselinePath, `${JSON.stringify(entries, null, 2)}\n`);
    console.log(`Style baseline rewritten: ${entries.length} known violations.`);
    return;
  }

  const baseline = JSON.parse(readFileSync(baselinePath, "utf8"));
  const { added, stale } = compareToBaseline(violations, baseline);

  if (added.length > 0) {
    console.error("New style-system violations:\n");
    for (const violation of added) {
      console.error(`  - ${violation.rule}: ${relative(".", violation.file)}:${violation.line} ${violation.detail}`);
    }
    console.error("\nSee docs/design-system.md. Use a token, or fix the rule -- the baseline is for what was already there, not for new work.");
  }
  if (stale.length > 0) {
    console.error(`${added.length > 0 ? "\n" : ""}Fixed, but still listed in scripts/style-baseline.json:\n`);
    for (const entry of stale) console.error(`  - ${entry}`);
    console.error("\nDelete those lines. The baseline only shrinks.");
  }
  if (added.length > 0 || stale.length > 0) process.exit(1);

  const byRule = new Map();
  for (const violation of violations) byRule.set(violation.rule, (byRule.get(violation.rule) ?? 0) + 1);
  const summary = [...byRule].sort().map(([rule, count]) => `${rule} ${count}`).join(", ");
  console.log(`Styles: no new violations (${violations.length} known${summary ? ` -- ${summary}` : ""}).`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
