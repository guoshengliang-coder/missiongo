import type { Message, Wire } from "./types.js";
import { codexMessages } from "./codex.js";

export interface HistoryResult { messages: Message[]; nextCursor?: string; error?: string }
const prefix = "items-v1:";
class InvalidHistoryPage extends Error {}

/** Item pagination preserves commentary/plans that turn summaries omit. No native input. */
export async function codexHistory(call: (method: string, params: Wire) => Promise<Wire>, threadId: string,
  sourceCursor?: string): Promise<HistoryResult> {
  let cursor = sourceCursor?.startsWith(prefix) ? sourceCursor.slice(prefix.length) : undefined;
  const seen = new Set(cursor ? [cursor] : []);
  const messages: Message[] = [];
  let bytes = 0;
  const started = Date.now();
  for (let page = 0; page < 8; page++) {
    const previous = cursor;
    let result: Wire;
    try {
      result = await call("thread/items/list", { threadId, limit: 50, sortDirection: "desc", ...(cursor ? { cursor } : {}) });
      if (!Array.isArray(result.data) || result.data.length > 50) throw new InvalidHistoryPage("Invalid Codex item page");
      const next = result.nextCursor;
      if (next != null && (typeof next !== "string" || !next || next.length + prefix.length > 4096 || seen.has(next))) throw new InvalidHistoryPage("Invalid Codex history cursor");
      if (next) seen.add(next);
      for (const entry of result.data) {
        if (typeof entry.turnId !== "string" || !entry.item || typeof entry.item.id !== "string") throw new InvalidHistoryPage("Invalid Codex history item");
        messages.push(...codexMessages({ turns: [{ id: entry.turnId, items: [{ ...entry.item, createdAt: entry.item.createdAt ?? entry.startedAtMs ?? entry.completedAtMs }] }] }));
      }
      bytes += Buffer.byteLength(JSON.stringify(result));
      cursor = next ?? undefined;
    } catch (error) {
      if (error instanceof InvalidHistoryPage) throw error;
      if (!previous) throw error;
      return { messages: messages.reverse(), nextCursor: prefix + previous, error: "unavailable" };
    }
    if (!cursor || messages.length >= 50 || bytes >= 4 * 1024 * 1024 || Date.now() - started >= 8000) break;
  }
  return { messages: messages.reverse(), ...(cursor ? { nextCursor: prefix + cursor } : {}) };
}
