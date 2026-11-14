import { describe, expect, it } from "vitest";
import { prerequisiteGate, prerequisitesActionSchema, recordPrerequisites, type PrerequisiteBatch } from "./merge-prerequisites.js";
import type { IntegrationPrerequisite } from "@missiongo/contracts";

export function prerequisiteEvidence() {
  const kinds=["main","installation_integrity","required_capability","authorization","scope"] as const;
  const deps={main:["base","heads"],installation_integrity:["tools"],required_capability:["tools","capabilities"],authorization:["scope","tools","capabilities"],scope:["scope","candidates"]} as const;
  return prerequisitesActionSchema.parse({kind:"prerequisites",checkedAt:new Date().toISOString(),source:"Synthetic independently observed facts",
    context:{base:"b".repeat(40),candidates:"c".repeat(64),tools:"d".repeat(64),capabilities:"e".repeat(64)},
    conditions:kinds.map(kind=>({id:kind,kind,category:"fact",stage:"pre_merge",required:true,state:"satisfied",reason:"Verified synthetic prerequisite",owner:"Original executor",resumeWhen:"Verify original evidence",
      dependencies:[...deps[kind]],...(kind==="authorization"?{authorizationRef:"original-native-request:fixture-scope"}:{})}))});
}
const fixture=():PrerequisiteBatch=>({publish:true,state:"active",operation:"merge_and_publish",deliveries:["one","two"],selection:[{id:"one",revision:"frozen-1"},{id:"two",revision:"frozen-2"}],results:{},
  integration:{protocol:1,revision:0,events:[],plans:[],entries:Object.fromEntries(["one","two"].map(id=>[id,{itemKeys:[],originalHead:"a".repeat(40),head:"a".repeat(40),progress:"queued",detail:"",repairs:[]}]))}});
describe("publication prerequisites",()=>{
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
    recordPrerequisites(b,{...a,conditions:[a.conditions[0]!]});
    expect(prerequisiteGate(b,true).ready).toBe(true);
    expect(b.integration!.prerequisites!.conditions.find(c=>c.kind==="authorization")).toEqual(auth);
    const changed={...a,context:{...a.context,tools:"f".repeat(64)},conditions:[a.conditions[1]!]};recordPrerequisites(b,changed);
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
