import { pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { scryptSync } from 'node:crypto';
const options={};
for(let i=2;i<process.argv.length;i+=2){
 const key=process.argv[i];if(!['--source','--output','--compare','--mirrors'].includes(key)||!process.argv[i+1])throw Error('Usage: console-performance.mjs [--source checkout] [--output report.json] [--compare baseline.json] [--mirrors 0|40]');
 options[key]=process.argv[i+1];
}
const root=resolve(options['--source']??fileURLToPath(new URL('../',import.meta.url)));
const output=resolve(options['--output']??'ci-diagnostics/console-performance/report.json');
const mirrors=Number(options['--mirrors']??40);if(![0,40].includes(mirrors))throw Error('mirrors must be 0 or 40');
const shape={sessions:200,longHistory:10000,otherHistory:20,textBytes:1024,mirrors};
mkdirSync(dirname(output),{recursive:true});
writeFileSync(output,JSON.stringify({status:'incomplete'}));
const {buildApp}=await import(pathToFileURL(root+'/services/server/dist/app.js'));
const {ExternalAgentSessionStore}=await import(pathToFileURL(root+'/services/server/dist/external-agent-session-store.js'));
const {AgentSessionStore}=await import(pathToFileURL(root+'/services/server/dist/agent-session-store.js'));
const salt=Buffer.from('and498-synthetic');
const app=buildApp({dingtalkWorker:false,adminAccount:{id:'owner',username:'owner@example.test',passwordScrypt:`scrypt:${salt.toString('base64url')}:${scryptSync('fixture-password',salt,64).toString('base64url')}`,sessionSecret:'synthetic-and498-only',cookieSecure:false}});
const store=app.missionGoStore, db=store.database.connection;
const product=store.createProduct({name:'Synthetic benchmark',keyPrefix:'SB'});
const item=store.createWorkItem({productId:product.id,title:'Synthetic benchmark',description:'',type:'task',priority:'normal'});
store.transitionWorkItem({itemKey:item.key,to:'ready',reason:'triaged',actor:'human'});
store.claimWorkItem({itemKey:item.key,agentId:'codex',idempotencyKey:'synthetic-claim'});
const now=new Date().toISOString();
db.prepare("INSERT INTO nodes(id,account_id,installation_id,name,token_hash,agents_json,last_seen_at,created_at,updated_at) VALUES ('node','owner','fixture','Fixture','synthetic','[]',?,?,?)").run(now,now,now);
const sessions=new AgentSessionStore(store.database), ids=[];
store.database.transaction(()=>{
for(let n=0;n<200;n++){
const id='dispatch-'+n;
db.prepare("INSERT INTO dispatches(id,account_id,node_id,agent_kind,mode,status,repo_path,created_at) VALUES (?,'owner','node','codex','default','launched','synthetic',?)").run(id,now);
db.prepare('INSERT INTO dispatch_items(dispatch_id,item_id,position) VALUES (?,?,0)').run(id,item.id);
ids.push(sessions.createForDispatch({dispatchId:id,nodeId:'node',sessionRef:'thread-'+n}));
}
const insert=db.prepare("INSERT INTO agent_session_messages(id,session_id,source_id,role,text,position,observed_at,occurred_at) VALUES (?,?,?,'agent',?,?,?,?)");
for(let n=0;n<200;n++)for(let i=0;i<(n===0?10000:20);i++)insert.run(`m-${n}-${i}`,ids[n],`source-${n}-${i}`,'x'.repeat(1024),i,now,now);
});
const external=new ExternalAgentSessionStore(store);
for(let n=0;n<mirrors;n++){
 const id=external.register({accountId:'owner',clientId:'synthetic'},{agentKind:'codex',sessionRef:'thread-'+n,refKind:'native'},item.key);
 db.prepare("UPDATE external_agent_sessions SET native_node_id='node',native_generation=1,native_synced_at=?,native_snapshot_json=? WHERE id=?")
   .run(now,JSON.stringify({status:'idle',turnState:{}}),id);
 const insert=db.prepare('INSERT INTO external_native_messages(id,session_id,source_id,payload_json,position) VALUES (?,?,?,?,?)');
 store.database.transaction(()=>{for(let i=0;i<(n===0?10000:20);i++)insert.run(`e-${n}-${i}`,id,`source-${n}-${i}`,JSON.stringify({sourceId:`source-${n}-${i}`,role:'agent',text:'x'.repeat(1024),occurredAt:now}),i);});
}
const login=await app.inject({method:'POST',url:'/api/v1/auth/login',payload:{username:'owner@example.test',password:'fixture-password'}});
const headers={cookie:login.headers['set-cookie'].split(';',1)[0]};
const paths={list:'/api/v1/agent-sessions',recent:`/api/v1/agent-sessions/${ids[0]}?history=recent`};
const detail=await app.inject({url:paths.recent,headers});
paths.older=`/api/v1/agent-sessions/${ids[0]}/history?cursor=${encodeURIComponent(detail.json().history.nextCursor)}`;
const prepare=db.prepare.bind(db); let active=false,queryCount=0,rowsRead=0;
db.prepare=sql=>{const stmt=prepare(sql);return new Proxy(stmt,{get:(target,key)=>{const v=Reflect.get(target,key,target);if(typeof v!=='function')return v;return (...args)=>{const result=Reflect.apply(v,target,args);if(active&&['get','all','run','iterate'].includes(key)){queryCount++;rowsRead+=Array.isArray(result)?result.length:result?1:0;}return result;};}});};
const results={};
for(const [name,url] of Object.entries(paths)){
await app.inject({url,headers}); const samples=[];
for(let i=0;i<7;i++){
queryCount=0;rowsRead=0;active=true;const t=performance.now(),cpu=process.cpuUsage();
const response=await app.inject({url,headers});const used=process.cpuUsage(cpu);active=false;
if(response.statusCode!==200)throw Error(response.body);
if(name==='list' ? response.json().sessions.length!==shape.sessions : response.json().messages.length!==50)throw Error('Invalid fixture response');
samples.push({wallMs:performance.now()-t,cpuMs:(used.user+used.system)/1000,queryCount,rowsRead,responseBytes:Buffer.byteLength(response.body),messages:response.json().messages?.length,sessions:response.json().sessions?.length});
}
results[name]=samples;
}
const median=(samples,key)=>[...samples].map(s=>s[key]).sort((a,b)=>a-b)[3];
const metrics=Object.fromEntries(Object.entries(results).map(([name,samples])=>[name,Object.fromEntries(['wallMs','cpuMs','queryCount','rowsRead','responseBytes'].map(key=>[key,median(samples,key)]))]));
const report={version:1,status:'measured',measuredAt:new Date().toISOString(),head:execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim(),
 dirty:Boolean(execFileSync('git',['status','--porcelain'],{cwd:root,encoding:'utf8'}).trim()),node:process.version,platform:process.platform,arch:process.arch,shape,metrics,samples:results};
if(options['--compare']){
 const baseline=JSON.parse(readFileSync(options['--compare'],'utf8'));
 if(JSON.stringify(baseline.shape)!==JSON.stringify(shape)||!baseline.metrics)throw Error('Baseline shape does not match');
 report.baselineHead=baseline.head;
 report.improvement=Object.fromEntries(Object.entries(metrics).map(([name,values])=>[name,{wallFraction:1-values.wallMs/baseline.metrics[name].wallMs,cpuFraction:1-values.cpuMs/baseline.metrics[name].cpuMs}]));
 report.targetMet=Object.values(report.improvement).every(value=>value.wallFraction>=.5);
 report.status=report.targetMet?'passed':'target_not_met';
 if(!report.targetMet)process.exitCode=1;
}
writeFileSync(output,JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({head:report.head,dirty:report.dirty,shape,metrics,...report.improvement?{improvement:report.improvement,targetMet:report.targetMet}:{}},null,2));
await app.close();
