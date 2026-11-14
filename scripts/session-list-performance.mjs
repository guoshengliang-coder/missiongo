/** Synthetic list-only comparison. Build both sources with tsc first. No real
 * database, node, AI provider or production traffic is used by this runner. */
import {performance} from 'node:perf_hooks';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {execFileSync} from 'node:child_process';
import {createHash,scryptSync} from 'node:crypto';
const args={};
for(let i=2;i<process.argv.length;i+=2){
 if(!['--source','--output','--scenario','--samples','--concurrency','--revision'].includes(process.argv[i])||!process.argv[i+1])throw Error('Expected --source/--output/--scenario/--samples/--concurrency/--revision value');
 args[process.argv[i]]=process.argv[i+1];
}
const root=resolve(args['--source']??fileURLToPath(new URL('../',import.meta.url)));
const output=resolve(args['--output']??'ci-diagnostics/session-list-performance.json');
const scenario=args['--scenario']??'normal',samples=Number(args['--samples']??100),concurrency=Number(args['--concurrency']??1);
if(!['normal','plans','external-plans','commands'].includes(scenario)||!Number.isInteger(samples)||samples<20||samples>1000||![1,4].includes(concurrency))throw Error('Invalid scenario, samples (20..1000) or concurrency (1|4)');
mkdirSync(dirname(output),{recursive:true});writeFileSync(output,JSON.stringify({status:'incomplete'}));
const load=file=>import(pathToFileURL(`${root}/services/server/dist/${file}.js`));
const {buildApp}=await load('app');
const {AgentSessionStore}=await load('agent-session-store');
const {ExternalAgentSessionStore}=await load('external-agent-session-store');
const {ImplementationPlans}=await load('implementation-plans');
const {PlanDocuments}=await load('plan-documents');
const salt=Buffer.from('synthetic-list-only');
const app=buildApp({dingtalkWorker:false,adminAccount:{id:'owner',username:'owner@example.test',passwordScrypt:`scrypt:${salt.toString('base64url')}:${scryptSync('fixture-password',salt,64).toString('base64url')}`,sessionSecret:'synthetic-list-benchmark',cookieSecure:false}});
try {
 const store=app.missionGoStore,db=store.database.connection;
 let active=false,queryCount=0,sqlMs=0;
 const stages={};
 const prepare=db.prepare.bind(db);
 db.prepare=sql=>{const stmt=prepare(sql);return new Proxy(stmt,{get(target,key){const value=Reflect.get(target,key,target);if(typeof value!=='function')return value;
  return (...values)=>{const start=performance.now();try{return Reflect.apply(value,target,values);}finally{if(active&&['get','all','run','iterate'].includes(key)){queryCount++;sqlMs+=performance.now()-start;}}};}});};
 const product=store.createProduct({name:'Synthetic list benchmark',keyPrefix:'SL'});
 const item=store.createWorkItem({productId:product.id,title:'Synthetic session',description:'',type:'task',status:'ready',priority:'normal',environment:{platform:'shared'}});
 store.claimWorkItem({itemKey:item.key,agentId:'codex',idempotencyKey:'synthetic-claim'});
 const nodeAgents=JSON.stringify([{kind:'codex',models:Array.from({length:100},(_,i)=>({id:`model-${i}`,label:'Synthetic model '.repeat(5),efforts:['low','high']}))}]);
 const now=new Date().toISOString(),sessions=new AgentSessionStore(store.database),external=new ExternalAgentSessionStore(store);
 const ids=[],mirrors=scenario==='external-plans'?200:40;
 db.prepare("INSERT INTO nodes(id,account_id,installation_id,name,token_hash,agents_json,last_seen_at,created_at,updated_at) VALUES ('node','owner','fixture','Fixture','synthetic','[]',?,?,?)").run(now,now,now);
 if(scenario==='commands')db.prepare("UPDATE nodes SET agents_json=? WHERE id='node'").run(nodeAgents);
 store.database.transaction(()=>{
  const message=db.prepare('INSERT INTO agent_session_messages(id,session_id,source_id,role,text,position,observed_at,occurred_at) VALUES (?,?,?,?,?,?,?,?)');
  for(let n=0;n<200;n++){
   db.prepare("INSERT INTO dispatches(id,account_id,node_id,agent_kind,mode,status,repo_path,created_at) VALUES (?,'owner','node','codex','default','launched','synthetic',?)").run(`d-${n}`,now);
   db.prepare('INSERT INTO dispatch_items(dispatch_id,item_id,position) VALUES (?,?,0)').run(`d-${n}`,item.id);
   const id=sessions.createForDispatch({dispatchId:`d-${n}`,nodeId:'node',sessionRef:`thread-${n}`});ids.push(id);
   const count=n===0?10000:20;
   for(let i=0;i<count;i++)message.run(`m-${n}-${i}`,id,`source-${n}-${i}`,scenario==='plans'&&i===count-1?'plan':'agent','x'.repeat(1024),i,now,now);
   if(scenario==='commands'){
    for(let c=0;c<4;c++)db.prepare("INSERT INTO agent_session_commands(id,session_id,account_id,kind,text,status,created_at) VALUES (?,?,'owner',?,'synthetic command','delivered',?)").run(`cmd-${n}-${c}`,id,c===3?'interrupt':'message',now);
    message.run(`user-${n}`,id,`cmd-${n}-2`,'user','synthetic command',count,now,now);
   }
  }
 });
 const plans=new ImplementationPlans(store.database),documents=new PlanDocuments(store);
 const registerPlan=identity=>{
  const summary='Synthetic reviewed plan';
  const document=documents.prepare({accountId:'owner',identity,keys:[item.key],summary,markdown:summary+'\n'+'plan body '.repeat(4000),origin:'https://fixture.example.test',requestKey:identity});
  plans.request('owner',identity,`r-${identity}`,{keys:[item.key],plan:document.plan,documentId:document.id,validation:''});
 };
 for(let n=0;n<mirrors;n++){
  const id=external.register({accountId:'owner',clientId:'synthetic'},{agentKind:'codex',sessionRef:`thread-${n}`,refKind:'native'},item.key);
  db.prepare("UPDATE external_agent_sessions SET native_node_id='node',native_generation=1,native_synced_at=?,native_snapshot_json=? WHERE id=?")
   .run(now,JSON.stringify({status:'idle',turnState:scenario==='external-plans'?{waitingForInput:true}:{}}),id);
  const insert=db.prepare('INSERT INTO external_native_messages(id,session_id,source_id,payload_json,position) VALUES (?,?,?,?,?)');
  store.database.transaction(()=>{const count=n===0?10000:20;for(let i=0;i<count;i++)insert.run(`e-${n}-${i}`,id,`source-${n}-${i}`,JSON.stringify({sourceId:`source-${n}-${i}`,role:scenario==='external-plans'&&i===count-1?'plan':'agent',text:'x'.repeat(1024),occurredAt:now}),i);});
  if(scenario==='external-plans')registerPlan(`native:synthetic:codex:native:thread-${n}`);
 }
 if(scenario==='plans'){
  db.prepare("UPDATE agent_sessions SET status='idle'").run();
  for(let n=0;n<200;n++)registerPlan(`dispatch:d-${n}`);
 }
 const serializationStarts=new WeakMap();
 app.addHook('preSerialization',(request,_reply,payload,done)=>{if(active)serializationStarts.set(request,performance.now());done(null,payload);});
 app.addHook('onSend',(request,_reply,payload,done)=>{const start=serializationStarts.get(request);if(active&&start!==undefined)stages.serialization=(stages.serialization??0)+performance.now()-start;done(null,payload);});
 const login=await app.inject({method:'POST',url:'/api/v1/auth/login',payload:{username:'owner@example.test',password:'fixture-password'}});
 const headers={cookie:login.headers['set-cookie'].split(';',1)[0]};
 // Nested stage totals are reported separately, never summed as exclusive time.
 for(const [file,cls,methods] of [
  ['agent-console-sessions','AgentConsoleSessions',['list','groups']],
  ['agent-session-store','AgentSessionStore',['listForAccount']],
  ['external-agent-session-store','ExternalAgentSessionStore',['listForAccount']],
  ['plan-approval','PlanApprovalService',['withAttention','withAttentionForSessions']],
  ['accounts-store','AccountStore',['allows']],['merge-deliveries','MergeDeliveries',['attentionSessionIds']],
 ]){
  const proto=(await load(file))[cls].prototype;
  for(const method of methods){const original=proto[method];if(!original)continue;
   proto[method]=function(...values){const start=performance.now();try{return original.apply(this,values);}finally{if(active)stages[`${cls}.${method}`]=(stages[`${cls}.${method}`]??0)+performance.now()-start;}};
  }
 }
 const read=async()=>{
  const start=performance.now(),response=await app.inject({url:'/api/v1/agent-sessions',headers});
  const wallMs=performance.now()-start;
  if(response.statusCode!==200||response.json().sessions.length!==200)throw Error('Invalid list response');
  return {wallMs,responseBytes:Buffer.byteLength(response.body)};
 };
 const cold=await read(); // first list after fixture setup/login; no OS-cold claim
 await read();await read();
 const measured=[];const cpu=process.cpuUsage();active=true;
 for(let i=0;i<samples;i++)measured.push(...await Promise.all(Array.from({length:concurrency},read)));
 active=false;const used=process.cpuUsage(cpu),count=measured.length;
 const sorted=measured.map(value=>value.wallMs).sort((a,b)=>a-b),percentile=q=>sorted[Math.ceil(sorted.length*q)-1];
 const paths=['services/server/src/agent-session-store.ts','services/server/src/agent-session-attachments.ts','services/server/src/command-source-message.ts','services/server/src/agent-settings.ts','services/server/src/app.ts','services/server/src/plan-approval.ts','services/server/src/implementation-plans.ts','services/server/src/external-agent-session-store.ts'];
 const sourceDigest=createHash('sha256');for(const path of paths)sourceDigest.update(path).update(readFileSync(resolve(root,path)));
 // --revision is used only for a separately extracted git archive; callers
 // retain the archive command as provenance. A checkout reports its real HEAD.
 const source=args['--revision']?{commit:args['--revision'],kind:'git-archive',dirty:null}:{commit:execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim(),kind:'checkout',dirty:Boolean(execFileSync('git',['status','--porcelain'],{cwd:root,encoding:'utf8'}).trim())};
 const report={version:1,status:'measured',measuredAt:new Date().toISOString(),source:{...source,digest:sourceDigest.digest('hex')},runtime:{node:process.version,platform:process.platform,arch:process.arch},client:'fastify-inject',cache:'memory-sqlite; first list then warm; not OS cold',shape:{scenario,sessions:200,mirrors,longHistory:10000,otherHistory:20,textBytes:1024,planBodyBytes:scenario==='normal'?0:40000,concurrency,...(scenario==='commands'?{commandsPerSession:4,nodeCapabilityBytes:Buffer.byteLength(nodeAgents)}:{})},cold,
  warm:{samples:count,medianMs:percentile(.5),p95Ms:percentile(.95),cpuMsPerRequest:(used.user+used.system)/1000/count,sqlPerRequest:queryCount/count,sqlMsPerRequest:sqlMs/count,responseBytes:[...new Set(measured.map(value=>value.responseBytes))],nestedStagesMsPerRequest:Object.fromEntries(Object.entries(stages).map(([key,value])=>[key,value/count]))},samples:measured};
 writeFileSync(output,JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify({...report,samples:undefined},null,2));
} finally {await app.close();}
