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

it("invalidates a dispatch route when startup replaces its temporary list ID",()=>{
 const before={sessions:[{id:"dispatch:launch",dispatchId:"launch"}]};
 const after={sessions:[{id:"registered",agentSessionId:"registered",dispatchId:"launch"}]};
 expect([...changedSessionIdentities(before,after)].sort()).toEqual(["dispatch:launch","registered"]);
 expect([...changedSessionIdentities(after,{sessions:[]})].sort()).toEqual(["dispatch:launch","registered"]);
 expect(changedSessionIdentities(after,after).size).toBe(0);
});
it("detects a changed explicit dispatch association even with an unchanged canonical ID",()=>{
 expect([...changedSessionIdentities({sessions:[{id:"a",dispatchId:"old"}]},
   {sessions:[{id:"a",dispatchId:"new"}]} )].sort()).toEqual(["a","dispatch:new","dispatch:old"]);
});
