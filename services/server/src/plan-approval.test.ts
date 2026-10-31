import { expect, it, vi } from "vitest";

import type { AgentSessionSnapshot } from "./agent-session-store.js";
import { PlanApprovalService } from "./plan-approval.js";

const session = () => ({
  id: "session", agentKind: "codex" as const, status: "idle" as const, updatedAt: "2026-10-30T01:00:00Z",
  activities: [], turnState: {}, replyable: true, canReply: true,
  attention: { state: "needed" as const, kind: "approval" as const, reason: "待批准", revision: "attention" },
  messages: [{ id: "plan", sourceId: "plan", role: "agent" as const, occurredAt: "2026-10-30T01:00:00Z", text: "等待批准" }],
} satisfies AgentSessionSnapshot & { canReply: boolean });

it("uses the existing approval attention even with long context and unsettled historical question metadata", () => {
  const input = session();
  const service = new PlanApprovalService();
  const assessment = service.assess({ ...input, messages: [
    { ...input.messages[0]!, text: "x".repeat(30_000), questions: [{ title: "旧问题", options: ["A", "B"] }] },
    input.messages[0]!,
  ] });
  expect(assessment.status.code).toBe("ready");
  expect(assessment.offer?.revision).toBeTruthy();
});

it("does not offer approval for other attention types or dismissed requests", () => {
  const service = new PlanApprovalService();
  const input = session();
  for (const kind of ["answer", "action", "instruction", "uncertain"] as const) {
    expect(service.assess({ ...input, attention: { ...input.attention, kind } }).offer).toBeUndefined();
  }
  expect(service.assess({ ...input, attention: { ...input.attention, dismissed: true } }).status.code).toBe("dismissed");
});

it("rejects stale content and rechecks transport state without interpreting prose", () => {
  const service = new PlanApprovalService();
  const input = session();
  const revision = service.assess(input).offer!.revision;
  const send = vi.fn();
  const changed = { ...input, messages: [{ ...input.messages[0]!, text: "新的方案" }] };
  expect(() => service.approve(changed, revision, true, send)).toThrow(/changed/);
  expect(() => service.approve({ ...input, canReply: false }, revision, true, send)).toThrow(/changed/);
  expect(() => service.approve(input, revision, false, send)).toThrow(/changed/);
  expect(send).not.toHaveBeenCalled();
  service.approve(input, revision, true, send);
  expect(send).toHaveBeenCalledTimes(1);
  expect(() => service.approve(input, revision, true, send)).toThrow(/changed/);
  expect(service.assess({ ...input, command: { id: "reply", kind: "message", text: "批准", status: "delivered", createdAt: "2026-10-30T00:59:00Z" } }).status.code).toBe("awaiting_source");
});

it("pending delivery and delivered replies block another approval until new source output", () => {
  const service = new PlanApprovalService();
  const input = session();
  for (const status of ["queued", "delivering", "delivery_unknown", "delivered"] as const) {
    expect(service.assess({ ...input, command: { id: "reply", kind: "message", text: "批准", status, createdAt: input.updatedAt } }).offer).toBeUndefined();
  }
  expect(service.assess({ ...input, approval: { id: "permission", kind: "manual", status: "pending", turnId: "turn", action: "Shell access", startedAtMs: 1 } }).status.code).toBe("permission_required");
});
