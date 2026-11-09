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
  // Only traverse completed, explicitly read-only reviews. Every user turn is
  // a boundary: unrelated instructions, fixes and incomplete history stop here.
  let index = session.messages.length - 1;
  let commit: string | undefined;
  const evidenceMessages = [message];
  while (index >= 0) {
    const candidate = session.messages[index]!;
    if (candidate.role !== "agent" || candidate.phase && candidate.phase !== "final_answer") return;
    commit = completedCommit(candidate.text);
    if (commit) break;
    if (!unchangedReview(candidate.text)) return;
    let requestIndex = index - 1;
    while (requestIndex >= 0 && session.messages[requestIndex]!.role === "agent"
      && session.messages[requestIndex]!.phase === "commentary") requestIndex--;
    const request = session.messages[requestIndex];
    if (!request || request.role !== "user" || !reviewOnlyRequest(request.text)) return;
    index = requestIndex - 1;
    const prior = session.messages[index];
    if (!prior) return;
    evidenceMessages.push(...session.messages.slice(index, requestIndex + 1));
  }
  if (!commit) return;
  let digest = 2166136261;
  for (const char of JSON.stringify(evidenceMessages.map(m => [m.id, m.text]))) digest = Math.imul(digest ^ char.charCodeAt(0), 16777619);
  return { messageId: message.id, commit, text: message.text, key: `${session.id}:${message.id}:${digest >>> 0}` };
}

function plainText(value: string): string {
  return value.replace(/```[\s\S]*?```/g, "").replace(/^\s*>.*$/gm, "").replace(/\*\*/g, "");
}

function completedCommit(value: string): string | undefined {
  const text = plainText(value);
  if (/(?:尚未|还未|未能|没有)完成|(?:检查|测试|验证)(?:仍|尚)?(?:失败|未通过)|请[^。\n]{0,15}(?:批准|审批)/u.test(text)) return;
  // Completion may describe the approved scope rather than repeat "修复/修改".
  // Require an affirmative statement boundary; plans, conditions and quotations
  // must not become completion evidence merely because they contain these words.
  const scopeComplete = /(?:^|[。\n；;])\s*(?:[-*]\s+)?(?:已(?:(?:按照?|依照)(?:已)?批准的?(?:实施)?方案)?完成|(?:按照?|依照)(?:已)?批准的?(?:实施)?方案已完成)(?=并(?:已)?(?:本地)?提交|[，,。；;：:\s]|$)/u.test(text);
  const complete = /已(?:完成[^。\n]{0,30}(?:修复|修改|开发|实现)|修复|补修|实现)|(?:修复|补修|实现|开发|修改)(?:已)?完成|(?:implemented|fixed|completed)\b/iu.test(text);
  const notDelivered = /(?:尚未|还未|未)(?:推送|\s*push|\s*(?:创建|建|开)\s*PR)|\b(?:not yet pushed|not pushed|not yet opened a PR)\b/iu.test(text);
  const commit = /(?:本地提交|提交|commit(?:ted)?)\s*[:：]?\s*`?([a-f0-9]{7,40})\b/iu.exec(text)?.[1];
  if (!(complete || scopeComplete) || !notDelivered || !commit) return;
  return commit;
}

function unchangedReview(value: string): boolean {
  const text = plainText(value);
  return /(?:复审|审计(?:检查)?)(?:已)?(?:完成|通过)/u.test(text)
    && /(?:未发现|没有发现)(?:新的?|新增的?)?(?:需补修)?问题/u.test(text)
    && /本(?:轮|次)未(?:修改|改动|改)代码/u.test(text)
    && /(?:尚未|未)推送/u.test(text)
    && !/(?:仍需|需要|建议|须|待)[^。\n]{0,12}(?:补修|修复)|(?:检查|测试|验证)(?:失败|未通过)|已(?:修改|改动|补修|修复)|(?:提交|commit)\s*[:：]?\s*`?[a-f0-9]{7,40}\b/iu.test(text);
}

function reviewOnlyRequest(value: string): boolean {
  return /^(?:请)?(?:再)?(?:做|进行)?(?:一次)?(?:审计检查|审计|复审|复查)(?:一次|一下)?[。！!]?$/u.test(value.trim());
}
