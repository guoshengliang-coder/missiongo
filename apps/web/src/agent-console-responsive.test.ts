import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const styles = readFileSync(fileURLToPath(new URL("./styles.css", import.meta.url)), "utf8");

function mediaBlock(maxWidth: number): string {
  const marker = `@media (max-width: ${maxWidth}px) {`;
  const start = styles.indexOf(marker);
  if (start < 0) throw new Error(`Missing ${marker}`);

  let depth = 0;
  for (let index = start; index < styles.length; index += 1) {
    if (styles[index] === "{") depth += 1;
    if (styles[index] !== "}") continue;
    depth -= 1;
    if (depth === 0) return styles.slice(start, index + 1);
  }
  throw new Error(`Unclosed ${marker}`);
}

describe("agent console responsive layout", () => {
  it("uses the compact filters throughout the mobile and tablet shell", () => {
    const tablet = mediaBlock(1023);

    expect(tablet).toMatch(/\.agent-console-page \{[^}]*grid-template-columns: minmax\(230px, 290px\) minmax\(0, 1fr\);/);
    expect(tablet).toContain(".agent-console-filters { display: none; }");
    expect(tablet).toContain(".agent-console-mobile-filters { display: flex;");
  });

  it("keeps the project switcher in the phone console header", () => {
    const tablet = mediaBlock(1023);
    const phone = mediaBlock(520);

    expect(tablet).toContain(".topbar .brand { display: none; }");
    expect(phone).not.toContain(".app-shell.agent-console-open .product-switcher-wrap { display: none; }");
    expect(phone).not.toContain(".app-shell.agent-console-open .topbar .brand { display: flex; }");
  });
});
