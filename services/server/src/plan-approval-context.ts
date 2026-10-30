import type { AgentSessionSnapshot } from "./agent-session-store.js";

type Message = AgentSessionSnapshot["messages"][number];

function hasPlanSection(message: Message): boolean {
  // A context anchor, never evidence that the person should approve anything.
  return message.role === "plan" || /(?:^|\n)\s*(?:#{1,6}\s*)?(?:\*\*)?(?:方案|计划|实施计划|处理计划|plan|implementation plan)(?:\*\*)?\s*[:：]/imu.test(message.text);
}

/** Keep whole conversational exchanges around the latest plan, rather than the last N events. */
export function planApprovalContext(messages: readonly Message[]): string {
  const conversation = messages.filter((message) => message.text.trim()
    && (message.role === "user" || message.role === "plan" || !message.phase || message.phase === "final")
    && !(message.questions?.length && message.questions.every((question) => question.withdrawn)));
  const latestIndex = conversation.length - 1;
  let start = latestIndex;
  // The latest user exchange carries revisions and constraints for the current plan.
  for (let i = latestIndex - 1; i >= 0; i--) {
    if (conversation[i]!.role === "user") { start = i; break; }
  }
  while (start > 0 && conversation[start - 1]!.role === "user") start--;
  // Retain the preceding plan anchor, or a chain of clarification questions and
  // their answers. A completed old execution report does not anchor a new ask.
  while (start > 0) {
    const previous = conversation[start - 1]!;
    if (previous.questions?.length) {
      start--;
      while (start > 0 && conversation[start - 1]!.role === "user") start--;
    } else if (hasPlanSection(previous)) {
      start--;
      break;
    } else break;
  }
  const selected = conversation.slice(Math.max(0, start)).map(({ sourceId, role, text, questions }) => ({ sourceId, role, text, questions }));
  // No text clipping: a clipped question could turn an unsafe answer into a false approval.
  return JSON.stringify({ scope: "current_plan_and_followup", earlierHistoryOmitted: start > 0, messages: selected });
}
