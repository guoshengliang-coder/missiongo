import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MissionGoStore } from "./store.js";
import { buildApp } from "./app.js";
import { beforeDisplayProjection } from "./test-fixtures/before-display-projection.js";

const stores:MissionGoStore[]=[], directories:string[]=[];
afterEach(async()=>{for(const store of stores.splice(0))store.database.close();for(const directory of directories.splice(0))await rm(directory,{recursive:true,force:true});});
const create=(store:MissionGoStore,productId:string,title="List summary")=>store.createWorkItem({productId,title,type:"bug",priority:"high",status:"ready",description:"Full description ".repeat(100),
  report:{overview:"Visible overview",reproductionSteps:"Full reproduction ".repeat(100),expectedOutcome:"Expected"},environment:{platform:"web"}});

describe("AND-484 item list projection",()=>{
  it("keeps summaries and media accurate while omitting full detail and timeline work",()=>{
    const store=new MissionGoStore(":memory:");stores.push(store);
    const p=store.createProduct({name:"List regression",keyPrefix:"LST"}),item=create(store,p.id);
    const image=store.createAttachmentMetadata({itemKey:item.key,kind:"image",filename:"preview.png",storageFilename:"preview-1.png",contentType:"image/png",sizeBytes:100});
    store.createAttachmentMetadata({itemKey:item.key,kind:"log",filename:"details.log",storageFilename:"details-1.log",contentType:"text/plain",sizeBytes:100});
    const db=store.database.connection;
    const event=db.prepare("SELECT id,payload_json FROM work_item_events WHERE item_id=? AND event_type='item_created'").get(item.id) as {id:string;payload_json:string};
    db.prepare("UPDATE work_item_events SET payload_json=? WHERE id=?").run(JSON.stringify({...JSON.parse(event.payload_json),logs:[{text:"Private full diagnostic"}],context:{source:"web"}}),event.id);
    const expected=store.getWorkItem(item.key);
    const detail=vi.spyOn(store,"getWorkItem").mockImplementation(()=>{throw new Error("Unexpected detail assembly");});
    const timeline=vi.spyOn(store,"getTimeline").mockImplementation(()=>{throw new Error("Unexpected timeline assembly");});
    const evidence=vi.spyOn(store,"getDevelopmentReleaseDecision").mockImplementation(()=>{throw new Error("Unexpected evidence computation");});
    try {
      const rows=store.listWorkItemRows({productId:p.id});
      expect(rows).toHaveLength(1);expect(rows[0]).not.toHaveProperty("attachments");expect(rows[0]).not.toHaveProperty("report");expect(rows[0]).not.toHaveProperty("description");
      expect(rows[0]?.listSummary).toEqual({overview:"Visible overview",hasReproduction:true,diagnosticSummary:{logCount:1,logFileCount:1,contextEntryCount:1},attachmentCount:2,media:expected.attachments.filter(a=>a.id===image.id)});
      expect(JSON.stringify(rows)).not.toContain("Private full diagnostic");
      expect(store.listWorkItems({productId:p.id})).toEqual([expected]);
    }finally{detail.mockRestore();timeline.mockRestore();evidence.mockRestore();}
    store.updateWorkItem(item.key,{title:"Updated title",report:{overview:"New summary"}});
    expect(store.listWorkItemRows({productId:p.id})[0]).toMatchObject({title:"Updated title",listSummary:{overview:"New summary",hasReproduction:false}});
  });
  it("uses a fixed number of row queries as page size increases",()=>{
    const store=new MissionGoStore(":memory:");stores.push(store);
    const p=store.createProduct({name:"Bounded queries",keyPrefix:"SQL"});
    store.database.transaction(()=>{for(let i=0;i<100;i++)create(store,p.id,`Row ${i}`);});
    const db=store.database.connection,prepare=db.prepare.bind(db),sql:string[]=[];
    const spy=vi.spyOn(db,"prepare").mockImplementation(query=>{sql.push(query);return prepare(query);});
    try{
      expect(store.listWorkItemRows({productId:p.id,limit:1})).toHaveLength(1);const small=sql.length;sql.length=0;
      expect(store.listWorkItemRows({productId:p.id,limit:100})).toHaveLength(100);expect(sql).toHaveLength(small);
      expect(sql.join(" ")).not.toContain("FROM work_item_events");expect(sql.join(" ")).not.toContain("SELECT * FROM work_items");
    }finally{spy.mockRestore();}
  });
  it("backfills a legacy database before serving and survives a restart",async()=>{
    const directory=await mkdtemp(join(tmpdir(),"and484-list-"));directories.push(directory);
    const path=join(directory,"db.sqlite"),store=new MissionGoStore(path);
    const p=store.createProduct({name:"Old database",keyPrefix:"OLD"}),item=create(store,p.id);
    store.database.close();
    const legacy=new DatabaseSync(path);beforeDisplayProjection(legacy);legacy.close();
    for(let pass=0;pass<2;pass++){
      const reopened=new MissionGoStore(path);
      try{expect(reopened.listWorkItemRows({productId:p.id})[0]).toMatchObject({key:item.key,listSummary:{overview:"Visible overview"}});
        expect(reopened.database.connection.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
      }finally{reopened.database.close();}
    }
  });
  it("uses compact rows in HTTP list and bootstrap and keeps detail fully loaded",async()=>{
    const app=buildApp(),p=app.missionGoStore.createProduct({name:"HTTP rows",keyPrefix:"ROW"});
    const item=create(app.missionGoStore,p.id);
    try{
      for(const url of [`/api/v1/items?productId=${p.id}&projection=list`,`/api/v1/bootstrap?productId=${p.id}&projection=list`]){
        const response=await app.inject({method:"GET",url});expect(response.statusCode).toBe(200);
        expect(response.json().items[0]).toMatchObject({projection:"list",key:item.key,listSummary:{overview:"Visible overview"}});
        expect(response.json().items[0]).not.toHaveProperty("attachments");
      }
      const detail=await app.inject({method:"GET",url:`/api/v1/items/${item.key}`});
      expect(detail.json().description).toBe(item.description);expect(detail.json().report.reproductionSteps).toBe(item.report!.reproductionSteps);
      const legacy=await app.inject({method:"GET",url:`/api/v1/items?productId=${p.id}`});expect(legacy.json().items[0].attachments).toEqual([]);
    }finally{await app.close();}
  });
});
