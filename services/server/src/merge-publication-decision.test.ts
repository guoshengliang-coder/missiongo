import { describe, expect, it } from "vitest";
import { batchPublicationDeferred, deferredPublicationScope } from "./merge-reconciliation.js";

function fixture() {
  const batch:Parameters<typeof batchPublicationDeferred>[0]={id:"original-batch",publish:true,operation:"merge_and_publish",
    selection:[{id:"delivery",revision:"frozen-revision"}],deliveries:["delivery"],publicationScope:{digest:"frozen-publication"},
    reconciliation:{requests:[{id:"human-choice",digest:"request-digest",snapshot:"reviewed-snapshot",at:"2026-11-16T00:00:00Z",
      action:{kind:"defer_publication",reason:"Finish this frozen batch without publishing"},decision:"approved",
      decidedAt:"2026-11-16T00:00:01Z",decidedBy:"authorized-human",appliedAt:"2026-11-16T00:00:02Z"}],history:[],handoffs:{}}};
  batch.reconciliation!.publication={decision:"defer_publication",reason:batch.reconciliation!.requests[0]!.action.kind==="defer_publication"?batch.reconciliation!.requests[0]!.action.reason:"",
    requestId:"human-choice",resultsDigest:"initial-results",batchScopeDigest:deferredPublicationScope(batch)};
  return batch;
}

describe("whole-batch publication deferral",()=>{
  it("requires an applied human decision and never upgrades an old finish-only record",()=>{
    const original=fixture();expect(batchPublicationDeferred(original)).toBe(true);
    for(const mutate of [
      (b:typeof original)=>{delete b.reconciliation!.publication!.batchScopeDigest;},
      (b:typeof original)=>{delete b.reconciliation!.requests[0]!.decision;},
      (b:typeof original)=>{b.reconciliation!.requests[0]!.decision="rejected";},
      (b:typeof original)=>{delete b.reconciliation!.requests[0]!.appliedAt;},
      (b:typeof original)=>{delete b.reconciliation!.requests[0]!.decidedBy;},
      (b:typeof original)=>{b.reconciliation!.publication!.requestId="unrelated";},
      (b:typeof original)=>{b.reconciliation!.publication!.reason="different decision";},
      (b:typeof original)=>{b.reconciliation!.requests[0]!.action={kind:"allow_partial_publication",reason:"different authority"};},
    ]) {const batch=structuredClone(original);mutate(batch);expect(batchPublicationDeferred(batch)).toBe(false);}
  });
  it("cannot transfer a deferral to a different batch, selection, publication scope or reference",()=>{
    const original=fixture();
    for(const mutate of [
      (b:typeof original)=>{b.id="another-batch";},
      (b:typeof original)=>{b.selection[0]!.revision="new-scope";},
      (b:typeof original)=>{b.deliveries.push("extra-delivery");},
      (b:typeof original)=>{b.publicationScope!.digest="new-publication";},
      (b:typeof original)=>{b.references={delivery:{head:"external-head"}};},
      (b:typeof original)=>{b.operation="publish_only";},
    ]) {const batch=structuredClone(original);mutate(batch);expect(batchPublicationDeferred(batch)).toBe(false);}
  });
});
