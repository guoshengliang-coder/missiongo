import {createHash} from "node:crypto";
import { describe, expect, it } from "vitest";
import { prerequisiteGate, prerequisiteObservation, prerequisitesActionSchema, recordPrerequisites, type PrerequisiteBatch } from "./merge-prerequisites.js";
import type { IntegrationPrerequisite } from "@missiongo/contracts";

export function prerequisiteEvidence(batch=fixture()) {
  const kinds=["main","installation_integrity","required_capability","authorization","scope"] as const;
  const deps={main:["base","heads"],installation_integrity:["tools"],required_capability:["tools","capabilities"],authorization:["scope","tools","capabilities"],scope:["scope","candidates"]} as const;
  return prerequisitesActionSchema.parse({kind:"prerequisites",checkedAt:new Date().toISOString(),source:"Synthetic independently observed facts",
    observation:prerequisiteObservation(batch),context:{base:"b".repeat(40),candidates:"c".repeat(64),tools:"d".repeat(64),capabilities:"e".repeat(64)},
    conditions:kinds.map(kind=>({id:kind,kind,category:"fact",stage:"pre_merge",required:true,state:"satisfied",reason:"Verified synthetic prerequisite",owner:"Original executor",resumeWhen:"Verify original evidence",
      dependencies:[...deps[kind]],...(kind==="authorization"?{authorizationRef:"original-native-request:fixture-scope"}:{})}))});
}
const fixture=():PrerequisiteBatch=>({id:"batch",publish:true,state:"active",operation:"merge_and_publish",deliveries:["one","two"],selection:[{id:"one",revision:"frozen-1"},{id:"two",revision:"frozen-2"}],results:{},
  integration:{protocol:1,revision:0,events:[],plans:[],entries:Object.fromEntries(["one","two"].map(id=>[id,{itemKeys:[],originalHead:"a".repeat(40),head:"a".repeat(40),progress:"queued",detail:"",repairs:[]}]))}});
describe("publication prerequisites",()=>{
  it("audit 3 shows base invalidation in the batch gate, then reuses unrelated evidence after refresh",()=>{
    const b=fixture(),a=prerequisiteEvidence();recordPrerequisites(b,a);
    const newer=new Date(Date.parse(a.checkedAt)+1).toISOString();
    b.integration!.entries.one!.check={head:"a".repeat(40),base:"f".repeat(40),checkedAt:newer,source:"Fresh target query",checks:"passed",mergeable:"clean",local:"passed",validation:"Actual target changed"};
    expect(prerequisiteGate(b,true).blockers).toEqual([expect.objectContaining({id:"main",code:"stale"})]);
    const permission=b.integration!.prerequisites!.conditions.find(c=>c.kind==="authorization");
    recordPrerequisites(b,{...a,checkedAt:newer,context:{...a.context,base:"f".repeat(40)},conditions:[a.conditions[0]!]});
    expect(prerequisiteGate(b,true).ready).toBe(true);
    expect(b.integration!.prerequisites!.conditions.find(c=>c.kind==="authorization")).toEqual(permission);
    expect(prerequisiteGate(b,true,"b".repeat(40)).ready).toBe(false);
  });
  it("audit 2 accepts the script's exact immutable observation without recomputing it from a later batch",async()=>{
    const {collectReadiness}=await import("../../../scripts/release-readiness.mjs");
    const b=fixture(),repository="https://github.com/example/project",head="a".repeat(40),now=Date.now();
    const report=collectReadiness({config:{schemaVersion:1,productId:"product",repository},now,
      candidates:{pages:[{productId:"product",coverageVersion:2,generatedAt:new Date(now).toISOString(),requestedBeforeSequence:null,candidates:[],noReleaseItems:[],noReleaseDeliveries:[]}]},
      batch:{...b,productId:"product",entries:b.deliveries.map((id,i)=>({id,head,repository,pullRequest:i+1,targetBranch:"main",requiredArtifacts:["web"]}))}},
      {repository:()=>repository,head:()=>head,originMain:()=>head,remoteMain:()=>head,ancestor:()=>true,tools:()=>({}),live:()=>({}),artifact:()=>[],coverage:()=>({ready:true}),versions:()=>[],patchBumps:()=>[],notes:()=>({missing:[]}),prospective:()=>({})});
    expect(report.observation).toEqual(prerequisiteObservation(b));
    const a=prerequisiteEvidence();recordPrerequisites(b,{...a,observation:report.observation});
    b.integration!.revision++;expect(prerequisiteGate(b,true).ready).toBe(true);
  });
  it("audit 1 rejects attaching an old observation to a repaired execution head",()=>{
    const b=fixture(),a=prerequisiteEvidence();recordPrerequisites(b,a);
    b.integration!.entries.one!.head="f".repeat(40);
    expect(()=>recordPrerequisites(b,a)).toThrow();
  });
  it("audit 1 cannot erase an unresolved circular dependency with an ordinary refresh",()=>{
    const b=fixture(),a=prerequisiteEvidence();a.conditions[1]!.dependsOnDeliveries=[{deliveryId:"two",head:"a".repeat(40)}];
    recordPrerequisites(b,a);
    expect(()=>recordPrerequisites(b,{...a,conditions:[{...a.conditions[1]!,dependsOnDeliveries:[]}]})).toThrow();
    const generic={...a.conditions[0]!,id:"external-fix",kind:"investigation" as const,dependsOnDeliveries:[{deliveryId:"two",head:"a".repeat(40)}]};
    recordPrerequisites(b,{...a,conditions:[generic]});
    expect(()=>recordPrerequisites(b,{...a,conditions:[{...generic,required:false}]})).toThrow();
    expect(()=>recordPrerequisites(b,{...a,conditions:[{...generic,stage:"post_merge"}]})).toThrow();
  });
  it("audit 1 rejects observations from another batch or frozen content scope",()=>{
    const b=fixture(),a=prerequisiteEvidence();
    expect(()=>recordPrerequisites({...b,id:"other-batch"},a)).toThrow(/观察/);
    b.selection[0]!.revision="new-content";
    expect(()=>recordPrerequisites(b,a)).toThrow(/观察/);
  });
  it("audit 1 resumes a circular wait only with matching evidence of an independent fix",()=>{
    const b=fixture(),a=prerequisiteEvidence();a.conditions[1]!.dependsOnDeliveries=[{deliveryId:"two",head:"a".repeat(40)}];
    recordPrerequisites(b,a);
    const fix={...a,context:{...a.context,tools:"f".repeat(64)},conditions:[{...a.conditions[1]!,dependsOnDeliveries:[]}],
      dependencyResolutions:[{conditionId:"installation_integrity",deliveryId:"two",head:"a".repeat(40),via:"tools" as const,before:a.context.tools,after:"f".repeat(64),source:"Independently installed compatible prerequisite, exact hashes verified"}]};
    expect(()=>recordPrerequisites(b,{...fix,dependencyResolutions:[{...fix.dependencyResolutions[0]!,after:a.context.tools}]})).toThrow();
    expect(()=>recordPrerequisites(b,{...fix,dependencyResolutions:[...fix.dependencyResolutions,...fix.dependencyResolutions]})).toThrow();
    recordPrerequisites(b,fix);
    expect(prerequisiteGate(b,true).blockers.map(c=>c.code)).not.toContain("cycle");
    expect(prerequisiteGate(b,true).blockers.map(c=>c.id)).toEqual(["required_capability","authorization"]);
    recordPrerequisites(b,{...fix,conditions:a.conditions.slice(2,4),dependencyResolutions:[]});
    expect(prerequisiteGate(b,true).ready).toBe(true);
    expect(b.integration!.prerequisites!.resolutions).toHaveLength(1);
    expect(b.integration!.prerequisites!.conditions.find(c=>c.kind==="authorization")!.authorizationRef).toBe(a.conditions[3]!.authorizationRef);
  });
  it("fails closed on missing, unknown and expired evidence without treating progress as a scope change",()=>{
    const b=fixture(),a=prerequisiteEvidence();expect(prerequisiteGate(b,true).ready).toBe(false);
    a.conditions[0]!.state="unknown";recordPrerequisites(b,a);expect(prerequisiteGate(b,true).blockers[0]!.code).toBe("pending");
    a.conditions[0]!.state="satisfied";recordPrerequisites(b,a);expect(prerequisiteGate(b,true).ready).toBe(true);
    b.integration!.revision++;b.integration!.events.push({id:"progress",action:"progress",detail:"Waiting",digest:"f",at:a.checkedAt});
    expect(prerequisiteGate(b,true).ready).toBe(true);
    expect(prerequisiteGate(b,true,undefined,Date.parse(a.checkedAt)+300001).blockers.every(c=>c.code==="stale")).toBe(true);
  });
  it("invalidates only dependent evidence and reuses the same original authorization reference",()=>{
    const b=fixture(),a=prerequisiteEvidence();recordPrerequisites(b,a);
    b.integration!.entries.one!.head="f".repeat(40);
    expect(prerequisiteGate(b,true).blockers.map(c=>c.id)).toEqual(["main"]);
    const auth=b.integration!.prerequisites!.conditions.find(c=>c.kind==="authorization");
    recordPrerequisites(b,{...a,observation:prerequisiteObservation(b),conditions:[a.conditions[0]!]});
    expect(prerequisiteGate(b,true).ready).toBe(true);
    expect(b.integration!.prerequisites!.conditions.find(c=>c.kind==="authorization")).toEqual(auth);
    const changed={...a,observation:prerequisiteObservation(b),context:{...a.context,tools:"f".repeat(64)},conditions:[a.conditions[1]!]};recordPrerequisites(b,changed);
    expect(prerequisiteGate(b,true).blockers.map(c=>c.id)).toEqual(["required_capability","authorization"]);
    recordPrerequisites(b,{...changed,conditions:a.conditions.slice(2,4)});
    expect(prerequisiteGate(b,true).ready).toBe(true);
    expect(b.integration!.prerequisites!.conditions.find(c=>c.kind==="authorization")!.authorizationRef).toBe(auth!.authorizationRef);
    expect(prerequisiteGate(b,true,"0".repeat(40)).blockers.map(c=>c.id)).toEqual(["main"]);
  });
  it("does not gate merge-only, publish-only, completed references or pure no-release batches",()=>{
    for(const operation of ["merge_only","publish_only"])expect(prerequisiteGate({...fixture(),operation},true).required).toBe(false);
    expect(prerequisiteGate(fixture(),false).required).toBe(false);
    const b=fixture();b.references={one:{},two:{}};expect(prerequisiteGate(b,true).required).toBe(false);
    expect(prerequisiteGate({...fixture(),state:"finished"},true).required).toBe(false);
  });
  it("keeps circular dependencies blocked even when the executor calls the fact satisfied",()=>{
    const b=fixture(),a=prerequisiteEvidence();a.conditions[1]!.dependsOnDeliveries=[{deliveryId:"two",head:"a".repeat(40)}];
    recordPrerequisites(b,a);expect(prerequisiteGate(b,true).blockers[0]).toMatchObject({id:"installation_integrity",code:"cycle"});
    b.results.two={status:"merged",head:"a".repeat(40)};expect(prerequisiteGate(b,true).ready).toBe(true);
    b.integration!.entries.two!.head="f".repeat(40);expect(prerequisiteGate(b,true).ready).toBe(false);
  });
  it("rejects downgraded integrity/capability evidence, arbitrary approval booleans and mismatched dependencies",()=>{
    for(const kind of ["installation_integrity","required_capability"] as const) {
      const a=prerequisiteEvidence(),c=a.conditions.find(c=>c.kind===kind)!;
      for(const change of [{required:false},{category:"notice"},{stage:"post_merge"},{state:"not_required"},{dependencies:["scope"]}])
        expect(()=>prerequisitesActionSchema.parse({...a,conditions:[{...c,...change}]})).toThrow();
    }
    const a=prerequisiteEvidence();expect(()=>prerequisitesActionSchema.parse({...a,approved:true})).toThrow();
    expect(()=>prerequisitesActionSchema.parse({...a,conditions:[{...a.conditions[0],id:"ordinary-drift",kind:"tool_difference"}]})).toThrow();
    expect(()=>prerequisitesActionSchema.parse({...a,conditions:[{...a.conditions[0],id:"version-before-merge",kind:"version"}]})).toThrow();
    delete a.conditions.find(c=>c.kind==="authorization")!.authorizationRef;
    expect(()=>prerequisitesActionSchema.parse(a)).toThrow();
    const b=fixture(),other=prerequisiteEvidence();other.conditions[0]!.dependsOnDeliveries=[{deliveryId:"outside",head:"a".repeat(40)}];
    expect(()=>recordPrerequisites(b,other)).toThrow();
    const stale=prerequisiteEvidence();stale.checkedAt=new Date(Date.now()-360000).toISOString();expect(()=>recordPrerequisites(b,stale)).toThrow();
  });
  it("keeps required facts separate from post-merge work and ordinary notices",()=>{
    const b=fixture(),a=prerequisiteEvidence();
    const c:IntegrationPrerequisite={id:"version",kind:"version",category:"work",stage:"post_merge",required:false,state:"pending",reason:"Bump after merge",owner:"Executor",resumeWhen:"Merge first",dependencies:["heads"]};
    recordPrerequisites(b,{...a,conditions:[...a.conditions,c,{...c,id:"tool-diff",kind:"tool_difference",category:"notice",stage:"pre_merge"}]});
    expect(prerequisiteGate(b,true).ready).toBe(true);
    b.selection[0]!.revision="new-content";
    expect(prerequisiteGate(b,true).blockers.map(c=>c.id)).toEqual(["authorization","scope"]);
  });
});

describe("native project stage adaptation",()=>{
  const finalTarget=(b:PrerequisiteBatch,head="b".repeat(40))=>{
    b.integration!.finalValidation={head,checkedAt:new Date().toISOString(),source:"Actual combined target",validation:"Combined validation",selectionDigest:createHash("sha256").update(JSON.stringify(b.results)).digest("hex")};
  };

  const native=(b=fixture())=>{
    const a=prerequisiteEvidence(b);
    return prerequisitesActionSchema.parse({...a,workflow:{tools:"project_native",repositories:["https://github.com/example/project"],source:"Existing project release guide",digest:"f".repeat(64)},context:{base:a.context.base,candidates:a.context.candidates},
      conditions:a.conditions.filter(c=>["main","authorization","scope"].includes(c.kind)).map(c=>({...c,dependencies:c.kind==="authorization"?["scope"]:c.dependencies}))});
  };
  it("needs no shared tool installation and gates the actual publication stage separately",()=>{
    const b=fixture(),a=native(b);
    a.conditions.push({id:"native-publish",kind:"investigation",category:"blocker",stage:"pre_publish",required:true,state:"unknown",reason:"Project signing credential unavailable",owner:"Project release operator",resumeWhen:"Verify existing credential",dependencies:["scope"]});
    recordPrerequisites(b,a);
    expect(prerequisiteGate(b,true).ready).toBe(true);
    expect(prerequisiteGate(b,true,undefined,Date.now(),"pre_publish").ready).toBe(false);
    finalTarget(b);
    recordPrerequisites(b,{...a,conditions:[{...a.conditions.at(-1)!,state:"satisfied"}]});
    expect(prerequisiteGate(b,true,undefined,Date.now(),"pre_publish").ready).toBe(true);
  });
  it("migrates old blockers explicitly, preserves history and rejects circular dependency waivers",()=>{
    const b=fixture(),old=prerequisiteEvidence(b);old.conditions[1]!.state="unknown";recordPrerequisites(b,old);
    const a=native(b);
    const tools=old.conditions.filter(c=>["installation_integrity","required_capability"].includes(c.kind)).map(c=>({...c,state:"not_required" as const,required:false,dependencies:["scope" as const],reason:"This project does not use the MissionGo release tools"}));
    recordPrerequisites(b,{...a,conditions:[...a.conditions,...tools]});
    expect(prerequisiteGate(b,true).ready).toBe(true);
    expect(b.integration!.prerequisites!.history?.[0]?.conditions.find(c=>c.kind==="installation_integrity")).toMatchObject({state:"unknown"});
    const cycle=fixture(),prior=prerequisiteEvidence(cycle);prior.conditions[1]!.dependsOnDeliveries=[{deliveryId:"two",head:"a".repeat(40)}];recordPrerequisites(cycle,prior);
    expect(()=>recordPrerequisites(cycle,{...native(cycle),conditions:[...a.conditions,...tools]})).toThrow(/循环/);
  });
  it("refreshes project rule bindings without changing scope authorization or granting permission",()=>{
    const b=fixture(),a=native(b);recordPrerequisites(b,a);
    recordPrerequisites(b,{...a,workflow:{...a.workflow!,source:"Changed project rule source"},conditions:[a.conditions[0]!]});
    expect(prerequisiteGate(b,true).ready).toBe(false);
    expect(()=>prerequisitesActionSchema.parse({...a,conditions:[{...a.conditions.find(c=>c.kind==="authorization")!,authorizationRef:undefined}]})).toThrow();
  });
});

describe("audit publication target and sustainable refresh",()=>{
  it.each(["pending","unknown","satisfied"] as const)("gates legacy publication evidence without workflow: %s",state=>{
    const b=fixture(),a=prerequisiteEvidence(b);
    a.conditions.push({id:"legacy-signing",kind:"investigation",category:"blocker",stage:"pre_publish",required:true,state,reason:"Actual signing prerequisite",owner:"Original executor",resumeWhen:"Verify signing",dependencies:["scope"]});
    recordPrerequisites(b,a);
    b.results={one:{status:"merged",head:"a".repeat(40)},two:{status:"merged",head:"a".repeat(40)}};
    b.integration!.finalValidation={head:a.context.base!,checkedAt:new Date().toISOString(),source:"Final target",validation:"Combined",selectionDigest:createHash("sha256").update(JSON.stringify(b.results)).digest("hex")};
    const gate=prerequisiteGate(b,true,undefined,Date.now(),"pre_publish");
    expect(gate.required).toBe(true);
    expect(gate.blockers.some(c=>c.id==="legacy-signing")).toBe(state!=="satisfied");
    expect(prerequisiteGate(b,true,undefined,Date.now()+300_001,"pre_publish").blockers).toContainEqual(expect.objectContaining({id:"legacy-signing",code:"stale"}));
  });

  it("binds publication to actual complete combined target, requiring only affected evidence to refresh",()=>{
    const b=fixture(),a=prerequisiteEvidence(b);
    const workflow={tools:"project_native" as const,repositories:["https://github.com/example/project"],source:"Existing native rules",digest:"f".repeat(64)};
    const native=prerequisitesActionSchema.parse({...a,workflow,context:{base:a.context.base,candidates:a.context.candidates},conditions:a.conditions.filter(c=>["main","authorization","scope"].includes(c.kind)).map(c=>({...c,dependencies:c.kind==="authorization"?["scope"]:c.dependencies}))});
    recordPrerequisites(b,native);
    expect(prerequisiteGate(b,true,undefined,Date.now(),"pre_publish").blockers.some(c=>c.id==="combined_target")).toBe(true);
    b.results={one:{status:"merged",head:"a".repeat(40)},two:{status:"merged",head:"a".repeat(40)}};
    b.integration!.finalValidation={head:"d".repeat(40),checkedAt:new Date().toISOString(),source:"Final target",validation:"Combined",selectionDigest:createHash("sha256").update(JSON.stringify(b.results)).digest("hex")};
    expect(prerequisiteGate(b,true,undefined,Date.now(),"pre_publish").blockers).toEqual([expect.objectContaining({id:"main",code:"stale"})]);
    const authorization=b.integration!.prerequisites!.conditions.find(c=>c.kind==="authorization");
    recordPrerequisites(b,{...native,context:{...native.context,base:"d".repeat(40)},conditions:[native.conditions.find(c=>c.kind==="main")!]});
    expect(prerequisiteGate(b,true,undefined,Date.now(),"pre_publish").ready).toBe(true);
    expect(b.integration!.prerequisites!.conditions.find(c=>c.kind==="authorization")).toEqual(authorization);
    b.integration!.finalValidation.selectionDigest="0".repeat(64);
    expect(prerequisiteGate(b,true,undefined,Date.now(),"pre_publish").ready).toBe(false);
  });
  it("continues ordinary renewals and substantive history beyond fifty updates without losing the original records",()=>{
    const b=fixture(),a=prerequisiteEvidence(b);recordPrerequisites(b,a);
    for(let i=0;i<60;i++)recordPrerequisites(b,{...a,checkedAt:new Date().toISOString()});
    expect(b.integration!.prerequisites!.history).toEqual([]);
    for(let i=0;i<60;i++)recordPrerequisites(b,{...a,conditions:[{...a.conditions[0]!,reason:`Actual source correction ${i}`} ]});
    expect(b.integration!.prerequisites!.history).toHaveLength(60);
    expect(b.integration!.prerequisites!.history![0]!.conditions[0]!.reason).toBe(a.conditions[0]!.reason);
    expect(prerequisiteGate(b,true).ready).toBe(true);
  });
});
