import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const styles = readFileSync(fileURLToPath(new URL("./styles.css", import.meta.url)), "utf8");
const consoleSource = readFileSync(fileURLToPath(new URL("./agent-session-console.tsx", import.meta.url)), "utf8");
const panelSource = readFileSync(fileURLToPath(new URL("./agent-session-panel.tsx", import.meta.url)), "utf8");
const appSource = readFileSync(fileURLToPath(new URL("./App.tsx", import.meta.url)), "utf8");

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
    expect(styles).toMatch(/\.topbar\.agent-console-topbar \{[^}]*grid-template-columns: auto minmax\(156px, 360px\) minmax\(44px, 1fr\);/);
    expect(styles).toMatch(/\.agent-console-topbar \.product-switcher-wrap \{[^}]*justify-self: start;/);
    expect(consoleSource).not.toContain('className="agent-console-list-head"');
  });

  it("starts batch selection from the console topbar and hides selection controls by default", () => {
    expect(appSource).toContain('className={`secondary-button agent-console-topbar-bulk');
    expect(appSource).toContain('aria-pressed={agentConsoleBulkMode}');
    expect(consoleSource).toContain('{bulkMode && bulkAvailable && (');
    expect(consoleSource).toContain('{bulkMode && selectable && (');
    expect(consoleSource).not.toContain('{filter !== "archived" && archivableIds.length > 0 && (');
  });

  it("uses rounded batch controls and preserves a compact phone topbar", () => {
    const phone = mediaBlock(520);

    expect(styles).toMatch(/\.agent-console-topbar-bulk \{[^}]*border-radius: 999px;/);
    expect(styles).toMatch(/\.agent-console-bulk-actions \{[^}]*border-radius: var\(--radius-lg\);/);
    expect(styles).toMatch(/\.agent-console-session-select input \{[^}]*border-radius: 6px;/);
    expect(phone).toContain(".agent-console-topbar-bulk span { display: none; }");
  });

  it("keeps replies below the textarea with quick actions", () => {
    expect(styles).toContain(".agent-console-reply form { display: grid; gap: 9px; }");
    expect(styles).toContain(".agent-console-reply-actions { display: flex;");
    expect(consoleSource).toContain('t("agentSessionQuickMergeRelease")');
    expect(consoleSource).toContain('t("agentSessionQuickRelease")');
  });

  it("starts both agent reply fields on one line and grows them to a bounded height", () => {
    for (const source of [consoleSource, panelSource]) {
      expect(source).toContain("<AutoGrowTextarea");
      expect(source).toContain("rows={1}");
      expect(source).toContain("maximumHeight={240}");
      expect(source).not.toContain("rows={3}");
    }
    expect(styles).toMatch(/\.agent-console-reply textarea \{[^}]*min-height: 38px;[^}]*max-height: 240px;[^}]*resize: none;/);
    expect(styles).toMatch(/\.agent-session-reply textarea \{[^}]*min-height: 42px;[^}]*max-height: 240px;[^}]*resize: none;/);
  });

  it("keeps unread and total badges visually distinct", () => {
    expect(styles).toContain("--badge-unread-fg: #ffffff;");
    expect(styles).toContain("--badge-count-fg: #303846;");
    expect(styles).toMatch(/\.agent-console-filter-unread \{[^}]*color: var\(--badge-unread-fg\);[^}]*background: var\(--badge-unread-bg\);/);
    expect(styles).toMatch(/\.agent-console-filter small \{[^}]*color: var\(--badge-count-fg\);[^}]*background: var\(--badge-count-bg\);/);
  });

  it("uses one aligned icon-button treatment for phone conversation actions", () => {
    const tablet = mediaBlock(760);

    expect(styles).toMatch(/\.agent-console-actions \{[^}]*margin-left: auto;/);
    expect(tablet).toMatch(/\.agent-console-actions button \{[^}]*width: 44px;[^}]*min-height: 44px;/);
    expect(consoleSource).toContain('className="secondary-button"');
    expect(consoleSource).not.toMatch(/className="danger-button"[\s\S]{0,250}agentConsoleStop/);
  });

  it("renders attention badges from the all-product session feed", () => {
    expect(appSource).toContain('queryFn: () => api.listAgentSessions()');
    expect(appSource).toContain('className="agent-attention-badge"');
    expect(appSource).toContain("agentSessionsQuery.data !== undefined && (");
    expect(appSource).not.toContain('agentSessionsQuery.data === undefined ? "–"');
    expect(appSource).toContain(
      "attentionCounts={agentConsoleOpen && hasAnyAiPermission ? attentionCounts.byProduct : undefined}",
    );
    expect(appSource).not.toContain('queryKey: ["agent-sessions", selectedProductId]');
  });

  it("shows a semantic occurrence time on mirrored and outgoing messages", () => {
    expect(consoleSource).toContain('<time dateTime={message.occurredAt}>');
    expect(consoleSource).toContain('<time dateTime={outgoing.occurredAt}>');
    expect(styles).toContain(".agent-console-message-meta time");
  });
});
