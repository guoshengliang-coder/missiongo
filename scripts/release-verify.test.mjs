import {test} from "node:test";
import assert from "node:assert/strict";
import {verifyExistingRelease,verificationScopeOptions} from "./release-verify.mjs";
const head="a".repeat(40),current={web:{commit:head,version:"1.2.3",clean:true,ciPassed:true}},before={schemaVersion:1,deployedCommit:head,current,previous:{web:{commit:"b".repeat(40)}}};
test("read-only recheck preserves the original before snapshot and records fresh public facts",async()=>{
  let reads=0,checks=0;const result=await verifyExistingRelease(before,{origin:"https://example.test"},{readSnapshot:()=>{reads++;return current;},verifyPublic:async()=>{checks++;return {checks:{web:true},errors:{}};}});
  assert.equal(reads,2);assert.equal(checks,1);assert.deepEqual(result.previous,before.previous);assert.equal(result.publicEvidence.checks.web,true);
});
test("changed deployment is rejected before public verification and changes during reading are rejected",async()=>{
  let checks=0;await assert.rejects(verifyExistingRelease(before,{}, {readSnapshot:()=>({web:{...current.web,commit:"c".repeat(40)}}),verifyPublic:async()=>{checks++;}}),/deployment changed/);assert.equal(checks,0);
  let reads=0;await assert.rejects(verifyExistingRelease(before,{}, {readSnapshot:()=>++reads===1?current:{web:{...current.web,version:"9.9.9"}},verifyPublic:async()=>({checks:{web:true}})}),/changed during/);
});
test("a failed public check is retained as failed and is never filled from the release ledger",async()=>{
  const result=await verifyExistingRelease(before,{}, {readSnapshot:()=>current,verifyPublic:async()=>({checks:{web:false},errors:{web:"timeout"}})});
  assert.equal(result.publicEvidence.checks.web,false);assert.equal(result.changes[0].verified,false);
  await assert.rejects(verifyExistingRelease({schemaVersion:1},{}),/complete original/);
});

test("changed artifacts at the same deployment head require reconciliation, not silent adoption",async()=>{
 let checks=0;await assert.rejects(verifyExistingRelease(before,{}, {readSnapshot:()=>({...current,linuxCli:{version:'9.9.9'}}),verifyPublic:async()=>{checks++;}}),/artifact snapshot changed/);assert.equal(checks,0);
});

test("read-only verification preserves explicit partial artifacts and rejects incomplete scope",()=>{
 const scope=verificationScopeOptions(new Map([["--only-artifacts","web"],["--scope-reason","User approved Web/Server only"]]));
 assert.deepEqual(scope,{onlyArtifacts:"web",scopeReason:"User approved Web/Server only"});
 assert.deepEqual(verificationScopeOptions(new Map()),{});
 for(const entries of [[["--only-artifacts","web"]],[["--scope-reason","partial"]],[["--only-artifacts","unknown"],["--scope-reason","partial"]]])assert.throws(()=>verificationScopeOptions(new Map(entries)));
});
