import type { AgentSessionMessage } from "./types";
import { historyMessageKey } from "./agent-history-catchup";

/** The visible history is not authority for a still-open source form. New
 * servers provide that separately, including requests outside the current page.
 * A cached old page must never revive a question the source already withdrew. */
export function withCurrentRequests(messages: readonly AgentSessionMessage[], requests: readonly AgentSessionMessage[] | undefined): readonly AgentSessionMessage[] {
  if (requests === undefined) return messages; // Older server contract.
  const current = new Map(requests.map(message=>[historyMessageKey(message),message]));
  const seen = new Set(messages.map(historyMessageKey));
  return [...requests.filter(message=>!seen.has(historyMessageKey(message))), ...messages.map(message=> {
    const active=current.get(historyMessageKey(message));
    if (active) return active;
    if (!message.questions?.some(question=>question.answered===undefined && !question.withdrawn)) return message;
    return {...message,historical:true};
  })];
}
