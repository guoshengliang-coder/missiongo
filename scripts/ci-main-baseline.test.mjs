import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { findFullMainBaseline, validBaseline } from './ci-main-baseline.mjs';
import { selectPlatforms, assertPlatformResult } from './ci-platform-plan.mjs';
import { parseDiff } from './ui-test-plan.mjs';

const head = 'a'.repeat(40), base = 'b'.repeat(40);
const names = ['web-and-server', 'ui', 'android', 'macos', 'linux-node', 'android-build', 'macos-build', 'linux-node (ubuntu-22.04)', 'linux-node (ubuntu-24.04)'];
const run = () => ({id: 123, run_attempt: 1, head_sha: base, head_branch: 'main', event: 'push', path: '.github/workflows/ci.yml', repository: {full_name:'owner/repo'}, status:'completed', conclusion:'success'});
const jobs = () => names.map(name => ({name, status:'completed', conclusion:'success', head_sha:base, run_id:123}));
function api(runs = [run()], buildJobs = jobs()) {
  const urls = [];
  return {urls, fetcher: async url => {
    urls.push(url);
    return {ok:true, json:async()=>url.includes('/attempts/') ? {jobs:buildJobs, total_count:buildJobs.length} : {workflow_runs:runs}};
  }};
}
const args = {repository:'owner/repo', head, token:'fixture', isAncestor:()=>true};

test('only complete successful builds from ancestor main CI become baselines', async () => {
  const stub = api();
  assert.deepEqual(await findFullMainBaseline({...args, ...stub}), {kind:'full-main-build', sha:base, runId:123, attempt:1});
  assert(stub.urls[1].includes('/attempts/1/jobs'));
  assert.equal(await findFullMainBaseline({...args, ...api(), isAncestor:()=>false}), null);
  for (const change of [r=>r.event='pull_request', r=>r.event='workflow_dispatch', r=>r.head_branch='feature', r=>r.head_sha=head,
    r=>r.status='in_progress', r=>r.conclusion='failure', r=>r.path='other.yml', r=>r.repository.full_name='fork/repo']) {
    const r=run();change(r);assert.equal(await findFullMainBaseline({...args, ...api([r])}),null);
  }
});

test('green summaries with skipped builds, failed jobs, partial reruns and wrong identities never anchor reuse', async () => {
  for (const change of [j=>j.pop(), j=>j.push(j[0]), j=>j.find(x=>x.name==='macos-build').conclusion='skipped',
    j=>j[0].conclusion='failure', j=>j[0].status='queued', j=>j[0].run_id=999, j=>j[0].head_sha=head]) {
    const j=jobs();change(j);assert.equal(await findFullMainBaseline({...args, ...api([run()],j)}), null);
  }
  const stub=api();
  const fetcher=async url=>url.includes('/attempts/') ? {ok:true,json:async()=>({jobs:jobs(),total_count:101})}:stub.fetcher(url);
  assert.equal(await findFullMainBaseline({...args,fetcher}),null);
  await assert.rejects(findFullMainBaseline({...args,fetcher:async()=>({ok:false,status:403})}),/403/);
});

test('baseline API inspection is bounded and does not inspect every historical run', async()=>{
  const runs=Array.from({length:20},(_,i)=>({...run(),id:123+i}));
  const stub=api(runs,[]);
  assert.equal(await findFullMainBaseline({...args,...stub}),null);
  assert.equal(stub.urls.length,11);
});

test('main skips require bound baseline evidence; scheduled and manual runs remain full',()=>{
  const baseline={kind:'full-main-build',sha:base,runId:123,attempt:1};
  const choose=(eventName='push', proof=baseline)=>selectPlatforms({head,eventName,baseline:proof,changes:[{path:'README.md',status:'M'}]});
  const plan=choose();
  for(const platform of ['android','macos','linuxNode']) {
    assert.equal(plan.required[platform],false);
    assert.doesNotThrow(()=>assertPlatformResult({plan,platform,head,eventName:'push',planResult:'success',buildResult:'skipped'}));
    assert.throws(()=>assertPlatformResult({plan,platform,head,eventName:'push',planResult:'failure',buildResult:'skipped'}));
  }
  for(const proof of [null,{...baseline,sha:head},{...baseline,runId:0},{...baseline,attempt:0}]) {
    assert(!validBaseline(proof,head));assert(Object.values(choose('push',proof).required).every(Boolean));
  }
  for(const event of ['schedule','workflow_dispatch','unknown']) assert(Object.values(choose(event).required).every(Boolean));
});

test('a failed native change followed by a web-only commit is still tested from the successful baseline',t=>{
  const directory=mkdtempSync(join(tmpdir(),'mg-ci-baseline-'));t.after(()=>rmSync(directory,{recursive:true,force:true}));
  const git=(...args)=>execFileSync('git',args,{cwd:directory,encoding:'utf8'}).trim();
  git('init');git('config','user.name','Fixture');git('config','user.email','fixture@example.test');
  mkdirSync(join(directory,'apps/macos'),{recursive:true});writeFileSync(join(directory,'apps/macos/source.swift'),'old');
  git('add','.');git('commit','-m','verified baseline');const sha=git('rev-parse','HEAD');
  writeFileSync(join(directory,'apps/macos/source.swift'),'changed');git('add','.');git('commit','-m','native change, CI failed');
  writeFileSync(join(directory,'README.md'),'web release note');git('add','.');git('commit','-m','later docs change');const tip=git('rev-parse','HEAD');
  const changes=parseDiff(execFileSync('git',['diff','--name-status','-z',sha,tip],{cwd:directory,encoding:'utf8'}));
  const plan=selectPlatforms({head:tip,eventName:'push',baseline:{kind:'full-main-build',sha,runId:1,attempt:1},changes});
  assert.equal(plan.required.macos,true);assert.equal(plan.required.android,false);
  const gate=()=>assertPlatformResult({plan,platform:'macos',head:tip,eventName:'push',planResult:'success',buildResult:'skipped'});
  assert.throws(gate,/must be success/);
});
