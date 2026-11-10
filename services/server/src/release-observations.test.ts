import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MissionGoStore } from "./store.js";
import { DispatchStore } from "./dispatch-store.js";
import { MAX_OBSERVATION_DIAGNOSTICS, ReleaseObservations, type ReleaseObservation } from "./release-observations.js";
import { deliveryExplanations } from "./delivery-explanation.js";
import { buildApp } from "./app.js";
import { createAiAccessToken } from "./admin-auth.js";
import { TEST_CONSOLE_ACCOUNT } from "./testing-fixtures.js";

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

describe("item-scoped observation diagnostics", () => {
 function delivery(s: ReturnType<typeof setup>, input: {completion?: typeof completion; unknown?: boolean} = {}) {
  const item=store.createWorkItem({productId:s.product.id,title:"Delivery",description:"Body",type:"task",priority:"normal",status:"ready",environment:{platform:"macos"}});
  store.claimWorkItem({itemKey:item.key,agentId:"test",idempotencyKey:randomUUID()});
  if(input.unknown) store.transitionWorkItem({itemKey:item.key,to:"development_complete",actor:"human",reason:"resolution_submitted"});
  else store.submitDevelopmentComplete({itemKey:item.key,completion:input.completion??completion,requiredArtifacts:["macos","windows"],idempotencyKey:randomUUID()});
  return item;
 }
 function read(s: ReturnType<typeof setup>, key: string) {
  const deliveries=store.getDeliveryRecords(key);
  return s.publications.diagnostics(s.product.id,deliveries,deliveryExplanations(store,key,deliveries));
 }
 it("exposes GitLab locator hints without asserting publication or changing a manually advanced card", () => {
  const s=setup(),item=delivery(s),fact=s.observation();s.upload(fact);
  store.transitionWorkItem({itemKey:item.key,to:"pending_verification",actor:"human",reason:"release_verified"});
  const before=store.getWorkItem(item.key),events=store.getTimeline(item.key);
  const result=read(s,item.key);
  expect(result).toMatchObject({unverified:true,total:1,truncated:false,items:[{status:"available",observationId:fact.id}],observations:[fact]});
  expect(result.items[0]!.developmentEventId).toBe(store.getDeliveryRecords(item.key)[0]!.id);
  expect(store.getDeliveryRecords(item.key)[0]).toMatchObject({published:false,releases:[]});
  expect(store.getWorkItem(item.key)).toEqual(before);expect(store.getTimeline(item.key)).toEqual(events);
  expect(JSON.stringify(result)).not.toContain("/example/repository");
  expect(JSON.stringify(result)).not.toContain(s.node.nodeId);
 });
 it("distinguishes missing integration, a commit without repository identity and no matching observation", () => {
  const s=setup(),unknown=delivery(s,{unknown:true});
  expect(read(s,unknown.key).items[0]!.status).toBe("integration_missing");
  const item=delivery(s);
  expect(read(s,item.key)).toMatchObject({items:[{status:"not_found"}],observations:[]});
  store.submitDevelopmentComplete({itemKey:item.key,completion:{kind:"commit",commit:"c".repeat(40),targetBranch:"dev"},requiredArtifacts:["macos"],idempotencyKey:randomUUID()});
  expect(read(s,item.key).items.map(row=>row.status)).toEqual(["not_found","repository_unavailable"]);
 });
 it("isolates repository, product and environment, including GitLab subgroups and GitHub", () => {
  const s=setup(),item=delivery(s);
  s.upload(s.observation({environment:"staging"}));
  s.upload(s.observation({repository:`${repository}/subgroup`}));
  expect(read(s,item.key).items[0]!.status).toBe("not_found");
  const fact=s.observation();s.upload(fact);
  const rows=store.getDeliveryRecords(item.key),explanations=deliveryExplanations(store,item.key,rows);
  const other=store.createProduct({name:"Other",keyPrefix:"OTH"});
  expect(s.publications.diagnostics(other.id,rows,explanations).items[0]!.status).toBe("not_found");
  expect(read(s,item.key).observations.map(row=>row.id)).toEqual([fact.id]);
  const github={kind:"github" as const,url:"https://github.com/example/project/pull/1"};
  const ghItem=store.createWorkItem({productId:s.product.id,title:"GitHub",description:"Body",type:"task",priority:"normal",status:"ready",environment:{platform:"web"}});
  store.claimWorkItem({itemKey:ghItem.key,agentId:"test",idempotencyKey:randomUUID()});
  store.submitDevelopmentComplete({itemKey:ghItem.key,completion:github,requiredArtifacts:["web"],idempotencyKey:randomUUID()});
  const ghFact=s.observation({repository:"https://github.com/example/project"});s.upload(ghFact);
  expect(read(s,ghItem.key).observations.map(row=>row.id)).toEqual([ghFact.id]);
 });
 it("keeps multiple integrations separate, deduplicates snapshots and does not combine a rollback with an older snapshot", () => {
  const s=setup(),item=delivery(s),first=s.observation();s.upload(first);
  store.submitDevelopmentComplete({itemKey:item.key,completion:{...completion,url:`${repository}/-/merge_requests/13`},requiredArtifacts:["macos"],idempotencyKey:randomUUID()});
  expect(read(s,item.key)).toMatchObject({total:2,items:[{status:"available",observationId:first.id},{status:"available",observationId:first.id}],observations:[first]});
  vi.setSystemTime(new Date(Date.now()+1000));const rollback=s.observation({releases:[]});s.upload(rollback);
  expect(read(s,item.key).observations).toEqual([rollback]);
  store.updateWorkItem(item.key,{description:"New delivery scope"});
  expect(read(s,item.key)).toMatchObject({items:[{status:"historical"}],observations:[]});
 });
 it("bounds output explicitly and rejects malformed stored observations without exposing extra fields", () => {
  const s=setup(),item=delivery(s),fact=s.observation();s.upload(fact);
  const write=(raw: unknown)=>store.database.connection.prepare("UPDATE release_observations SET payload_json=? WHERE id=?").run(typeof raw==="string"?raw:JSON.stringify(raw),fact.id);
  write({...fact,repoPath:"/private/hidden",token:"synthetic-secret"});
  expect(read(s,item.key).observations).toEqual([fact]);
  write({...fact,releases:[{...fact.releases[0],version:"x".repeat(101)}]});
  expect(read(s,item.key)).toMatchObject({items:[{status:"invalid_observation"}],observations:[]});
  write("{");expect(read(s,item.key).items[0]!.status).toBe("invalid_observation");
  write("null");expect(read(s,item.key).items[0]!.status).toBe("invalid_observation");
  write(fact);
  const failedRead=vi.spyOn(s.publications,"latest").mockImplementationOnce(()=>{throw new Error("Synthetic storage failure");});
  expect(read(s,item.key)).toMatchObject({items:[{status:"read_failed"}],observations:[]});failedRead.mockRestore();
  for(let i=0;i<MAX_OBSERVATION_DIAGNOSTICS;i++) store.submitDevelopmentComplete({itemKey:item.key,completion:{...completion,url:`${repository}/-/merge_requests/${100+i}`},requiredArtifacts:["macos"],idempotencyKey:randomUUID()});
  const result=read(s,item.key);
  expect(result).toMatchObject({limit:MAX_OBSERVATION_DIAGNOSTICS,total:MAX_OBSERVATION_DIAGNOSTICS+1,truncated:true});
  expect(result.items).toHaveLength(MAX_OBSERVATION_DIAGNOSTICS);expect(result.observations).toHaveLength(1);
  expect(result.items.map(row=>row.developmentEventId)).toEqual(store.getDeliveryRecords(item.key).slice(-MAX_OBSERVATION_DIAGNOSTICS).map(row=>row.id));
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

it("returns diagnostics through read-only MCP while keeping other products inaccessible", async () => {
 const app=buildApp({databasePath:":memory:",adminAccount:TEST_CONSOLE_ACCOUNT,writeTools:"none",statusCheckTime:false});
 try {
  const s=app.missionGoStore,accounts=app.missionGoAccounts;
  const product=s.createProduct({name:"Read product",keyPrefix:"READ"});
  const item=s.createWorkItem({productId:product.id,title:"Delivery",description:"Body",type:"task",priority:"normal",status:"ready",environment:{platform:"macos"}});
  s.claimWorkItem({itemKey:item.key,agentId:"test",idempotencyKey:randomUUID()});
  s.submitDevelopmentComplete({itemKey:item.key,completion,requiredArtifacts:["macos","windows"],idempotencyKey:randomUUID()});
  const publications=new ReleaseObservations(s);
  const node=new DispatchStore(s.database).registerNode({accountId:TEST_CONSOLE_ACCOUNT.id,installationId:"mcp-observation",name:"Node"});
  s.database.connection.prepare("INSERT INTO node_product_repos(id,node_id,product_id,repo_path,created_at,updated_at) VALUES (?,?,?,?,?,?)")
   .run(randomUUID(),node.nodeId,product.id,"/example/mcp-repository",merged.occurredAt,merged.occurredAt);
  const fact:ReleaseObservation={schemaVersion:2,id:randomUUID(),repository,environment:"production",observedAt:merged.occurredAt,
   releases:[{artifact:"macos",version:"1.2",sourceCommit:"b".repeat(40),proof:{kind:"sha256",url:"https://release.example.test/app.zip",sha256:"c".repeat(64)}}]};
  publications.upload(product.id,"/example/mcp-repository",fact,{accountId:TEST_CONSOLE_ACCOUNT.id,nodeId:node.nodeId});
  const account=accounts.getAccount(TEST_CONSOLE_ACCOUNT.id);
  const token=createAiAccessToken(TEST_CONSOLE_ACCOUNT,{id:account.id,username:account.email,role:account.role},accounts.credentialsStamp(account),"read-only-observation",["missiongo:read"]).token;
  const call=async()=>{
   const response=await app.inject({method:"POST",url:"/mcp",headers:{authorization:`Bearer ${token}`,accept:"application/json, text/event-stream","content-type":"application/json"},
    payload:{jsonrpc:"2.0",id:1,method:"tools/call",params:{name:"get_item_context",arguments:{itemKey:item.key}}}});
   const raw=response.headers["content-type"]?.includes("text/event-stream")?response.body.split("\n").find(line=>line.startsWith("data: "))!.slice(6):response.body;
   return JSON.parse(raw);
  };
  const before=s.getWorkItem(item.key),timeline=s.getTimeline(item.key);
  const result=await call();
  expect(result.error??result.result?.isError).toBeUndefined();
  expect(result.result.structuredContent.releaseObservationDiagnostics).toMatchObject({unverified:true,items:[{status:"available",observationId:fact.id}],observations:[fact]});
  expect(result.result.structuredContent.deliveries[0]).toMatchObject({published:false,releases:[]});
  expect(s.getWorkItem(item.key)).toEqual(before);expect(s.getTimeline(item.key)).toEqual(timeline);
  const other=s.createProduct({name:"Other",keyPrefix:"DENY"});
  accounts.replacePermissions(account.id,[{productId:other.id,canView:true,canOperate:false,canUseAi:true}],"selected");
  const denied=await call();expect(denied.error??denied.result?.isError).toBeTruthy();
  expect(JSON.stringify(denied)).not.toContain(fact.id);
 } finally {await app.close();}
});
