import { compactItemKeys } from "@missiongo/domain";

import type { AgentSessionSummary } from "./types";

export { compactItemKeys };

/**
 * The session list row and conversation heading: compact keys, then the first item's title.
 *
 * A session dispatched after the item was sent back carries the attempt number
 * (AND-365) so it is told apart from the first go, matching the name the machine
 * gives its own session. The first round stays unlabelled, and a caller that
 * has no wording for the number (or a session MissionGo did not dispatch) just
 * gets the old title.
 *
 * A project conversation (AND-395) keeps its own name only while it links no
 * work items. Once it claims items during the run it is named the same way a
 * dispatch is (AND-445): the keys it works on, then the first item's title, so
 * the row says what the conversation is about instead of the first message it
 * happened to start with.
 */
export function sessionTitle(
  session: Pick<AgentSessionSummary, "items" | "sessionName" | "id" | "round" | "productId">,
  roundLabel?: (round: number) => string,
): string {
  const keys = compactItemKeys(session.items.map((item) => item.key));
  const firstTitle = session.items[0]?.title;
  if (session.productId) return firstTitle ? `${keys} · ${firstTitle}` : session.sessionName ?? session.id;
  const title = firstTitle ? `${keys} · ${firstTitle}` : session.sessionName ?? session.id;
  return roundLabel && session.round && session.round > 1 ? `${title} ${roundLabel(session.round)}` : title;
}
