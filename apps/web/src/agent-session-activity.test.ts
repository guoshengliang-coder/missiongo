import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const consoleSource = readFileSync(fileURLToPath(new URL("./agent-session-console.tsx", import.meta.url)), "utf8");

/**
 * AND-236: Codex and OpenCode report turns too, so the running and waiting
 * activity lines must carry the agent that is actually running the session.
 * The i18n copy test covers the strings; this covers the call sites, where the
 * literal "Claude Code" was previously baked into the turn line.
 */
describe("agent session activity copy names the running agent", () => {
  it("passes the session's agent label into the turn and waiting lines", () => {
    expect(consoleSource).toContain('const agentName = selected ? agentLabel(selected, t) : "";');
    expect(consoleSource).toContain('t("agentSessionTurnRunning", { duration: elapsed(turnState?.turnStartedAt, clock) ?? "–", agent: agentName })');
    expect(consoleSource).toContain('t("agentSessionWaitingForInput", { agent: agentName })');
  });
});
