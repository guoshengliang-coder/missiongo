import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,existsSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
test('synthetic collection refuses a frozen business clock outside its health window before creating output',()=>{
 const dir=mkdtempSync(join(tmpdir(),'and528-clock-')),output=join(dir,'report.json');
 try{
  const r=spawnSync(process.execPath,[fileURLToPath(new URL('./session-list-performance.mjs',import.meta.url)),'--output',output,'--collect','on','--at',new Date(Date.now()-120000).toISOString()],{encoding:'utf8'});
  assert.notEqual(r.status,0);assert.match(r.stderr,/health requires --at within 30 seconds/);assert.equal(existsSync(output),false);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
