import { describe, expect, it } from "vitest";
import { mergeMessages } from "./agent-history";
import type { AgentSessionMessage } from "./types";
const message=(id:string,text=id):AgentSessionMessage=>({id,sourceId:id,role:"user",text,occurredAt:""});
const ids=(messages:readonly AgentSessionMessage[])=>messages.map(message=>message.sourceId);
describe("ordered history merge",()=>{
  it("inserts a late native mirror before the replies it originally preceded",()=>{
    const existing=[message("before"),message("reply"),message("after")];
    const incoming=[message("before"),message("input"),message("reply","Updated reply"),message("after")];
    expect(ids(mergeMessages(existing,incoming))).toEqual(["before","input","reply","after"]);
    expect(mergeMessages(existing,incoming)[2]?.text).toBe("Updated reply");
  });
  it("retains the cached prefix when a bounded recent window advances",()=>{
    expect(ids(mergeMessages([message("a"),message("b"),message("c")],[message("b"),message("c"),message("d")]))).toEqual(["a","b","c","d"]);
  });
  it("prepends older overlapping pages exactly once without timestamp sorting",()=>{
    expect(ids(mergeMessages([message("a"),message("b"),message("c")],[message("c"),message("d")]))).toEqual(["a","b","c","d"]);
    expect(ids(mergeMessages([message("a"),message("b")],[message("b"),message("a")]))).toEqual(["b","a"]);
  });
});


it("weaves partial overlap without moving cached-only records past their next source anchor",()=>{
  expect(ids(mergeMessages([message("a"),message("b"),message("c"),message("d")],[message("b"),message("x"),message("d")]))).toEqual(["a","b","x","c","d"]);
});
it("keeps late items in the older page before already cached replies",()=>{
  const page=[message("a"),message("b"),message("c")];
  const cached=[message("a"),message("c"),message("d")];
  expect(ids(mergeMessages(page,cached))).toEqual(["a","b","c","d"]);
});
