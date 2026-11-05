import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { MissionGoStore } from "../store.js";

it("retires only old mode waits and persists independent Web continuation intents across restart",()=>{
  const root=mkdtempSync(join(tmpdir(),"single-plan-migration-"));
  const path=join(root,"fixture.sqlite");
  let store=new MissionGoStore(path);
  try {
    const db=store.database.connection,now=new Date().toISOString();
    for(const state of ["waiting","queued","cancelled"]) db.prepare(`INSERT INTO implementation_plan_recovery_resumes
      (account_id,identity_key,revision,session_id,user_digest,requested_at,state,command_id) VALUES ('owner',?,'revision','session','digest',?,?,?)`)
      .run(state,now,state,state==="queued"?"existing-command":null);
    db.exec("DROP TABLE implementation_plan_continuations; DELETE FROM schema_migrations WHERE version=202611051453;");
    store.close();store=new MissionGoStore(path);
    expect(store.database.connection.prepare("SELECT identity_key,state,command_id FROM implementation_plan_recovery_resumes ORDER BY identity_key").all()).toEqual([
      {identity_key:"cancelled",state:"cancelled",command_id:null},{identity_key:"queued",state:"queued",command_id:"existing-command"},
      {identity_key:"waiting",state:"cancelled",command_id:null},
    ]);
    store.database.connection.prepare(`INSERT INTO implementation_plan_continuations
      (account_id,identity_key,revision,session_id,source_digest,requested_at,state) VALUES ('owner','original','revision','session','digest',?,'waiting')`).run(now);
    store.close();store=new MissionGoStore(path);
    expect(store.database.connection.prepare("SELECT state FROM implementation_plan_continuations").get()).toMatchObject({state:"waiting"});
    expect(store.database.connection.prepare("SELECT COUNT(*) AS n FROM implementation_plan_approvals").get()).toMatchObject({n:0});
  } finally {store.close();rmSync(root,{recursive:true,force:true});}
});

it("preserves a pre-upgrade Web shortcut approval even when native history IDs change",async()=>{
  const root=mkdtempSync(join(tmpdir(),"single-plan-existing-")),path=join(root,"fixture.sqlite");
  let store=new MissionGoStore(path);
  try {
    const {ImplementationPlans,planDigest}=await import("../implementation-plans.js");
    const product=store.createProduct({name:"Existing",keyPrefix:"OLD"});
    const item=store.createWorkItem({productId:product.id,title:"Existing approval",description:"Original scope",status:"ready",type:"task",priority:"normal",environment:{platform:"web"}});
    const plan="Preserve the user's existing approval and original item boundary.";
    new ImplementationPlans(store.database).record({accountId:"owner",identity:"original",revision:"existing-revision",planHash:planDigest(["old-source-id",plan]),keys:[item.key],plan,source:"web",commandId:"original-command"});
    store.database.connection.exec("DROP TABLE implementation_plan_continuations; DELETE FROM schema_migrations WHERE version=202611051453;");
    store.close();store=new MissionGoStore(path);
    const plans=new ImplementationPlans(store.database);
    expect(plans.proposal("owner","original")).toMatchObject({approved:true,valid:true,plan,keys:[item.key],origin:"attention"});
    expect(plans.commandRevision("original-command")).toBe("existing-revision");
    expect(store.database.connection.prepare("SELECT source,command_id FROM implementation_plan_approvals").get()).toMatchObject({source:"web",command_id:"original-command"});
    store.database.connection.prepare("UPDATE work_items SET content_version=content_version+1 WHERE id=?").run(item.id);
    expect(plans.proposal("owner","original")).toMatchObject({approved:false,valid:false});
  } finally {store.close();rmSync(root,{recursive:true,force:true});}
});
