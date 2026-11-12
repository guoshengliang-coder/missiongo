import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const styles = readFileSync(fileURLToPath(new URL("./styles.css", import.meta.url)), "utf8");
const appSource = readFileSync(fileURLToPath(new URL("./App.tsx", import.meta.url)), "utf8");

function mediaBlocks(maxWidth: number): string[] {
  const marker = `@media (max-width: ${maxWidth}px) {`;
  const blocks: string[] = [];
  let start = styles.indexOf(marker);
  if (start < 0) throw new Error(`Missing ${marker}`);

  while (start >= 0) {
    let depth = 0;
    let end = -1;
    for (let index = start; index < styles.length; index += 1) {
      if (styles[index] === "{") depth += 1;
      if (styles[index] !== "}") continue;
      depth -= 1;
      if (depth === 0) { end = index + 1; break; }
    }
    if (end < 0) throw new Error(`Unclosed ${marker}`);
    blocks.push(styles.slice(start, end));
    start = styles.indexOf(marker, end);
  }
  return blocks;
}

describe("phone detail shell", () => {
  it("marks the shell while an item detail is open", () => {
    expect(appSource).toContain('className={`app-shell ${selectedItemKey ? "detail-open" : ""}');
  });

  it("drops the list topbar so the item toolbar is the only row", () => {
    const phone = mediaBlocks(520).join("\n");
    expect(phone).toContain(".app-shell.detail-open > .topbar { display: none; }");
    // The detail page now owns the full viewport the topbar used to shorten.
    expect(phone).toContain(".app-shell.detail-open .workspace.detail-open { height: 100vh; height: 100dvh; }");
    // The toolbar takes over the safe area the topbar supplied.
    expect(phone).toContain(".app-shell.detail-open .detail-toolbar { min-height: calc(62px + var(--safe-top)); padding-top: calc(9px + var(--safe-top)); }");
  });

  it("leaves the tablet shell and larger widths unchanged", () => {
    expect(mediaBlocks(1023).join("\n")).not.toContain(".app-shell.detail-open > .topbar");
  });
});
