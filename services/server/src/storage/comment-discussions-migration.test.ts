import { mkdtempSync,rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect,it } from "vitest";
import { MissionGoStore } from "../store.js";
import { DINGTALK_SCHEMA } from "./dingtalk-schema.js";

it("upgrades existing comments and verification jobs without replaying notifications and reopens idempotently",()=>{
  const dir=mkdtempSync(join(tmpdir(),"missiongo-discussion-migration-")),path=join(dir,"db.sqlite");
  let store:MissionGoStore|undefined;
  try {
    store=new MissionGoStore(path);const product=store.createProduct({name:"Old project",keyPrefix:"OLD"});
    const item=store.createWorkItem({productId:product.id,type:"note",priority:"normal",title:"Old item",description:""});
    const old=store.createComment({itemKey:item.key,actorKind:"human",bodyKind:"free",body:{text:"Before upgrade"}});
    store.transitionWorkItem({itemKey:item.key,to:"pending_verification",actor:"human",reason:"manual_override"});
    const before=store.database.connection.prepare("SELECT * FROM dingtalk_notifications").all();store.close();store=undefined;
    const db=new DatabaseSync(path);
    try {
      db.exec("DROP INDEX comments_thread; ALTER TABLE work_item_comments DROP COLUMN reply_to_comment_id; ALTER TABLE work_item_comments DROP COLUMN thread_root_comment_id; ALTER TABLE work_item_comments DROP COLUMN mentions_json;");
      db.exec("ALTER TABLE dingtalk_notifications RENAME TO notices_new; DROP INDEX dingtalk_notifications_pending; DROP INDEX dingtalk_notifications_item;");
      const start=DINGTALK_SCHEMA.indexOf("  CREATE TABLE dingtalk_notifications"),end=DINGTALK_SCHEMA.indexOf("  CREATE TABLE dingtalk_audit");
      db.exec(DINGTALK_SCHEMA.slice(start,end));
      db.exec(`INSERT INTO dingtalk_notifications(id,event_id,item_id,account_id,kind,status,reason,attempts,task_id,recipient,config_revision,binding_revision,next_at,lease_until,created_at,updated_at)
        SELECT id,event_id,item_id,account_id,kind,status,reason,attempts,task_id,recipient,config_revision,binding_revision,next_at,lease_until,created_at,updated_at FROM notices_new;
        DROP TABLE notices_new; DELETE FROM schema_migrations WHERE version=202610310925;`);
    } finally {db.close();}
    store=new MissionGoStore(path);
    expect(store.listComments(item.key)).toEqual([old]);
    expect(store.database.connection.prepare("SELECT * FROM dingtalk_notifications").all()).toEqual(before);
    expect(store.database.connection.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    store.close();store=new MissionGoStore(path);
    expect(store.database.connection.prepare("SELECT COUNT(*) AS n FROM schema_migrations WHERE version=202610310925").get()).toMatchObject({n:1});
    expect(store.database.connection.prepare("SELECT COUNT(*) AS n FROM dingtalk_notifications").get()).toMatchObject({n:1});
  } finally {store?.close();rmSync(dir,{recursive:true,force:true});}
});
