import { expect, it, vi } from "vitest";
import { codexHistory } from "./codex-history.js";
import { readHostHistory } from "./host.js";
import type { Adapter } from "./types.js";
import type { Wire } from "./types.js";

it("reads commentary and plans omitted by a turn summary, including tool-only pages", async () => {
  const calls: Wire[] = [];
  const result = await codexHistory(async (method, params) => {
    calls.push({ method, ...params });
    if (!params.cursor) return { data: [{ turnId: "turn", item: { type: "commandExecution", id: "tool" } }], nextCursor: "body" };
    return { data: [
      { turnId: "turn", item: { type: "plan", id: "plan", text: "Reviewed plan" } },
      ...Array.from({ length: 6 }, (_, index) => ({ turnId: "turn", item: { type: "agentMessage", id: `text-${index}`, phase: "commentary", text: `Progress ${index}` } })),
      { turnId: "turn", item: { type: "userMessage", id: "user", content: [{ type: "text", text: "Start" }] } },
    ], nextCursor: null };
  }, "exact-thread");
  expect(result.messages.map(message => message.role)).toEqual(["user", ...Array(6).fill("agent"), "plan"]);
  expect(result.messages.at(-1)?.sourceId).toBe("turn:plan");
  expect(result.nextCursor).toBeUndefined();
  expect(calls.map(call => call.method)).toEqual(["thread/items/list", "thread/items/list"]);
});

it("bounds one long turn and resumes its item cursor without relying on turn count", async () => {
  const read = async (_method: string, params: Wire) => {
    const offset = Number(params.cursor ?? 0);
    return { data: Array.from({ length: 50 }, (_, n) => ({ turnId: "one-turn",
      item: { type: "agentMessage", id: `id-${n + offset}`, text: `Message ${n + offset}` } })), nextCursor: String(offset + 50) };
  };
  const recent = await codexHistory(read, "thread");
  expect(recent.messages).toHaveLength(50);
  expect(recent.nextCursor).toBe("items-v1:50");
  const older = await codexHistory(read, "thread", recent.nextCursor);
  expect(older.messages.at(-1)?.text).toBe("Message 50");
  expect(older.nextCursor).toBe("items-v1:100");
});

it("restarts a legacy summary cursor on the same thread so old omissions can be repaired", async () => {
  let input: Wire | undefined;
  await codexHistory(async (_method, params) => { input = params; return { data: [] }; }, "same-thread", "legacy-turn-cursor");
  expect(input).toEqual({ threadId: "same-thread", limit: 50, sortDirection: "desc" });
});

it("retains an already read page when an older source page fails", async () => {
  const result = await codexHistory(async (_method, params) => {
    if (params.cursor) throw new Error("Offline");
    return { data: [{ turnId: "turn", item: { id: "last", type: "agentMessage", text: "Latest" } }], nextCursor: "retry" };
  }, "thread");
  expect(result).toMatchObject({ messages: [{ text: "Latest" }], nextCursor: "items-v1:retry", error: "unavailable" });
});

it("rejects a cursor cycle instead of caching a non-advancing page", async () => {
  await expect(codexHistory(async () => ({ data: [], nextCursor: "same" }), "thread", "items-v1:same")).rejects.toThrow(/cursor/);
});

it("serves only the bound history source and never invokes native input methods", async () => {
  const historyPage = vi.fn(async () => ({ messages: [{ sourceId: "old", role: "plan" as const, text: "Plan" }] }));
  const adapter = { historyPage, deliver: vi.fn(), start: vi.fn(), stop: vi.fn(), decide: vi.fn() } as unknown as Adapter;
  await expect(readHostHistory(adapter, "exact-thread", { sessionRef: "other", cursor: "items-v1:old" })).rejects.toThrow();
  expect(historyPage).not.toHaveBeenCalled();
  await expect(readHostHistory(adapter, "exact-thread", { sessionRef: "exact-thread", cursor: "items-v1:old" })).resolves.toMatchObject({ messages: [{ text: "Plan" }] });
  for (const method of [adapter.start, adapter.deliver, adapter.stop, adapter.decide]) expect(method).not.toHaveBeenCalled();
});

it("reports an oversized source message instead of sending a page the server will reject", async () => {
  const adapter = { historyPage: async () => ({ messages: [{ sourceId: "large", role: "plan", text: "x".repeat(4_000_001) }] }) } as unknown as Adapter;
  await expect(readHostHistory(adapter, "thread", { sessionRef: "thread", cursor: "items-v1:old" })).resolves.toEqual({ messages: [], error: "too_large" });
});


it("keeps item occurrence time and never substitutes a newer thread metadata clock", async () => {
  const result=await codexHistory(async()=>({data:[{turnId:"turn",startedAtMs:1794022791894,
    item:{id:"answer",type:"agentMessage",text:"Yesterday"}}],nextCursor:null}),"thread");
  expect(result.messages[0]?.occurredAt).toBe("2026-11-07T03:39:51.894Z");
});
