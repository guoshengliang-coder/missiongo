import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MissionGoStore } from "./store.js";
import { DispatchStore } from "./dispatch-store.js";
import { StatusChecks } from "./status-checks.js";
import { ReleaseObservations, type ReleaseObservation } from "./release-observations.js";
import { buildApp } from "./app.js";

let store: MissionGoStore;
const merged = {commit:"a".repeat(40),occurredAt:"2026-10-31T04:00:00.000Z"};
const repository = "https://git.example.test/team/project";
const completion = {kind:"gitlab" as const,url:`${repository}/-/merge_requests/12`};
beforeEach(() => { vi.useFakeTimers({toFake:["Date"]}); vi.setSystemTime(new Date(merged.occurredAt)); store = new MissionGoStore(":memory:"); });
afterEach(() => { store.close(); vi.useRealTimers(); });
function setup() {
  const product = store.createProduct({name:"Project",keyPrefix:"PRJ"});
  const checks = new StatusChecks(store); const publications = new ReleaseObservations(store);
  const dispatches = new DispatchStore(store.database);
  const nodes = [1,2].map(i => dispatches.registerNode({accountId:"owner",installationId:`install-${i}`,name:`Node ${i}`}));
  for (const node of nodes) store.database.connection.prepare("INSERT INTO node_product_repos(id,node_id,product_id,repo_path,created_at,updated_at) VALUES (?,?,?,?,?,?)")
    .run(randomUUID(),node.nodeId,product.id,"/example/repository",merged.occurredAt,merged.occurredAt);
  function item(requiredArtifacts = ["web"]) {
    const item = store.createWorkItem({productId:product.id,title:"Fix",description:"Release handover",type:"bug",priority:"normal",environment:{platform:"web"}});
    store.transitionWorkItem({itemKey:item.key,to:"ready",actor:"human",reason:"triaged"});
    store.claimWorkItem({itemKey:item.key,agentId:"test",idempotencyKey:randomUUID()});
    const handover = checks.register(item.key,"owner",{completion,requiredArtifacts});
    checks.report(handover.id,{merged},{accountId:"owner"});
    return {item,handover};
  }
  function observation(overrides: Partial<ReleaseObservation> = {}): ReleaseObservation {
    return {schemaVersion:2,id:randomUUID(),repository,environment:"production",observedAt:new Date().toISOString(),releases:[{
      artifact:"web",version:"1.2",sourceCommit:"b".repeat(40),proof:{kind:"health",url:"https://release.example.test/health"}
    }],...overrides};
  }
  function upload(fact:ReleaseObservation) { return publications.upload(product.id,"/example/repository",fact,{accountId:"owner",nodeId:nodes[0]!.nodeId}); }
  function proof(fact:ReleaseObservation) { return {merged,sharedReleaseId:fact.id,releases:fact.releases.map(r=>({artifact:r.artifact,version:r.version,sourceCommit:r.sourceCommit,containsMergeCommit:merged.commit,verifiedAt:new Date().toISOString(),receiptDigest:"c".repeat(64)}))}; }
  function report(job:NonNullable<ReturnType<StatusChecks["claim"]>>, index:number, fact:ReleaseObservation) {
    return checks.report(job.id,proof(fact),{accountId:"owner",nodeId:nodes[index]!.nodeId,leaseToken:job.leaseToken});
  }
  return {product,checks,publications,nodes,item,observation,upload,proof,report};
}

describe("shared publication observations",()=>{
 it("shares one publication across two nodes and items without transitioning on upload",()=>{
  const s=setup(); const a=s.item(); const b=s.item(); const fact=s.observation();
  expect(s.upload(fact).accepted).toBe(true);
  expect(store.getWorkItem(a.item.key).status).toBe("development_complete");
  expect(s.checks.claim(s.nodes[0]!.nodeId,"owner",()=>{})).toBeNull(); // old node cannot consume shared work
  const first=s.checks.claim(s.nodes[0]!.nodeId,"owner",()=>{},true)!;
  const second=s.checks.claim(s.nodes[1]!.nodeId,"owner",()=>{},true)!;
  expect(first.sharedRelease?.id).toBe(fact.id); expect(second.sharedRelease?.id).toBe(fact.id);
  expect(s.report(first,0,fact).itemStatus).toBe("pending_verification");
  expect(s.report(second,1,fact).itemStatus).toBe("pending_verification");
  expect(s.upload(fact).duplicate).toBe(true);
  s.checks.request(s.product.id,"owner");
  for(const key of [a.item.key,b.item.key]) expect(store.getTimeline(key).filter(e=>e.toStatus==="pending_verification")).toHaveLength(1);
 });
 it("does not let an old leased node clear shared proof or complete from stale local facts",()=>{
  const s=setup(); const {handover}=s.item(["web","desktop"]);
  s.checks.request(s.product.id,"owner"); const old=s.checks.claim(s.nodes[0]!.nodeId,"owner",()=>{})!;
  const fact=s.observation(); s.upload(fact);
  const legacy=s.proof(fact); delete (legacy as {sharedReleaseId?:string}).sharedReleaseId;
  s.checks.report(old.id,legacy,{accountId:"owner",nodeId:s.nodes[0]!.nodeId,leaseToken:old.leaseToken});
  expect(s.checks.snapshot(handover.id).itemStatus).toBe("development_complete");
  s.checks.request(s.product.id,"owner"); const job=s.checks.claim(s.nodes[1]!.nodeId,"owner",()=>{},true)!;
  s.report(job,1,fact);
  expect(s.checks.snapshot(handover.id).evidence.releases).toHaveLength(1);
  s.checks.report(handover.id,{releases:[],failure:"waiting_release"},{accountId:"owner"});
  expect(s.checks.snapshot(handover.id).evidenceReporter.nodeId).toBe(s.nodes[1]!.nodeId);
  expect(s.checks.snapshot(handover.id).evidence.releases).toHaveLength(1);
  expect(s.checks.snapshot(handover.id).itemStatus).toBe("development_complete");
 });
 it("persists retries across restart and rechecks all artifacts instead of combining stale success",()=>{
  const s=setup(); const {handover}=s.item(["web","desktop"]); const fact=s.observation(); s.upload(fact);
  let job=s.checks.claim(s.nodes[0]!.nodeId,"owner",()=>{},true)!; s.report(job,0,fact);
  expect(s.checks.snapshot(handover.id).requestedAt).not.toBeNull();
  expect(s.checks.claim(s.nodes[0]!.nodeId,"owner",()=>{},true)).toBeNull();
  vi.setSystemTime(new Date(Date.now()+61_000));
  const retried=new StatusChecks(store).claim(s.nodes[1]!.nodeId,"owner",()=>{},true)!;
  expect(retried).not.toBeNull();
  const next=s.observation({releases:[{...fact.releases[0]!,artifact:"desktop"}]}); s.upload(next);
  expect(()=>s.report(retried,1,fact)).toThrow(/newer publication/);
  job=s.checks.claim(s.nodes[0]!.nodeId,"owner",()=>{},true)!;
  expect(s.report(job,0,next).itemStatus).toBe("development_complete");
  expect(s.checks.snapshot(handover.id).evidence.releases?.map(r=>r.artifact)).toEqual(["desktop"]);
  vi.setSystemTime(new Date(Date.now()+1000));
  const complete=s.observation({releases:[...fact.releases,...next.releases]}); s.upload(complete);
  job=s.checks.claim(s.nodes[0]!.nodeId,"owner",()=>{},true)!;
  expect(s.report(job,0,complete).itemStatus).toBe("pending_verification");
 });
 it("rejects late reports for a replaced publication and ignores out-of-order uploads",()=>{
  const s=setup(); const {item}=s.item(); const first=s.observation(); s.upload(first);
  const job=s.checks.claim(s.nodes[0]!.nodeId,"owner",()=>{},true)!;
  vi.setSystemTime(new Date(Date.now()+1000)); const rollback=s.observation({releases:[]}); s.upload(rollback);
  expect(()=>s.report(job,0,first)).toThrow(/newer publication/);
  const delayed=s.observation({observedAt:"2026-10-31T03:59:59.000Z"}); expect(s.upload(delayed).superseded).toBe(true);
  expect(s.publications.latest(s.product.id,completion)?.id).toBe(rollback.id);
  const fresh=s.checks.claim(s.nodes[1]!.nodeId,"owner",()=>{},true)!;
  s.report(fresh,1,rollback);
  expect(store.getWorkItem(item.key).status).toBe("development_complete");
 });
 it("isolates project, environment and repository and requires mapped node permission",()=>{
  const s=setup(); const {handover}=s.item();
  expect(()=>s.publications.upload(s.product.id,"/another/repo",s.observation(),{accountId:"owner",nodeId:s.nodes[0]!.nodeId})).toThrow(/mapping/);
  s.upload(s.observation({environment:"staging"})); expect(s.publications.latest(s.product.id,completion)).toBeUndefined();
  s.upload(s.observation({repository:"https://git.example.test/other/project"})); expect(s.publications.latest(s.product.id,completion)).toBeUndefined();
  const other=store.createProduct({name:"Other",keyPrefix:"OT"}); expect(s.publications.latest(other.id,completion)).toBeUndefined();
  expect(s.checks.snapshot(handover.id).itemStatus).toBe("development_complete");
 });
 it("keeps the last reported result timestamp when a new check is queued",()=>{
  const s=setup(); const {handover}=s.item(); const previous=s.checks.snapshot(handover.id).lastResultAt;
  vi.setSystemTime(new Date(Date.now()+60_000));
  s.checks.request(s.product.id,"owner");
  expect(s.checks.snapshot(handover.id).lastResultAt).toBe(previous);
  expect(s.checks.snapshot(handover.id).requestedAt).not.toBeNull();
 });
 it("rejects changed IDs, conflicting timestamps, future and expired verification",()=>{
  const s=setup(); const {handover}=s.item(); const fact=s.observation(); s.upload(fact);
  expect(()=>s.upload({...fact,releases:[]})).toThrow(/ID/);
  expect(()=>s.upload(s.observation())).toThrow(/timestamp/);
  expect(()=>s.upload(s.observation({observedAt:"2027-01-01T00:00:00Z"}))).toThrow(/future/);
  const stale=s.proof(fact); vi.setSystemTime(new Date(Date.now()+301_000));
  expect(()=>s.checks.report(handover.id,stale,{accountId:"owner"})).toThrow(/freshly/);
  const wrong=s.proof(fact); wrong.releases[0]!.sourceCommit="d".repeat(40);
  expect(()=>s.checks.report(handover.id,wrong,{accountId:"owner"})).toThrow(/current publication/);
 });
 it("does not reuse shared evidence after a new processing round",()=>{
  const s=setup(); const {item,handover}=s.item(); const fact=s.observation(); s.upload(fact);
  const job=s.checks.claim(s.nodes[0]!.nodeId,"owner",()=>{},true)!; s.report(job,0,fact);
  store.transitionWorkItem({itemKey:item.key,to:"ready",actor:"human",reason:"verification_failed",note:"Rework"});
  vi.setSystemTime(new Date(Date.now()+60_000));
  store.claimWorkItem({itemKey:item.key,agentId:"test",idempotencyKey:randomUUID()});
  expect(s.checks.report(handover.id,s.proof(fact),{accountId:"owner"}).status).toBe("stale");
  const next=s.checks.register(item.key,"owner",{completion,requiredArtifacts:["web"]});
  expect(s.checks.report(next.id,s.proof(fact),{accountId:"owner"}).status).toBe("evidence_missing");
  expect(store.getWorkItem(item.key).status).toBe("in_progress");
 });
 it("rechecks instead of reusing old releases when current verification fails before producing a list",()=>{
  const s=setup(); const {handover}=s.item(["web","desktop"]); const first=s.observation(); s.upload(first);
  s.checks.report(handover.id,s.proof(first),{accountId:"owner"});
  vi.setSystemTime(new Date(Date.now()+1000)); const next=s.observation(); s.upload(next);
  const result=s.checks.report(handover.id,{sharedReleaseId:next.id,failure:"permission_failed"},{accountId:"owner"});
  expect(result.evidence.releases).toEqual([]); expect(result.itemStatus).toBe("development_complete");
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
