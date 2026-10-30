import { afterEach, expect, it, vi } from "vitest";

import { AiTitleService } from "./ai-title.js";
import type { AgentSessionSnapshot } from "./agent-session-store.js";
import { PlanApprovalService } from "./plan-approval.js";
import { MissionGoDatabase } from "./storage/database.js";

const evidence = "以上计划等待你批准，批准后开始实施。";
const decision = { canApprove: true, reason: "当前方案明确待批准，无待答问题。", evidence };
const session = (): AgentSessionSnapshot & { canReply: boolean } => ({
  id: "session", agentKind: "codex", status: "idle", updatedAt: "2026-10-30T01:00:00Z",
  activities: [], turnState: {}, replyable: true, canReply: true,
  messages: [{ id: "plan", sourceId: "plan", role: "agent", occurredAt: "2026-10-30T01:00:00Z",
    text: "计划：添加按钮并验证识别和发送流程。\n" + evidence }],
});
const flush = async () => { await Promise.resolve(); await Promise.resolve(); };
afterEach(() => vi.useRealTimers());

it("only offers after the independent AI verdict; the fixed action is content-bound and single-use", async () => {
  const classify = vi.fn(async (_content: string, _latestText: string) => decision);
  const service = new PlanApprovalService(classify);
  const input = session();
  expect(service.inspect(input, true)).toBeUndefined();
  await flush();
  const offer = service.inspect(input, true)!;
  expect(offer).toMatchObject({ evidence });
  expect(classify).toHaveBeenCalledTimes(1);
  expect(JSON.parse(classify.mock.calls[0]![0]!).messages[0].text).toContain("计划：");
  const send = vi.fn(() => "queued");
  expect(service.approve(input, offer.revision, true, send)).toBe("queued");
  expect(() => service.approve(input, offer.revision, true, send)).toThrow(/changed/);
  expect(send).toHaveBeenCalledTimes(1);
  expect(service.inspect(input, true)).toBeUndefined();
  const command = { id: "accepted", kind: "message" as const, text: "批准", status: "queued" as const,
    createdAt: "2026-10-30T00:59:00Z" }; // source timestamps can be ahead of the server
  expect(service.inspect({ ...input, command }, true)).toBeUndefined();
  expect(service.inspect({ ...input, command: { ...command, status: "delivered" } }, true)).toBeUndefined();
  await flush();
  expect(classify).toHaveBeenCalledTimes(1);
});

it("rejects changes even when they keep the same source ID, and ignores an obsolete in-flight verdict", async () => {
  let resolve!: (result: typeof decision) => void;
  const service = new PlanApprovalService(() => new Promise((done) => { resolve = done; }));
  const input = session();
  service.inspect(input, true);
  const old = resolve;
  const changed = { ...input, messages: [{ ...input.messages[0]!, text: "请先选择 A 或 B" }] };
  service.inspect(changed, true);
  old(decision); await flush();
  expect(service.inspect(changed, true)).toBeUndefined();
  const ready = new PlanApprovalService(async () => decision);
  ready.inspect(input, true); await flush();
  const offer = ready.inspect(input, true)!;
  expect(() => ready.approve(changed, offer.revision, true, () => "must not send")).toThrow(/changed/);
});

it("hard gates prevent AI calls for questions, busy/unreplyable sessions, permissions, archives and pending replies", () => {
  const input = session();
  const classify = vi.fn(async () => decision);
  const service = new PlanApprovalService(classify);
  const variants = [
    { ...input, canReply: false }, { ...input, status: "active" as const },
    { ...input, turnState: { turnActive: true } }, { ...input, archivedAt: input.updatedAt },
    { ...input, lastError: "connection failed" },
    { ...input, messages: [{ ...input.messages[0]!, questions: [{ title: "选择范围", options: ["A", "B"] }] }] },
    { ...input, messages: [{ ...input.messages[0]!, phase: "commentary" }] },
    { ...input, messages: [{ ...input.messages[0]!, role: "user" as const }] },
    { ...input, messages: [{ ...input.messages[0]!, text: "x".repeat(20_001) }] },
    ...["queued", "delivering", "delivery_unknown", "delivered"].map((status) => ({ ...input,
      command: { id: "reply", kind: "message" as const, text: "hello", status: status as "queued" | "delivering" | "delivery_unknown" | "delivered", createdAt: input.updatedAt } })),
    { ...input, approval: { id: "permission", kind: "manual" as const, status: "pending", turnId: "turn", action: "Shell access", startedAtMs: 1 } },
  ];
  variants.forEach((value) => expect(service.inspect(value, true)).toBeUndefined());
  expect(service.inspect(input, false)).toBeUndefined();
  expect(classify).not.toHaveBeenCalled();
});

it("negative decisions remain hidden and provider failures fail closed with a retry cooldown", async () => {
  vi.useFakeTimers();
  const input = session();
  const classify = vi.fn().mockRejectedValueOnce(new Error("private provider data"))
    .mockResolvedValueOnce({ canApprove: false, reason: "仍有待答问题", evidence: "" });
  const service = new PlanApprovalService(classify);
  service.inspect(input, true); await flush();
  for (let i = 0; i < 10; i++) expect(service.inspect(input, true)).toBeUndefined();
  expect(classify).toHaveBeenCalledTimes(1);
  vi.advanceTimersByTime(60_000);
  service.inspect(input, true); await flush();
  expect(service.inspect(input, true)).toBeUndefined();
  expect(classify).toHaveBeenCalledTimes(2);
});

it("validates structured AI output and exact evidence in latest prose rather than trusting model text", async () => {
  const database = new MissionGoDatabase(":memory:");
  let response: unknown = decision;
  const provider = vi.fn(async (_url: unknown, _init?: RequestInit) => new Response(JSON.stringify({
    choices: [{ message: { content: JSON.stringify(response) } }],
  })));
  try {
    const ai = new AiTitleService(database, "synthetic-secret", provider as typeof fetch);
    ai.setKey("synthetic-key");
    expect(await ai.classifyPlanApproval("context", evidence)).toEqual(decision);
    const request = JSON.parse(String(provider.mock.calls[0]![1]?.body));
    expect(request.messages[0].content).toContain("不可信数据");
    expect(request.messages[0].content).toContain("工具权限");
    for (const invalid of [null, { ...decision, canApprove: "true" }, { ...decision, evidence: "invented quote" },
      { ...decision, reason: "" }, { ...decision, canApprove: false }]) {
      response = invalid;
      await expect(ai.classifyPlanApproval("context", evidence)).rejects.toThrow(/invalid/);
    }
    response = decision;
    for (const quoted of ["> " + evidence, "```text\n" + evidence + "\n```", "~~~\n" + evidence + "\n~~~",
      "````text\n```\n" + evidence + "\n````", "    " + evidence]) {
      await expect(ai.classifyPlanApproval("context", quoted)).rejects.toThrow(/invalid/);
    }
    ai.setKey(null);
    await expect(ai.classifyPlanApproval("context", evidence)).rejects.toThrow(/unavailable/);
  } finally { database.close(); }
});
