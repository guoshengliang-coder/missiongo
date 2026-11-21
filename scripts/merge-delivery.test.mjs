import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspectDelivery } from "./merge-delivery.mjs";

const delivery = { repository: "https://github.com/example/project", pullRequest: 12, head: "a".repeat(40), targetBranch: "main" };
const pr = { url: `${delivery.repository}/pull/12`, headRefOid: delivery.head, baseRefName: "main", baseRefOid: "b".repeat(40),
  state: "OPEN", isDraft: false, mergeable: "MERGEABLE", statusCheckRollup: [{ __typename: "CheckRun", status: "COMPLETED", conclusion: "SUCCESS" }] };
const mock = (p = pr) => (command, args) => {
  if (command === "git" && args[0] === "ls-remote") return `${pr.baseRefOid}\trefs/heads/main`;
  assert.equal(command, "gh");
  return JSON.stringify(args[0] === "repo" ? { nameWithOwner: "example/project" } : p);
};
test("evidence fails closed on unknown checks, conflict, draft, and changed head", () => {
  assert.equal(inspectDelivery(delivery, mock()).ready, true);
  assert.equal(inspectDelivery({ ...delivery, mergeReady: false }, mock()).ready, false);
  assert.throws(() => inspectDelivery({ ...delivery, expectedBase: "c".repeat(40) }, mock()), /base/i);
  for (const change of [{ statusCheckRollup: [] }, { isDraft: true }, { mergeable: "CONFLICTING" },
    { statusCheckRollup: [{ __typename: "CheckRun", status: "IN_PROGRESS" }] }]) {
    assert.equal(inspectDelivery(delivery, mock({ ...pr, ...change })).ready, false);
  }
  assert.throws(() => inspectDelivery(delivery, mock({ ...pr, headRefOid: "c".repeat(40) })), /revision changed/);
  assert.deepEqual(inspectDelivery(delivery, mock()).mergeArguments.slice(-2), ["--match-head-commit", delivery.head]);
});

test("verifies two actual isolated branch integrations and rejects an unintegrated commit", () => {
  const dir = mkdtempSync(join(tmpdir(), "missiongo-merge-fixture-"));
  const git = (...args) => execFileSync("git", args, { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  try {
    git("init", "-b", "main"); git("config", "user.name", "Synthetic fixture"); git("config", "user.email", "fixture@example.test");
    writeFileSync(join(dir, "base.txt"), "base"); git("add", "."); git("commit", "-m", "base");
    const base = git("rev-parse", "HEAD");
    const heads = [];
    for (const name of ["one", "two", "unfinished"]) {
      git("checkout", "-b", name, base); writeFileSync(join(dir, `${name}.txt`), name); git("add", "."); git("commit", "-m", name);
      heads.push(git("rev-parse", "HEAD"));
    }
    git("checkout", "main");
    const commits = [];
    for (const name of ["one", "two"]) { git("merge", "--no-ff", name, "-m", `Integrate ${name}`); commits.push(git("rev-parse", "HEAD")); }
    const target = git("rev-parse", "HEAD");
    const inspect = (index, commit) => inspectDelivery({ ...delivery, head: heads[index] }, (command, args) => {
      if (command === "gh") return JSON.stringify(args[0] === "repo" ? { nameWithOwner: "example/project" }
        : { ...pr, headRefOid: heads[index], state: "MERGED", mergedAt: new Date().toISOString(), mergeCommit: { oid: commit } });
      // Substitute only transport: ancestry check still runs against a real repository.
      if (args[0] === "ls-remote") return `${target}\trefs/heads/main`;
      if (args[0] === "fetch") return git("fetch", dir, "main");
      return git(...args);
    });
    for (let i = 0; i < 2; i++) assert.equal(inspect(i, commits[i]).result.commit, commits[i]);
    assert.throws(() => inspect(2, heads[2]));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

 test("tolerates a lagging GraphQL baseRefOid while the ls-remote head guard still rejects a moved base", () => {
   const movedHead = "d".repeat(40);
   const run = (command, args) => command === "git" && args[0] === "ls-remote" ? `${movedHead}\trefs/heads/main` : mock()(command, args);
   assert.equal(inspectDelivery({ ...delivery, expectedBase: movedHead }, run).ready, true);
   assert.throws(() => inspectDelivery({ ...delivery, expectedBase: pr.baseRefOid }, run), /Target base changed/);
 });

test("external reconciliation proves original-head and target ancestry using real Git", async () => {
  const { inspectMergedReconciliation } = await import("./merge-delivery.mjs");
  const dir = mkdtempSync(join(tmpdir(), "missiongo-reconcile-fixture-"));
  const git = (...args) => execFileSync("git", args, { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  try {
    git("init", "-b", "main");git("config", "user.name", "Fixture");git("config", "user.email", "fixture@example.test");
    writeFileSync(join(dir, "base"), "base");git("add", ".");git("commit", "-m", "base");
    git("checkout", "-b", "feature");writeFileSync(join(dir, "feature"), "original");git("add", ".");git("commit", "-m", "original");const original = git("rev-parse", "HEAD");
    writeFileSync(join(dir, "feature"), "external repair");git("commit", "-am", "external repair");const head = git("rev-parse", "HEAD");
    git("checkout", "main");git("merge", "--no-ff", "feature", "-m", "merge");const target = git("rev-parse", "HEAD");
    const run = (command, args) => {
      if (command === "gh") return JSON.stringify(args[0] === "repo" ? {nameWithOwner:"example/project"} : {...pr, state:"MERGED", headRefOid:head, mergeCommit:{oid:target}, mergedAt:new Date().toISOString()});
      if (args[0] === "ls-remote") return git("ls-remote", "--refs", dir, "refs/heads/main");
      if (args[0] === "fetch") return git("fetch", dir, args[2].startsWith("refs/pull/") ? "feature" : "main");
      return git(...args);
    };
    const input = {...delivery, head:original, validation:"Local checks passed on actual target"};
    const evidence = inspectMergedReconciliation(input, run);
    assert.deepEqual(evidence, {
      head, commit:target, targetHead:target, source:pr.url, checkedAt:evidence.checkedAt,
      checks:"passed", local:"passed", originalIncluded:true, targetIncludesMerge:true, validation:input.validation,
    });
    // A target-only commit was never part of the merged feature.
    assert.throws(() => inspectMergedReconciliation({...input,head:target},run));
    assert.throws(() => inspectMergedReconciliation({...input,validation:""},run));
  } finally {rmSync(dir,{recursive:true,force:true});}
});

const projectRules = {source:"AGENTS.md at frozen head",digest:"c".repeat(64),reason:"Existing project workflow",ci:"not_required",local:"not_required",mergeMethod:"squash"};
const platformMock = (p, {auto=false, required=[], rulesetRequired=[], queue=false, deny=false}={}) => (command,args) => {
  if(command==="gh"&&args[0]==="api") {
    if(deny)throw new Error("Forbidden policy read");
    if(args[1].endsWith("/protection"))throw new Error("Administration API must not be required");
    if(args[1].includes("/rules/branches/"))return JSON.stringify([...(queue?[{type:"merge_queue"}]:[]),...(rulesetRequired.length?[{type:"required_status_checks",parameters:{required_status_checks:rulesetRequired.map(context=>({context}))}}]:[])]);
    if(args[1].includes("/branches/"))return JSON.stringify({name:"main",protected:required.length+rulesetRequired.length>0,protection:{enabled:required.length>0,required_status_checks:{contexts:required,checks:[]}}});
    return JSON.stringify({allow_auto_merge:auto,allow_merge_commit:false,allow_squash_merge:true,allow_rebase_merge:true});
  }
  return mock(p)(command,args);
};
test("native projects merge without auto-merge or CI, but policy read failures and missing expected checks stay blocked",()=>{
  const input={...delivery,projectRules},empty={...pr,statusCheckRollup:[]};
  const result=inspectDelivery(input,platformMock(empty));
  assert.equal(result.ready,true);assert.equal(result.evidence.checks,"not_applicable");assert.equal(result.canAutoMerge,false);
  assert.ok(result.mergeArguments.includes("--squash"));assert.ok(!result.mergeArguments.includes("--auto"));
  assert.throws(()=>inspectDelivery(input,platformMock(empty,{deny:true})),/Forbidden/);
  const missing=inspectDelivery(input,platformMock({...pr,statusCheckRollup:[{name:"other",status:"COMPLETED",conclusion:"SUCCESS"}]},{required:["build"]}));
  assert.equal(missing.ready,false);assert.equal(missing.evidence.checks,"unknown");
  assert.equal(inspectDelivery({...input,projectRules:{...projectRules,ci:"required"}},platformMock(empty)).evidence.checks,"unknown");
});
test("pending CI can use auto-merge only with configured protection and actual capability; failure never becomes absence",()=>{
  const input={...delivery,projectRules},pending={...pr,statusCheckRollup:[{name:"build",status:"IN_PROGRESS",conclusion:null}]};
  for(const auto of [false,true])for(const required of [[],["build"]]){
    const result=inspectDelivery(input,platformMock(pending,{auto,required}));
    assert.equal(result.canAutoMerge,auto&&required.length>0);assert.equal(result.ready,false);
    assert.equal(result.mergeArguments.includes("--auto"),result.canAutoMerge);
  }
  const failed=inspectDelivery(input,platformMock({...pr,statusCheckRollup:[{name:"build",status:"COMPLETED",conclusion:"FAILURE"}]}));
  assert.equal(failed.evidence.checks,"failed");assert.equal(failed.ready,false);
  const queue=inspectDelivery(input,platformMock({...pr,statusCheckRollup:[{name:"build",status:"COMPLETED",conclusion:"SUCCESS"}]},{queue:true}));
  assert.equal(queue.evidence.verification.mergeMethod,"queue");assert.ok(!queue.mergeArguments.includes("--squash"));
});
test("project-only requirements and partial branch protection never masquerade as protected auto-merge",()=>{
  const input={...delivery,projectRules:{...projectRules,requiredChecks:["project-smoke"]}},
    pending={...pr,statusCheckRollup:[{name:"project-smoke",status:"IN_PROGRESS",conclusion:null}]};
  assert.equal(inspectDelivery(input,platformMock(pending,{auto:true})).canAutoMerge,false);
  const partial={...pr,statusCheckRollup:[{name:"build",status:"COMPLETED",conclusion:"SUCCESS"},{name:"project-smoke",status:"IN_PROGRESS",conclusion:null}]};
  assert.equal(inspectDelivery(input,platformMock(partial,{auto:true,required:["build"]})).canAutoMerge,false);
  assert.throws(()=>inspectDelivery(input,platformMock({...pr,statusCheckRollup:undefined})),/Incomplete/);
});
test("squash and rebase integrations on develop preserve exact PR evidence without requiring original head ancestry on target",async()=>{
  const {inspectMergedReconciliation}=await import("./merge-delivery.mjs");
  for(const method of ["squash","rebase"]){
    const dir=mkdtempSync(join(tmpdir(),"missiongo-native-merge-"));
    const git=(...args)=>execFileSync("git",args,{cwd:dir,encoding:"utf8",stdio:["ignore","pipe","pipe"]}).trim();
    try{
      git("init","-b","develop");git("config","user.name","Fixture");git("config","user.email","fixture@example.test");
      writeFileSync(join(dir,"base"),"base");git("add",".");git("commit","-m","base");const base=git("rev-parse","HEAD");
      git("checkout","-b","feature");writeFileSync(join(dir,"feature"),"change");git("add",".");git("commit","-m","feature");const original=git("rev-parse","HEAD");
      git("checkout","develop");writeFileSync(join(dir,"other"),"independent");git("add",".");git("commit","-m","advance target");
      if(method==="squash"){git("merge","--squash","feature");git("commit","-m","squashed integration");}
      else {git("checkout","feature");git("rebase","develop");git("checkout","develop");git("merge","--ff-only","feature");}
      const target=git("rev-parse","HEAD");
      assert.throws(()=>git("merge-base","--is-ancestor",original,target));
      const input={...delivery,head:original,targetBranch:"develop",validation:"Actual target smoke passed",projectRules:{...projectRules,mergeMethod:method}};
      const run=(command,args)=>{
        if(command==="gh"){
          if(args[0]==="api"){
            if(args[1].includes("rules/branches/"))return "[]";
            if(args[1].includes("branches/"))return JSON.stringify({name:"develop",protected:false});
            return JSON.stringify({allow_auto_merge:false,allow_merge_commit:true,allow_squash_merge:true,allow_rebase_merge:true});
          }
          return JSON.stringify(args[0]==="repo"?{nameWithOwner:"example/project"}:{...pr,state:"MERGED",headRefOid:original,baseRefName:"develop",baseRefOid:base,statusCheckRollup:[],mergedAt:new Date().toISOString(),mergeCommit:{oid:target}});
        }
        if(args[0]==="ls-remote")return `${target}\trefs/heads/develop`;
        if(args[0]==="fetch")return git("fetch",dir,args[2].startsWith("refs/pull/")?original:"develop");
        return git(...args);
      };
      assert.equal(inspectDelivery(input,run).result.commit,target);
      const recovered=inspectMergedReconciliation(input,run);assert.equal(recovered.commit,target);assert.equal(recovered.checks,"not_applicable");assert.equal(recovered.local,"not_applicable");
      assert.throws(()=>inspectMergedReconciliation({...input,local:"failed"},run),/local validation/);
    }finally{rmSync(dir,{recursive:true,force:true});}
  }
});

test("ruleset-only branches use Contents/Metadata reads without requiring the administrator protection endpoint",()=>{
  const pending={...pr,statusCheckRollup:[{name:"build",status:"IN_PROGRESS",conclusion:null}]};
  const result=inspectDelivery({...delivery,projectRules},platformMock(pending,{auto:true,rulesetRequired:["build"]}));
  assert.deepEqual(result.evidence.verification.requiredChecks,["build"]);
  assert.equal(result.canAutoMerge,true);
  const missing=inspectDelivery({...delivery,projectRules},platformMock({...pr,statusCheckRollup:[]},{rulesetRequired:["build"]}));
  assert.equal(missing.evidence.checks,"unknown");assert.equal(missing.ready,false);
});

test("all rule pages are required; later-page checks and methods cannot disappear",()=>{
  const input={...delivery,projectRules};
  const first=Array.from({length:100},(_,i)=>({type:"commit_message_pattern",ruleset_id:i,parameters:{pattern:"fixture"}}));
  const pages=(page2,fail=false)=>(command,args)=>{
    if(command==="gh"&&args[0]==="api"&&args[1].includes("/rules/branches/")) {
      const page=new URL(`https://fixture.invalid/${args[1]}`).searchParams.get("page");
      if(page==="1")return JSON.stringify(first);
      if(fail)throw new Error("Second rule page failed");
      assert.equal(page,"2");return JSON.stringify(page2);
    }
    return platformMock({...pr,statusCheckRollup:[]})(command,args);
  };
  const page2=[{type:"required_status_checks",parameters:{required_status_checks:[{context:"late-check"}]}},{type:"pull_request",parameters:{allowed_merge_methods:["rebase"]}}];
  const result=inspectDelivery({...input,projectRules:{...projectRules,mergeMethod:undefined}},pages(page2));
  assert.equal(result.evidence.checks,"unknown");assert.equal(result.ready,false);
  assert.deepEqual(result.evidence.verification.requiredChecks,["late-check"]);
  assert.equal(result.evidence.verification.mergeMethod,"rebase");
  assert.throws(()=>inspectDelivery(input,pages(page2,true)),/Second rule page/);
});
test("target-branch methods and linear history restrict repository-level choices",()=>{
  const run=(rules)=>(command,args)=>{
    if(command==="gh"&&args[0]==="api"&&args[1].includes("/rules/branches/"))return JSON.stringify(rules);
    if(command==="gh"&&args[0]==="api"&&!args[1].includes("/branches/"))return JSON.stringify({allow_auto_merge:false,allow_merge_commit:true,allow_squash_merge:true,allow_rebase_merge:true});
    return platformMock({...pr,statusCheckRollup:[]})(command,args);
  };
  const input={...delivery,projectRules:{...projectRules,mergeMethod:undefined}};
  assert.equal(inspectDelivery(input,run([{type:"pull_request",parameters:{allowed_merge_methods:["squash"]}}])).evidence.verification.mergeMethod,"squash");
  assert.equal(inspectDelivery(input,run([{type:"required_linear_history"}])).evidence.verification.mergeMethod,"squash");
  assert.throws(()=>inspectDelivery({...input,projectRules:{...projectRules,mergeMethod:"merge"}},run([{type:"required_linear_history"}])),/method is unavailable/);
  assert.throws(()=>inspectDelivery(input,run([{type:"pull_request",parameters:{allowed_merge_methods:["squash"]}},{type:"pull_request",parameters:{allowed_merge_methods:["rebase"]}}])),/method is unavailable/);
});
test("incomplete protected summaries stay unknown while explicit review-only protection allows no-CI",()=>{
  const input={...delivery,projectRules};
  const branch=(protection)=>(command,args)=>{
    if(command==="gh"&&args[0]==="api"&&args[1].includes("/branches/")&&!args[1].includes("/rules/"))return JSON.stringify({name:"main",protected:true,protection});
    return platformMock({...pr,statusCheckRollup:[]})(command,args);
  };
  for(const protection of [{},undefined,{enabled:true,required_status_checks:{}},{enabled:true,required_status_checks:{contexts:"missing"}}])
    assert.throws(()=>inspectDelivery(input,branch(protection)),/Incomplete/);
  assert.equal(inspectDelivery(input,branch({enabled:true,required_status_checks:{contexts:[],checks:[]}})).evidence.checks,"not_applicable");
});
