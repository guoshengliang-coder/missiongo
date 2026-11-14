/** Local authorized-copy benchmark. Never opens the live database or contacts a provider.
 * Build both sources first. Pass the same immutable backup to independent runs. */
import {mkdtempSync,copyFileSync,chmodSync,rmSync,readFileSync,writeFileSync,mkdirSync} from "node:fs";
import {tmpdir} from "node:os";
import {join,resolve,dirname} from "node:path";
import {pathToFileURL} from "node:url";
import {randomBytes,createHash} from "node:crypto";
import {performance} from "node:perf_hooks";
import {restrictToLoopback} from "./release-performance-network.mjs";
const args={};
for(let i=2;i<process.argv.length;i+=2){
 if(!['--source','--database','--account','--output','--samples','--concurrency','--revision'].includes(process.argv[i])||!process.argv[i+1])throw Error('Expected explicit source/database/account/output and optional samples/concurrency/revision');
 args[process.argv[i]]=process.argv[i+1];
}
if(!args['--source']||!args['--database']||!args['--account']||!args['--output']||!args['--revision'])throw Error('Explicit source, database, account, output and verified source revision required');
const samples=Number(args['--samples']??100),concurrency=Number(args['--concurrency']??1);
if(!Number.isInteger(samples)||samples<100||samples>1000||![1,4].includes(concurrency)||samples%concurrency)throw Error('Use 100..1000 samples divisible by concurrency (1|4)');
const root=resolve(args['--source']),output=resolve(args['--output']);
if(output===resolve(args['--database']))throw Error('Output must differ from the immutable input');
mkdirSync(dirname(output),{recursive:true});writeFileSync(output,JSON.stringify({status:'incomplete'}));
const directory=mkdtempSync(join(tmpdir(),'session-list-copy-'));let app;
try{
 const database=join(directory,'work.sqlite');copyFileSync(resolve(args['--database']),database);chmodSync(database,0o600);
 restrictToLoopback();
 const load=file=>import(pathToFileURL(join(root,'services/server/dist',file+'.js')));
 const {buildApp}=await load('app'),{createAdminSession,ADMIN_SESSION_COOKIE}=await load('admin-auth');
 const auth={id:'isolated-list-benchmark',username:'local@example.invalid',passwordScrypt:'unused-no-login',sessionSecret:randomBytes(32).toString('hex'),cookieSecure:false};
 const noRemote=()=>{throw Error('Provider disabled in local benchmark');};
 app=buildApp({databasePath:database,attachmentsPath:join(directory,'attachments'),adminAccount:auth,dingtalkWorker:false,aiProviderFetch:noRemote,dingtalkFetch:noRemote,widgetPushFetch:noRemote,writeTools:'none'});
 const account=app.missionGoAccounts.getAccount(args['--account']);
 if(account.disabledAt)throw Error('Benchmark account disabled');
 const cookie=`${ADMIN_SESSION_COOKIE}=${createAdminSession(auth,{id:account.id,username:account.email,role:account.role},app.missionGoAccounts.credentialsStamp(account))}`;
 let active=false,queries=0,sqlMs=0,serializationMs=0;const starts=new WeakMap();
 app.addHook('preSerialization',(request,_reply,payload,done)=>{if(active)starts.set(request,performance.now());done(null,payload);});
 app.addHook('onSend',(request,_reply,payload,done)=>{if(active&&starts.has(request))serializationMs+=performance.now()-starts.get(request);done(null,payload);});
 const db=app.missionGoStore.database.connection,prepare=db.prepare.bind(db);
 db.prepare=sql=>{const stmt=prepare(sql);return new Proxy(stmt,{get(target,key){const value=Reflect.get(target,key,target);if(typeof value!=='function')return value;return (...values)=>{const start=performance.now();try{return Reflect.apply(value,target,values);}finally{if(active&&['get','all','run','iterate'].includes(key)){queries++;sqlMs+=performance.now()-start;}}};}});};
 const digests=new Set(),sizes=new Set(),counts=new Set();
 const read=async()=>{const start=performance.now(),response=await app.inject({url:'/api/v1/agent-sessions',headers:{cookie}});const ms=performance.now()-start;if(response.statusCode!==200)throw Error('List response unsuccessful');
  digests.add(createHash('sha256').update(response.body).digest('hex'));sizes.add(Buffer.byteLength(response.body));counts.add(response.json().sessions.length);return ms;};
 const firstListMs=await read();await read();await read();active=true;const used=process.cpuUsage(),values=[];
 for(let i=0;i<samples;i+=concurrency)values.push(...await Promise.all(Array.from({length:concurrency},read)));
 active=false;const cpu=process.cpuUsage(used),sorted=[...values].sort((a,b)=>a-b);
 const paths=['agent-session-store.ts','agent-session-attachments.ts','command-source-message.ts','implementation-plans.ts','agent-settings.ts','app.ts'];const digest=createHash('sha256');
 for(const path of paths)digest.update(path).update(readFileSync(join(root,'services/server/src',path)));
 const result={status:'measured',revision:args['--revision'],sourceDigest:digest.digest('hex'),measuredAt:new Date().toISOString(),node:process.version,environment:'authorized static copy; local Fastify inject; loopback only; not production traffic',concurrency,firstListMs,firstListMeaning:'first list after startup; not OS cold',samples:values,medianMs:sorted[Math.ceil(samples*.5)-1],p95Ms:sorted[Math.ceil(samples*.95)-1],cpuMsPerRequest:(cpu.user+cpu.system)/1000/samples,queriesPerRequest:queries/samples,queryTiming:'statements prepared after startup; execution only',sqlMsPerRequest:sqlMs/samples,serializationMsPerRequest:serializationMs/samples,responseDigests:[...digests],responseBytes:[...sizes],sessionCounts:[...counts]};
 writeFileSync(output,JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify({...result,samples:undefined,responseDigests:undefined}));
}finally{if(app)await app.close();rmSync(directory,{recursive:true,force:true});}
