import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MissionGoStore } from "./store.js";
import { StatusChecks } from "./status-checks.js";
import { DispatchStore } from "./dispatch-store.js";

let store: MissionGoStore;
beforeEach(()=>{vi.useFakeTimers({toFake:["Date"]});vi.setSystemTime(new Date("2026-10-27T01:00:00Z"));store=new MissionGoStore(":memory:");});
afterEach(()=>{store.close();vi.useRealTimers();});
const pr="https://github.com/example/project/pull/42";
const merged={commit:"a".repeat(40),occurredAt:"2026-10-27T01:00:00Z"};
const release=(artifact="web")=>({artifact,version:"1.2.0",sourceCommit:"b".repeat(40),containsMergeCommit:merged.commit,verifiedAt:"2026-10-27T01:00:00Z",receiptDigest:"c".repeat(64)});
function seed(requiredArtifacts: string[] | undefined=["web"], noReleaseReason?:string) {
 const product=store.createProduct({name:"Project",keyPrefix:"PRJ"});
 const item=store.createWorkItem({productId:product.id,title:"Fix",description:"Fix flow",type:"bug",priority:"normal",environment:{platform:"web"}});
 store.transitionWorkItem({itemKey:item.key,to:"ready",actor:"human",reason:"triaged"});
 store.claimWorkItem({itemKey:item.key,agentId:"test",idempotencyKey:"claim"});
 const checks=new StatusChecks(store);
 const handover=checks.register(item.key,"account-1",{pullRequestUrl:pr,...(requiredArtifacts ? {requiredArtifacts}:{}),...(noReleaseReason?{noReleaseReason}:{})});
 return {product,item,checks,handover};
}
describe("durable handover checks",()=>{
 it("persists registration before merge and repairs a missed handoff without a fresh deployment",()=>{
  const {item,checks,handover}=seed();expect(handover.status).toBe("waiting_merge");
  const before=store.getTimeline(item.key).length;
  const data={merged,releases:[release()]};
  expect(checks.report(handover.id,data,{accountId:"account-1"}).itemStatus).toBe("pending_verification");
  checks.report(handover.id,data,{accountId:"account-1"});checks.request(item.productId,"account-1");
  const events=store.getTimeline(item.key).slice(before);
  expect(events).toHaveLength(2);expect(events.every(e=>e.actorKind==="system")).toBe(true);
  expect(events[1]?.payload.occurredAt).toBe(release().verifiedAt);
  expect(store.getWorkItem(item.key).status).not.toBe("done");
 });
 it("waits for every explicitly declared artifact across separate publication batches",()=>{
  const {checks,handover}=seed(["web","macosApp"]);
  expect(checks.report(handover.id,{merged,releases:[release()]},{accountId:"account-1"})).toMatchObject({itemStatus:"development_complete",status:"waiting_release"});
  expect(checks.report(handover.id,{releases:[release("macosApp")]},{accountId:"account-1"}).itemStatus).toBe("development_complete");
  expect(checks.report(handover.id,{releases:[release(),release("macosApp")]},{accountId:"account-1"}).itemStatus).toBe("pending_verification");
 });
 it("keeps unknown scope separate from explicit no-release work",()=>{
  const {item,checks}=seed();
  const unknown=checks.register(item.key,"account-1",{pullRequestUrl:pr});
  expect(checks.report(unknown.id,{merged},{accountId:"account-1"}).status).toBe("needs_scope");
  expect(store.getWorkItem(item.key).status).toBe("in_progress");
  expect(()=>checks.register(item.key,"account-1",{pullRequestUrl:pr,requiredArtifacts:[]})).toThrow(/reason/);
  const explicit=checks.register(item.key,"account-1",{pullRequestUrl:pr,requiredArtifacts:[],noReleaseReason:"Only a test; verify in CI"});
  expect(explicit).toMatchObject({status:"checked",itemStatus:"development_complete"});
 });
 it("does not reuse old proof after a human returns the work and a new round begins",()=>{
  const {checks,handover,item}=seed();
  checks.report(handover.id,{merged,releases:[release()]},{accountId:"account-1"});
  store.transitionWorkItem({itemKey:item.key,to:"ready",actor:"human",reason:"verification_failed",note:"Still broken"});
  store.claimWorkItem({itemKey:item.key,agentId:"test",idempotencyKey:"claim-round-2"});
  expect(checks.report(handover.id,{merged,releases:[release()]},{accountId:"account-1"}).status).toBe("stale");
  expect(store.getWorkItem(item.key).status).toBe("in_progress");
 });
 it("keeps PRs merged before the current work round for human review",()=>{
  const {checks,handover,item}=seed();
  expect(checks.report(handover.id,{merged:{...merged,occurredAt:"2026-10-26T00:00:00Z"}},{accountId:"account-1"})).toMatchObject({status:"evidence_missing",itemStatus:"in_progress"});
  expect(store.getWorkItem(item.key).status).toBe("in_progress");
 });
 it("rejects releases without the exact verified merge, foreign artifacts and future proof",()=>{
  const {checks,handover}=seed();
  expect(()=>checks.report(handover.id,{releases:[release()]},{accountId:"account-1"})).toThrow(/merge/);
  expect(()=>checks.report(handover.id,{merged,releases:[{...release(),containsMergeCommit:"d".repeat(40)}]},{accountId:"account-1"})).toThrow(/merge/);
  expect(()=>checks.report(handover.id,{merged,releases:[release("unregistered")]},{accountId:"account-1"})).toThrow(/Unknown/);
  expect(()=>checks.report(handover.id,{merged:{...merged,occurredAt:"2027-01-01T00:00:00Z"}},{accountId:"account-1"})).toThrow(/future/);
 });
 it("runs daily once after the configured Beijing time, including after restart",()=>{
  const {checks,product,handover}=seed();
  checks.schedule("09:00",()=>true,new Date("2026-10-27T00:59:00Z"));
  expect(store.database.connection.prepare("SELECT * FROM status_check_days").all()).toHaveLength(0);
  checks.schedule("09:00",()=>true,new Date("2026-10-27T01:00:00Z"));
  new StatusChecks(store).schedule("09:00",()=>true,new Date("2026-10-27T15:59:00Z"));
  expect(store.database.connection.prepare("SELECT * FROM status_check_days").all()).toHaveLength(1);
  expect(checks.list(product.id).items[0]?.id).toBe(handover.id);
  checks.schedule("09:00",()=>false,new Date("2026-10-28T01:00:00Z"));
  expect(store.database.connection.prepare("SELECT * FROM status_check_days").all()).toHaveLength(1);
  checks.schedule("09:00",()=>true,new Date("2026-10-28T01:00:00Z"));
  expect(store.database.connection.prepare("SELECT * FROM status_check_days").all()).toHaveLength(2);
 });
 it("keeps offline jobs durable, leases only to an account-owned mapped node and rejects a stale lease",()=>{
  const {checks,handover,product}=seed();
  const dispatches=new DispatchStore(store.database);
  const node=dispatches.registerNode({accountId:"account-1",installationId:"node-installation",name:"Node"});
  const stranger=dispatches.registerNode({accountId:"other",installationId:"other-installation",name:"Other"});
  store.database.connection.prepare("INSERT INTO node_product_repos(id,node_id,product_id,repo_path,created_at,updated_at) VALUES (?,?,?,?,?,?)").run("mapping",node.nodeId,product.id,"/example/repository",new Date().toISOString(),new Date().toISOString());
  expect(checks.request(product.id,"account-1").queued).toBe(1);
  expect(checks.claim(stranger.nodeId,"other",()=>{})).toBeNull();
  const job=checks.claim(node.nodeId,"account-1",()=>{})!;
  expect(job.id).toBe(handover.id);expect(checks.claim(node.nodeId,"account-1",()=>{})).toBeNull();
  expect(()=>checks.report(job.id,{merged},{accountId:"account-1",nodeId:node.nodeId,leaseToken:"wrong"})).toThrow(/lease/);
  expect(checks.report(job.id,{merged},{accountId:"account-1",nodeId:node.nodeId,leaseToken:job.leaseToken}).itemStatus).toBe("development_complete");
 });
 it("accepts an explicitly corrected release scope after a development handoff",()=>{
  const {checks,handover,item}=seed(["web","macosApp"]);
  checks.report(handover.id,{merged,releases:[release()]},{accountId:"account-1"});
  expect(checks.register(item.key,"account-1",{pullRequestUrl:pr,requiredArtifacts:["web"]}).itemStatus).toBe("pending_verification");
 });
});
