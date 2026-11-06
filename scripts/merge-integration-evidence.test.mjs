import {test} from "node:test";
import assert from "node:assert/strict";
import {execFileSync} from "node:child_process";
import {mkdtempSync,writeFileSync,rmSync} from "node:fs";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {inspectRepair} from "./merge-integration-evidence.mjs";
import {inspectDelivery} from "./merge-delivery.mjs";
test("real overlapping branches require a recorded repair; external commits and changed bases are rejected",()=>{
 const dir=mkdtempSync(join(tmpdir(),"integration-repair-"));
 const git=(...args)=>execFileSync("git",args,{cwd:dir,encoding:"utf8",stdio:["ignore","pipe","pipe"]}).trim();
 try {
  git("init","-b","main");git("config","user.name","Fixture");git("config","user.email","fixture@example.test");
  writeFileSync(join(dir,"api.txt"),"base\n");git("add",".");git("commit","-m","base");const base=git("rev-parse","HEAD");
  git("checkout","-b","feature");writeFileSync(join(dir,"api.txt"),"feature\n");git("commit","-am","feature");const original=git("rev-parse","HEAD");
  git("checkout","main");writeFileSync(join(dir,"api.txt"),"foundation\n");git("commit","-am","foundation");const target=git("rev-parse","HEAD");
  git("checkout","feature");assert.throws(()=>git("merge","main"));
  writeFileSync(join(dir,"api.txt"),"foundation\nfeature\n");git("add",".");git("commit","-m","Resolve both behaviors");const repaired=git("rev-parse","HEAD");
  const input={repository:"https://github.com/example/project",pullRequest:1,targetBranch:"main",fromHead:original,head:repaired,base:target,commits:[repaired]};
  let remote=repaired;
  const run=(cmd,args)=>cmd==="git"?(args[0]==="ls-remote"?git("ls-remote","--refs",dir,"refs/heads/main"):git(...args)):JSON.stringify(args[0]==="repo"?{nameWithOwner:"example/project"}:{url:input.repository+"/pull/1",state:"OPEN",headRefOid:remote,baseRefName:"main",baseRefOid:target,mergeable:"MERGEABLE",statusCheckRollup:[{status:"COMPLETED",conclusion:"SUCCESS"}]});
  assert.equal(inspectRepair(input,run).head,repaired);
  assert.equal(inspectDelivery({...input,head:original,executionHead:repaired,expectedBase:target},run).ready,true);
  assert.throws(()=>inspectDelivery({...input,expectedBase:base},run),/base changed/);
  writeFileSync(join(dir,"external.txt"),"other developer");git("add",".");git("commit","-m","External work");remote=git("rev-parse","HEAD");
  assert.throws(()=>inspectRepair(input,run),/Remote PR changed/);
  assert.throws(()=>inspectRepair({...input,head:remote,commits:[remote]},run),/unrecorded/);
  git("checkout","main");git("merge","--no-ff",repaired,"-m","Integrate verified repair");
  assert.equal(git("show","HEAD:api.txt"),"foundation\nfeature");
 } finally {rmSync(dir,{recursive:true,force:true});}
});
