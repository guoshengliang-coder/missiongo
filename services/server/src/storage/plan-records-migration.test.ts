import {expect,it} from "vitest";
import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {MissionGoStore} from "../store.js";
import {ImplementationPlans} from "../implementation-plans.js";
import {PlanDocuments} from "../plan-documents.js";
import {PlanRecords} from "../plan-records.js";

it("recovers only evidenced legacy versions and leaves document bytes and decisions unchanged",()=>{
 const root=mkdtempSync(join(tmpdir(),"plan-records-migration-")),path=join(root,"data.sqlite");
 let store=new MissionGoStore(path);
 try {
  const product=store.createProduct({name:"Plans",keyPrefix:"PLAN"});
  const item=store.createWorkItem({productId:product.id,status:"ready",type:"task",title:"Scope",description:"Exact",priority:"normal",environment:{platform:"web"}});
  const documents=new PlanDocuments(store),plans=new ImplementationPlans(store.database),keys=[item.key];
  const doc=documents.prepare({accountId:"owner",identity:"conversation",keys,summary:"Original",markdown:"Original\n\nExact old content.",origin:"https://example.test",requestKey:"old"});
  plans.request("owner","conversation","approved-old",{keys,plan:doc.plan,validation:"",documentId:doc.id});
  plans.record({accountId:"owner",identity:"conversation",revision:"approved-old",planHash:"approved-old",keys,source:"web",plan:doc.plan});
  plans.request("owner","conversation","current",{keys,plan:"Current legacy body",validation:"Exact validation"});
  // Simulate the pre-migration schema in this disposable database.
  store.database.connection.exec(`DROP TRIGGER plan_version_request_insert;DROP TRIGGER plan_version_request_update;
    DROP TRIGGER plan_version_approval;DROP TRIGGER plan_version_rework;DROP TRIGGER plan_versions_immutable;DROP TRIGGER plan_versions_no_delete;
    DROP TABLE implementation_plan_versions;DELETE FROM schema_migrations WHERE version=202611080115;`);
  store.close();store=new MissionGoStore(path);
  const records=new PlanRecords(store).read("owner",["conversation"],()=>undefined);
  expect(records.records).toHaveLength(2);expect(records.records[0]?.revision).toBe("current");expect(records.historyIncomplete).toBe(true);
  const old=records.records.find(record=>record.revision==="approved-old")!;
  expect(old).toMatchObject({documentId:doc.id,current:false,effective:false,approval:{source:"web"}});
  const read=new PlanRecords(store).read("owner",["conversation"],()=>undefined,{recordId:old.id});
  expect(read.records[0]?.markdown).toBe(doc.markdown);expect(read.records[0]?.submittedAt).toBeUndefined();
  expect(new PlanDocuments(store).get(doc.id,()=>undefined).sha256).toBe(doc.sha256);
  expect(()=>new PlanRecords(store).read("owner",["conversation"],()=>{throw new Error("Forbidden scope");})).toThrow("Forbidden scope");
  expect(new PlanRecords(store).has("owner",["conversation"],()=>{throw new Error("Forbidden scope");})).toBe(false);
  expect(new PlanRecords(store).read("outsider",["conversation"],()=>undefined).records).toEqual([]);
  expect(()=>store.database.connection.prepare("DELETE FROM implementation_plan_versions").run()).toThrow("immutable");
 } finally {store.close();rmSync(root,{recursive:true,force:true});}
});
