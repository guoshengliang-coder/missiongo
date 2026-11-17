import assert from 'node:assert/strict';
import {test} from 'node:test';
import {productPlatforms} from './ci-platform-impact.mjs';
import {selectPlatforms} from './ci-platform-plan.mjs';
const before={name:'Fixture',web:{version:'1.0.0'},android:{app:{label:'Fixture'}},macos:{app:{label:'Fixture'}},linuxNode:{version:'1.0.0'}};
test('product field changes select consumers without treating unknown identity changes as web-only',()=>{
  const web={...before,web:{version:'1.0.1'}};
  assert.deepEqual(productPlatforms(before,web),[]);
  assert.deepEqual(productPlatforms(before,{...before,macos:{app:{label:'Next'}}}),['macos']);
  assert.deepEqual(productPlatforms(before,{...before,linuxNode:{version:'1.0.1'}}),['linuxNode']);
  for(const after of [{...before,name:'Next'},{...before,unknown:{}},{...before,web:{other:1}},{...before,web:{version:'bad'}},null]) assert.equal(productPlatforms(before,after),null);
  assert.equal(productPlatforms(null,web),null);
  const plan=selectPlatforms({head:'a'.repeat(40),eventName:'pull_request',changes:[{path:'product.json',status:'M'},{path:'release-notes/web/1.0.1.md',status:'A'}],productImpact:productPlatforms(before,web)});
  assert(Object.values(plan.required).every(v=>!v));
});

test('every current direct Android bridge consumer stays covered when the Web imports change', async()=>{
  const {readdirSync,readFileSync}=await import('node:fs');
  const {pathPlatforms}=await import('./ci-platform-impact.mjs');
  for(const file of readdirSync('apps/web/src').filter(f=>/\.[jt]sx?$/.test(f)&&!f.includes('.test.'))) {
    const source=readFileSync(`apps/web/src/${file}`,'utf8');
    if(/from\s+["']\.\/android-bridge["']/.test(source)) assert(pathPlatforms(`apps/web/src/${file}`).includes('android'),file);
  }
});

test('the declared macOS packaging icon cannot silently fall outside native impact rules', async()=>{
  const {readFileSync}=await import('node:fs');
  const {pathPlatforms}=await import('./ci-platform-impact.mjs');
  const product=JSON.parse(readFileSync('product.json','utf8'));
  assert(pathPlatforms(product.icon.replace(/\.svg$/,'-1024.png'))?.includes('macos'));
});

test('Windows launcher, desktop and shared node changes select native validation',async()=>{
  const {pathPlatforms}=await import('./ci-platform-impact.mjs');
  for(const path of ['apps/windows/src/main.ts','scripts/build-windows.mjs','scripts/windows-release-tools.mjs'])assert(pathPlatforms(path)?.includes('windows'),path);
  assert.deepEqual([...pathPlatforms('apps/node/src/runner.ts')].sort(),['linuxNode','windows']);
  assert.deepEqual(productPlatforms({...before,windows:{app:{version:'0.1.0'}}},{...before,windows:{app:{version:'0.1.1'}}}),['windows']);
});

test('the Windows renderer shared import graph cannot escape native impact selection',async()=>{
  const {readFileSync,existsSync}=await import('node:fs');const {resolve,dirname,relative}=await import('node:path');const {pathPlatforms}=await import('./ci-platform-impact.mjs');
  const seen=new Set(),pending=['apps/windows/src/renderer.tsx','apps/windows/src/styles.css'];
  while(pending.length){
    const file=pending.pop();if(seen.has(file))continue;seen.add(file);
    for(const match of readFileSync(file,'utf8').matchAll(/(?:from\s*|import\s*|@import\s*)["'](\.[^"']+)["']/g)){
      const base=resolve(dirname(file),match[1]),target=[base,base+'.ts',base+'.tsx',base+'.css'].find(existsSync);
      if(!target)continue;const path=relative(process.cwd(),target).replaceAll('\\','/');
      if(path.startsWith('apps/web/src/')){assert(pathPlatforms(path)?.includes('windows'),path);pending.push(path);}
    }
  }
});
