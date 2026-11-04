import {afterEach,beforeEach,describe,expect,it} from "vitest";
import {MissionGoStore} from "./store.js";
import {seedStoreActors} from "./testing-fixtures.js";
import {DispatchStore} from "./dispatch-store.js";
import {CompletionDiscovery} from "./completion-discovery.js";
import {StatusChecks} from "./status-checks.js";
let store:MissionGoStore;
beforeEach(()=>{store=new MissionGoStore(":memory:");seedStoreActors(store,["human-1"]);});
afterEach(()=>store.close());
function seed() {
 const product=store.createProduct({name:"Project",keyPrefix:"PRJ"});
 const item=store.createWorkItem({productId:product.id,title:"Fix",description:"Fix",type:"bug",priority:"normal",status:"ready",environment:{platform:"web"}});
 store.claimWorkItem({itemKey:item.key,agentId:"test",idempotencyKey:"claim"});
 const discovery=new CompletionDiscovery(store);
 const node=new DispatchStore(store.database).registerNode({accountId:"account-1",installationId:"installation",name:"Node"});
 store.database.connection.prepare("INSERT INTO node_product_repos(id,node_id,product_id,repo_path,created_at,updated_at) VALUES (?,?,?,?,?,?)").run("mapping",node.nodeId,product.id,"/example/repository",new Date().toISOString(),new Date().toISOString());
 return {item,product,discovery,node};
}
const completion={kind:"github" as const,url:"https://github.com/example/project/pull/385"};
describe("completion discovery",()=>{
 it("extracts agent comments as hints without treating a merge assertion as evidence",()=>{
  const {item,discovery,node}=seed();
  const c=store.createComment({itemKey:item.key,actorKind:"agent",bodyKind:"free",body:{text:"PR #385 已合并 main (60ca83a)，CI 全过"},idempotencyKey:"comment"});
  discovery.request(item.key,"account-1");
  const job=discovery.claim(node.nodeId,"account-1",()=>{})!;
  expect(job.hints).toContainEqual({kind:"github",value:"385",commentId:c.id});
  expect(job.hints).toContainEqual({kind:"commit",value:"60ca83a",commentId:c.id});
  discovery.report(job.id,{leaseToken:job.leaseToken,repository:"https://github.com/example/project",candidates:[{completion,title:"Fix",state:"merged",commentId:c.id}]},node.nodeId,"account-1");
  expect(store.getWorkItem(item.key).status).toBe("in_progress");
  expect(new StatusChecks(store).list(item.productId).items).toEqual([]);
  expect(()=>discovery.assertSelection(item.key,job.id,0,completion)).not.toThrow();
 });
 it("preserves offline requests, leases to the mapped account, and repeated requests do not steal a lease",()=>{
  const {item,discovery,node}=seed();discovery.request(item.key,"account-1");
  expect(discovery.snapshot(item.key)?.status).toBe("waiting_node");
  expect(discovery.claim(node.nodeId,"stranger",()=>{})).toBeNull();
  expect(discovery.claim(node.nodeId,"account-1",()=>{throw Error("denied");})).toBeNull();
  const job=discovery.claim(node.nodeId,"account-1",()=>{})!;
  discovery.request(item.key,"account-1");
  expect(discovery.claim(node.nodeId,"account-1",()=>{})).toBeNull();
  expect(()=>discovery.report(job.id,{leaseToken:"00000000-0000-4000-8000-000000000000",repository:"https://github.com/example/project",candidates:[]},node.nodeId,"account-1")).toThrow(/lease/i);
  discovery.report(job.id,{leaseToken:job.leaseToken,repository:"https://github.com/example/project",candidates:[]},node.nodeId,"account-1");
  expect(discovery.snapshot(item.key)?.status).toBe("empty");
 });
 it("rejects foreign repository candidates and changed repository mappings",()=>{
  const {item,discovery,node}=seed();discovery.request(item.key,"account-1");const job=discovery.claim(node.nodeId,"account-1",()=>{})!;
  const raw={leaseToken:job.leaseToken,repository:"https://github.com/other/project",candidates:[{completion,title:"Wrong repository",state:"merged"}]};
  expect(()=>discovery.report(job.id,raw,node.nodeId,"account-1")).toThrow(/repository/i);
  store.database.connection.prepare("UPDATE node_product_repos SET repo_path='/other'").run();
  expect(()=>discovery.report(job.id,{...raw,candidates:[]},node.nodeId,"account-1")).toThrow(/lease/i);
 });
 it("rejects stale round reports and excludes old-round or withdrawn comments",()=>{
  const {item,discovery,node}=seed();
  const c=store.createComment({itemKey:item.key,actorKind:"agent",bodyKind:"free",body:{text:"PR #385"},idempotencyKey:"old"});
  discovery.request(item.key,"account-1");const job=discovery.claim(node.nodeId,"account-1",()=>{})!;
  store.database.connection.prepare("UPDATE work_item_comments SET withdrawn_at=? WHERE id=?").run(new Date().toISOString(),c.id);
  expect(()=>discovery.report(job.id,{leaseToken:job.leaseToken,repository:"https://github.com/example/project",candidates:[{completion,title:"Fix",state:"merged",commentId:c.id}]},node.nodeId,"account-1")).toThrow(/source comment/i);
  store.database.connection.prepare("UPDATE work_items SET content_version=content_version+1 WHERE id=?").run(item.id);
  expect(discovery.snapshot(item.key)?.status).toBe("stale");
  expect(()=>discovery.report(job.id,{leaseToken:job.leaseToken,candidates:[],failure:"failed"},node.nodeId,"account-1")).toThrow(/round/i);
 });
 it("does not let a previous handover suppress discovery in a new round",()=>{
  const {item,discovery,node}=seed();
  const checks=new StatusChecks(store);
  checks.register(item.key,"account-1",{completion});
  store.createComment({itemKey:item.key,actorKind:"agent",bodyKind:"free",body:{text:"PR #385"},idempotencyKey:"previous"});
  discovery.request(item.key,"account-1");
  store.transitionWorkItem({itemKey:item.key,to:"ready",actor:"human",reason:"released",note:"New work"});
  store.claimWorkItem({itemKey:item.key,agentId:"test",idempotencyKey:"claim-round-2"});
  expect(checks.request(item.productId,"account-1",item.key).missingAssociation).toBe(true);
  discovery.request(item.key,"account-1");
  expect(discovery.claim(node.nodeId,"account-1",()=>{})?.hints).toEqual([]);
 });
 it("bounds hints and permits permission failures to retry without a repository",()=>{
  const {item,discovery,node}=seed();
  store.createComment({itemKey:item.key,actorKind:"human",bodyKind:"free",body:{text:Array.from({length:80},(_,n)=>`PR #${n+1}`).join(" ")}});
  discovery.request(item.key,"account-1");const job=discovery.claim(node.nodeId,"account-1",()=>{})!;
  expect(job.hints).toHaveLength(30);
  discovery.report(job.id,{leaseToken:job.leaseToken,candidates:[],failure:"permission_failed"},node.nodeId,"account-1");
  expect(discovery.snapshot(item.key)?.status).toBe("permission_failed");
  discovery.request(item.key,"account-1");expect(discovery.claim(node.nodeId,"account-1",()=>{})).not.toBeNull();
 });
 it("requires a real processing round and an unchanged candidate before association",()=>{
  const {item,discovery,node}=seed();discovery.request(item.key,"account-1");const job=discovery.claim(node.nodeId,"account-1",()=>{})!;
  discovery.report(job.id,{leaseToken:job.leaseToken,repository:"https://github.com/example/project",candidates:[{completion,title:"Fix",state:"merged"}]},node.nodeId,"account-1");
  expect(()=>discovery.assertSelection(item.key,job.id,1,completion)).toThrow(/Refresh/);
  expect(()=>discovery.assertSelection(item.key,job.id,0,{...completion,url:completion.url+"9"})).toThrow(/Refresh/);
  store.database.connection.prepare("UPDATE node_product_repos SET repo_path='/changed'").run();
  expect(()=>discovery.assertSelection(item.key,job.id,0,completion)).toThrow(/mapping/);
  const draft=store.createWorkItem({productId:item.productId,title:"Unclaimed",description:"Unclaimed",type:"bug",priority:"normal",environment:{platform:"web"}});
  expect(()=>discovery.request(draft.key,"account-1")).toThrow();
 });
});
