import {test,expect} from "@playwright/test";
import {build} from "esbuild";
import {readFile} from "node:fs/promises";
import {resolve} from "node:path";

test("a pre-acknowledgement read cannot erase a newer continuation receipt",async({page},testInfo)=>{
  await page.clock.setFixedTime(new Date("2026-11-22T02:00:00Z"));
  const root=process.cwd(),directory=resolve(root,"apps/web/src");
  let source=await readFile(resolve(directory,"merge-reconciliation.tsx"),"utf8");
  // Release a real in-flight network promise at the ACK callback boundary. No production hook is added.
  const boundary=/(onSuccess:\(result,variables\)=>\{[\s\S]*?)(\n    \},\n    onError:)/;
  expect(source).toMatch(boundary);
  source=source.replace(boundary,"$1\n      globalThis.probe.whenAck?.();$2");
  const entry=`import React from 'react';import {createRoot} from 'react-dom/client';
    import {QueryClient,QueryClientProvider} from '@tanstack/react-query';import {MergeReconciliation} from 'subject';
    const p=globalThis.probe={events:[],gets:0,sends:0};
    const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b});return {promise,resolve,reject}};
    p.old=deferred();p.post=deferred();p.fresh=deferred();
    p.payload=()=>({batchId:'batch',sessionId:'session',state:'active',publish:false,snapshot:'snapshot',entries:[],
      reconciliation:{requests:[{id:'one',snapshot:'snapshot',digest:'d',at:'2026-11-22',action:{kind:'retry_blocked'},decision:'approved'}],history:[],handoffs:{}},
      continuations:{one:{state:'not_sent'}}});
    p.request=(path,init)=>{
      if(init?.method==='POST'){p.sends++;p.events.push('post start');return p.post.promise}
      p.gets++;p.events.push('get '+p.gets+' start');
      return p.gets===1?Promise.resolve(p.payload()):p.gets===2?p.old.promise:p.gets===3?p.fresh.promise:Promise.resolve(p.next);
    };
    const client=p.client=new QueryClient({defaultOptions:{queries:{retry:false,refetchOnWindowFocus:false},mutations:{retry:false}}});
    client.getQueryCache().subscribe(e=>{if(e.type==='updated')p.events.push('query '+e.query.state.fetchStatus+' '+e.query.state.status+' '+e.query.state.data?.continuations?.one?.state)});
    p.whenAck=()=>{p.events.push('ack hook');p.old.resolve(p.payload())};
    createRoot(document.getElementById('root')).render(<QueryClientProvider client={client}><MergeReconciliation batchId='batch' compact initiallyOpen/></QueryClientProvider>);`;
  const result=await build({stdin:{contents:entry,resolveDir:root,loader:"tsx"},bundle:true,write:false,platform:"browser",jsx:"automatic",
    define:{"process.env.NODE_ENV":'"development"'},plugins:[{name:"ack-boundary",setup(b){
      b.onResolve({filter:/^subject$/},()=>({path:"subject",namespace:"subject"}));
      b.onLoad({filter:/.*/,namespace:"subject"},()=>({contents:source,loader:"tsx",resolveDir:directory}));
      b.onResolve({filter:/^\.\/(api|i18n)$/},args=>args.namespace==="subject"?{path:args.path,namespace:"stub"}:undefined);
      b.onLoad({filter:/.*/,namespace:"stub"},args=>({loader:"js",contents:args.path==="./api"
        ?"export const request=(path,init)=>globalThis.probe.request(path,init)"
        :"export function useI18n(){return {t:key=>key,formatTime:x=>x,statusLabel:x=>x}}"}));
    }}]});
  await page.setContent('<div id="root"></div>');await page.addScriptTag({content:result.outputFiles[0]!.text});
  await expect(page.getByText("recoveryApprovedSaved",{exact:true})).toBeVisible();
  await page.getByRole("button",{name:"recoveryContinue",exact:true}).click();
  await page.evaluate("void probe.client.refetchQueries({queryKey:['merge-reconciliation','batch']})");
  await page.waitForFunction("probe.gets===2");
  await page.evaluate("probe.post.resolve({...probe.payload(),continuation:{state:'queued',queued:true,commandId:'command'}})");
  await page.waitForFunction("probe.gets>=3");
  await page.evaluate("probe.fresh.reject(new Error('read failed'))");
  await expect(page.getByText("recoveryContinueReadFailed",{exact:true})).toBeVisible();
  await expect(page.getByText("recoveryContinueQueued",{exact:true})).toBeVisible();
  await expect(page.getByText("recoveryApprovedSaved",{exact:true})).toHaveCount(0);
  await expect(page.getByRole("button",{name:"recoveryContinue",exact:true})).toHaveCount(0);
  expect(await page.evaluate("probe.sends")).toBe(1);
  await page.evaluate("probe.next={...probe.payload(),continuations:{one:{state:'delivered',commandId:'command'}}}");
  await page.getByRole("button",{name:"recoveryContinueCheck",exact:true}).click();
  await expect(page.getByText("recoveryContinueDelivered",{exact:true})).toBeVisible();
  await expect(page.getByText("recoveryContinueQueued",{exact:true})).toHaveCount(0);
  const events=await page.evaluate("probe.events") as string[];
  expect(events.indexOf("ack hook")).toBeGreaterThan(events.indexOf("get 2 start"));
  expect(events.indexOf("get 3 start")).toBeGreaterThan(events.indexOf("ack hook"));
  await testInfo.attach("network-order",{body:JSON.stringify(events,null,2),contentType:"application/json"});
});
