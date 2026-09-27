import { expect, it } from "vitest";
import * as decision from "./managed-decision.js";

it("validates an explicit, bounded approval contract rather than inferred authority", () => {
  const content = { title: "Implement the approved task", recommendation: "Local isolated implementation",
    alternatives: ["Defer: feature remains unavailable"], costs: "Local tests; no deployment",
    acceptanceCriteria: ["Permission tests pass"], allowedActions: ["implement", "review", "verify"] };
  expect(decision.isManagedDecisionContent(content)).toBe(true);
  for (const invalid of [null, {}, { ...content, actorKind: "human" }, { ...content, allowedActions: [] },
    { ...content, allowedActions: ["merge"] }, { ...content, allowedActions: ["implement", "implement"] },
    { ...content, acceptanceCriteria: [] }, { ...content, costs: " " }]) {
    expect(decision.isManagedDecisionContent(invalid)).toBe(false);
  }
});
