import {describe,it,expect} from "vitest";
import {deriveMergeProgress} from "./merge-progress";
const delivery={id:"d",productId:"p",sessionId:"s",itemKeys:["P-1","P-2"],state:"confirmed"};
describe("merge list labels",()=>{
  it.each(["proposed","withdrawn","merged"])("does not label %s",state=>{
    expect(deriveMergeProgress("p",[{...delivery,state}],[]).items.size).toBe(0);
  });
  it("requires valid confirmation and isolates projects",()=>{
    expect(deriveMergeProgress("p",[{...delivery,blocker:"changed"}],[]).sessions.size).toBe(0);
    expect(deriveMergeProgress("other",[delivery],[]).items.size).toBe(0);
    for(const blocker of [undefined,"stale","pending","failed","dependency"]){
      const result=deriveMergeProgress("p",[{...delivery,blocker}],[]);
      expect([...result.items.values()]).toEqual(["pending","pending"]);expect(result.sessions.get("s")).toBe("pending");
    }
  });
  it("shows active merging and removes completed entries independently",()=>{
    const d={...delivery,state:"batched"};
    const batch={state:"active",deliveries:["d"],results:{}};
    expect(deriveMergeProgress("p",[d],[batch]).items.get("P-1")).toBe("merging");
    expect(deriveMergeProgress("p",[d],[{...batch,state:"finished"}]).items.size).toBe(0);
    expect(deriveMergeProgress("p",[d],[{...batch,results:{d:{status:"merged"}}}]).items.size).toBe(0);
    expect(deriveMergeProgress("p",[d,delivery],[batch]).sessions.get("s")).toBe("merging");
  });
  it("keeps the batch's item keys for the integration session that ran it",()=>{
    const second={id:"d2",productId:"p",sessionId:"s",itemKeys:["P-2","P-3"],state:"merged"};
    const batch={state:"finished",deliveries:["d","d2"],results:{}};
    expect(deriveMergeProgress("p",[delivery,second],[batch]).sessionItems.get("s")).toEqual(["P-1","P-2","P-3"]);
    expect(deriveMergeProgress("other",[delivery,second],[batch]).sessionItems.size).toBe(0);
    expect(deriveMergeProgress("p",[delivery],[]).sessionItems.size).toBe(0);
  });
});
