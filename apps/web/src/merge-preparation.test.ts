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
