import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,symlinkSync,linkSync,rmSync,readdirSync,statSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const script=fileURLToPath(new URL('./session-list-backup-performance.mjs',import.meta.url));
for(const alias of ['same-path','symlink','hardlink','existing-report'])test(`output ${alias} cannot truncate input or an existing report`,()=>{
 const directory=mkdtempSync(join(tmpdir(),'list-output-audit-'));
 try{
  const database=join(directory,'snapshot.sqlite'),output=alias==='same-path'?database:join(directory,'report.json');
  const sentinel='immutable synthetic input';writeFileSync(database,sentinel);
  if(alias==='symlink')symlinkSync(database,output);
  if(alias==='hardlink')linkSync(database,output);
  if(alias==='existing-report')writeFileSync(output,'previous report');
  const child=spawnSync(process.execPath,[script,'--source',directory,'--database',database,'--account','fixture','--revision','audit','--output',output],{encoding:'utf8',timeout:10000});
  assert.notEqual(child.status,0);
  assert.equal(readFileSync(database,'utf8'),sentinel);
  if(alias==='existing-report')assert.equal(readFileSync(output,'utf8'),'previous report');
 }finally{rmSync(directory,{recursive:true,force:true});}
});

function simulatedSource(directory, mode, database, output){
 const root=join(directory,'source'),dist=join(root,'services/server/dist'),src=join(root,'services/server/src');
 mkdirSync(dist,{recursive:true});mkdirSync(src,{recursive:true});
 writeFileSync(join(root,'package.json'),JSON.stringify({type:'module'}));
 writeFileSync(join(dist,'admin-auth.js'),`export const ADMIN_SESSION_COOKIE='fixture';export function createAdminSession(){return 'local';}`);
 writeFileSync(join(dist,'app.js'),`
  import {unlinkSync,symlinkSync} from 'node:fs';
  let swapped=false;
  export function buildApp(){return {
   missionGoAccounts:{getAccount:()=>({id:'fixture',email:'fixture@example.invalid',role:'admin'}),credentialsStamp:()=>''},
   missionGoStore:{database:{connection:{prepare(){return {};}}}},addHook(){},
   async inject(){
    if(${JSON.stringify(mode)}==='swap'&&!swapped){swapped=true;unlinkSync(${JSON.stringify(output)});symlinkSync(${JSON.stringify(database)},${JSON.stringify(output)});}
    return {statusCode:200,body:'{"sessions":[]}',json:()=>({sessions:[]})};
   },async close(){if(${JSON.stringify(mode)}==='close-failure')throw Error('fixture close failure');}
  };}
 `);
 for(const name of ['agent-session-store','agent-session-attachments','command-source-message','implementation-plans','agent-settings','app'])writeFileSync(join(src,name+'.ts'),'synthetic');
 return root;
}
for(const mode of ['success','close-failure','swap'])test(`local-copy cleanup and report integrity: ${mode}`,()=>{
 const directory=mkdtempSync(join(tmpdir(),'list-lifecycle-audit-'));
 try{
  const database=join(directory,'snapshot.sqlite'),output=join(directory,'report.json'),temp=join(directory,'private');mkdirSync(temp);
  const sentinel='immutable synthetic input';writeFileSync(database,sentinel);
  const source=simulatedSource(directory,mode,database,output);
  const child=spawnSync(process.execPath,[script,'--source',source,'--database',database,'--account','fixture','--revision','synthetic-only','--output',output,'--at','2026-11-14T10:00:00Z'],{encoding:'utf8',timeout:10000,env:{...process.env,TMPDIR:temp,TMP:temp,TEMP:temp}});
  assert.equal(readFileSync(database,'utf8'),sentinel);assert.deepEqual(readdirSync(temp),[]);
  if(mode==='success'){
   assert.equal(child.status,0,child.stderr);const report=JSON.parse(readFileSync(output));assert.equal(report.status,'measured');assert.equal(report.samples.length,100);assert.equal(statSync(output).mode&0o077,0);
  }else{
   assert.notEqual(child.status,0);if(mode==='close-failure')assert.equal(JSON.parse(readFileSync(output)).status,'incomplete');
  }
 }finally{rmSync(directory,{recursive:true,force:true});}
});
