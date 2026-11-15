/** Controlled, synthetic browser experiment. Requires a separately compiled Server
 * source and the current checkout's Vite frontend. Never reads production data. */
import { createServer } from 'node:net';
import { spawn,execFileSync } from 'node:child_process';
import { openSync,writeSync,closeSync,readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath,pathToFileURL } from 'node:url';
import { createHash,scryptSync } from 'node:crypto';
import { chromium,devices } from '@playwright/test';
const args={};for(let i=2;i<process.argv.length;i+=2){if(!['--source','--output','--samples','--round','--web','--revision'].includes(process.argv[i])||!process.argv[i+1])throw Error('Expected --source --web --output --samples --round');args[process.argv[i]]=process.argv[i+1];}
const source=resolve(args['--source']),web=resolve(args['--web']??fileURLToPath(new URL('../',import.meta.url))),output=resolve(args['--output']);
const revision=args['--revision'];if(revision&&!/^[a-f0-9]{40}$/.test(revision))throw Error('revision must be full source commit');
const count=Number(args['--samples']??34);if(!Number.isInteger(count)||count<1||count>100)throw Error('samples 1..100');
// Never overwrite an earlier report or follow an output alias.
const fd=openSync(output,'wx',0o600);writeSync(fd,JSON.stringify({status:'incomplete'}));
const at='2026-11-15T02:00:00.000Z',load=file=>import(pathToFileURL(`${source}/services/server/dist/${file}.js`));
let app,browser,vite;
try{
 const {buildApp}=await load('app'),{AgentSessionStore}=await load('agent-session-store');
 const salt=Buffer.from('and528-browser-only'),password='synthetic-only';
 app=buildApp({adminAccount:{id:'owner',username:'owner@example.test',passwordScrypt:`scrypt:${salt.toString('base64url')}:${scryptSync(password,salt,64).toString('base64url')}`,sessionSecret:'synthetic-list-browser',cookieSecure:false},dingtalkWorker:false,performance:{enabled:false},aiProviderFetch:()=>{throw Error('Provider prohibited');}});
 const store=app.missionGoStore,db=store.database.connection;
 const product=store.createProduct({name:'Controlled list experiment',keyPrefix:'SYN'}),item=store.createWorkItem({productId:product.id,title:'Synthetic item',description:'',type:'task',status:'ready',priority:'normal',environment:{platform:'shared'}});
 store.claimWorkItem({itemKey:item.key,agentId:'codex',idempotencyKey:'synthetic'});
 const capabilities=JSON.stringify([{kind:'codex',models:Array.from({length:100},(_,i)=>({id:`model-${i}`,label:'Synthetic model '.repeat(5),efforts:['low','high']}))}]);
 db.prepare("INSERT INTO nodes(id,account_id,installation_id,name,token_hash,agents_json,last_seen_at,created_at,updated_at) VALUES ('node','owner','fixture','Fixture','synthetic',?,?,?,?)").run(capabilities,at,at,at);
 const sessions=new AgentSessionStore(store.database);
 store.database.transaction(()=>{for(let n=0;n<200;n++){
  const dispatch=`d-${n}`;db.prepare("INSERT INTO dispatches(id,account_id,node_id,agent_kind,mode,status,repo_path,created_at) VALUES (?,'owner','node','codex','default','launched','synthetic',?)").run(dispatch,at);
  db.prepare('INSERT INTO dispatch_items(dispatch_id,item_id,position) VALUES (?,?,0)').run(dispatch,item.id);
  const id=sessions.createForDispatch({dispatchId:dispatch,nodeId:'node',sessionRef:`thread-${n}`});
  for(let c=0;c<4;c++)db.prepare("INSERT INTO agent_session_commands(id,session_id,account_id,kind,text,status,created_at) VALUES (?,?,'owner',?,'synthetic command','delivered',?)").run(`cmd-${n}-${c}`,id,c===3?'interrupt':'message',at);
 }});
 // Freeze business timestamps in synthetic records, never the browser monotonic clock.
 db.prepare('UPDATE agent_sessions SET created_at=?,updated_at=?').run(at,at);
 const login=await app.inject({method:'POST',url:'/api/v1/auth/login',payload:{username:'owner@example.test',password}});
 const cookie=login.headers['set-cookie'].split(';',1)[0];
 const baseline=await app.inject({url:'/api/v1/agent-sessions',headers:{cookie}});if(baseline.statusCode!==200||baseline.json().sessions.length!==200)throw Error('Fixture mismatch');
 const normalize=v=>typeof v==='string'?v.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi,'<uuid>').replace(/\b[0-9a-f]{64}\b/gi,'<digest>'):Array.isArray(v)?v.map(normalize):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,normalize(v[k])])):v;
 const responseDigest=createHash('sha256').update(JSON.stringify(normalize({...baseline.json(),sessions:baseline.json().sessions.sort((a,b)=>String(a.dispatchId).localeCompare(String(b.dispatchId)))}))).digest('hex');
 await app.listen({host:'127.0.0.1',port:0});const apiPort=app.server.address().port;
 const reserve=createServer();await new Promise(r=>reserve.listen(0,'127.0.0.1',r));const port=reserve.address().port;await new Promise(r=>reserve.close(r));
 const origin=`http://127.0.0.1:${port}`;
 vite=spawn(process.execPath,[`${web}/node_modules/vite/bin/vite.js`,'--host','127.0.0.1','--port',String(port),'--strictPort'],{cwd:`${web}/apps/web`,env:{...process.env,MISSIONGO_DEV_SERVER_URL:`http://127.0.0.1:${apiPort}`},stdio:['ignore','pipe','pipe']});
 let viteLog='';vite.stderr.on('data',c=>{viteLog=(viteLog+String(c)).slice(-3000);});
 const deadline=Date.now()+30000;while(true){try{if((await fetch(origin)).ok)break;}catch{}if(vite.exitCode!==null||Date.now()>deadline)throw Error(`Vite startup failed: ${viteLog}`);await new Promise(r=>setTimeout(r,100));}
 browser=await chromium.launch({headless:true});const samples=[],startedAt=new Date().toISOString();
 for(const device of ['phone','pc']){
  const context=await browser.newContext(device==='phone'?devices['Pixel 7']:{viewport:{width:1440,height:900}});
  const eq=cookie.indexOf('=');await context.addCookies([{name:cookie.slice(0,eq),value:cookie.slice(eq+1),domain:'127.0.0.1',path:'/'}]);
  // Every stratum uses the same 40ms synthetic API delay. It is not Wi-Fi or cellular.
  await context.route('**/api/v1/agent-sessions',async route=>{await new Promise(r=>setTimeout(r,40));await route.continue();});
  for(let iteration=0;iteration<count;iteration++){
   const page=await context.newPage(),events=[];
   await page.clock.setFixedTime(new Date(at));
   await page.route('**/api/v1/console/performance',async route=>{events.push(...route.request().postDataJSON().events);await route.fulfill({status:202,json:{protocol:1}});});
   const flush=async()=>{await page.evaluate(async()=>{await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));const modulePath='/src/console-performance.ts';const m=await import(modulePath);for(let i=0;i<8;i++)await m.flushPerformance();});};
   await page.goto(`${origin}/?product=${product.id}&console=agent`);
   await page.locator('.agent-console-session').first().waitFor();await flush();
   await page.locator('.agent-console-topbar-back').click();await page.waitForURL(url=>!url.searchParams.has('console'));
   await page.evaluate(()=>history.forward());await page.locator('.agent-console-session').first().waitFor();await flush();
   // CDP lifecycle gives the same visibility event path as the actual observer;
   // this is an explicit simulation, not a real device background test.
   await page.evaluate(()=>{Object.defineProperty(document,'visibilityState',{configurable:true,value:'hidden'});document.dispatchEvent(new Event('visibilitychange'));});
   await page.evaluate(()=>{Object.defineProperty(document,'visibilityState',{configurable:true,value:'visible'});document.dispatchEvent(new Event('visibilitychange'));});
   await flush();
   const visits=events.filter(e=>e.stage==='list_visit');
   for(const scenario of ['first_entry','cache_return','background_resume']){
    const visit=visits.find(e=>e.list.scenario===scenario);if(!visit)throw Error(`Missing ${scenario} ${device} ${iteration}`);
    const selected=events.filter(e=>e.list?.visitId===visit.list.visitId);
    samples.push({device,scenario,iteration,events:selected.map(({id:_id,...e})=>({...e,list:{...e.list,visitId:undefined}}))});
   }
   await page.close();
  }
  await context.close();
 }
 const report={version:1,status:'measured',sourceCommit:revision??execFileSync('git',['rev-parse','HEAD'],{cwd:source,encoding:'utf8'}).trim(),runtimeDigest:createHash('sha256').update(readFileSync(`${source}/services/server/dist/app.js`)).update(readFileSync(`${source}/services/server/dist/agent-session-store.js`)).digest('hex'),webCommit:execFileSync('git',['rev-parse','HEAD'],{cwd:web,encoding:'utf8'}).trim(),sourceDirty:revision?null:!!execFileSync('git',['status','--porcelain'],{cwd:source,encoding:'utf8'}).trim(),webDirty:!!execFileSync('git',['status','--porcelain'],{cwd:web,encoding:'utf8'}).trim(),startedAt,endedAt:new Date().toISOString(),round:Number(args['--round']??1),environment:{browser:browser.version(),mode:'Vite development; fixed current frontend across server sources',businessTime:at,network:'synthetic 40ms API routing delay; loopback',sessions:200,commandsPerSession:4,nodeModels:100,requestConcurrency:1,provider:'disabled',collection:'Web queue captured, upload fulfilled by harness; server collector disabled'},responseBytes:Buffer.byteLength(baseline.body),normalizedResponseSha256:responseDigest,samples};
 await browser.close();browser=undefined;await app.close();app=undefined;
 const bytes=Buffer.from(JSON.stringify(report,null,2)+'\n');let offset=0;while(offset<bytes.length){const n=writeSync(fd,bytes,offset,bytes.length-offset,offset);if(!n)throw Error('No write progress');offset+=n;}
 console.log(JSON.stringify({status:report.status,round:report.round,source:report.sourceCommit,samples:samples.length}));
}finally{if(browser)await browser.close();if(vite){vite.kill('SIGTERM');await new Promise(r=>vite.once('exit',r));}if(app)await app.close();closeSync(fd);}
