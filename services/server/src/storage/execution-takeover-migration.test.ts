import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { MissionGoStore } from "../store.js";
import { seedStoreActors } from "../testing-fixtures.js";
import { ExternalAgentSessionStore } from "../external-agent-session-store.js";
import { assertItemExecutionIdentity } from "../item-execution-blockers.js";

it("upgrades without inventing takeovers and preserves parallel history across restarts",()=>{
  const directory=mkdtempSync(join(tmpdir(),"missiongo-takeover-")),path=join(directory,"fixture.sqlite");
  let store=new MissionGoStore(path);
  try {
    seedStoreActors(store,["owner"]);
    const owner={accountId:"owner",clientId:"migration"};
    const product=store.createProduct({name:"Takeover",keyPrefix:"TAKE",createdByAccountId:owner.accountId});
    const item=store.createWorkItem({productId:product.id,title:"Interrupted",description:"Scope",type:"task",priority:"normal",status:"ready",environment:{platform:"shared"}});
    store.transitionWorkItem({itemKey:item.key,to:"in_progress",reason:"claim",actor:"human",attribution:owner});
    const identity={agentKind:"codex" as const,refKind:"native" as const,sessionRef:randomUUID()};
    const source=new ExternalAgentSessionStore(store).register(owner,identity,item.key);
    store.transitionWorkItem({itemKey:item.key,to:"ready",reason:"released",actor:"human",note:"Interrupted",attribution:owner});
    const history=store.getTimeline(item.key);
    store.database.connection.exec("DROP TABLE item_execution_takeovers; DELETE FROM schema_migrations WHERE version=202611060020");
    store.close();store=new MissionGoStore(path);
    expect(store.getTimeline(item.key)).toEqual(history);
    expect(store.database.connection.prepare("SELECT COUNT(*) AS n FROM item_execution_takeovers").get()).toMatchObject({n:0});
    store.claimWorkItem({itemKey:item.key,agentId:"new",idempotencyKey:randomUUID(),attribution:owner});
    const rows=store.database.connection.prepare("SELECT * FROM item_execution_takeovers ORDER BY source").all();
    expect(rows).toHaveLength(0);
    store.close();store=new MissionGoStore(path);
    expect(store.database.connection.prepare("SELECT * FROM item_execution_takeovers ORDER BY source").all()).toEqual(rows);
    expect(()=>assertItemExecutionIdentity(store.database,item.id,`native:migration:codex:native:${identity.sessionRef}`)).not.toThrow();
    expect(store.database.connection.prepare("SELECT progress_status FROM external_agent_sessions WHERE id=?").get(source)).toMatchObject({progress_status:"working"});
    expect(store.database.connection.prepare("SELECT COUNT(*) AS n FROM item_execution_stop_confirmations").get()).toMatchObject({n:0});
  } finally {store.close();rmSync(directory,{recursive:true,force:true});}
});
