import { expect, it } from "vitest";
import { changedSessionIdentities } from "./session-identities";
it("invalidates both sides of merges and splits, including standalone delivery identities",()=>{
 const split={sessions:[{id:"a",agentSessionId:"a"},{id:"b",agentSessionId:"b"}]};
 const merged={sessions:[{id:"a",agentSessionId:"a",relatedSessionIds:["a","b"]}]};
 expect([...changedSessionIdentities(split,merged)].sort()).toEqual(["a","b"]);
 expect([...changedSessionIdentities(merged,split)].sort()).toEqual(["a","b"]);
 expect([...changedSessionIdentities(merged,{sessions:[]})].sort()).toEqual(["a","b"]);
});
it("ignores ordering and normal activity but catches a canonical channel change",()=>{
 const before={sessions:[{id:"a",agentSessionId:"a",relatedSessionIds:["b","a"]}]};
 expect(changedSessionIdentities(before,{sessions:[{id:"a",agentSessionId:"a",relatedSessionIds:["a","b"]}]}).size).toBe(0);
 expect([...changedSessionIdentities(before,{sessions:[{id:"b",agentSessionId:"b",relatedSessionIds:["a","b"]}]})].sort()).toEqual(["a","b"]);
});
