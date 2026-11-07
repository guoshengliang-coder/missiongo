import { expect, it } from "vitest";
import type { AgentSession, AgentSessionMessage } from "./types";

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

it("shows the offered revision rather than an older persisted proposal", async () => {
  const { currentPlan } = await import("./agent-plan-content");
  const session = { implementationPlan: { revision: "old", plan: "Old body" },
    planApproval: { revision: "new", plan: "New body", validation: "New verification" } } as AgentSession;
  expect(currentPlan(session)?.plan).toBe("New body");
});


it("attaches approval to the complete original proposal including validation and extra explanation", async () => {
  const { inlinePlanTranscript } = await import("./agent-plan-content");
  const session = { implementationPlan: { revision: "r1", plan: "Full proposal", validation: "Verify result" } } as AgentSession;
  const messages = [{ id: "original", role: "agent", text: "Full proposal\n\nValidation:\nVerify result\n\nApproval explanation" }] as AgentSessionMessage[];
  const result = inlinePlanTranscript(messages, session);
  expect(result.messages).toEqual(messages);
  expect(result.planMessageId).toBe("original");
  const bodyOnly = inlinePlanTranscript([{ ...messages[0]!, text: "Full proposal" }], session);
  expect(bodyOnly.messages).toHaveLength(1);
  expect(bodyOnly.messages[0]?.text).toBe("Full proposal");
});

it("does not attach current approval to an old or partial proposal; replaces fallback when source arrives", async () => {
  const { inlinePlanTranscript } = await import("./agent-plan-content");
  const session = { implementationPlan: { revision: "r2", plan: "New complete proposal", validation: "Check", submittedAt: "2026-11-06T10:00:00Z" } } as AgentSession;
  const old = { id: "old", role: "agent", text: "New complete proposal with different scope", occurredAt: "2026-11-06T09:00:00Z" } as AgentSessionMessage;
  const pending = inlinePlanTranscript([old], session);
  expect(pending.planMessageId).toBeUndefined();
  expect(pending.messages).toEqual([old]);
  const source = { ...old, id: "source", text: "New complete proposal\n\nCheck" };
  const synced = inlinePlanTranscript([old, source], session);
  expect(synced.planMessageId).toBe("source");
  expect(synced.messages).toEqual([old, source]);
});

it("keeps an older validation separate from the current frozen scope", async () => {
  const { inlinePlanTranscript } = await import("./agent-plan-content");
  const session = { implementationPlan: { revision: "new", plan: "Body", validation: "New validation" } } as AgentSession;
  const old = { id: "old", role: "agent", text: "Body\n\nOld validation", occurredAt: "2026-11-06T09:00:00Z" } as AgentSessionMessage;
  const result = inlinePlanTranscript([old], session);
  expect(result.planMessageId).toBeUndefined();
  expect(result.messages).toContain(old);
});


it("binds a fixed document through prefix, split delivery and revisions without changing source bytes", async () => {
  const { inlinePlanTranscript } = await import("./agent-plan-content");
  const id = "11111111-1111-4111-8111-111111111111";
  const session = { implementationPlan: { revision: "v2", documentId: id, plan: "Summary", validation: "" } } as AgentSession;
  const messages = [
    {id:"old",role:"agent",text:"[Old](/?planDocument=22222222-2222-4222-8222-222222222222)"},
    {id:"split",role:"agent",text:"Summary"},
    {id:"source",role:"agent",text:`Revision clarification\n\n[Read fixed document](https://example.test/?planDocument=${id})\n\nNo new authority.`},
  ] as AgentSessionMessage[];
  const pending = inlinePlanTranscript(messages.slice(0,2),session);
  expect(pending.planMessageId).toBeUndefined();
  expect(pending.messages).toEqual(messages.slice(0,2));
  const complete = inlinePlanTranscript(messages,session);
  expect(complete.messages).toBe(messages);
  expect(complete.planMessageId).toBe("source");
  expect(inlinePlanTranscript(messages,{...session,implementationPlan:{...session.implementationPlan!,documentId:"new"}}).planMessageId).toBeUndefined();
});

it("keeps approval on the final answer when a later progress message repeats its document link", async () => {
  const { inlinePlanTranscript } = await import("./agent-plan-content");
  const documentId = "11111111-1111-4111-8111-111111111111";
  const link = `[Plan](/?planDocument=${documentId})`;
  const session = {implementationPlan:{revision:"v1",documentId,plan:`Decision\n${link}`}} as AgentSession;
  const messages = [
    {id:"early",role:"agent",phase:"commentary",text:`Decision\n${link}`},
    {id:"final",role:"agent",phase:"final_answer",text:`Decision\n${link}`},
    {id:"later",role:"agent",phase:"commentary",text:`Waiting: ${link}`},
  ] as AgentSessionMessage[];
  const result = inlinePlanTranscript(messages, session);
  expect(result.messages).toBe(messages);
  expect(result.planMessageId).toBe("final");
  expect(inlinePlanTranscript([messages[0]!],session).planMessageId).toBe("early");
  expect(inlinePlanTranscript(messages,{implementationPlan:{revision:"v2",documentId:"different",plan:"New"}} as AgentSession).planMessageId).toBeUndefined();
});
