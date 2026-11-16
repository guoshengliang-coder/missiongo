import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { reviewAction } from "../apps/web/public/downloads/missiongo-agent-integration/review-cli.mjs";

async function fixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "missiongo-review-cli-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const repo = join(root, "repo"); execFileSync("git", ["init", "-q", repo]);
  const git = args => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();
  writeFileSync(join(repo, "sum.mjs"), "export const sum = v => v.reduce((a,b)=>a+b,0);\n");
  writeFileSync(join(repo, "test.mjs"), "import assert from 'node:assert/strict';import{sum}from'./sum.mjs';assert.equal(sum([]),0);\n");
  git(["add", "."]); git(["-c","user.name=Fixture","-c","user.email=fixture@example.invalid","commit","-qm","baseline"]);
  const input = { stateRoot: join(root,"state"), taskId:"task", agentKind:"codex", sessionRef:"session", requestId:"human-message",
    repository:repo, base:git(["rev-parse","HEAD"]), model:"model", provider:"provider", requirements:"Empty sum returns zero",
    scope:["sum.mjs","test.mjs"], untracked:[], checkCommands:[{name:"behavior",argv:["node","test.mjs"]}] };
  const action = (name, extra={}, options) => reviewAction(name,{...input,...extra},options);
  await action("enable"); await action("begin");
  const options = { runReview: async ({task,onBound}) => {
    onBound("child"); return {receipt:{sessionRef:"child",model:"model",provider:"provider",readOnly:true,generation:task.generation},result:{findings:[],limitations:[{kind:"validation_pending",detail:"Run behavior test in original context"}]}};
  } };
  return {repo,git,input,action,options};
}
test("same human request cannot reset the budget by supplying another task ID; verified content survives commit but not edits", async t => {
  const f=await fixture(t);
  assert.equal((await f.action("begin",{taskId:"replacement"})).taskId,"task");
  writeFileSync(join(f.repo,"sum.mjs"),"export const sum = v => v.length ? v.reduce((a,b)=>a+b) : 0;\n");
  assert.equal((await f.action("review",{},f.options)).status,"validating");
  assert.equal((await f.action("check")).status,"passed");
  assert.equal((await f.action("verify")).proof.valid,false);
  f.git(["add","."]);f.git(["-c","user.name=Fixture","-c","user.email=fixture@example.invalid","commit","-qm","fix"]);
  const proof=await f.action("verify");assert.equal(proof.proof.valid,true);assert.equal(proof.round,1);
  writeFileSync(join(f.repo,"sum.mjs"),"export const sum = v => v.reduce((a,b)=>a+b);\n");
  assert.equal((await f.action("verify")).status,"stale");
  const next=await f.action("review",{},f.options);assert.equal(next.round,2);assert.equal(next.status,"validating");
});
test("a clean reviewer cannot hide a failing behavior test",async t=>{
  const f=await fixture(t);writeFileSync(join(f.repo,"sum.mjs"),"export const sum = v => v.reduce((a,b)=>a+b);\n");
  await f.action("review",{},f.options);const state=await f.action("check");
  assert.equal(state.status,"incomplete");assert.equal(state.checks[0].result,"failed");
  assert.equal((await f.action("verify")).proof.valid,false);
});
test("scope omissions fail closed before launching a reviewer",async t=>{
  const f=await fixture(t);writeFileSync(join(f.repo,"extra.mjs"),"export const extra = 1;\n");f.git(["add","extra.mjs"]);
  await assert.rejects(f.action("review",{},f.options),/outside the frozen review scope/);
  assert.equal((await f.action("status")).round,0);
});
test("late native results after cancellation cannot resurrect a review",async t=>{
  const f=await fixture(t);let release,started;
  const ready=new Promise(resolve=>{started=resolve;});
  const running=f.action("review",{}, {runReview:async ({task,onBound})=>{onBound("child");started();await new Promise(resolve=>{release=resolve;});return{receipt:{sessionRef:"child",model:"model",provider:"provider",readOnly:true,generation:task.generation},result:{findings:[],limitations:[]}};}});
  await ready;await f.action("cancel");release();assert.equal((await running).status,"cancelled");
});
