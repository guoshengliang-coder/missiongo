import { expect, it } from "vitest";
import { isConversationMessage } from "./agent-transcript.js";
it("uses explicit metadata rather than guessing from message contents", () => {
  expect(isConversationMessage({ phase: "execution" })).toBe(false);
  for (const phase of [undefined, null, "commentary", "final", "plan_approved"]) expect(isConversationMessage({ phase })).toBe(true);
});
