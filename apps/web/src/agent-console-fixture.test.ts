import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const fixture = readFileSync(fileURLToPath(new URL("../../../tests/ui/fixture.mjs", import.meta.url)), "utf8");
const navigation = readFileSync(fileURLToPath(new URL("./navigation.ts", import.meta.url)), "utf8");

/**
 * The `agent-console` fixture page asked for `&agent=1` from the day it was
 * added, but the console has only ever opened on `?console=agent`. So the
 * screenshot and audit of that page measured an item list while reporting the
 * console was covered. Keep the two in step.
 */
describe("agent console fixture page", () => {
  it("opens the console with the parameter navigation.ts reads", () => {
    expect(navigation).toContain('url.searchParams.get("console") === "agent"');
    expect(fixture).toMatch(/name: "agent-console", path: \(f\) => `\/\?product=\$\{f\.productId\}&console=agent`/);
    expect(fixture).not.toContain("&agent=1");
  });
});
