// Synthetic local HTTP measurement. No real node credentials or model calls.
import {performance} from 'node:perf_hooks';
import {setTimeout as delay} from 'node:timers/promises';
import {mkdirSync,writeFileSync} from 'node:fs';
import {dirname,resolve} from 'node:path';
import {execFileSync} from 'node:child_process';
import {scryptSync} from 'node:crypto';
import {buildApp} from '../services/server/dist/app.js';
import {DispatchStore} from '../services/server/dist/dispatch-store.js';
const output=resolve(process.argv[2]??'ci-diagnostics/node-control/report.json');
const salt=Buffer.from('and500-synthetic');
const results=[];
for(const count of [1,10,50]) {
 const app=buildApp({databasePath:':memory:',dingtalkWorker:false,adminAccount:{id:'owner',username:'owner@example.test',
  passwordScrypt:`scrypt:${salt.toString('base64url')}:${scryptSync('fixture-password',salt,64).toString('base64url')}`,
  sessionSecret:'synthetic-and500-only',cookieSecure:false}});
 try {
  const db=app.missionGoStore.database.connection;
  const node=new DispatchStore(app.missionGoStore.database).registerNode({accountId:'owner',installationId:'synthetic-control-benchmark',name:'Synthetic'});
  const stamp=new Date().toISOString();
  app.missionGoStore.database.transaction(()=>{
   for(let i=0;i<count;i++){
    db.prepare("INSERT INTO dispatches(id,account_id,node_id,agent_kind,mode,status,repo_path,created_at) VALUES (?,'owner',?,'codex','default','launched','synthetic',?)").run(`d${i}`,node.nodeId,stamp);
    db.prepare("INSERT INTO agent_sessions(id,dispatch_id,node_id,agent_kind,agent_session_ref,status,created_at,updated_at) VALUES (?,?,?,'codex',?,'active',?,?)").run(`s${i}`,`d${i}`,node.nodeId,`ref${i}`,stamp,stamp);
   }
  });
  const origin=await app.listen({host:'127.0.0.1',port:0}),headers={authorization:`Bearer ${node.token}`};
  const get=async path=>{
   const response=await fetch(origin+path,{headers,signal:AbortSignal.timeout(3000)});
   if(!response.ok)throw Error(`HTTP ${response.status}`);return response.json();
  };
  const samples=[];
  for(let i=0;i<105;i++) {
   db.prepare("UPDATE agent_session_commands SET status='delivered' WHERE status='queued'").run();
   const initial=await get('/api/v1/node/control-changes?waitMs=0');
   const poll=get(`/api/v1/node/control-changes?waitMs=25000&cursor=${encodeURIComponent(initial.cursor)}`);
   await delay(i%7);
   const start=performance.now(),id=`command-${i}`;
   db.prepare("INSERT INTO agent_session_commands(id,session_id,account_id,text,status,created_at) VALUES (?,'s0','owner','Synthetic input','queued',?)").run(id,new Date().toISOString());
   await poll;
   const sessions=await get('/api/v1/node/agent-sessions');
   if(!sessions.sessions.some(s=>s.id==='s0'&&s.command?.id===id))throw Error('Command was not obtained');
   if(i>=5)samples.push(performance.now()-start);
  }
  const sorted=[...samples].sort((a,b)=>a-b), p95=sorted[Math.ceil(sorted.length*.95)-1];
  results.push({sessions:count,samplesMs:samples,p50Ms:sorted[Math.ceil(sorted.length*.5)-1],p95Ms:p95,maxMs:sorted.at(-1),passed:p95<=500});
 }finally{await app.close();}
}
const report={schema:1,sourceCommit:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),
 sourceDirty:!!execFileSync('git',['status','--porcelain'],{encoding:'utf8'}).trim(),node:process.version,platform:process.platform,arch:process.arch,
 transport:'real HTTP over loopback; no model; in-memory SQLite',boundary:'before durable command insert through long-poll wake and authenticated node session GET',
 warmup:5,samplesPerShape:100,results};
mkdirSync(dirname(output),{recursive:true});writeFileSync(output,JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify(results.map(({sessions,p50Ms,p95Ms,maxMs,passed})=>({sessions,p50Ms,p95Ms,maxMs,passed})),null,2));
if(results.some(r=>!r.passed))process.exitCode=1;
