import { expect, it, vi } from "vitest";
import type { AgentSessionSnapshot } from "./agent-session-store.js";
import { planApprovalContext } from "./plan-approval-context.js";
import { PlanApprovalService } from "./plan-approval.js";

type Message = AgentSessionSnapshot["messages"][number];
const message = (id: string, role: Message["role"], text: string, extra: Partial<Message> = {}): Message => ({ id, sourceId: id, role, text, ...extra });
const input = (messages: readonly Message[]) => ({ id: "fixture", agentKind: "codex" as const, status: "idle" as const,
  updatedAt: "2026-10-30T09:00:00Z", canReply: true, replyable: true, activities: [], turnState: {}, messages });
const decision = { canApprove: true, reason: "当前方案明确", evidence: "请批准以上方案。" };

it("omits an old completed report while keeping the whole new request and plan", async () => {
  const messages = [message("old", "agent", "旧报告".repeat(8_000)), message("request", "user", "增加快捷批准按钮"),
    message("plan", "agent", "方案：实现按钮及服务端校验。请批准以上方案。")];
  const selected = JSON.parse(planApprovalContext(messages));
  expect(selected.messages.map((m: { sourceId: string }) => m.sourceId)).toEqual(["request", "plan"]);
  expect(selected.earlierHistoryOmitted).toBe(true);
  const classify = vi.fn(async () => decision);
  const service = new PlanApprovalService(classify);
  service.assess(input(messages)); await Promise.resolve();
  expect(service.assess(input(messages)).offer).toBeDefined();
  expect(classify).toHaveBeenCalledTimes(1);
});

it("retains a full prior plan and all subsequent human constraints across more than twelve execution events", () => {
  const messages = [message("old", "agent", "更早任务".repeat(8_000)), message("anchor", "plan", "明确方案：统一全部单选控件，保留表单语义。")];
  for (let i = 0; i < 16; i++) {
    messages.push(message(`log${i}`, "agent", "旧执行流水".repeat(5_000), { phase: "commentary" }));
    messages.push(message(`user${i}`, "user", `约束 ${i} 必须保留`));
  }
  messages.push(message("latest", "agent", "方案调整完毕，请批准以上方案。"));
  const context = planApprovalContext(messages);
  const selected = JSON.parse(context).messages;
  expect(selected[0].sourceId).toBe("anchor");
  expect(selected.filter((m: { role: string }) => m.role === "user")).toHaveLength(16);
  expect(context).not.toContain("旧执行流水");
  expect(context).not.toContain("更早任务");
  expect(context).toContain("保留表单语义");
  expect(context.length).toBeLessThan(20_000);
});

it("does not clip an oversized plan or later constraint to manufacture a positive result", () => {
  const classify = vi.fn(async () => decision);
  const service = new PlanApprovalService(classify);
  for (const messages of [
    [message("plan", "plan", "计划：" + "完整方案".repeat(6_000))],
    [message("plan", "plan", "计划：完整方案"), message("constraint", "user", "必须保留的限制".repeat(4_000)), message("latest", "agent", "请批准以上方案。")],
  ]) {
    expect(service.assess(input(messages))).toEqual({ status: { code: "context_too_large" } });
  }
  expect(classify).not.toHaveBeenCalled();
});
