import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { AgentPlanContent, repeatsSubmittedPlan, withoutDuplicatePlan } from "./agent-plan-content";
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

it("hides only the agent message that repeats the submitted plan body", () => {
  const session = { implementationPlan: { plan: "Exact plan" } } as AgentSession;
  const message = (role: AgentSessionMessage["role"], text: string) => ({ role, text }) as AgentSessionMessage;
  expect(repeatsSubmittedPlan(message("agent", " Exact plan\n"), session)).toBe(true);
  expect(repeatsSubmittedPlan(message("plan", "Exact plan"), session)).toBe(false);
  expect(repeatsSubmittedPlan(message("user", "Exact plan"), session)).toBe(false);
  expect(repeatsSubmittedPlan(message("agent", "Exact plan plus commentary"), session)).toBe(false);
  expect(repeatsSubmittedPlan(message("agent", "Exact plan"), undefined)).toBe(false);
});

it("keeps post-approval replies after the plan, including legacy plans and paged history", async () => {
  const { planTranscript } = await import("./agent-plan-content");
  const messages = [
    { id: "investigation", role: "agent", text: "Investigated", occurredAt: "2026-11-05T10:00:00Z" },
    { id: "original", role: "plan", text: "Exact plan", occurredAt: "2026-11-05T10:01:00Z" },
    { id: "accepted", role: "agent", text: "Approval received", occurredAt: "2026-11-05T10:02:00Z" },
    { id: "result", role: "agent", text: "Implementation complete", occurredAt: "2026-11-05T11:00:00Z" },
  ] as AgentSessionMessage[];
  const ids = (rows: readonly (AgentSessionMessage | null)[]) => rows.map(row => row?.id ?? "submitted-plan");
  const legacy = { implementationPlan: { plan: "Exact plan" } } as AgentSession;
  expect(ids(planTranscript(messages, legacy))).toEqual(["investigation", "submitted-plan", "accepted", "result"]);
  const registered = { implementationPlan: { plan: "Different registered proposal", submittedAt: "2026-11-05T10:01:30Z" } } as AgentSession;
  expect(ids(planTranscript(messages, registered))).toEqual(["investigation", "original", "submitted-plan", "accepted", "result"]);
  expect(ids(planTranscript(messages.slice(2), registered))).toEqual(["submitted-plan", "accepted", "result"]);
  const oldApproved = { implementationPlan: { plan: "Different registered proposal", approvedAt: "2026-11-05T10:02:00.500Z" } } as AgentSession;
  expect(ids(planTranscript(messages, oldApproved))).toEqual(["investigation", "original", "submitted-plan", "accepted", "result"]);
  expect(ids(planTranscript(messages.slice(2), legacy))).toEqual(["submitted-plan", "accepted", "result"]);
  expect(planTranscript(messages, undefined)).toBe(messages);
});

it("ends the approval acknowledgement on native progress while retaining uncertain delivery", async () => {
  const { planContinuationObserved } = await import("./agent-plan-content");
  const base = { messages: [], status: "idle", implementationPlan: { revision: "reviewed", plan: "Plan", approvedAt: "2026-11-05T10:00:00.500Z" },
    planApprovalState: { approved: true, revision: "reviewed", continuationQueued: true },
    command: { text: "批准", status: "queued", createdAt: "2026-11-05T10:00:00.500Z" },
    turnState: { turnActive: false, turnStartedAt: "2026-11-05T09:59:00Z" } } as unknown as AgentSession;
  expect(planContinuationObserved(undefined)).toBe(false);
  expect(planContinuationObserved(base)).toBe(false);
  expect(planContinuationObserved({ ...base, command: { ...base.command!, status: "delivery_unknown" } })).toBe(false);
  expect(planContinuationObserved({ ...base, status: "active", turnState: { turnActive: true, turnStartedAt: "2026-11-05T10:00:01Z" } })).toBe(true);
  expect(planContinuationObserved({ ...base, turnState: { turnActive: false, lastOutputAt: "2026-11-05T10:01:00Z" } })).toBe(true);
  expect(planContinuationObserved({ ...base, messages: [{ role: "agent", text: "Now implementing", occurredAt: "2026-11-05T10:00:00Z" } as AgentSessionMessage] })).toBe(true);
  expect(planContinuationObserved({ ...base, implementationPlan: { ...base.implementationPlan!, revision: "new" },
    turnState: { turnActive: true, turnStartedAt: "2026-11-05T10:00:01Z" } })).toBe(false);
  const offline = { ...base, implementationPlan: undefined, command: undefined,
    planApprovalState: { ...base.planApprovalState!, continuationQueued: false } } as unknown as AgentSession;
  expect(planContinuationObserved(offline)).toBe(false);
});

it("does not promote plan-mode progress to a submitted proposal", async () => {
  const { planTranscript } = await import("./agent-plan-content");
  const messages = [{ id: "progress", role: "plan", text: "正在调查，等待结果" }] as AgentSessionMessage[];
  const session = { messages } as unknown as AgentSession;
  expect(planTranscript(messages, session)).toBe(messages);
  const html = renderToStaticMarkup(<I18nProvider><AgentPlanContent session={session} surface="panel" /></I18nProvider>);
  expect(html).toBe("");
});


it("anchors an agent-carried proposal at its original message, including legacy timing and polling", async () => {
  const { planTranscript } = await import("./agent-plan-content");
  const messages = [
    { id: "progress", role: "agent", text: "Investigating", occurredAt: "2026-11-06T07:51:17Z" },
    { id: "answer", role: "agent", text: "Exact proposal", occurredAt: "2026-11-06T07:51:23Z" },
    { id: "followup", role: "user", text: "？？", occurredAt: "2026-11-06T07:54:32Z" },
  ] as AgentSessionMessage[];
  for (const submittedAt of [undefined, "2026-11-06T07:55:00Z"]) {
    const session = { implementationPlan: { plan: "Exact proposal", submittedAt } } as AgentSession;
    expect(planTranscript(messages, session).map(message => message?.id ?? "card"))
      .toEqual(["progress", "card", "answer", "followup"]);
    expect(repeatsSubmittedPlan(messages[1]!, session)).toBe(true);
  }
  expect(planTranscript(messages, { messages } as unknown as AgentSession)).toBe(messages);
});

it("shows the offered revision rather than an older persisted proposal", async () => {
  const { currentPlan } = await import("./agent-plan-content");
  const session = { implementationPlan: { revision: "old", plan: "Old body" },
    planApproval: { revision: "new", plan: "New body", validation: "New verification" } } as AgentSession;
  expect(currentPlan(session)?.plan).toBe("New body");
});


it("does not carry an older human approval onto a different current proposal", () => {
  const session={implementationPlan:{revision:"old",plan:"Old approved plan",approved:true,valid:false},
    planApprovalState:{revision:"old",approved:true},planApproval:{revision:"new",plan:"New unapproved proposal"}} as AgentSession;
  const html=renderToStaticMarkup(<I18nProvider><AgentPlanContent session={session} surface="console" /></I18nProvider>);
  expect(html).toContain("New unapproved proposal");
  expect(html).not.toContain("方案已批准");
  expect(html).not.toContain("范围已变化");
});
