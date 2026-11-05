import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { AgentPlanContent, withoutDuplicatePlan } from "./agent-plan-content";
import { I18nProvider } from "./i18n";
import type { AgentSession, AgentSessionMessage } from "./types";

it("renders the exact submitted plan and validation before and after approval, independently of permissions", () => {
  for (const agentKind of ["codex", "claude_code", "opencode", "hermes"]) for (const approved of [false, true]) {
    const session = { agentKind, implementationPlan: { revision: "current", plan: "## Exact plan\n\n**Keep the body**",
      validation: "Verify the visible result", itemKeys: ["EX-1"], approved, valid: true },
      approval: { status: "pending" }, canReply: false } as unknown as AgentSession;
    const html = renderToStaticMarkup(<I18nProvider><AgentPlanContent session={session} surface="console" /></I18nProvider>);
    expect(html).toContain("<h2>Exact plan</h2>");
    expect(html).toContain("<strong>Keep the body</strong>");
    expect(html).toContain("Verify the visible result");
    expect(html).not.toContain("<details");
    expect(html.includes("方案已批准")).toBe(approved);
  }
});

it("deduplicates only identical plan messages, preserving commentary and different native plans", () => {
  const session = { implementationPlan: { plan: "Exact plan" } } as AgentSession;
  const messages = [
    { id: "same", role: "plan", text: "Exact plan" },
    { id: "different", role: "plan", text: "A different original plan" },
    { id: "comment", role: "agent", text: "Exact plan" },
  ] as AgentSessionMessage[];
  expect(withoutDuplicatePlan(messages, session).map(message => message.id)).toEqual(["different", "comment"]);
});
