import type { AgentSession } from "./types";

export interface MergePreparationEvidence { messageId: string; commit: string; text: string; key: string }

/** An advisory offer, never evidence of a PR, approval or completed delivery. */
export function mergePreparationEvidence(session: AgentSession | undefined): MergePreparationEvidence | undefined {
  if (!session || session.status !== "idle" || session.archivedAt || session.managedExecution
    || session.turnState?.turnActive || session.activities.length || session.planApproval
    || session.planApprovalStatus?.code === "content_unavailable"
    || session.approval && ["pending", "reviewing"].includes(session.approval.status)) return;
  const pending = (command: AgentSession["command"]) => command && ["queued", "delivering", "delivery_unknown"].includes(command.status);
  if (pending(session.command) || pending(session.stopCommand)) return;
  const message = session.messages.at(-1);
  if (!message || message.role !== "agent" || message.phase && message.phase !== "final_answer"
    || session.messages.some(m => m.questions?.some(q => !q.answered && !q.withdrawn))) return;
  // A newer accepted/failed send must not revive the previous completion while awaiting a turn.
  if (session.command && session.command.status !== "cancelled"
    && !(Date.parse(session.command.createdAt) < Date.parse(message.occurredAt))) return;
  const text = message.text.replace(/```[\s\S]*?```/g, "").replace(/^\s*>.*$/gm, "");
  if (/(?:尚未|还未|未能|没有)完成|(?:检查|测试|验证)(?:仍|尚)?(?:失败|未通过)|请[^。\n]{0,15}(?:批准|审批)/u.test(text)) return;
  // Completion may describe the approved scope rather than repeat "修复/修改".
  // Require an affirmative statement boundary; plans, conditions and quotations
  // must not become completion evidence merely because they contain these words.
  const scopeComplete = /(?:^|[。\n；;])\s*(?:[-*]\s+)?(?:已(?:(?:按照?|依照)(?:已)?批准的?(?:实施)?方案)?完成|(?:按照?|依照)(?:已)?批准的?(?:实施)?方案已完成)(?=并(?:已)?(?:本地)?提交|[，,。；;：:\s]|$)/u.test(text);
  const complete = /已(?:完成[^。\n]{0,30}(?:修复|修改|开发|实现)|修复|实现)|(?:修复|实现|开发|修改)(?:已)?完成|(?:implemented|fixed|completed)\b/iu.test(text);
  const notDelivered = /(?:尚未|还未|未)(?:推送|\s*push|\s*(?:创建|建|开)\s*PR)|\b(?:not yet pushed|not pushed|not yet opened a PR)\b/iu.test(text);
  const commit = /(?:本地提交|提交|commit(?:ted)?)\s*[:：]?\s*`?([a-f0-9]{7,40})\b/iu.exec(text)?.[1];
  if (!(complete || scopeComplete) || !notDelivered || !commit) return;
  let digest = 2166136261;
  for (const char of message.text) digest = Math.imul(digest ^ char.charCodeAt(0), 16777619);
  return { messageId: message.id, commit, text: message.text, key: `${session.id}:${message.id}:${digest >>> 0}` };
}
