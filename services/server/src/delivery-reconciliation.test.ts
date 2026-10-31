import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { MissionGoStore } from "./store.js";
import { StatusChecks } from "./status-checks.js";
import { DispatchStore } from "./dispatch-store.js";

let store: MissionGoStore;
const pr = "https://github.com/example/project/pull/42";
const merged = {commit:"a".repeat(40),occurredAt:"2026-10-31T01:00:00Z"};
const release = {artifact:"web",version:"1.0.0",sourceCommit:"b".repeat(40),containsMergeCommit:merged.commit,
  verifiedAt:"2026-10-31T01:00:00Z",receiptDigest:"c".repeat(64)};
beforeEach(() => {
  vi.useFakeTimers({toFake:["Date"]}); vi.setSystemTime("2026-10-31T01:00:00Z");
  store = new MissionGoStore(":memory:");
});
afterEach(() => {store.close();vi.useRealTimers();});
function fixture() {
  const product = store.createProduct({name:"Example",keyPrefix:"EX"});
  const item = store.createWorkItem({productId:product.id,title:"Fix delivery",description:"Original requirement",type:"task",priority:"normal",status:"ready",environment:{platform:"web"}});
  store.claimWorkItem({itemKey:item.key,agentId:"Codex",idempotencyKey:`claim-${item.key}`});
  const checks = new StatusChecks(store);
  const handover = checks.register(item.key,"owner",{pullRequestUrl:pr,requiredArtifacts:["web"]});
  return {item,product,checks,handover};
}
function move(key:string,to:"ready"|"inbox") {
  store.transitionWorkItem({itemKey:key,to,actor:"human",reason:"manual_override",note:"Change planning status"});
}

it.each(["ready","inbox"] as const)("corrects a manual move to %s from verified merge and then verified publication",to => {
  const {item,checks,handover} = fixture(); move(item.key,to);
  expect(checks.snapshot(handover.id).requestedAt).toBeTruthy();
  expect(checks.report(handover.id,{merged},{accountId:"owner"})).toMatchObject({itemStatus:"development_complete",status:"waiting_release"});
  const correction = store.getTimeline(item.key).at(-1)!;
  expect(correction).toMatchObject({actorKind:"system",fromStatus:to,toStatus:"development_complete",
    payload:{reconciledFrom:to,handoverId:handover.id,occurredAt:merged.occurredAt}});
  expect(checks.report(handover.id,{releases:[release]},{accountId:"owner"})).toMatchObject({itemStatus:"pending_verification",status:"checked"});
});

it("corrects another manual move after a previously successful correction without duplicate events",() => {
  const {item,checks,handover} = fixture();
  checks.report(handover.id,{merged,releases:[release]},{accountId:"owner"});
  for (const to of ["ready","inbox"] as const) {
    move(item.key,to); const before=store.getTimeline(item.key).length;
    checks.report(handover.id,{merged,releases:[release]},{accountId:"owner"});
    expect(store.getWorkItem(item.key).status).toBe("pending_verification");
    expect(store.getTimeline(item.key)).toHaveLength(before+2);
    checks.report(handover.id,{merged,releases:[release]},{accountId:"owner"});
    expect(store.getTimeline(item.key)).toHaveLength(before+2);
  }
});

it("allows the original execution to register its PR after a card was moved to drafts",() => {
  const {item,checks} = fixture(); move(item.key,"inbox");
  const registered = checks.register(item.key,"owner",{pullRequestUrl:"https://github.com/example/project/pull/43"});
  expect(checks.report(registered.id,{merged},{accountId:"owner"})).toMatchObject({itemStatus:"development_complete",status:"needs_scope"});
});

it("rechecks an old publication observation after a second manual move",()=>{
  const {item,checks,handover}=fixture();
  checks.report(handover.id,{merged,releases:[release]},{accountId:"owner"});
  vi.setSystemTime("2026-10-31T01:10:00Z"); move(item.key,"ready");
  checks.request(item.productId,"owner",item.key);
  expect(checks.snapshot(handover.id)).toMatchObject({itemStatus:"development_complete",status:"waiting_node"});
  expect(checks.snapshot(handover.id).requestedAt).toBeTruthy();
  const refreshed={...release,verifiedAt:"2026-10-31T01:10:00Z"};
  expect(checks.report(handover.id,{releases:[refreshed]},{accountId:"owner"}).itemStatus).toBe("pending_verification");
});

it("requires stored evidence even when an internal caller supplies a handover ID",()=>{
  const {item,handover}=fixture();move(item.key,"ready");
  expect(()=>store.submitDevelopmentComplete({itemKey:item.key,pullRequestUrl:pr,idempotencyKey:"forged-evidence"},
    {actor:"system",occurredAt:merged.occurredAt,handoverId:handover.id})).toThrow(/current processing round/);
  expect(store.getWorkItem(item.key).status).toBe("ready");
});

it("exposes the current delivery phase rather than session completion",()=>{
  const {item,checks,handover}=fixture();
  expect(store.getWorkItem(item.key).deliveryProgress).toBe("waiting_merge");move(item.key,"ready");
  expect(store.getWorkItem(item.key).deliveryProgress).toBe("waiting_merge");
  checks.report(handover.id,{merged},{accountId:"owner"});
  expect(store.getWorkItem(item.key).deliveryProgress).toBe("waiting_release");
  checks.report(handover.id,{releases:[release]},{accountId:"owner"});
  expect(store.getWorkItem(item.key).deliveryProgress).toBeUndefined();
});

it("never treats an untouched draft or ready item as a previous execution",() => {
  const {product,checks}=fixture();
  for(const status of ["inbox","ready"] as const) {
    const item=store.createWorkItem({productId:product.id,title:"Not started",description:"No claim",type:"task",priority:"normal",status,environment:{platform:"web"}});
    expect(()=>checks.register(item.key,"owner",{pullRequestUrl:pr})).toThrow(/recorded start/);
  }
});

it("does not promote a manually moved card from session completion, PR registration or missing merge evidence",() => {
  const {item,checks,handover}=fixture(); move(item.key,"ready");
  expect(checks.report(handover.id,{failure:"waiting_merge"},{accountId:"owner"}).itemStatus).toBe("ready");
  expect(()=>store.transitionWorkItem({itemKey:item.key,to:"development_complete",actor:"system",reason:"resolution_submitted"})).toThrow(/verified handover evidence/);
  expect(()=>store.submitDevelopmentComplete({itemKey:item.key,pullRequestUrl:pr,idempotencyKey:"unverified"})).toThrow(/in-progress/);
});

it("invalidates failed verification immediately, before a new claim",() => {
  const {item,checks,handover}=fixture();
  checks.report(handover.id,{merged,releases:[release]},{accountId:"owner"});
  store.transitionWorkItem({itemKey:item.key,to:"ready",actor:"human",reason:"verification_failed",note:"Still broken"});
  expect(checks.report(handover.id,{merged,releases:[release]},{accountId:"owner"})).toMatchObject({status:"stale",itemStatus:"ready"});
});

it("invalidates completed work that was explicitly reopened",() => {
  const {item,checks,handover}=fixture();
  checks.report(handover.id,{merged,releases:[release]},{accountId:"owner"});
  store.transitionWorkItem({itemKey:item.key,to:"done",actor:"human",reason:"verification_passed"});
  store.transitionWorkItem({itemKey:item.key,to:"ready",actor:"human",reason:"reopened",note:"New problem"});
  expect(checks.report(handover.id,{merged},{accountId:"owner"})).toMatchObject({status:"stale",itemStatus:"ready"});
});

it("invalidates an old association when requirements change, and requires a new verification",() => {
  const {item,checks,handover}=fixture(); vi.setSystemTime("2026-10-31T01:01:00Z");
  store.updateWorkItem(item.key,{description:"New requirement"});
  expect(checks.report(handover.id,{merged},{accountId:"owner"})).toMatchObject({status:"stale",itemStatus:"in_progress"});
  const revised=checks.register(item.key,"owner",{pullRequestUrl:pr,requiredArtifacts:["web"]});
  expect(revised.id).not.toBe(handover.id);
  expect(checks.report(revised.id,{merged},{accountId:"owner"}).status).toBe("evidence_missing");
  expect(checks.report(revised.id,{merged:{...merged,occurredAt:"2026-10-31T01:01:00Z"}},{accountId:"owner"}).itemStatus).toBe("development_complete");
});

it("keeps a handover valid for a priority edit and an unchanged save",() => {
  const {item,checks,handover}=fixture();
  store.updateWorkItem(item.key,{priority:"high"});
  store.updateWorkItem(item.key,{title:item.title,description:item.description});
  expect(checks.report(handover.id,{merged},{accountId:"owner"}).itemStatus).toBe("development_complete");
});

it("handles items sharing a PR independently after only one begins a new round",() => {
  const {item,product,checks,handover}=fixture();
  const other=store.createWorkItem({productId:product.id,title:"Other",description:"Other task",type:"task",priority:"normal",status:"ready",environment:{platform:"web"}});
  store.claimWorkItem({itemKey:other.key,agentId:"Codex",idempotencyKey:"other"});
  const otherHandover=checks.register(other.key,"owner",{pullRequestUrl:pr,requiredArtifacts:["web"]});
  move(item.key,"ready"); store.claimWorkItem({itemKey:item.key,agentId:"Codex",idempotencyKey:"new-round"});
  expect(checks.report(handover.id,{merged},{accountId:"owner"}).status).toBe("stale");
  expect(checks.report(otherHandover.id,{merged,releases:[release]},{accountId:"owner"}).itemStatus).toBe("pending_verification");
  expect(store.getWorkItem(item.key).status).toBe("in_progress");
});

it.each(["cancelled","on_hold","done"] as const)("does not overwrite a human decision to move to %s",to => {
  const {item,checks,handover}=fixture();
  store.transitionWorkItem({itemKey:item.key,to,actor:"human",reason:"manual_override",note:"Human decision"});
  checks.report(handover.id,{merged,releases:[release]},{accountId:"owner"});
  expect(store.getWorkItem(item.key).status).toBe(to);
});

it("queues manually returned work for a mapped node and periodic checks",() => {
  const {item,product,checks,handover}=fixture();
  const dispatches=new DispatchStore(store.database);
  const node=dispatches.registerNode({name:"Mac",installationId:"reconciliation-node",accountId:"owner"});
  dispatches.replaceRepos("owner",node.nodeId,[{productId:product.id,repoPath:"/synthetic/project"}]);
  move(item.key,"inbox");
  expect(checks.claim(node.nodeId,"owner",()=>{})).toMatchObject({id:handover.id,itemStatus:"inbox"});
  expect(checks.report(handover.id,{failure:"waiting_merge"},{accountId:"owner"}).itemStatus).toBe("inbox");
  checks.schedule("09:00",()=>true);
  expect(checks.snapshot(handover.id).requestedAt).toBeTruthy();
});
