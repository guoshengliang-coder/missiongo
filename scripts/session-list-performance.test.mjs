import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,existsSync,rmSync,mkdirSync,readdirSync,symlinkSync,writeFileSync,readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath,pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
test('synthetic collection refuses a frozen business clock outside its health window before creating output',()=>{
 const dir=mkdtempSync(join(tmpdir(),'and528-clock-')),output=join(dir,'report.json');
 try{
  const r=spawnSync(process.execPath,[fileURLToPath(new URL('./session-list-performance.mjs',import.meta.url)),'--output',output,'--collect','on','--at',new Date(Date.now()-120000).toISOString()],{encoding:'utf8'});
  assert.notEqual(r.status,0);assert.match(r.stderr,/health requires --at within 30 seconds/);assert.equal(existsSync(output),false);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
test('failed collector health cannot publish a measured experiment',()=>{
 const dir=mkdtempSync(join(tmpdir(),'and528-health-')),output=join(dir,'report.json'),dist=join(dir,'services/server/dist');
 const actual=fileURLToPath(new URL('../services/server/dist/',import.meta.url));
 try{
  mkdirSync(dist,{recursive:true});
  for(const file of readdirSync(actual))if(file!=='app.js')symlinkSync(join(actual,file),join(dist,file));
  writeFileSync(join(dir,'package.json'),JSON.stringify({type:'module'}));
  writeFileSync(join(dist,'app.js'),`import {buildApp as real} from ${JSON.stringify(pathToFileURL(join(actual,'app.js')).href)};export function buildApp(options){const app=real(options),inject=app.inject.bind(app);app.inject=(request)=>request.url.startsWith('/api/v1/console/performance')?Promise.resolve({statusCode:200,json:()=>({status:{ready:true},collectionEvents:{accepted:0}})}):inject(request);return app;}`);
  const r=spawnSync(process.execPath,[fileURLToPath(new URL('./session-list-performance.mjs',import.meta.url)),'--source',dir,'--revision','0'.repeat(40),'--output',output,'--collect','on','--samples','20'],{encoding:'utf8',timeout:30000});
  assert.notEqual(r.status,0);assert.match(r.stderr,/Collector health window missing measured events/);
  assert.equal(JSON.parse(readFileSync(output,'utf8')).status,'incomplete');
  assert.doesNotMatch(r.stdout,/"status": "measured"/);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
