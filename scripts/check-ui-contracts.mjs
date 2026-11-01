#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";
import { sourceFiles } from "./check-styles.mjs";

// Existing specialized surfaces may keep their markup, but not an independent
// lifecycle. New surfaces should use OverlayDialog/Modal rather than join this
// list. Exact counts prevent a second dialog silently inheriting an exemption.
const nativeSurfaces = new Map([
  ["App.tsx", 1], ["modal.tsx", 1], ["ImageAnnotator.tsx", 1], ["AndroidUpdateNotice.tsx", 1],
]);

export function uiContractViolations(file, source) {
  const text = source.replace(/\/\*[\s\S]*?\*\//g, "");
  const failures = [];
  const dialogs = [...text.matchAll(/<dialog\b/g)].length;
  if (file !== "overlay.tsx") {
    if (dialogs && (dialogs !== nativeSurfaces.get(file) || !/useModalSurface\(dialogRef,/.test(text))) failures.push("Native dialogs must use OverlayDialog or the registered useModalSurface lifecycle");
    if (/\.showModal\s*\(/.test(text)) failures.push("showModal belongs to the shared overlay lifecycle");
    if (/\srole\s*=\s*(?:["'](?:dialog|alertdialog)["']|\{\s*["'](?:dialog|alertdialog)["']\s*\})/.test(text)) failures.push("ARIA alone does not make a modal: use OverlayDialog");
    if (/<details\b[^>]*className=["'][^"']*(?:menu|popover|topbar-more|more-actions|account-more)/.test(text)) failures.push("Popup details must use OverlayMenu; plain details are for disclosures");
  }
  return failures;
}

function main() {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  const directory = join(root, "apps/web/src");
  const failures = sourceFiles(directory, ".tsx").filter(file => !file.endsWith(".test.tsx")).flatMap(file =>
    uiContractViolations(relative(directory, file), readFileSync(file, "utf8")).map(message => `${relative(root, file)}: ${message}`));
  if (failures.length) { console.error(failures.join("\n")); process.exitCode = 1; }
  else console.log("UI surfaces use the shared modal/menu lifecycle. Browser contract tests verify behavior.");
}
if (process.argv[1] === fileURLToPath(import.meta.url)) main();
