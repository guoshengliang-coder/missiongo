import { describe, expect, it } from "vitest";
import { projectCheckSatisfied } from "@missiongo/contracts";
import { mergeEvidenceSchema } from "./merge-deliveries.js";
import { integrationActionSchema, applyIntegrationAction, assertIntegrationMerge } from "./merge-integration.js";
import { mergedObservationSchema } from "./merge-reconciliation.js";
import { assertProjectBinding } from "./project-verification.js";
const head="a".repeat(40), base="b".repeat(40);
import { verification } from "./project-verification-fixture.js";
const evidence={head,base,checkedAt:new Date().toISOString(),checks:"not_applicable",mergeable:"clean",source:"https://github.com/example/native/pull/1",verification};
describe("project-specific verification",()=>{
  it("distinguishes verified absence from unknown, pending and failed checks",()=>{
    expect(mergeEvidenceSchema.parse(evidence).checks).toBe("not_applicable");
    for(const state of ["unknown","pending","failed"])expect(projectCheckSatisfied(state,verification)).toBe(false);
    for(const change of [{verification:undefined},{verification:{...verification,ci:"required"}},{verification:{...verification,requiredChecks:["build"]}},{verification:{...verification,observedChecks:["build"]}},{verification:{...verification,platformRead:"failed"}},{verification:{...verification,rulesSource:""}}])
      expect(()=>mergeEvidenceSchema.parse({...evidence,...change})).toThrow();
    expect(()=>mergeEvidenceSchema.parse({...evidence,checks:"passed",verification:{...verification,requiredChecks:["build"]}})).toThrow();
  });
  it("binds project and target without demanding a main branch or a particular merge method",()=>{
    expect(()=>assertProjectBinding(verification,verification.repository,"develop")).not.toThrow();
    expect(()=>assertProjectBinding(verification,"https://github.com/other/project","develop")).toThrow();
    expect(()=>assertProjectBinding(verification,verification.repository,"main")).toThrow();
  });
  it("accepts a complete no-CI check through plan, merge gate and recovery without claiming passed",()=>{
    const state={protocol:1 as const,revision:0,events:[],plans:[],entries:{one:{itemKeys:[],originalHead:head,head,progress:"queued" as const,detail:"",repairs:[]}}};
    applyIntegrationAction(state,integrationActionSchema.parse({kind:"plan",base,summary:"Native project",validation:"Existing project smoke validation",entries:[{deliveryId:"one",head,dependsOn:[],group:"one",reason:"Independent",validation:"Smoke"}]}),"plan",{});
    const check={kind:"check",deliveryId:"one",expectedHead:head,...evidence,local:"not_applicable",validation:"Manual smoke verified; automated tests do not apply"};
    applyIntegrationAction(state,integrationActionSchema.parse(check),"check",{});
    expect(()=>assertIntegrationMerge(state,"one",{})).not.toThrow();
    expect(mergedObservationSchema.parse({head,commit:base,targetHead:base,checkedAt:evidence.checkedAt,source:evidence.source,checks:"not_applicable",local:"not_applicable",verification,originalIncluded:true,targetIncludesMerge:true,validation:"Actual merge and target verified"}).checks).toBe("not_applicable");
    expect(()=>integrationActionSchema.parse({...check,verification:{...verification,local:"required"}})).toThrow();
  });
  it("does not arm pending auto-merge without both capability and reliable protection",()=>{
    const check={head,base,checkedAt:new Date().toISOString(),checks:"pending" as const,local:"passed" as const,mergeable:"clean" as const,source:"Live results",validation:"Waiting",verification:{...verification,ci:"required" as const,requiredChecks:["build"],observedChecks:["build"]}};
    const state={protocol:1 as const,revision:1,events:[],plans:[{base,summary:"Plan",validation:"CI",entries:[{deliveryId:"one",head,dependsOn:[],group:"one",reason:"Independent",validation:"CI"}],at:new Date().toISOString()}],entries:{one:{itemKeys:[],originalHead:head,head,progress:"waiting_ci" as const,detail:"",repairs:[],check}}};
    expect(()=>integrationActionSchema.parse({kind:"check",deliveryId:"one",expectedHead:head,...check,verification:{...check.verification,autoMerge:true,protectedChecks:true,requiredChecks:[],observedChecks:[]}})).toThrow();
    expect(()=>integrationActionSchema.parse({kind:"check",deliveryId:"one",expectedHead:head,...check,verification:{...check.verification,autoMerge:true,protectedChecks:true,observedChecks:["build","unprotected"]}})).toThrow();
    const withoutVerification={...state,entries:{one:{...state.entries.one,check:{...check,verification:undefined}}}};
    expect(()=>assertIntegrationMerge(withoutVerification,"one",{},{allowPendingCI:true})).toThrow();
    expect(()=>assertIntegrationMerge({...withoutVerification,entries:{one:{...withoutVerification.entries.one,check:{...check,verification:undefined,checks:"passed" as const}}}},"one",{})).not.toThrow();
    for(const autoMerge of [false,true])for(const protectedChecks of [false,true]) {
      check.verification={...check.verification,autoMerge,protectedChecks};
      if(autoMerge&&protectedChecks)expect(()=>assertIntegrationMerge(state,"one",{},{allowPendingCI:true})).not.toThrow();
      else expect(()=>assertIntegrationMerge(state,"one",{},{allowPendingCI:true})).toThrow();
      expect(()=>assertIntegrationMerge(state,"one",{})).toThrow();
    }
  });
});
