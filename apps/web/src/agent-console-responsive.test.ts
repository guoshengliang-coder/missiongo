import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const styles = readFileSync(fileURLToPath(new URL("./styles.css", import.meta.url)), "utf8");
const consoleSource = readFileSync(fileURLToPath(new URL("./agent-session-console.tsx", import.meta.url)), "utf8");

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

  it("uses one console topbar instead of a second list heading", () => {
    expect(styles).toMatch(/\.topbar\.agent-console-topbar \{[^}]*grid-template-columns:/);
    expect(consoleSource).not.toContain('className="agent-console-list-head"');
  });

  it("keeps replies below the textarea with quick actions", () => {
    expect(styles).toContain(".agent-console-reply form { display: grid; gap: 9px; }");
    expect(styles).toContain(".agent-console-reply-actions { display: flex;");
    expect(consoleSource).toContain('t("agentSessionQuickMergeRelease")');
    expect(consoleSource).toContain('t("agentSessionQuickRelease")');
  });

  it("uses one aligned icon-button treatment for phone conversation actions", () => {
    const tablet = mediaBlock(760);

    expect(styles).toMatch(/\.agent-console-actions \{[^}]*margin-left: auto;/);
    expect(tablet).toMatch(/\.agent-console-actions button \{[^}]*width: 44px;[^}]*min-height: 44px;/);
    expect(consoleSource).toContain('className="secondary-button"');
    expect(consoleSource).not.toMatch(/className="danger-button"[\s\S]{0,250}agentConsoleStop/);
  });

  it("renders attention badges from the all-product session feed", () => {
    const appSource = readFileSync(fileURLToPath(new URL("./App.tsx", import.meta.url)), "utf8");

    expect(appSource).toContain('queryFn: () => api.listAgentSessions()');
    expect(appSource).toContain('className="agent-attention-badge"');
    expect(appSource).toContain(
      "attentionCounts={agentConsoleOpen && hasAnyAiPermission ? attentionCounts.byProduct : undefined}",
    );
    expect(appSource).not.toContain('queryKey: ["agent-sessions", selectedProductId]');
  });
});
