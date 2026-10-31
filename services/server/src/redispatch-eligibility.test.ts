import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { MissionGoStore } from "./store.js";
import { DispatchStore } from "./dispatch-store.js";
import { AgentSessionStore } from "./agent-session-store.js";

let store: MissionGoStore;
beforeEach(()=>{vi.useFakeTimers({toFake:["Date"]});vi.setSystemTime("2026-10-31T01:00:00Z");store=new MissionGoStore(":memory:");});
afterEach(()=>{store.close();vi.useRealTimers();});
function fixture() {
  const product=store.createProduct({name:"Example",keyPrefix:"EX"});
  const dispatches=new DispatchStore(store.database);
  function node(accountId="owner") {
    const node=dispatches.registerNode({accountId,name:`${accountId} Mac`,installationId:randomUUID()});
    dispatches.recordHeartbeat(node.nodeId,[{kind:"codex",version:"test",ready:true}]);
    dispatches.replaceRepos(accountId,node.nodeId,[{productId:product.id,repoPath:"/example/repository"}]);
    return node;
  }
  const original=node();
  const items=[1,2].map(i=>store.createWorkItem({productId:product.id,title:`Task ${i}`,description:"Dispatch",type:"task",priority:"normal",status:"ready",environment:{platform:"web"}}));
  function send(keys=items.map(i=>i.key),accountId="owner",target=original.nodeId,force=false) {
    return dispatches.createDispatch({accountId,nodeId:target,agentKind:"codex",mode:"default",itemKeys:keys,force});
  }
  return {items,dispatches,original,node,send};
}

it("only offers confirmation when the full owned queued batch can actually be replaced",()=>{
  const f=fixture();const keys=f.items.map(i=>i.key);
  expect(f.dispatches.checkRedispatch("owner",keys)).toMatchObject({allowed:true,requiresConfirmation:false,conflicts:[]});
  const previous=f.send();
  expect(f.dispatches.checkRedispatch("owner",keys)).toMatchObject({allowed:true,requiresConfirmation:true,reason:null});
  expect(f.dispatches.checkRedispatch("owner",[keys[0]!])).toMatchObject({allowed:false,reason:"partial_batch",requiresConfirmation:false});
  expect(()=>f.send([keys[0]!],"owner",f.original.nodeId,true)).toThrow(/Existing execution/);
  const replacement=f.send(keys,"owner",f.original.nodeId,true);
  expect(replacement.id).not.toBe(previous.id);
  expect(f.dispatches.getDispatch("owner",previous.id).status).toBe("cancelled");
});

it("never offers a force checkbox after delivery or launch, matching the write guard",()=>{
  const f=fixture(); const keys=[f.items[0]!.key]; const dispatched=f.send(keys);
  f.dispatches.claimNextDispatch(f.original.nodeId);
  expect(f.dispatches.checkRedispatch("owner",keys)).toMatchObject({allowed:false,requiresConfirmation:false,reason:"started"});
  expect(()=>f.send(keys,"owner",f.original.nodeId,true)).toThrow(/Existing execution/);
  f.dispatches.recordDispatchResult({nodeId:f.original.nodeId,dispatchId:dispatched.id,status:"launched",sessionRef:"native-thread"});
  expect(f.dispatches.checkRedispatch("owner",keys)).toMatchObject({allowed:false,reason:"started"});
});

it("does not expose another account's private conversation ID or permit a replacement",()=>{
  const f=fixture();const keys=[f.items[0]!.key];const other=f.node("other"); f.send(keys,"other",other.nodeId);
  const policy=f.dispatches.checkRedispatch("owner",keys);
  expect(policy).toMatchObject({allowed:false,reason:"other_account"});
  expect(policy.conflicts[0]).not.toHaveProperty("agentSessionId");
  expect(policy.conflicts[0]).not.toHaveProperty("accountId");
  expect(()=>f.send(keys,"owner",f.original.nodeId,true)).toThrow(/Existing execution/);
});

it("projects a waiting, unclaimed conversation separately from an item's ready status",()=>{
  const f=fixture();const item=f.items[0]!;const dispatched=f.send([item.key]);
  f.dispatches.claimNextDispatch(f.original.nodeId);
  f.dispatches.recordDispatchResult({nodeId:f.original.nodeId,dispatchId:dispatched.id,status:"launched",sessionRef:"native-thread"});
  const sessions=new AgentSessionStore(store.database);
  const id=sessions.createForDispatch({dispatchId:dispatched.id,nodeId:f.original.nodeId,sessionRef:"native-thread"});
  store.database.connection.prepare("UPDATE agent_sessions SET status='active',turn_state_json=? WHERE id=?")
    .run(JSON.stringify({turnActive:false,waitingForInput:true}),id);
  expect(f.dispatches.listActiveDispatches("owner")).toMatchObject([{itemKey:item.key,itemStatus:"ready",waitingForInput:true,sessionStatus:"active",claimed:false}]);
  expect(store.getWorkItem(item.key).status).toBe("ready");
  store.claimWorkItem({itemKey:item.key,agentId:"Codex",idempotencyKey:"claim",dispatchId:dispatched.id,attribution:{accountId:"owner"}});
  store.transitionWorkItem({itemKey:item.key,to:"ready",actor:"human",reason:"released",note:"Adjust planning"});
  expect(f.dispatches.listActiveDispatches("owner")).toMatchObject([{itemKey:item.key,claimed:true}]);
});
