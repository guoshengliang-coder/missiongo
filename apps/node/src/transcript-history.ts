import { createHash } from "node:crypto";
import type { Message } from "./types.js";

/** Read only a host's own bound transcript. Source IDs keep anchors stable as new text arrives. */
export function transcriptHistory(messages: readonly Message[], cursor?: string) {
  const digest=(end:number)=>createHash("sha256").update(JSON.stringify(messages.slice(0,end))).digest("hex");
  let end = messages.length;
  if (cursor) {
    if (!cursor.startsWith("transcript:")) throw new Error("Invalid transcript cursor");
    const parts=cursor.slice(11).split(":");
    end = messages.findIndex(m => m.sourceId === decodeURIComponent(parts[0]!));
    if (parts.length!==2 || end < 0 || parts[1]!==digest(end)) throw new Error("Transcript anchor unavailable");
  }
  let start = end; let bytes = 0;
  while (start > 0 && end - start < 50) {
    const size = Buffer.byteLength(JSON.stringify(messages[start - 1]));
    if (start < end && bytes + size > 512 * 1024) break;
    start--; bytes += size;
  }
  return { messages: messages.slice(start,end), ...(start > 0 ? {nextCursor:`transcript:${encodeURIComponent(messages[start]!.sourceId)}:${digest(start)}`} : {}) };
}
