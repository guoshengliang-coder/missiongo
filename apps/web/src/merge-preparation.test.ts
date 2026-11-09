import { describe, expect, it } from "vitest";
import { mergePreparationEvidence } from "./merge-preparation";
import type { AgentSession } from "./types";

const report = "已完成本地修复并提交 `dacc633a`，完整检查、66 项 UI 回归通过。尚未推送、合并或发布，条目保持处理中。";
const message = { id: "final", sourceId: "final", role: "agent" as const, phase: "final_answer", text: report, occurredAt: "2026-11-08T00:43:00Z" };
const session = (changes: Partial<AgentSession> = {}): AgentSession => ({ id: "session", agentKind: "codex", status: "idle", updatedAt: message.occurredAt,
  messages: [message], activities: [], canReply: true, canResolveDelivery: false, ...changes });

describe("local merge preparation guidance", () => {
  it("offers the reported local commit before any PR exists", () => {
    expect(mergePreparationEvidence(session())?.commit).toBe("dacc633a");
    expect(mergePreparationEvidence(session({ agentKind: "claude_code", messages: [{ id: message.id, sourceId: message.sourceId, role: message.role, text: message.text, occurredAt: message.occurredAt }] }))?.commit).toBe("dacc633a");
  });
  it.each([
    "已按批准方案完成并本地提交 `06a98a04`：\n\n- 列表隐藏派单标签，详情保留“派单会话”。\n- 统一“派单会话／非派单会话”及筛选名称。\n- 完整检查、42 个相关 UI 场景通过，结果已回写条目。\n\n尚未推送、创建 PR、合并或发布；条目保持处理中。真实设备及线上效果待发布后验证。",
    "已完成并本地提交 `06a98a04`，检查通过。尚未推送。",
    "已按照批准的方案完成，本地提交 `06a98a04`。尚未创建 PR。",
    "已依照已批准的实施方案完成；本地提交 `06a98a04`，尚未推送。",
    "按批准方案已完成并提交 `06a98a04`，尚未推送。",
  ])("recognizes affirmative scope completion: %s", text => {
    expect(mergePreparationEvidence(session({ messages: [{ ...message, text }] }))?.commit).toBe("06a98a04");
  });
  it.each([
    "计划按批准方案完成并本地提交 `06a98a04`，尚未推送。",
    "尚未按批准方案完成，本地提交 `06a98a04`，尚未推送。",
    "如果已按批准方案完成并本地提交 `06a98a04`，可以继续；尚未推送。",
    "完成后的示例：已按批准方案完成并本地提交 `06a98a04`，尚未推送。",
    "> 已按批准方案完成并本地提交 `06a98a04`，尚未推送。\n以上是旧消息。",
    "```\n已按批准方案完成并本地提交 `06a98a04`，尚未推送。\n```",
    "已按批准方案完成并本地提交 `06a98a04`，检查未通过。尚未推送。",
    "已按批准方案完成并本地提交 `06a98a04`。",
    "已按批准方案完成，尚未推送。",
    "已按批准方案完成并本地提交 `06a98a04`，尚未推送。请批准下一阶段方案。",
  ])("keeps incomplete, hypothetical and blocked scope reports out: %s", text => {
    expect(mergePreparationEvidence(session({ messages: [{ ...message, text }] }))).toBeUndefined();
  });
  it.each(["active", "suspended", "stalled", "unavailable", "failed"] as const)("does not offer for %s sessions", status => {
    expect(mergePreparationEvidence(session({ status }))).toBeUndefined();
  });
  it("does not replace live work, approvals, or questions", () => {
    for (const changes of [
      { turnState: { turnActive: true } },
      { archivedAt: message.occurredAt },
      { planApproval: { revision: "r", reason: "Review", plan: "Plan" } },
      { planApprovalStatus: { code: "content_unavailable" } },
      { messages: [{ ...message, questions: [{ title: "Which scope?" }] }] },
      { messages: [{ ...message, phase: "commentary" }] },
      { messages: [{ ...message, role: "plan" as const }] },
    ]) expect(mergePreparationEvidence(session(changes))).toBeUndefined();
  });
  it("does not revive stale completion after a user reply or queued/unknown command", () => {
    expect(mergePreparationEvidence(session({ messages: [message, { ...message, id: "user", role: "user", text: "Change scope" }] }))).toBeUndefined();
    for (const status of ["queued", "delivering", "delivery_unknown", "delivered", "failed"] as const) {
      expect(mergePreparationEvidence(session({ command: { id: "c", kind: "message", text: "Continue", status, createdAt: "2026-11-08T00:44:00Z" } }))).toBeUndefined();
    }
    expect(mergePreparationEvidence(session({ stopCommand: { id: "stop", kind: "interrupt", text: "", status: "delivery_unknown", createdAt: "2026-11-08T00:42:00Z" } }))).toBeUndefined();
    expect(mergePreparationEvidence(session({ command: { id: "c", kind: "message", text: "Implement", status: "delivered", createdAt: "2026-11-08T00:42:00Z" } }))).toBeDefined();
  });
  it.each([
    "建议修复并提交，之后推送 PR。",
    "已合并 PR，尚未发布。",
    "已完成本地修复，尚未推送。",
    "尚未完成修复，本地提交 abcdef1，未推送。",
    "已修复并本地提交 abcdef1，检查失败，尚未推送。",
    "```\n" + report + "\n```\n以上仅是示例。",
    "> " + report + "\n这是历史引用。",
  ])("does not turn plans, merged work or quotations into a new delivery: %s", text => {
    expect(mergePreparationEvidence(session({ messages: [{ ...message, text }] }))).toBeUndefined();
  });
  it("versions the guide when the same message changes", () => {
    const updated = session({ messages: [{ ...message, text: report + " 补充验证通过。" }] });
    expect(mergePreparationEvidence(updated)?.key).not.toBe(mergePreparationEvidence(session())?.key);
  });
});

const repaired = { ...message, id: "repair", text: "已补修审计发现的两个问题。针对性测试通过，未推送、合并或发布。已本地提交 `cc64a106`。" };
const reviewRequest = { ...message, id: "request-review", role: "user" as const, text: "做一次审计检查" };
const review = { ...message, id: "review", text: "复审完成，**未发现新的需补修问题**，上一轮两个P2在代码层已解决。\n原生9项、Android15项测试重新运行通过。\n实机WebView、端到端注销和跨版本安装仍待验证。本轮未修改代码，未推送、合并或发布。" };

describe("review-only continuation of a completed delivery", () => {
  it("recognizes a repair and carries its commit through the actual clean review", () => {
    expect(mergePreparationEvidence(session({ messages: [repaired] }))?.commit).toBe("cc64a106");
    const evidence = mergePreparationEvidence(session({ messages: [repaired, reviewRequest,
      { ...message, id: "progress", phase: "commentary", text: "我会重点复审刚补修的两条路径。" }, review] }));
    expect(evidence?.commit).toBe("cc64a106");
    expect(evidence?.messageId).toBe("review");
    expect(evidence?.key).not.toBe(mergePreparationEvidence(session({ messages: [repaired] }))?.key);
  });
  it("can follow consecutive unchanged reviews and binds every source record", () => {
    const messages = [repaired, reviewRequest, review, { ...reviewRequest, id: "request-2", text: "再复审一下" }, { ...review, id: "review-2" }];
    const evidence = mergePreparationEvidence(session({ messages }));
    expect(evidence?.commit).toBe("cc64a106");
    const changed = [{ ...repaired, text: repaired.text.replace("cc64a106", "abcdef12") }, ...messages.slice(1)];
    expect(mergePreparationEvidence(session({ messages: changed }))?.key).not.toBe(evidence?.key);
  });
  it.each(["补修", "审计并修复", "修改界面后再审计", "提交到待合并", "合并", "改变需求范围", "不用继续了"])("does not cross an action or scope change: %s", text => {
    expect(mergePreparationEvidence(session({ messages: [repaired, { ...reviewRequest, text }, review] }))).toBeUndefined();
  });
  it.each([
    "复审完成，发现两个P2问题，需要补修。本轮未修改代码，未推送。",
    "复审完成，未发现新问题，但建议补修重试路径。本轮未修改代码，未推送。",
    "复审完成，未发现新问题，本轮已修改代码，未推送。",
    "复审完成，未发现新问题，本轮未修改代码，未推送，测试失败。",
    "复审完成，未发现新问题，未推送。",
    "复审完成，未发现新问题，本轮未修改代码，未推送。本地提交 abcdef12。",
  ])("does not carry uncertain or conflicting review outcomes: %s", text => {
    expect(mergePreparationEvidence(session({ messages: [repaired, reviewRequest, { ...review, text }] }))).toBeUndefined();
  });
  it("does not invent missing history or revive while the user already ordered delivery", () => {
    expect(mergePreparationEvidence(session({ messages: [reviewRequest, review] }))).toBeUndefined();
    expect(mergePreparationEvidence(session({ messages: [repaired, reviewRequest, review, { ...reviewRequest, text: "提交到待合并" }] }))).toBeUndefined();
    expect(mergePreparationEvidence(session({ status: "active", messages: [repaired, reviewRequest, review] }))).toBeUndefined();
  });
});
