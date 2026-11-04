import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { MissionGoStore } from "../store.js";
import { seedStoreActors } from "../testing-fixtures.js";
import { ExternalAgentSessionStore } from "../external-agent-session-store.js";
import { confirmItemExecutionStopped, itemExecutionBlockers } from "../item-execution-blockers.js";
import { EXECUTION_STOP_SCHEMA } from "./execution-stop-schema.js";

it("upgrades interrupted working history, preserves existing checks and persists new per-execution checks across restart",()=>{
  const directory=mkdtempSync(join(tmpdir(),"missiongo-interrupted-stops-")),path=join(directory,"fixture.sqlite");
  let store=new MissionGoStore(path);
  try {
    seedStoreActors(store,["owner"]);
    const owner={accountId:"owner"};
    const product=store.createProduct({name:"Interrupted execution",keyPrefix:"INT",createdByAccountId:owner.accountId});
    const item=store.createWorkItem({productId:product.id,title:"Interrupted working",description:"Scope",type:"bug",priority:"normal",status:"ready",environment:{platform:"shared"}});
    store.transitionWorkItem({itemKey:item.key,to:"in_progress",reason:"claim",actor:"human",attribution:owner});
    const source=new ExternalAgentSessionStore(store).register(owner,{agentKind:"codex",refKind:"native",sessionRef:randomUUID()},item.key);
    const unavailable=()=>store.database.connection.prepare("UPDATE external_agent_sessions SET native_snapshot_json=?,native_synced_at=? WHERE id=?")
      .run(JSON.stringify({status:"unavailable",turnState:{}}),new Date().toISOString(),source);
    unavailable();
    store.transitionWorkItem({itemKey:item.key,to:"ready",reason:"released",actor:"human",note:"Recover stopped execution",attribution:owner});
    const history=store.getTimeline(item.key);
    // Reconstruct the last released schema, including an existing audit row that must not be rewritten.
    store.database.connection.exec(`DROP TRIGGER invalidate_external_stop_on_progress;
      DROP TRIGGER invalidate_external_stop_on_activity;
      DROP TRIGGER invalidate_performer_stop_on_activity;
      DROP TRIGGER invalidate_linked_performer_stop_on_insert;
      DROP TRIGGER invalidate_linked_performer_stop_on_update;
      DROP TABLE item_performer_stop_confirmations;
      ALTER TABLE item_executions DROP COLUMN stop_generation;
      DELETE FROM schema_migrations WHERE version=202611040657;`);
    store.database.connection.exec(EXECUTION_STOP_SCHEMA.match(/CREATE TRIGGER invalidate_external_stop_on_activity[\s\S]*?END;/)![0]);
    store.database.connection.prepare("INSERT INTO item_execution_stop_confirmations(item_id,source,execution_id,evidence_key,confirmed_by,note,confirmed_at,invalidated_at) VALUES (?,'external',?,'old-check',?,'Old human audit',?,?)")
      .run(item.id,source,owner.accountId,new Date().toISOString(),new Date().toISOString());
    const previous=store.database.connection.prepare("SELECT * FROM item_execution_stop_confirmations").all();
    store.close();store=new MissionGoStore(path);
    expect(store.getTimeline(item.key)).toEqual(history);
    expect(store.database.connection.prepare("SELECT * FROM item_execution_stop_confirmations").all()).toEqual(previous);
    const blockers=itemExecutionBlockers(store.database,item.id);
    expect(blockers).toHaveLength(2);
    expect(blockers.every(row=>row.canConfirmStopped)).toBe(true);
    for(const blocker of blockers) store.database.transaction(()=>confirmItemExecutionStopped(store.database,item.id,blocker,owner.accountId,"Checked this exact execution on its device",new Date().toISOString()));
    store.close();store=new MissionGoStore(path);
    unavailable();
    expect(itemExecutionBlockers(store.database,item.id)).toEqual([]);
    expect(store.database.connection.prepare("SELECT progress_status FROM external_agent_sessions WHERE id=?").get(source)).toEqual({progress_status:"working"});
    store.database.connection.prepare("UPDATE item_executions SET status='working' WHERE item_id=?").run(item.id);
    store.close();store=new MissionGoStore(path);
    expect(itemExecutionBlockers(store.database,item.id)).toMatchObject([{source:"performer",canConfirmStopped:true}]);
    expect(store.database.connection.prepare("SELECT invalidated_at FROM item_performer_stop_confirmations").get()).toMatchObject({invalidated_at:expect.any(String)});
    expect(store.database.connection.prepare("SELECT count(*) AS count FROM schema_migrations WHERE version=202611040657").get()).toEqual({count:1});
  } finally {store.close();rmSync(directory,{recursive:true,force:true});}
});
