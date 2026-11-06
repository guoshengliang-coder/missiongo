import { expect, it } from "vitest";
import { hasPendingPermissionQuestion, permissionQuestionKey } from "./agent-permission-question.js";
const keyed = { key: "授权请求 req-1", options: ["批准", "拒绝"] };
it("uses the existing request identity and supports released keyless macOS Claude cards", () => {
  expect(permissionQuestionKey("opencode", "permission-req-1", keyed)).toBe(keyed.key);
  expect(permissionQuestionKey("claude_code", "permission-req-1", { header: "授权请求", options: keyed.options })).toBe(keyed.key);
  expect(permissionQuestionKey("claude_code", "message-1", { header: "授权请求", options: keyed.options })).toBeUndefined();
  expect(permissionQuestionKey("codex", "permission-req-1", keyed)).toBeUndefined();
  expect(permissionQuestionKey("opencode", "form-1", { ...keyed, multiSelect: true })).toBeUndefined();
  expect(permissionQuestionKey("claude_code", "permission-req-1", { title: "授权请求", options: keyed.options } as typeof keyed)).toBeUndefined();
  expect(permissionQuestionKey("opencode", "permission-req-1", { ...keyed, key: "授权请求 req-1\nnext: yes" })).toBeUndefined();
});
it("settled or withdrawn permissions do not revive when history loads", () => {
  const messages = [{ sourceId: "permission-req-1", questions: [keyed] }];
  expect(hasPendingPermissionQuestion("claude_code", messages)).toBe(true);
  for (const settled of [{ answered: "批准" }, { withdrawn: true }]) {
    expect(hasPendingPermissionQuestion("claude_code", [{ ...messages[0], questions: [{ ...keyed, ...settled }] }])).toBe(false);
  }
  expect(hasPendingPermissionQuestion("claude_code", [{ questions: [{ options: ["A", "B"], key: "choice" }] }])).toBe(false);
});
