import { expect, it } from "vitest";
import { transcriptHistory } from "./transcript-history.js";

it("keeps host transcript anchors stable while messages append, without truncating text", () => {
  const messages=Array.from({length:121},(_,i)=>({sourceId:`id-${i}`,role:"agent" as const,text:`方案 ${i} 🧑‍💻`}));
  const recent=transcriptHistory(messages);
  messages.push({sourceId:"new",role:"agent",text:"New"});
  const older=transcriptHistory(messages,recent.nextCursor);
  const oldest=transcriptHistory(messages,older.nextCursor);
  expect([...oldest.messages,...older.messages,...recent.messages]).toEqual(messages.slice(0,-1));
  expect(oldest.nextCursor).toBeUndefined();
  messages[0]!.text="Changed earlier body";
  expect(()=>transcriptHistory(messages,recent.nextCursor)).toThrow(/anchor/);
  expect(()=>transcriptHistory(messages,"transcript:foreign")).toThrow();
  expect(()=>transcriptHistory(messages,"arbitrary")).toThrow();
});
