import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MissionGoStore } from "./store.js";
import { DispatchStore } from "./dispatch-store.js";
import { ReleaseObservations, type ReleaseObservation } from "./release-observations.js";
import { buildApp } from "./app.js";

let store: MissionGoStore;
const merged = {commit:"a".repeat(40),occurredAt:"2026-10-31T04:00:00.000Z"};
const repository = "https://git.example.test/team/project";
const completion = {kind:"gitlab" as const,url:`${repository}/-/merge_requests/12`};
beforeEach(() => { vi.useFakeTimers({toFake:["Date"]}); vi.setSystemTime(new Date(merged.occurredAt)); store = new MissionGoStore(":memory:"); });
afterEach(() => { store.close(); vi.useRealTimers(); });
function setup() {
 const product=store.createProduct({name:"Project",keyPrefix:"PRJ"});
 const publications=new ReleaseObservations(store);
 const node=new DispatchStore(store.database).registerNode({accountId:"owner",installationId:"observation-install",name:"Node"});
 store.database.connection.prepare("INSERT INTO node_product_repos(id,node_id,product_id,repo_path,created_at,updated_at) VALUES (?,?,?,?,?,?)")
   .run(randomUUID(),node.nodeId,product.id,"/example/repository",merged.occurredAt,merged.occurredAt);
 function observation(overrides:Partial<ReleaseObservation>={}):ReleaseObservation {
  return {schemaVersion:2,id:randomUUID(),repository,environment:"production",observedAt:new Date().toISOString(),releases:[{artifact:"web",version:"1.2",sourceCommit:"b".repeat(40),proof:{kind:"health",url:"https://release.example.test/health"}}],...overrides};
 }
 const upload=(fact:ReleaseObservation)=>publications.upload(product.id,"/example/repository",fact,{accountId:"owner",nodeId:node.nodeId});
 return {product,publications,node,observation,upload};
}
describe("passive publication history",()=>{
 it("stores publications without changing cards or requeueing old status checks",()=>{
  const s=setup();
  const item=store.createWorkItem({productId:s.product.id,title:"Fix",description:"Body",type:"bug",priority:"normal",status:"ready",environment:{platform:"web"}});
  store.claimWorkItem({itemKey:item.key,agentId:"test",idempotencyKey:"claim"});
  store.submitDevelopmentComplete({itemKey:item.key,completion,requiredArtifacts:["web"],idempotencyKey:"complete"});
  const before=store.getWorkItem(item.key), events=store.getTimeline(item.key);
  store.database.connection.prepare("INSERT INTO status_handovers(id,item_id,account_id,round_key,pull_request_url,created_at,updated_at) VALUES (?,?,?,?,?,?,?)")
   .run("legacy",item.id,"owner","old-round",completion.url,merged.occurredAt,merged.occurredAt);
  const fact=s.observation();expect(s.upload(fact)).toMatchObject({accepted:true,duplicate:false});
  expect(s.upload(fact)).toMatchObject({accepted:true,duplicate:true});
  expect(store.getWorkItem(item.key)).toEqual(before);expect(store.getTimeline(item.key)).toEqual(events);
  expect(store.database.connection.prepare("SELECT requested_at FROM status_handovers").get()).toMatchObject({requested_at:null});
 });
 it("keeps immutable IDs, rejects conflicts and future observations, and ignores older snapshots",()=>{
  const s=setup(),first=s.observation();s.upload(first);
  expect(()=>s.upload({...first,releases:[]})).toThrow(/ID/);
  expect(()=>s.upload(s.observation())).toThrow(/timestamp/);
  expect(()=>s.upload(s.observation({observedAt:"2027-01-01T00:00:00Z"}))).toThrow(/future/);
  vi.setSystemTime(new Date(Date.now()+1000));const rollback=s.observation({releases:[]});s.upload(rollback);
  expect(s.upload(s.observation({observedAt:"2026-10-31T03:59:59Z"})).superseded).toBe(true);
  expect(s.publications.latest(s.product.id,completion)?.id).toBe(rollback.id);
 });
 it("isolates project, environment and repository and requires the exact mapping",()=>{
  const s=setup();
  expect(()=>s.publications.upload(s.product.id,"/wrong",s.observation(),{accountId:"owner",nodeId:s.node.nodeId})).toThrow(/mapping/);
  s.upload(s.observation({environment:"staging"}));expect(s.publications.latest(s.product.id,completion)).toBeUndefined();
  s.upload(s.observation({repository:"https://git.example.test/other/project"}));expect(s.publications.latest(s.product.id,completion)).toBeUndefined();
  const other=store.createProduct({name:"Other",keyPrefix:"OT"});expect(s.publications.latest(other.id,completion)).toBeUndefined();
 });
});

it("node publication route requires node authentication and a product repository mapping",async()=>{
 const app=buildApp({databasePath:":memory:",statusCheckTime:false});
 try {
  const product=app.missionGoStore.createProduct({name:"Route",keyPrefix:"RT"});
  const node=new DispatchStore(app.missionGoStore.database).registerNode({accountId:"owner",installationId:"route-installation",name:"Node"});
  const observation={schemaVersion:2,id:randomUUID(),repository,environment:"production",observedAt:merged.occurredAt,releases:[]};
  const payload={productId:product.id,repoPath:"/example/repository",observation};
  expect((await app.inject({method:"POST",url:"/api/v1/node/release-observations",payload})).statusCode).toBe(401);
  const headers={authorization:`Bearer ${node.token}`};
  expect((await app.inject({method:"POST",url:"/api/v1/node/release-observations",headers,payload})).statusCode).toBe(404);
  app.missionGoStore.database.connection.prepare("INSERT INTO node_product_repos(id,node_id,product_id,repo_path,created_at,updated_at) VALUES (?,?,?,?,?,?)")
    .run(randomUUID(),node.nodeId,product.id,payload.repoPath,merged.occurredAt,merged.occurredAt);
  expect((await app.inject({method:"POST",url:"/api/v1/node/release-observations",headers,payload})).json()).toMatchObject({accepted:true});
  expect((await app.inject({method:"POST",url:"/api/v1/node/release-observations",headers,payload:{...payload,observation:{...observation,schemaVersion:8}}})).statusCode).toBe(400);
 } finally {await app.close();}
});
