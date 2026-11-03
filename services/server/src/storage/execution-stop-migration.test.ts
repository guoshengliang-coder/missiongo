import { mkdtempSync,rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { expect,it } from "vitest";
import { MissionGoStore } from "../store.js";
import { seedStoreActors } from "../testing-fixtures.js";
import { ExternalAgentSessionStore } from "../external-agent-session-store.js";
import { DispatchStore } from "../dispatch-store.js";
import { confirmItemExecutionStopped,itemExecutionBlockers } from "../item-execution-blockers.js";
import { beforeExecutionStops } from "../test-fixtures/before-execution-stops.js";

it("upgrades completed/unavailable history without inventing a stop, and persists exact confirmations and activity invalidation across restarts",()=>{
  const directory=mkdtempSync(join(tmpdir(),"missiongo-execution-stops-"));
  const path=join(directory,"fixture.sqlite");let store=new MissionGoStore(path);
  try {
    seedStoreActors(store,["owner"]);
    const product=store.createProduct({name:"Historical execution",keyPrefix:"OLD",createdByAccountId:"owner"});
    const item=store.createWorkItem({productId:product.id,title:"Old handling",description:"Scope",type:"task",priority:"normal",status:"ready",environment:{platform:"shared"}});
    store.claimWorkItem({itemKey:item.key,agentId:"Codex",idempotencyKey:randomUUID(),attribution:{accountId:"owner"}});
    const external=new ExternalAgentSessionStore(store),owner={accountId:"owner"};
    const id=external.register(owner,{agentKind:"codex",refKind:"native",sessionRef:randomUUID()},item.key);
    external.report(owner,id,item.key,"completed","Handling finished",randomUUID());
    store.transitionWorkItem({itemKey:item.key,to:"pending_verification",reason:"manual_override",actor:"human",note:"Fixture delivery",attribution:owner});
    const dispatches=new DispatchStore(store.database),node=dispatches.registerNode({accountId:"owner",installationId:randomUUID(),name:"Fixture node"});
    const setSnapshot=(status:string)=>store.database.connection.prepare("UPDATE external_agent_sessions SET native_node_id=?,native_snapshot_json=?,native_synced_at=? WHERE id=?")
      .run(node.nodeId,JSON.stringify({status,turnState:{}}),new Date().toISOString(),id);
    setSnapshot("unavailable");
    store.transitionWorkItem({itemKey:item.key,to:"ready",reason:"verification_failed",actor:"human",note:"Rework",attribution:owner});
    const history=store.getTimeline(item.key);
    beforeExecutionStops(store.database.connection);store.close();
    store=new MissionGoStore(path);
    expect(store.getTimeline(item.key)).toEqual(history);
    expect(store.database.connection.prepare("SELECT count(*) AS count FROM item_execution_stop_confirmations").get()).toEqual({count:0});
    const blocker=itemExecutionBlockers(store.database,item.id)[0]!;
    expect(blocker).toMatchObject({progressStatus:"completed",status:"unavailable",canConfirmStopped:true});
    store.database.transaction(()=>confirmItemExecutionStopped(store.database,item.id,blocker,"owner","Checked the stopped process on its device",new Date().toISOString()));
    store.close();store=new MissionGoStore(path);
    expect(itemExecutionBlockers(store.database,item.id)).toEqual([]);
    setSnapshot("active");setSnapshot("unavailable");
    store.close();store=new MissionGoStore(path);
    expect(itemExecutionBlockers(store.database,item.id)).toHaveLength(1);
    expect(store.database.connection.prepare("SELECT count(*) AS count FROM schema_migrations WHERE version=202611031536").get()).toEqual({count:1});
    expect(store.database.connection.prepare("SELECT invalidated_at FROM item_execution_stop_confirmations").get()).toMatchObject({invalidated_at:expect.any(String)});
  } finally {store.close();rmSync(directory,{recursive:true,force:true});}
});
