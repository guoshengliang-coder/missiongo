import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { MissionGoStore } from "../store.js";
import { AccountStore } from "../accounts-store.js";
import { seedStoreActors } from "../testing-fixtures.js";
import { PersonalNotifications } from "../personal-notifications.js";

it("adds an empty personal inbox without replaying old comments or changing existing external jobs",()=>{
  const dir=mkdtempSync(join(tmpdir(),"missiongo-personal-migration-")),path=join(dir,"fixture.sqlite");
  let store:MissionGoStore|undefined;
  try {
    store=new MissionGoStore(path);seedStoreActors(store,["reader"]);
    const product=store.createProduct({name:"Existing messages",keyPrefix:"OLD",createdByAccountId:"reader"});
    const item=store.createWorkItem({productId:product.id,title:"Existing item",description:"",type:"note",priority:"normal"});
    store.createComment({itemKey:item.key,actorKind:"human",bodyKind:"free",body:{text:"Historical comment"},mentionAccountIds:["reader"]});
    const db=store.database.connection;
    // Reconstruct precisely the pre-message-center schema with a real external job.
    db.exec(`ALTER TABLE dingtalk_notifications DROP COLUMN personal_notification_id;
      DROP TABLE personal_notifications; DROP TABLE notification_events;
      ALTER TABLE dingtalk_projects DROP COLUMN comments_enabled;
      DELETE FROM schema_migrations WHERE version=202611030125;`);
    const before=db.prepare("SELECT id,status,attempts,created_at FROM dingtalk_notifications").all();
    store.close();store=undefined;store=new MissionGoStore(path);
    const accounts=new AccountStore(store.database),service=new PersonalNotifications(store,accounts);
    expect(service.list(accounts.getAccount("reader"),{}).notifications).toEqual([]);
    expect(store.database.connection.prepare("SELECT id,status,attempts,created_at FROM dingtalk_notifications").all()).toEqual(before);
    store.createComment({itemKey:item.key,actorKind:"human",bodyKind:"free",body:{text:"New comment"},mentionAccountIds:["reader"]});
    expect(service.count(accounts.getAccount("reader"))).toBe(1);
    store.close();store=undefined;store=new MissionGoStore(path);
    expect(store.database.connection.prepare("SELECT count(*) AS n FROM personal_notifications").get()).toEqual({n:1});
    expect(store.database.connection.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  } finally {store?.close();rmSync(dir,{recursive:true,force:true});}
});
