import { expect, it } from "vitest";
import { codexMessages } from "./codex.js";
import { codexHistory } from "./codex-history.js";

it("preserves native and client identities separately, including paginated history", async () => {
  const item = { id: "native-user", type: "userMessage", clientId: "command", content: [{ type: "text", text: "Continue" }] };
  const expected = { sourceId: "turn:native-user", clientMessageId: "command", turnId: "turn", role: "user", text: "Continue" };
  expect(codexMessages({ turns: [{ id: "turn", items: [item] }] })).toEqual([expected]);
  const history = await codexHistory(async () => ({ data: [{ turnId: "turn", item }], nextCursor: null }), "thread");
  expect(history.messages).toEqual([expected]);
  for (const clientId of [null, 42, "", " ", "x".repeat(201)]) {
    expect(codexMessages({ turns: [{ id: "turn", items: [{ ...item, clientId }] }] })[0]).not.toHaveProperty("clientMessageId");
  }
});
