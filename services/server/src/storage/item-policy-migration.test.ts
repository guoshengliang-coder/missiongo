import { randomUUID } from "node:crypto";
import { mkdtempSync,rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect,it } from "vitest";
import { MissionGoStore } from "../store.js";
import { AccountStore } from "../accounts-store.js";
import { deliveryRound } from "../delivery-round.js";
import { seedStoreActors } from "../testing-fixtures.js";

it("upgrades existing owners, held cards, content and claim credentials once without widening cleared AI grants",()=>{
 const directory=mkdtempSync(join(tmpdir(),"missiongo-policy-migration-"));
 const path=join(directory,"fixture.sqlite");let store=new MissionGoStore(path);
 try {
  seedStoreActors(store,["owner","limited"]);
  const accounts=new AccountStore(store.database);
  const product=store.createProduct({name:"Existing",keyPrefix:"OLD",createdByAccountId:"owner"});
  accounts.replacePermissions("limited",[{productId:product.id,canView:true,canOperate:true,canUseAi:true}]);
  const item=store.createWorkItem({productId:product.id,title:"Existing scope",description:"Original",type:"task",priority:"normal",status:"ready",environment:{platform:"web"}});
  store.claimWorkItem({itemKey:item.key,agentId:"Agent",attribution:{accountId:"owner"},idempotencyKey:"existing-claim"});
  const db=store.database.connection,at=new Date().toISOString(),live=randomUUID(),old=randomUUID();
  for(const [id,date] of [[live,at],[old,"2000-01-01T00:00:00.000Z"]]) db.prepare("INSERT INTO builder_execution_authorizations(id,item_id,account_id,client_id,created_at) VALUES (?,?,?,'client',?)").run(id!,item.id,"owner",date!);
  const held=store.createWorkItem({productId:product.id,title:"Paused before start",description:"",type:"task",priority:"normal",status:"ready",environment:{platform:"web"}});
  store.transitionWorkItem({itemKey:held.key,to:"on_hold",actor:"human",reason:"request_human_input",note:"Await prioritization"});
  // Reconstruct the schema immediately preceding AND-357, retaining real rows and history.
  db.exec(`DROP TRIGGER item_policy_revision;
    DROP TABLE item_content_versions; DROP TABLE project_role_audit; DROP TABLE item_decision_receipts; DROP TABLE account_access_audit;
    ALTER TABLE work_items DROP COLUMN revision; ALTER TABLE work_items DROP COLUMN content_version;
    ALTER TABLE work_items DROP COLUMN held_from; ALTER TABLE work_items DROP COLUMN execution_disposition;
    ALTER TABLE builder_execution_authorizations DROP COLUMN round_key;
    ALTER TABLE item_executions DROP COLUMN authorization_revoked; ALTER TABLE item_executions DROP COLUMN origin;
    ALTER TABLE accounts DROP COLUMN ai_scope;
    DELETE FROM product_administrators;
    DELETE FROM schema_migrations WHERE version=202611020744;`);
  store.close();store=new MissionGoStore(path);
  const upgraded=new AccountStore(store.database);
  expect(upgraded.projectAdministratorIds(product.id)).toEqual(["owner"]);
  expect(store.getWorkItem(held.key)).toMatchObject({status:"on_hold",heldFrom:"ready",revision:1,contentVersion:1});
  expect(upgraded.getAccount("owner").aiScope).toBe("all");expect(upgraded.getAccount("limited").aiScope).toBe("selected");
  expect(store.database.connection.prepare("SELECT revoked,round_key FROM builder_execution_authorizations WHERE id=?").get(live)).toEqual({revoked:0,round_key:deliveryRound(store.database,item.id,true)});
  expect(store.database.connection.prepare("SELECT revoked FROM builder_execution_authorizations WHERE id=?").get(old)).toEqual({revoked:1});
  upgraded.replacePermissions("limited",[]);
  expect(upgraded.reachableProductIds(upgraded.getAccount("limited"),"ai")).toEqual([]);
  expect(store.database.connection.prepare("SELECT COUNT(*) AS count FROM item_content_versions").get()).toEqual({count:2});
  store.close();store=new MissionGoStore(path);
  expect(new AccountStore(store.database).getAccount("limited").aiScope).toBe("selected");
  expect(store.database.connection.prepare("SELECT COUNT(*) AS count FROM item_content_versions").get()).toEqual({count:2});
 } finally {store.close();rmSync(directory,{recursive:true,force:true});}
});
